// POST /v1beta/models/{model}:generateContent  和  /v1beta/models/{model}:predict
// 接收 Gemini 原生图像生成格式，内部转成 OpenAI /images/generations 调上游（你的中转站都支持），
// 再把上游结果转回 Gemini 形状返回。这样一套 Gemini 原生接口能打通所有 OpenAI 兼容上游。
//
// 鉴权（任选其一，值都等于 PROXY_API_KEY）：Authorization: Bearer <key> / 头 x-goog-api-key / 查询串 ?key=
// 选路：按 {model} 路由，模型必须在某站点的模型列表里（与 chat 一致：裸名→列出该模型的站点；含"/"→该组；否则通配站）。

function gj(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
async function loadConfig(env) {
  try {
    const raw = await env.CONFIG_KV.get("config");
    if (!raw) return { endpoints: [] };
    const c = JSON.parse(raw);
    return { endpoints: Array.isArray(c.endpoints) ? c.endpoints : [] };
  } catch { return { endpoints: [] }; }
}
async function loadStats(env) {
  try { const raw = await env.CONFIG_KV.get("stats"); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function pickKey(keys) { return keys[Math.floor(Math.random() * keys.length)]; }
const hasKey = (e) => Array.isArray(e.apiKeys) && e.apiKeys.length > 0;
const listed = (e, m) => Array.isArray(e.models) && e.models.includes(m);
const wildcard = (e) => !(Array.isArray(e.models) && e.models.length);
function normBase(u) { return String(u || "").replace(/\/+$/, "").toLowerCase(); }

function resolveCandidates(cfg, model) {
  // 图像：模型必须在站点模型列表里才路由（不走通配站兜底）
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
  return [first, ...rest, ...(healthy.length ? cold : [])].map((a) => a.ep);
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
const IMG_TIMEOUT = 120000;

// 调上游 OpenAI 图像端点，含多站点故障转移；成功返回解析后的 OpenAI JSON
async function callOpenAIImages(env, cfg, stats, model, openaiBody, updates) {
  const { cands, chosenModel } = resolveCandidates(cfg, model);
  if (!cands.length) return { none: true };
  const ordered = orderCandidates(cands, stats);
  let last = null;
  for (const ep of ordered) {
    const key = pickKey(ep.apiKeys);
    const url = normBase(ep.baseUrl) + "/images/generations";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
    const start = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ ...openaiBody, model: chosenModel }),
      });
      clearTimeout(t);
      const lat = Date.now() - start;
      const text = await r.text();
      if (r.status < 400) {
        updates.push({ baseUrl: ep.baseUrl, ok: true, lat, down: false });
        let json = null; try { json = JSON.parse(text); } catch {}
        return { ep, chosenModel, json };
      }
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat, down: r.status >= 500 || r.status === 429 });
      last = { status: r.status, text };
    } catch (e) {
      clearTimeout(t);
      updates.push({ baseUrl: ep.baseUrl, ok: false, lat: Date.now() - start, down: true });
      last = { status: 502, text: "upstream fetch failed: " + (e.name === "AbortError" ? "timeout" : String(e)) };
    }
  }
  return { fail: true, last };
}

