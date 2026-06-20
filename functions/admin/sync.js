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
  const writeProgress = (p) => env.CONFIG_KV.put("syncState", JSON.stringify(p)).catch(() => {});
  let progress = { phase: "sync", startedAt: Date.now(), total: targets.length, done: 0, ok: 0, fail: 0 };
  await writeProgress(progress);
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

  // 同步完模型清单后：如果开了 autoSelfTest，用各上游自己的 key 对所有「裸模型名」发小请求测活，
  // 把可用模型按延迟从快到慢写回 fallbackModels。不经过 PROXY_API_KEY、不走自己的 /v1（避免循环）。
  let fallbackModels = cfg.fallbackModels || [];
  let selfTestSummary = null;
  if (ss.autoSelfTest) {
    const allModels = new Set();
    endpoints.forEach((e) => (e.models || []).forEach((m) => allModels.add(m)));
    const maxN = Math.max(1, Math.min(500, ss.selfTestMax || 200));
    const list = Array.from(allModels).slice(0, maxN);
    const tmo = Math.max(2000, Math.min(60000, (ss.selfTestTimeoutMs || 15000)));
    const tQueue = [...list];
    const alive = []; // {model, lat}
    let aOk = 0, aFail = 0;
    progress = { ...progress, phase: "test", testTotal: list.length, testDone: 0, testAlive: 0, testDead: 0 };
    await writeProgress(progress);

    async function probeOne(model) {
      const cands = endpoints.filter((e) => (e.apiKeys || []).length && Array.isArray(e.models) && e.models.includes(model));
      if (!cands.length) return null;
      // 随机挑一个上游测（避免总打同一家被限流；按需也可遍历）
      const ep = cands[Math.floor(Math.random() * cands.length)];
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
        return null;
      } catch (e) { clearTimeout(t); return null; }
    }

    async function tWorker() {
      while (tQueue.length > 0) {
        const m = tQueue.shift();
        await acquire();
        const res = await probeOne(m);
        if (res) { alive.push(res); aOk++; } else { aFail++; }
        progress = { ...progress, phase: "test", testTotal: list.length, testDone: aOk + aFail, testAlive: aOk, testDead: aFail, current: m };
        writeProgress(progress);
      }
    }
    const tws = []; for (let k = 0; k < Math.min(concurrency, list.length); k++) tws.push(tWorker());
    await Promise.all(tws);

    alive.sort((a, b) => a.lat - b.lat);
    fallbackModels = alive.map((x) => x.model); // 自动更新兜底池
    selfTestSummary = { tested: list.length, alive: aOk, dead: aFail, capped: allModels.size > list.length };
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
