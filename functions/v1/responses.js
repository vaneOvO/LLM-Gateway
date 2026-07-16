// POST /v1/responses  —— OpenAI Responses API（透传，复用 chat 的路由/故障转移/兜底/流式/超时/错误体识别/最近调用记录）
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

// 4xx（408/425/429 除外）与正文明显是上下文超限的错误 → 直接透传，不冷却、不降级。
const RETRYABLE_4XX = new Set([408, 425, 429]);
function looksContextError(t) {
  return /context[_\s-]*length|context window|maximum context|max(?:imum)?[_\s-]*tokens|too many tokens|reduce the length|prompt is too long|input is too long|string too long|exceed[^\n]{0,48}(?:context|token|length)|上下文|请求(?:体|内容)?过长|token\s*数(?:超|过)/i.test(String(t || ""));
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

const KIND = "responses";
// 最近调用记录：内存缓冲 + 写入节流，折进 stats 的同一次写入里，不额外增加 KV 写入。
let __lastStatWrite = 0;
let __pendingRecent = [];
const RECENT_MAX = 20;

async function applyStats(env, updates, opts) {
  const recent = opts && opts.recent;
  if (recent) __pendingRecent.push(recent);
  if (!updates.length && !recent) return;
  // 钉死/测活请求(force)不记不写：既不污染真实延迟，也省 KV 写入配额
  if (opts && opts.forced) return;
  const hasFailure = updates.some((u) => u.down);
  const now = Date.now();
  // 仅在“有失败(需刷新冷却)”或“距上次写 ≥4s”时才真正写 KV，其余只在内存缓冲，避免每请求一写撑爆免费版额度
  if (!hasFailure && now - __lastStatWrite < 4000) return;
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
      merged.sort((a, b) => (b.t || 0) - (a.t || 0)); // 新的在前
      s.__recent = merged.slice(0, RECENT_MAX);
      __pendingRecent = [];
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

// 有些上游会返回 HTTP 200，但正文其实是错误（这些免费中转很常见）。识别出来以便继续故障转移。
// 返回 { ok:true, stream?, text?, ct } 或 { ok:false, status, errText }
async function passOrFail(resp) {
  const ct = resp.headers.get("Content-Type") || "";
  if (ct.includes("text/event-stream")) {
    // 流式：偷看第一块；若在出现正文内容之前就带 error，判为失败；否则把第一块 + 剩余重新拼成流
    const reader = resp.body.getReader();
    let first;
    try { first = await reader.read(); } catch { return { ok: false, status: 502, errText: "" }; }
    if (first.done) return { ok: false, status: 502, errText: "" };
    const head = new TextDecoder().decode(first.value).slice(0, 1200);
    const looksError = /"error"\s*[:=]/.test(head) &&
      !/"choices"|"delta"|"content_block"|"message_start"|"output_text"|"content"\s*:/.test(head);
    if (looksError) { try { reader.cancel(); } catch {} return { ok: false, status: 502, errText: head }; }
    const firstChunk = first.value;
    const stream = new ReadableStream({
      start(c) { c.enqueue(firstChunk); },
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (done) { c.close(); return; }
          c.enqueue(value);
        } catch { try { c.close(); } catch {} }
      },
      cancel(reason) { try { reader.cancel(reason); } catch {} },
    });
    return { ok: true, stream, ct };
  }
  // 非流式：整体读出；若是"只有 error、没有任何内容字段"的体，判为失败
  let text;
  try { text = await resp.text(); } catch { return { ok: false, status: 502, errText: "" }; }
  try {
    const jj = JSON.parse(text);
    if (jj && jj.error && !jj.choices && !jj.content && !jj.output && !jj.output_text && !jj.data && !jj.candidates) {
      return { ok: false, status: 502, errText: text.slice(0, 400) };
    }
  } catch { /* 非 JSON：原样透传 */ }
  return { ok: true, text, ct };
}

