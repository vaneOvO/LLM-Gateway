// GET /v1/models —— 返回所有已配置的模型，id 形如 "站点名/模型名"。
// 用 Authorization: Bearer <PROXY_API_KEY> 鉴权。

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

export async function onRequestGet({ request, env }) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.PROXY_API_KEY || auth !== `Bearer ${env.PROXY_API_KEY}`) {
    return j({ error: "Unauthorized" }, 401);
  }
  const cfg = await loadConfig(env);
  const data = [];
  for (const ep of cfg.endpoints) {
    for (const m of ep.models || []) {
      data.push({ id: `${ep.name}/${m}`, object: "model", owned_by: ep.name });
    }
  }
  return j({ object: "list", data });
}
