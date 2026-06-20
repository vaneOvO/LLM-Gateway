// POST/DELETE /admin/sync-cancel —— 请求终止当前正在跑的同步/测活
// 实现：写一个 syncCancel 时间戳;sync.js 的 tWorker 在每完成几个 model 后读 KV.syncCancel,
// 若其 at > 本次 sync 的 startedAt,就 break 整轮,把 cursor 标 cancelled=true 保留进度。
function j(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } }); }
function adminOk(req, env) { return Boolean(env.ADMIN_TOKEN) && (req.headers.get("X-Admin-Token") || "") === env.ADMIN_TOKEN; }

async function handle({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  try {
    await env.CONFIG_KV.put("syncCancel", JSON.stringify({ at: Date.now() }));
    return j({ ok: true, at: Date.now() });
  } catch (e) { return j({ error: String(e) }, 500); }
}
export const onRequestPost = handle;
export const onRequestDelete = handle;
