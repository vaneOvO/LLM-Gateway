// POST /admin/upstream-models —— 拉取某个上游的可用模型列表。
// 请求体 { baseUrl, apiKey }，请求 {baseUrl}/models，解析出模型 id 列表返回。
// 管理员令牌鉴权。用当前表单里的值即可，不必先保存。

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

  // 诊断：Cloudflare Workers 出站 fetch 只允许一批端口，且明文 http 到裸 IP 常被就地拦截（表现为 ~1ms 就返回错误）
  const ALLOWED_HTTP = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  const ALLOWED_HTTPS = [443, 8443, 2053, 2083, 2087, 2096];
  function portHint(u) {
    try {
      const x = new URL(u);
      const isHttps = x.protocol === "https:";
      const port = x.port ? Number(x.port) : (isHttps ? 443 : 80);
      const allowed = isHttps ? ALLOWED_HTTPS : ALLOWED_HTTP;
      const badPort = !allowed.includes(port);
      const rawIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(x.hostname);
      if (badPort || (!isHttps && rawIp)) {
        return `疑似 Cloudflare 出站限制：Workers 只允许出站到特定端口（http:${ALLOWED_HTTP.join("/")}；https:${ALLOWED_HTTPS.join("/")}），且明文 http 到裸 IP 常被拦。建议给上游套 HTTPS 域名（如 Cloudflare Tunnel）用 443，或改用被允许的端口（如 8080）。`;
      }
    } catch {}
    return "";
  }

  const url = baseUrl + "/models";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const start = Date.now();
  try {
    const r = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    let raw = null;
    try {
      raw = await r.json();
    } catch {
      /* 上游返回的不是 JSON */
    }

    // 兼容几种返回结构：{data:[{id}]} / {models:[...]} / 直接是数组
    let arr = [];
    if (raw) {
      if (Array.isArray(raw.data)) arr = raw.data;
      else if (Array.isArray(raw.models)) arr = raw.models;
      else if (Array.isArray(raw)) arr = raw;
    }
    const models = arr
      .map((m) => (typeof m === "string" ? m : (m && (m.id || m.name || m.model))))
      .filter(Boolean);

    const ms = Date.now() - start;
    return j({ ok: r.ok, status: r.status, ms, count: models.length, models, hint: r.ok ? "" : portHint(baseUrl) });
  } catch (e) {
    clearTimeout(timer);
    return j({ ok: false, error: String(e), ms: Date.now() - start, hint: portHint(baseUrl) });
  }
}
