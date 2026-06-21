// POST /admin/ping —— 连通测试。
// 请求体 { baseUrl, apiKey }，探测 {baseUrl}/models，返回 { ok, status, ms }。
// 管理员令牌鉴权。用当前表单里的值即可测，不必先保存。

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

export async function onRequestPost({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return j({ error: "Invalid JSON" }, 400);
  }

  const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(body.apiKey || "").trim();
  if (!baseUrl) return j({ ok: false, error: "缺少 baseUrl" }, 400);

  const url = baseUrl + "/models";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const start = Date.now();
  try {
    const r = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return j({ ok: r.ok, status: r.status, ms: Date.now() - start });
  } catch (e) {
    clearTimeout(timer);
    return j({ ok: false, error: String(e), ms: Date.now() - start });
  }
}
