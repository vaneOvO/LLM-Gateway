// POST /v1/images/generations  —— OpenAI 兼容的图像生成
// 鉴权：Authorization: Bearer <PROXY_API_KEY>
// 选路：与 /v1/chat/completions 完全一致（按模型名路由 + 多站点故障转移 + X-Force-Upstream 钉死）。
//   模型必须在某个站点的「模型列表」里才会被路由（裸名→列出该模型的站点；"组名/模型"→该组；都没有→通配站）。
// 透传：把上游 /images/generations 的响应（JSON，含 url 或 b64_json）原样返回；命中站点见响应头 X-Upstream。
// 图像生成较慢，单次上游超时放宽到 120s。

function j(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
// 把上游错误体清洗成简洁 JSON：JSON 原样；HTML/纯文本(如 Cloudflare 524 页)去标签压空白截断，附状态提示
function cleanErr(status, text) {
  const t = (text || "").trim();
  if (t.startsWith("{") || t.startsWith("[")) { try { JSON.parse(t); return t; } catch {} }
  const snippet = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  const hint = (status === 524 || status === 504 || status === 522) ? "上游超时（该模型在上游可能不可用或过慢）"
    : status === 404 ? "上游称该模型不存在"
    : status >= 500 ? "上游服务错误" : "上游返回错误";
  return JSON.stringify({ error: { message: hint + "（HTTP " + status + "）" + (snippet ? "：" + snippet : ""), type: "upstream_error", code: status } });
}
async function loadConfig(env) {
  try {
    const raw = await env.CONFIG_KV.get("config");
    if (!raw) return { endpoints: [], imageFallbackModels: [] };
    const c = JSON.parse(raw);
    return {
      endpoints: Array.isArray(c.endpoints) ? c.endpoints : [],
      imageFallbackModels: Array.isArray(c.imageFallbackModels) ? c.imageFallbackModels : [],
    };
  } catch { return { endpoints: [], imageFallbackModels: [] }; }
}
async function loadStats(env) {
  try { const raw = await env.CONFIG_KV.get("stats"); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function pickKey(keys) { return keys[Math.floor(Math.random() * keys.length)]; }
const hasKey = (e) => Array.isArray(e.apiKeys) && e.apiKeys.length > 0;
const listed = (e, m) => Array.isArray(e.models) && e.models.includes(m);
const wildcard = (e) => !(Array.isArray(e.models) && e.models.length);
function normBase(u) { return String(u || "").replace(/\/+$/, "").toLowerCase(); }

function resolveCandidates(cfg, model, force) {
  if (force) {
    const f = normBase(force);
    const cands = cfg.endpoints.filter((e) => hasKey(e) && normBase(e.baseUrl) === f);
    const rm = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    return { cands, chosenModel: rm };
  }
  // 图像：模型必须在站点的模型列表里才路由（不走通配站兜底，避免发到只供文本的站）
  if (model.includes("/")) {
    const i = model.indexOf("/");
    const g = model.slice(0, i), rm = model.slice(i + 1);
    return { cands: cfg.endpoints.filter((e) => e.name === g && hasKey(e) && listed(e, rm)), chosenModel: rm };
  }
  return { cands: cfg.endpoints.filter((e) => hasKey(e) && listed(e, model)), chosenModel: model };
}

function weightedPick(pool) {
  const w = pool.map((a) => 1 / Math.max(a.lat, 1));
  const sum = w.reduce((x, y) => x + y, 0);
  let r = Math.random() * sum;
  for (let k = 0; k < pool.length; k++) { r -= w[k]; if (r <= 0) return pool[k]; }
  return pool[pool.length - 1];
}
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
const KIND = "image";
let __lastStatWrite = 0;
let __pendingRecent = [];
const RECENT_MAX = 20;
async function applyStats(env, updates, opts) {
  const recent = opts && opts.recent;
  if (recent) __pendingRecent.push(recent);
  if (!updates.length && !recent) return;
  if (opts && opts.forced) return; // 测活/钉死不记不写
  const hasFailure = updates.some((u) => u.down);
  const now = Date.now();
  if (!hasFailure && now - __lastStatWrite < 4000) return; // 节流：仅失败或距上次写 ≥4s 才写，其余内存缓冲
  __lastStatWrite = now;
  try {
    const raw = await env.CONFIG_KV.get("stats");
    const s = raw ? JSON.parse(raw) : {};
    for (const u of updates) {
      const e = s[u.baseUrl] || { total: 0, ok: 0, err: 0, lastUsed: null, latMs: null, downUntil: 0 };
      e.total++; u.ok ? e.ok++ : e.err++;
      e.lastUsed = new Date().toISOString();
      if (typeof u.lat === "number") e.latMs = e.latMs == null ? u.lat : Math.round(e.latMs * 0.7 + u.lat * 0.3);
      e.downUntil = u.down ? now + 30000 : 0;
      s[u.baseUrl] = e;
    }
    if (__pendingRecent.length) {
      const prev = Array.isArray(s.__recent) ? s.__recent : [];
      const merged = [...__pendingRecent, ...prev];
      merged.sort((a, b) => (b.t || 0) - (a.t || 0));
      s.__recent = merged.slice(0, RECENT_MAX);
      __pendingRecent = [];
    }
    await env.CONFIG_KV.put("stats", JSON.stringify(s));
  } catch {}
}

const IMG_TIMEOUT = 60000;

// 试某个模型在所有候选站点上的图像生成；成功（HTTP<400）即返回 {resp, ep}
async function tryImage(env, cfg, stats, model, body, updates, force) {
  const { cands, chosenModel } = resolveCandidates(cfg, model, force);
  if (!cands.length) return { none: true };
  const ordered = orderCandidates(cands, stats);
  let last = null;
  for (const ep of ordered) {
    const key = pickKey(ep.apiKeys);
    const url = normBase(ep.baseUrl) + "/images/generations";
    const payload = { ...body, model: chosenModel };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
    const start = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      clearTimeout(t);
      const lat = Date.now() - start;
      const text = await r.text();
      if (r.status < 400) {
        updates.push({ baseUrl: ep.baseUrl, ok: true, lat, down: false });
        return { resp: { status: r.status, text, ct: r.headers.get("content-type") || "application/json" }, ep, chosenModel };
      }
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: r.status >= 500 || r.status === 429 });
      last = { status: r.status, text: cleanErr(r.status, text) };
    } catch (e) {
      clearTimeout(t);
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat: Date.now() - start, down: true });
      last = { status: 502, text: JSON.stringify({ error: { message: "upstream fetch failed: " + (e.name === "AbortError" ? "timeout" : String(e)) } }) };
    }
  }
  return { fail: true, last };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!env.PROXY_API_KEY || token !== env.PROXY_API_KEY) return j({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return j({ error: { message: "请求体不是 JSON" } }, 400); }
  const model = (body && body.model ? String(body.model) : "").trim();
  if (!model) return j({ error: { message: "缺少 model 字段" } }, 400);

  const cfg = await loadConfig(env);
  const stats = await loadStats(env);
  const force = request.headers.get("X-Force-Upstream") || "";
  const updates = [];

  // 尝试顺序：先请求的图像模型，再依次是 imageFallbackModels（去重）；
  // 钉死模式(force)与「显式站点名(model 含 "/")」都只试该模型本身，不跨模型降级。
  const pinned = !!force || model.includes("/");
  const tryList = [];
  const seen = new Set();
  const source = pinned ? [model] : [model, ...(cfg.imageFallbackModels || [])];
  for (const m of source) { const mm = String(m || "").trim(); if (mm && !seen.has(mm)) { seen.add(mm); tryList.push(mm); } }

  let served = null, anyCandidates = false, last = null;
  for (const m of tryList) {
    const r = await tryImage(env, cfg, stats, m, body, updates, force);
    if (r.none) continue;                 // 没有站点列出这个图像模型 → 试下一个兜底
    anyCandidates = true;
    if (r.resp) { served = { resp: r.resp, ep: r.ep, chosenModel: r.chosenModel, model: m }; break; }
    last = r.last;                         // 这个模型所有站点都失败 → 试下一个兜底
  }
  let recent = null;
  if (served && !force) {
    const okU = [...updates].reverse().find((u) => u.ok);
    recent = { t: Date.now(), m: served.chosenModel, u: served.ep.baseUrl, s: served.resp.status, ms: okU ? okU.lat : undefined, k: KIND };
    if (served.model !== model) recent.r = model;
  }
  context.waitUntil(applyStats(env, updates, { forced: !!force, recent }));

  if (served) {
    const headers = { "Content-Type": served.resp.ct, "X-Upstream": served.ep.baseUrl, "X-Served-Model": served.chosenModel };
    if (served.model !== model) headers["X-Fallback-From"] = model;   // 发生了图像兜底
    return new Response(served.resp.text, { status: served.resp.status, headers });
  }
  if (!anyCandidates) return j({ error: { message: `没有列出图像模型「${model}」或其兜底模型的可用站点（请确认模型在某站点的模型列表里且已填 key）` } }, 404);
  return new Response(last ? last.text : JSON.stringify({ error: { message: "所有候选站点（含兜底模型）均失败" } }), {
    status: last ? last.status : 502, headers: { "Content-Type": "application/json" },
  });
}