function abToBase64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
// 把 OpenAI 图像响应里的每张图都拿成 base64（b64_json 直接用；只有 url 的就抓下来编码）
async function collectBase64(json) {
  const out = [];
  const arr = (json && Array.isArray(json.data)) ? json.data : [];
  for (const d of arr) {
    if (d && d.b64_json) { out.push(d.b64_json); continue; }
    if (d && d.url) {
      try { const r = await fetch(d.url); out.push(abToBase64(await r.arrayBuffer())); } catch {}
    }
  }
  return out;
}
const AR_TO_SIZE = { "1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792" };

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  // 鉴权：Bearer / x-goog-api-key / ?key=
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const goog = (request.headers.get("x-goog-api-key") || "").trim();
  const qkey = (url.searchParams.get("key") || "").trim();
  const provided = bearer || goog || qkey;
  if (!env.PROXY_API_KEY || provided !== env.PROXY_API_KEY) {
    return gj({ error: { code: 401, message: "Unauthorized", status: "UNAUTHENTICATED" } }, 401);
  }

  // 解析 {model}:{action}
  const seg = Array.isArray(params.path) ? params.path.join("/") : String(params.path || "");
  const ci = seg.lastIndexOf(":");
  if (ci < 0) return gj({ error: { message: "路径需形如 /v1beta/models/<model>:generateContent 或 :predict" } }, 400);
  const model = seg.slice(0, ci).trim();
  const action = seg.slice(ci + 1).trim();
  if (!model) return gj({ error: { message: "缺少模型名" } }, 400);

  let body;
  try { body = await request.json(); } catch { return gj({ error: { message: "请求体不是 JSON" } }, 400); }

  // 按 action 把 Gemini 请求转成 OpenAI 图像请求
  let prompt = "", n = 1, size = "";
  if (action === "generateContent" || action === "streamGenerateContent") {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    prompt = contents.flatMap((c) => (c && Array.isArray(c.parts) ? c.parts : []))
      .map((p) => (p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
    const gc = body.generationConfig || {};
    n = gc.candidateCount || 1;
    const ar = (gc.imageConfig && gc.imageConfig.aspectRatio) || gc.aspectRatio;
    if (ar && AR_TO_SIZE[ar]) size = AR_TO_SIZE[ar];
  } else if (action === "predict") {
    const inst = (Array.isArray(body.instances) ? body.instances : [])[0] || {};
    prompt = String(inst.prompt || inst.text || "");
    const pm = body.parameters || {};
    n = pm.sampleCount || pm.numberOfImages || 1;
    if (pm.aspectRatio && AR_TO_SIZE[pm.aspectRatio]) size = AR_TO_SIZE[pm.aspectRatio];
  } else {
    return gj({ error: { message: `不支持的 action「${action}」，仅支持 generateContent / streamGenerateContent / predict` } }, 400);
  }
  if (!prompt) return gj({ error: { message: "未能从请求中解析出提示词（prompt）" } }, 400);

  const openaiBody = { prompt, n: Math.max(1, Math.min(n, 8)), response_format: "b64_json" };
  if (size) openaiBody.size = size;

  const cfg = await loadConfig(env);
  const stats = await loadStats(env);
  const updates = [];
  const r = await callOpenAIImages(env, cfg, stats, model, openaiBody, updates);
  context.waitUntil(applyStats(env, updates));

  if (r.none) return gj({ error: { code: 404, message: `没有列出图像模型「${model}」的可用站点`, status: "NOT_FOUND" } }, 404);
  if (r.fail) {
    let msg = r.last ? r.last.text : "所有候选站点均失败";
    return gj({ error: { code: r.last ? r.last.status : 502, message: msg, status: "UNAVAILABLE" } }, r.last ? r.last.status : 502);
  }

  const images = await collectBase64(r.json);
  if (!images.length) return gj({ error: { message: "上游未返回图像数据" } }, 502);

  // 转回 Gemini 形状
  if (action === "predict") {
    return new Response(JSON.stringify({ predictions: images.map((b64) => ({ bytesBase64Encoded: b64, mimeType: "image/png" })) }),
      { status: 200, headers: { "Content-Type": "application/json", "X-Upstream": r.ep.baseUrl, "X-Served-Model": r.chosenModel } });
  }
  const out = {
    candidates: images.map((b64, i) => ({
      content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] },
      finishReason: "STOP", index: i,
    })),
    modelVersion: r.chosenModel,
  };
  return new Response(JSON.stringify(out), {
    status: 200, headers: { "Content-Type": "application/json", "X-Upstream": r.ep.baseUrl, "X-Served-Model": r.chosenModel },
  });
}
