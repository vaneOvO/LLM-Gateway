// GET /v1/models —— 列出可用模型。
// 同时给出两种 id：
//   "站点名/模型名"（指定上游）和 "模型名"（自动路由，去重）。
// 用 Authorization: Bearer <PROXY_API_KEY> 鉴权。

function j(data, status = 200) {
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

export async function onRequestGet({ request, env }) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.PROXY_API_KEY || auth !== `Bearer ${env.PROXY_API_KEY}`) {
    return j({ error: "Unauthorized" }, 401);
  }
  const cfg = await loadConfig(env);
  const seen = new Set();
  const data = [];
  for (const ep of cfg.endpoints) {
    for (const m of ep.models || []) {
      if (seen.has(m)) continue;   // 跨所有上游按裸模型名去重
      seen.add(m);
      data.push({ id: m, object: "model", owned_by: "gateway" });
    }
  }
  return j({ object: "list", data });
}
