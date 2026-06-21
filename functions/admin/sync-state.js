// GET /admin/sync-state —— 同步进度快照（供面板轮询）
function j(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } }); }
function adminOk(req, env) { return Boolean(env.ADMIN_TOKEN) && (req.headers.get("X-Admin-Token") || "") === env.ADMIN_TOKEN; }

export async function onRequestGet({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  try {
    const stateRaw = await env.CONFIG_KV.get("syncState");
    const cursorRaw = await env.CONFIG_KV.get("syncCursor");
    return j({
      state: stateRaw ? JSON.parse(stateRaw) : {},
      cursor: cursorRaw ? JSON.parse(cursorRaw) : null,
    });
  } catch (e) { return j({ error: String(e) }, 500); }
}
