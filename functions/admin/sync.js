// POST /admin/sync —— 服务端同步：把所有站点的模型列表从上游 /models 拉取并写回 KV。
// 鉴权：X-Admin-Token == env.ADMIN_TOKEN。
// 用法：
//   POST /admin/sync          → 立即强制同步（面板「立即同步全部」用）
//   POST /admin/sync?auto=1    → 自动模式：仅当 syncSettings.enabled 且距上次同步 >= intervalHours 才执行
//                                （给浏览器定时器 / Cloudflare Cron Worker 用，按设定间隔生效，且不会重复跑）
// 并发 / 重试 / 速率(令牌桶 rpm+burst) 都取自 config.syncSettings。

function j(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function adminOk(request, env) {
  const t = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.ADMIN_TOKEN) && t === env.ADMIN_TOKEN;
}

async function loadConfig(env) {
  try {
    const raw = await env.CONFIG_KV.get("config");
    if (!raw) return { endpoints: [], fallbackModels: [], syncSettings: {} };
    const c = JSON.parse(raw);
    return {
      endpoints: Array.isArray(c.endpoints) ? c.endpoints : [],
      fallbackModels: Array.isArray(c.fallbackModels) ? c.fallbackModels : [],
      syncSettings: (c.syncSettings && typeof c.syncSettings === "object") ? c.syncSettings : {},
    };
  } catch { return { endpoints: [], fallbackModels: [], syncSettings: {} }; }
}

// 拉取一个上游的模型列表（兼容 {data:[...]} / {models:[...]} / 直接数组；元素可为字符串或 {id|name|model}）
async function fetchUpstreamModels(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const arr = d && (Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : (Array.isArray(d) ? d : null)));
  if (!arr) return null;
  return arr.map((x) => (typeof x === "string" ? x : (x.id || x.name || x.model))).filter(Boolean);
}

// 令牌桶限流：每分钟 rpm 个，桶容量 burst
function makeLimiter(rpm, burst) {
  let tokens = burst, last = Date.now();
  const refillPerMs = rpm / 60000;
  return async function acquire() {
    while (true) {
      const now = Date.now();
      tokens = Math.min(burst, tokens + (now - last) * refillPerMs);
      last = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await new Promise((r) => setTimeout(r, Math.ceil((1 - tokens) / refillPerMs)));
    }
  };
}

