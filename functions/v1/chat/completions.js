// POST /v1/chat/completions
// 鉴权：Authorization: Bearer <PROXY_API_KEY>
//
// 选路（按优先级）：
//   1) 裸模型名：model 直接写 "gemini-3.5-flash" → 所有「列出了该模型」的上游都是候选；
//   2) 显式分组：若没有上游列出该完整字符串，且含 "/"，按 "组名/模型名" 解析；
//   3) 通配兜底：再没有，就用「模型列表留空」的上游(通配任意模型)当候选。
// 候选里：未冷却的优先；首选按 1/延迟 加权随机（低延迟优先 + 负载均衡）；失败自动切下一个，失败上游冷却 30s。
//
// 模型降级/兜底（本次新增）：
//   依次尝试 [请求的模型, ...config.fallbackModels]；
//   只要某个模型在某个上游成功（HTTP < 400）就立即把它的响应（含流式）原样返回，绝不返回错误中断；
//   实际命中：响应头 X-Upstream / X-Served-Model；若发生降级，附 X-Fallback-From=<原请求模型>。
//
// 计数/延迟：响应后用 waitUntil 按 baseUrl 写进 KV "stats"。

function j(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
async function loadConfig(env) {
  try {
    const raw = await env.CONFIG_KV.get("config");
    if (!raw) return { endpoints: [], fallbackModels: [] };
    const c = JSON.parse(raw);
    return {
      endpoints: Array.isArray(c.endpoints) ? c.endpoints : [],
      fallbackModels: Array.isArray(c.fallbackModels) ? c.fallbackModels : [],
    };
  } catch { return { endpoints: [], fallbackModels: [] }; }
}
async function loadStats(env) {
  try { const raw = await env.CONFIG_KV.get("stats"); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function pickKey(keys) { return keys[Math.floor(Math.random() * keys.length)]; }
const hasKey = (e) => Array.isArray(e.apiKeys) && e.apiKeys.length > 0;
const listed = (e, m) => Array.isArray(e.models) && e.models.includes(m);
const wildcard = (e) => !(Array.isArray(e.models) && e.models.length);

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

async function applyStats(env, updates, opts) {
  if (!updates.length) return;
  // 钉死/测活请求(force)不写 stats：既避免污染真实延迟，又省 KV 写入配额（测活是写入大头）
  if (opts && opts.forced) return;
  // 普通请求：仅在“有失败需记录冷却”或抽样命中(~8%)时才写，避免每请求一写撑爆免费版每日写入额度
  const hasFailure = updates.some((u) => u.down);
  if (!hasFailure && Math.random() > 0.08) return;
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

// 解析某个 model 的候选上游 + 实际下发给上游的模型名
function normBase(u) { return String(u || "").replace(/\/+$/, "").toLowerCase(); }
function resolveCandidates(cfg, model, force) {
  // 强制指定上游：按 baseUrl 钉死到某个站点（测活用），与站点名无关，绝不外溢到别家
  if (force) {
    const f = normBase(force);
    const cands = cfg.endpoints.filter((e) => hasKey(e) && normBase(e.baseUrl) === f);
    const rm = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    return { cands, chosenModel: rm };
  }
  // 显式分组：model="组名/模型名" → 严格只在该组内找(包括该组的 wildcard 站)，
  // 不允许 fall through 到别家通配兜底，避免 "我点 A，结果 B 在答" 的误判。
  if (model.includes("/")) {
    const i = model.indexOf("/");
    const g = model.slice(0, i), rm = model.slice(i + 1);
    const gc = cfg.endpoints.filter((e) => e.name === g && hasKey(e) && (listed(e, rm) || wildcard(e)));
    return { cands: gc, chosenModel: rm };
  }
  // 裸模型名：先找列出该模型的；都没有再走全局通配兜底
  let cands = cfg.endpoints.filter((e) => hasKey(e) && listed(e, model));
  if (!cands.length) cands = cfg.endpoints.filter((e) => hasKey(e) && wildcard(e));
  return { cands, chosenModel: model };
}

// 尝试一个 model：在其候选上游间做故障转移。成功(HTTP<400)→ {ok:true, resp, ep, chosenModel}；否则 {ok:false, resp:最后的错误响应|null}
async function tryModel(env, cfg, stats, model, body, updates, force) {
  const { cands, chosenModel } = resolveCandidates(cfg, model, force);
  if (!cands.length) return { ok: false, resp: null };
  const ordered = orderCandidates(cands, stats);
  const upstreamBody = JSON.stringify({ ...body, model: chosenModel });
  let lastResp = null;
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
      continue;
    }
    const lat = Date.now() - start;
    if (resp.status < 400) {
      updates.push({ baseUrl: ep.baseUrl, ok: true, lat });
      return { ok: true, resp, ep, chosenModel };
    } else {
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: true });
      lastResp = resp;
    }
  }
  return { ok: false, resp: lastResp };
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
  const stats = await loadStats(env);

  // 测活用：钉死到某个上游（按 baseUrl），且不触发兜底降级
  const force = request.headers.get("X-Force-Upstream") || "";

  // 尝试顺序：先请求的模型，再依次是配置里的兜底模型（去重、去掉与请求相同的）；钉死模式只测该模型本身
  const tryList = [];
  const seen = new Set();
  const source = force ? [model] : [model, ...(cfg.fallbackModels || [])];
  for (const m of source) {
    const mm = String(m || "").trim();
    if (mm && !seen.has(mm)) { seen.add(mm); tryList.push(mm); }
  }

  const updates = [];
  let lastResp = null;

  for (const m of tryList) {
    const r = await tryModel(env, cfg, stats, m, body, updates, force);
    if (r.ok) {
      context.waitUntil(applyStats(env, updates, { forced: !!force }));
      const headers = new Headers();
      const ct = r.resp.headers.get("Content-Type"); if (ct) headers.set("Content-Type", ct);
      headers.set("X-Upstream", r.ep.baseUrl);
      headers.set("X-Served-Model", r.chosenModel);
      if (m !== model) headers.set("X-Fallback-From", model); // 发生了降级
      return new Response(r.resp.body, { status: r.resp.status, headers });
    }
    if (r.resp) lastResp = r.resp;
  }

  // 全部（含兜底）都失败
  context.waitUntil(applyStats(env, updates, { forced: !!force }));
  if (lastResp) {
    const headers = new Headers();
    const ct = lastResp.headers.get("Content-Type"); if (ct) headers.set("Content-Type", ct);
    return new Response(lastResp.body, { status: lastResp.status, headers });
  }
  return j({ error: `模型 '${model}' 及兜底模型均不可用` }, 502);
}
