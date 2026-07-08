// 给所有响应加 CORS 头，并处理 OPTIONS 预检。
// 这样 /v1 接口可被外部工具/SDK 跨域调用；/admin 同源也无妨。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Admin-Token,x-goog-api-key,X-Force-Upstream,x-api-key,anthropic-version",
  "Access-Control-Expose-Headers": "X-Upstream,X-Served-Model,X-Fallback-From",
  "Access-Control-Max-Age": "86400",
};

export async function onRequest(context) {
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  const res = await context.next();
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}