async function handle({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  if (!env.CONFIG_KV) return j({ error: "未绑定 KV 命名空间 CONFIG_KV" }, 500);

  const auto = new URL(request.url).searchParams.get("auto") === "1";
  const cfg = await loadConfig(env);
  const ss = cfg.syncSettings || {};

  if (auto) {
    if (!ss.enabled) return j({ skipped: "disabled" });
    let st = {};
    try { const r = await env.CONFIG_KV.get("syncState"); st = r ? JSON.parse(r) : {}; } catch {}
    const intervalMs = Math.max(1, ss.intervalHours || 6) * 3600 * 1000;
    const elapsed = Date.now() - (st.lastSyncAt || 0);
    if (elapsed < intervalMs) return j({ skipped: "not_due", nextInMin: Math.ceil((intervalMs - elapsed) / 60000) });
  }

  const endpoints = cfg.endpoints || [];
  const targets = endpoints.map((e, i) => ({ e, i })).filter((x) => x.e.baseUrl && (x.e.apiKeys || []).length);
  const concurrency = Math.max(1, Math.min(10, ss.concurrency || 2));
  const maxRetries = Math.max(0, Math.min(10, ss.maxRetries || 2));
  const acquire = makeLimiter(Math.max(1, ss.rpm || 20), Math.max(1, ss.burst || 5));

  const queue = [...targets];
  let ok = 0, fail = 0;
  let lastProgressWrite = 0;
  const writeProgress = (p, force) => {
    const now = Date.now();
    if (!force && now - lastProgressWrite < 1500) return Promise.resolve(); // 节流：≤1.5s 内不重复写 KV，省写入配额
    lastProgressWrite = now;
    return env.CONFIG_KV.put("syncState", JSON.stringify(p)).catch(() => {});
  };
  let progress = { phase: "sync", startedAt: Date.now(), total: targets.length, done: 0, ok: 0, fail: 0 };
  await writeProgress(progress, true);
  async function worker() {
    while (queue.length > 0) {
      const { e, i } = queue.shift();
      let done = false;
      for (let a = 0; a <= maxRetries && !done; a++) {
        await acquire();
        try {
          const models = await fetchUpstreamModels(e.baseUrl, (e.apiKeys || [])[0] || "");
          if (models && models.length) { endpoints[i].models = models; done = true; }
        } catch {}
      }
      done ? ok++ : fail++;
      progress = { ...progress, done: ok + fail, ok, fail, current: e.baseUrl };
      writeProgress(progress);
    }
  }
  const ws = [];
  for (let k = 0; k < Math.min(concurrency, targets.length); k++) ws.push(worker());
  await Promise.all(ws);

  // 同步完模型清单后：如果开了 autoSelfTest，「分批测活」——每次 sync 只测一小批(默认 20)，
  // 用 KV.syncCursor 记录本轮进度；Cron 多次触发后跑完整轮，再整体把可用模型按延迟写入兜底池。
  // 优点：每次 sync 的子请求数可控、不会撞 Cloudflare 免费版 50/请求 的子请求限额。
  let fallbackModels = cfg.fallbackModels || [];
  let selfTestSummary = null;
  if (ss.autoSelfTest) {
    // 进入测活前清掉旧的取消信号(避免上一次的影响)
    const syncStartedAt = Date.now();
    try { await env.CONFIG_KV.delete("syncCancel"); } catch {}
    const allModels = new Set();
    endpoints.forEach((e) => (e.models || []).forEach((m) => allModels.add(m)));
    const maxN = Math.max(1, Math.min(500, ss.selfTestMax || 200));
    const allList = Array.from(allModels).slice(0, maxN);
    const tmo = Math.max(2000, Math.min(60000, (ss.selfTestTimeoutMs || 15000)));
    const batchSize = Math.max(5, Math.min(40, ss.selfTestBatchSize || 20));

    let cursor;
    try { const raw = await env.CONFIG_KV.get("syncCursor"); cursor = raw ? JSON.parse(raw) : null; } catch {}
    const sigNow = allList.join("|");
    // 新一轮触发条件：游标不存在 / 上一轮已 done / 模型清单变了
    if (!cursor || cursor.done || cursor.signature !== sigNow) {
      cursor = { startedAt: Date.now(), signature: sigNow, snapshot: allList, offset: 0, alive: [], deadCount: 0, done: false, round: ((cursor && cursor.round) || 0) + 1 };
    }
    const batch = cursor.snapshot.slice(cursor.offset, cursor.offset + batchSize);
    progress = { ...progress, phase: "test", testTotal: cursor.snapshot.length, testDone: cursor.offset, testAlive: cursor.alive.length, testDead: cursor.deadCount, round: cursor.round };
    await writeProgress(progress, true);

    async function probeOne(model) {
      const cands = endpoints.filter((e) => (e.apiKeys || []).length && Array.isArray(e.models) && e.models.includes(model));
      if (!cands.length) return null;
      const order = [...cands].sort(() => Math.random() - 0.5).slice(0, 2); // 最多 2 家(故障转移)
      for (const ep of order) {
        const key = ep.apiKeys[Math.floor(Math.random() * ep.apiKeys.length)];
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), tmo);
        const start = Date.now();
        try {
          const r = await fetch(ep.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
            method: "POST", signal: ctrl.signal,
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: false }),
          });
          clearTimeout(t);
          const lat = Date.now() - start;
          const d = await r.json().catch(() => null);
          if (r.status < 400 && d && !d.error) return { model, lat };
        } catch (e) { clearTimeout(t); }
      }
      return null;
    }

    const tQueue = [...batch];
    let cancelled = false;
    let checkCounter = 0;
    async function checkCancel() {
      try {
        const raw = await env.CONFIG_KV.get("syncCancel");
        if (raw) { const c = JSON.parse(raw); if (c && c.at && c.at >= syncStartedAt) { cancelled = true; } }
      } catch {}
    }
    async function tWorker() {
      while (tQueue.length > 0 && !cancelled) {
        const m = tQueue.shift();
        const res = await probeOne(m);
        if (res) { cursor.alive.push(res); } else { cursor.deadCount++; }
        progress = { ...progress, testDone: cursor.offset + (batch.length - tQueue.length), testAlive: cursor.alive.length, testDead: cursor.deadCount, current: m, round: cursor.round, cancelled };
        writeProgress(progress);
        // 每 4 个完成检查一次取消信号(KV 读不计子请求)
        checkCounter++;
        if (checkCounter % 4 === 0) await checkCancel();
      }
    }
    const tws = []; const testConc = Math.max(1, Math.min(32, ss.selfTestConcurrency || 12));
    for (let k = 0; k < Math.min(testConc, batch.length); k++) tws.push(tWorker());
    await Promise.all(tws);

    // 中断时:只把"已完成的部分"计入 offset,剩余未跑的等下次继续
    const completedInBatch = batch.length - tQueue.length;
    cursor.offset += completedInBatch;
    cursor.cancelled = cancelled || undefined;
    if (!cancelled && cursor.offset >= cursor.snapshot.length) {
      cursor.alive.sort((a, b) => a.lat - b.lat);
      fallbackModels = cursor.alive.map((x) => x.model); // 整轮完成才整体替换兜底池
      cursor.done = true;
      selfTestSummary = { tested: cursor.snapshot.length, alive: cursor.alive.length, dead: cursor.deadCount, capped: allModels.size > cursor.snapshot.length, round: cursor.round, complete: true };
    } else {
      selfTestSummary = { tested: cursor.offset, total: cursor.snapshot.length, alive: cursor.alive.length, dead: cursor.deadCount, round: cursor.round, complete: false, cancelled: cancelled || undefined };
    }
    await env.CONFIG_KV.put("syncCursor", JSON.stringify(cursor));
    // 终止后清掉 cancel 信号,避免影响下次
    if (cancelled) { try { await env.CONFIG_KV.delete("syncCancel"); } catch {} }
  }

  // 写回（保留 syncSettings；fallbackModels 可能被自测刷新）
  await env.CONFIG_KV.put("config", JSON.stringify({ endpoints, fallbackModels, syncSettings: ss }));
  await env.CONFIG_KV.put("syncState", JSON.stringify({
    phase: "done", lastSyncAt: Date.now(), startedAt: progress.startedAt,
    total: targets.length, ok, fail, selfTest: selfTestSummary,
  }));

  return j({ ok: true, total: targets.length, synced: ok, failed: fail, selfTest: selfTestSummary, at: new Date().toISOString() });
}

export const onRequestPost = handle;
export const onRequestGet = handle; // 允许 GET 触发（部分 cron/手动场景方便）