// 尝试一个 model：在其候选上游间做故障转移。
// 加了回源超时（流式 30s 到头、非流式 120s 全程）与"200 但错误体"识别。
async function tryModel(env, cfg, stats, model, body, updates, force) {
  const { cands, chosenModel } = resolveCandidates(cfg, model, force);
  if (!cands.length) return { none: true };
  const ordered = orderCandidates(cands, stats);
  const upstreamBody = JSON.stringify({ ...body, model: chosenModel });
  // 重型模型（多智能体/heavy/expert/xhigh 等）首字节可能很慢：流式首字节超时放宽到 90s，避免被误判失败而降级
  const heavy = /multi-agent|heavy|expert|xhigh|x-high|reasoning|thinking|deep-?research/i.test(String(chosenModel || model));
  const timeoutMs = body && body.stream ? (heavy ? 90000 : 30000) : 120000;
  let last = null;
  for (const ep of ordered) {
    const key = pickKey(ep.apiKeys);
    const url = ep.baseUrl.replace(/\/+$/, "") + "/responses";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const start = Date.now();
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: upstreamBody,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat: Date.now() - start, down: true });
      last = { status: 504, text: JSON.stringify({ error: { message: "上游超时或连接失败：" + (err && err.name === "AbortError" ? "timeout" : String(err)).slice(0, 120) } }) };
      continue;
    }
    clearTimeout(timer);
    const lat = Date.now() - start;
    if (resp.status < 400) {
      const pf = await passOrFail(resp);
      if (pf.ok) {
        updates.push({ baseUrl: ep.baseUrl, ok: true, lat });
        return { ok: true, ep, chosenModel, status: resp.status, ct: pf.ct, stream: pf.stream, text: pf.text, lat };
      }
      if (looksContextError(pf.errText)) {
        updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: false });
        return { clientError: true, status: 400, text: pf.errText || JSON.stringify({ error: { message: "上下文超限" } }), ct: "application/json", ep, chosenModel };
      }
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: true });
      last = { status: pf.status || 502, text: pf.errText || JSON.stringify({ error: { message: "上游返回了错误正文" } }) };
    } else {
      const t = await resp.text().catch(() => "");
      const is4xx = resp.status >= 400 && resp.status < 500;
      if ((is4xx && !RETRYABLE_4XX.has(resp.status)) || looksContextError(t)) {
        updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: false });
        return { clientError: true, status: resp.status, text: t, ct: resp.headers.get("Content-Type") || "application/json", ep, chosenModel };
      }
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: true });
      last = { status: resp.status, text: t };
    }
  }
  return { ok: false, last };
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

  // 尝试顺序：先请求的模型，再依次是配置里的兜底模型（去重、去掉与请求相同的）；
  // 钉死模式(force)与「显式站点名(model 含 "/")」都只试该模型本身，不跨模型降级。
  const pinned = !!force || model.includes("/");
  const tryList = [];
  const seen = new Set();
  const source = pinned ? [model] : [model, ...(cfg.fallbackModels || [])];
  for (const m of source) {
    const mm = String(m || "").trim();
    if (mm && !seen.has(mm)) { seen.add(mm); tryList.push(mm); }
  }

  const updates = [];
  let last = null;
  let anyCandidates = false;

  for (const m of tryList) {
    const r = await tryModel(env, cfg, stats, m, body, updates, force);
    if (r.none) continue;              // 没有列出该模型的上游 → 试下一个兜底
    anyCandidates = true;
    if (r.clientError) {
      // 客户端错误（上下文超限 / 参数非法）：直接透传，不冷却、不降级。
      context.waitUntil(applyStats(env, updates, { forced: !!force }));
      const headers = new Headers();
      headers.set("Content-Type", r.ct || "application/json");
      if (r.ep) headers.set("X-Upstream", r.ep.baseUrl);
      if (r.chosenModel) headers.set("X-Served-Model", r.chosenModel);
      headers.set("X-Client-Error", "1");
      return new Response(r.text || "", { status: r.status, headers });
    }
    if (r.ok) {
      const recent = force ? null : { t: Date.now(), m: r.chosenModel, u: r.ep.baseUrl, s: r.status, ms: r.lat, k: KIND };
      if (recent && m !== model) recent.r = model; // 记录降级来源
      context.waitUntil(applyStats(env, updates, { forced: !!force, recent }));
      const headers = new Headers();
      if (r.ct) headers.set("Content-Type", r.ct);
      headers.set("X-Upstream", r.ep.baseUrl);
      headers.set("X-Served-Model", r.chosenModel);
      if (m !== model) headers.set("X-Fallback-From", model); // 发生了降级
      return new Response(r.stream || r.text || "", { status: r.status, headers });
    }
    if (r.last) last = r.last;         // 该模型所有上游都失败 → 试下一个兜底
  }

  // 全部（含兜底）都失败
  context.waitUntil(applyStats(env, updates, { forced: !!force }));
  if (!anyCandidates) return j({ error: `没有列出模型 '${model}' 或其兜底模型的可用上游` }, 404);
  if (last) return new Response(last.text || "", { status: last.status, headers: { "Content-Type": "application/json" } });
  return j({ error: `模型 '${model}' 及兜底模型均不可用` }, 502);
}
