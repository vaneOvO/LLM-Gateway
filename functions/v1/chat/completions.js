// POST /v1/chat/completions
// 鉴权：Authorization: Bearer <PROXY_API_KEY>
//
// 选路（按优先级）：
//   1) 裸模型名：model 直接写 "gemini-3.5-flash" → 所有「列出了该模型」的上游都是候选；
//   2) 显式分组：若没有上游列出该完整字符串，且含 "/"，按 "组名/模型名" 解析，
//      在该组里找列出该模型(或通配)的上游；
//   3) 通配兜底：再没有，就用「模型列表留空」的上游(通配任意模型)当候选。
// 候选里：未冷却的优先；首选用「按 1/延迟 加权随机」(既偏向低延迟又分摊负载)；
//   失败(连接错误或非 2xx)自动切下一个，失败的上游冷却 30 秒。
// 计数/延迟：响应后用 waitUntil 按 baseUrl 写进 KV "stats"。

function j(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
async function loadConfig(env) {
  try { const raw = await env.CONFIG_KV.get("config"); if (!raw) return { endpoints: [] };
    const c = JSON.parse(raw); return { endpoints: Array.isArray(c.endpoints) ? c.endpoints : [] };
  } catch { return { endpoints: [] }; }
}
async function loadStats(env) {
  try { const raw = await env.CONFIG_KV.get("stats"); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function pickKey(keys) { return keys[Math.floor(Math.random() * keys.length)]; }
const hasKey = (e) => Array.isArray(e.apiKeys) && e.apiKeys.length > 0;
const listed = (e, m) => Array.isArray(e.models) && e.models.includes(m);
const wildcard = (e) => !(Array.isArray(e.models) && e.models.length);

// 加权随机：weight = 1/延迟，越快被选中概率越高，同时把负载分摊到各家
function weightedPick(pool) {
  const w = pool.map((a) => 1 / Math.max(a.lat, 1));
  const sum = w.reduce((x, y) => x + y, 0);
  let r = Math.random() * sum;
  for (let k = 0; k < pool.length; k++) { r -= w[k]; if (r <= 0) return pool[k]; }
  return pool[pool.length - 1];
}
// 返回尝试顺序：首选加权随机，其余按延迟升序；全部冷却时也照试
function orderCandidates(cands, stats) {
  const now = Date.now();
  const ann = cands.map((ep) => {
    const s = stats[ep.baseUrl] || {};
    return { ep, down: (s.downUntil || 0) > now, lat: typeof s.latMs === "number" ? s.latMs : 1000 };
  });
  const healthy = ann.filter((a) => !a.down);
  const cold = ann.filter((a) => a.down).sort((a, b) => a.lat - b.lat);
  const pool = healthy.length ? healthy : cold;
  if (!pool.length) return [];
  const first = weightedPick(pool);
  const rest = pool.filter((a) => a !== first).sort((a, b) => a.lat - b.lat);
  const tail = healthy.length ? cold : [];
  return [first, ...rest, ...tail].map((a) => a.ep);
}

async function applyStats(env, updates) {
  if (!updates.length) return;
  try {
    const raw = await env.CONFIG_KV.get("stats");
    const s = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const u of updates) {
      const e = s[u.baseUrl] || { total: 0, ok: 0, err: 0, lastUsed: null, latMs: null, downUntil: 0 };
      e.total++; u.ok ? e.ok++ : e.err++;
      e.lastUsed = new Date().toISOString();
      if (typeof u.lat === "number") e.latMs = e.latMs == null ? u.lat : Math.round(e.latMs * 0.7 + u.lat * 0.3);
      e.downUntil = u.down ? now + 30000 : 0;
      s[u.baseUrl] = e;
    }
    await env.CONFIG_KV.put("stats", JSON.stringify(s));
  } catch {}
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("Authorization") || "";
  if (!env.PROXY_API_KEY || auth !== `Bearer ${env.PROXY_API_KEY}`) return j({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }

  const model = String(body.model || "");
  if (!model) return j({ error: "缺少 model" }, 400);
  const cfg = await loadConfig(env);

  // 1) 裸模型名：全局找列出该模型的上游
  let cands = cfg.endpoints.filter((e) => hasKey(e) && listed(e, model));
  let chosenModel = model;

  // 2) 显式 组名/模型名
  if (!cands.length && model.includes("/")) {
    const i = model.indexOf("/");
    const g = model.slice(0, i), rm = model.slice(i + 1);
    const gc = cfg.endpoints.filter((e) => e.name === g && hasKey(e) && (listed(e, rm) || wildcard(e)));
    if (gc.length) { cands = gc; chosenModel = rm; }
  }

  // 3) 通配兜底
  if (!cands.length) cands = cfg.endpoints.filter((e) => hasKey(e) && wildcard(e));

  if (!cands.length) return j({ error: `没有可用上游提供模型 '${model}'` }, 404);

  const stats = await loadStats(env);
  const ordered = orderCandidates(cands, stats);
  const upstreamBody = JSON.stringify({ ...body, model: chosenModel });

  const updates = [];
  let lastResp = null, lastErr = null;

  for (const ep of ordered) {
    const key = pickKey(ep.apiKeys);
    const url = ep.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const start = Date.now();
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: upstreamBody,
      });
    } catch (err) {
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat: Date.now() - start, down: true });
      lastErr = String(err); continue;
    }
    const lat = Date.now() - start;
    if (resp.status < 400) {
      updates.push({ baseUrl: ep.baseUrl, ok: true, lat });
      context.waitUntil(applyStats(env, updates));
      const headers = new Headers();
      const ct = resp.headers.get("Content-Type"); if (ct) headers.set("Content-Type", ct);
      headers.set("X-Upstream", ep.baseUrl);
      return new Response(resp.body, { status: resp.status, headers });
    } else {
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: true });
      lastResp = resp;
    }
  }

  context.waitUntil(applyStats(env, updates));
  if (lastResp) {
    const headers = new Headers();
    const ct = lastResp.headers.get("Content-Type"); if (ct) headers.set("Content-Type", ct);
    return new Response(lastResp.body, { status: lastResp.status, headers });
  }
  return j({ error: `模型 '${model}' 的所有上游均失败：${lastErr || "未知错误"}` }, 502);
}
