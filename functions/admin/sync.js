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
    }
  }
  const ws = [];
  for (let k = 0; k < Math.min(concurrency, targets.length); k++) ws.push(worker());
  await Promise.all(ws);

  // 写回（保留 fallbackModels / syncSettings）
  await env.CONFIG_KV.put("config", JSON.stringify({ endpoints, fallbackModels: cfg.fallbackModels || [], syncSettings: ss }));
  await env.CONFIG_KV.put("syncState", JSON.stringify({ lastSyncAt: Date.now(), ok, fail, total: targets.length }));

  return j({ ok: true, total: targets.length, synced: ok, failed: fail, at: new Date().toISOString() });
}

export const onRequestPost = handle;
export const onRequestGet = handle; // 允许 GET 触发（部分 cron/手动场景方便）
