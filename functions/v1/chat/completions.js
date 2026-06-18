// POST /v1/chat/completions
// 鉴权：Authorization: Bearer <PROXY_API_KEY>
// 路由：model 形如 "站点名/真实模型名"，按站点名找到上游 baseUrl，
//       带上该站点的 key 转发到 {baseUrl}/chat/completions，原样透传响应（支持流式 SSE）。
// 计数：响应返回后用 waitUntil 后台更新 KV 的 "stats"（不给调用加延迟）。

function j(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function loadConfig(env) {
  try {
    const raw = await env.CONFIG_KV.get("config");
    if (!raw) return { endpoints: [] };
    const c = JSON.parse(raw);
    return { endpoints: Array.isArray(c.endpoints) ? c.endpoints : [] };
  } catch {
    return { endpoints: [] };
  }
}

function pickKey(keys) {
  return keys[Math.floor(Math.random() * keys.length)];
}

// 读-改-写更新计数。注意：KV 单键写有 ~1次/秒 的软限制，高并发下可能少计；
// 自用够用，要精确请改用 Durable Objects 或 Analytics Engine（见 README）。
async function bumpStats(env, name, ok) {
  try {
    const raw = await env.CONFIG_KV.get("stats");
    const s = raw ? JSON.parse(raw) : {};
    const e = s[name] || { total: 0, ok: 0, err: 0, lastUsed: null };
    e.total++;
    ok ? e.ok++ : e.err++;
    e.lastUsed = new Date().toISOString();
    s[name] = e;
    await env.CONFIG_KV.put("stats", JSON.stringify(s));
  } catch {
    /* 计数失败不影响主流程 */
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = request.headers.get("Authorization") || "";
  if (!env.PROXY_API_KEY || auth !== `Bearer ${env.PROXY_API_KEY}`) {
    return j({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return j({ error: "Invalid JSON" }, 400);
  }

  const model = String(body.model || "");
  const i = model.indexOf("/");
  if (i < 0) {
    return j({ error: "model 必须形如 '站点名/模型名'，例如 openai/gpt-4o" }, 400);
  }
  const epName = model.slice(0, i);
  const realModel = model.slice(i + 1);

  const cfg = await loadConfig(env);
  const ep = cfg.endpoints.find((e) => e.name === epName);
  if (!ep) return j({ error: `未知站点：'${epName}'` }, 404);
  if (!ep.apiKeys || ep.apiKeys.length === 0) {
    return j({ error: `站点 '${epName}' 没有配置 key` }, 400);
  }

  const key = pickKey(ep.apiKeys);
  const upstreamURL = ep.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  let upstream;
  try {
    upstream = await fetch(upstreamURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ ...body, model: realModel }),
    });
  } catch (err) {
    context.waitUntil(bumpStats(env, epName, false));
    return j({ error: `请求上游失败：${err}` }, 502);
  }

  context.waitUntil(bumpStats(env, epName, upstream.status < 400));

  // 原样透传响应体（JSON 或 text/event-stream 流都适用）
  const headers = new Headers();
  const ct = upstream.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  return new Response(upstream.body, { status: upstream.status, headers });
}
