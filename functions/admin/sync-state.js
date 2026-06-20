// GET /admin/sync-state —— 同步进度快照（供面板轮询）
function j(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } }); }
function adminOk(req, env) { return Boolean(env.ADMIN_TOKEN) && (req.headers.get("X-Admin-Token") || "") === env.ADMIN_TOKEN; }

export async function onRequestGet({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  try {
    const raw = await env.CONFIG_KV.get("syncState");
    return j(raw ? JSON.parse(raw) : {});
  } catch (e) { return j({ error: String(e) }, 500); }
}
