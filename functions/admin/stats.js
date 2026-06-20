// /admin/stats —— 读取(GET)/清零(DELETE) 按站点的请求计数。
// 管理员令牌(X-Admin-Token == ADMIN_TOKEN)鉴权。

function j(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adminOk(request, env) {
  const t = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.ADMIN_TOKEN) && t === env.ADMIN_TOKEN;
}

export async function onRequestGet({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  try {
    const raw = await env.CONFIG_KV.get("stats");
    return j({ stats: raw ? JSON.parse(raw) : {} });
  } catch {
    return j({ stats: {} });
  }
}

export async function onRequestDelete({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  await env.CONFIG_KV.put("stats", "{}");
  return j({ ok: true });
}
