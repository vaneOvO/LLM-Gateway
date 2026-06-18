// /admin/config —— 读写上游站点配置（存在 KV: CONFIG_KV，key = "config"）。
// 用请求头 X-Admin-Token 与环境变量 ADMIN_TOKEN 比对鉴权。

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
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  if (!env.CONFIG_KV) return j({ error: "未绑定 KV 命名空间 CONFIG_KV" }, 500);
  return j(await loadConfig(env));
}

export async function onRequestPut({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  if (!env.CONFIG_KV) return j({ error: "未绑定 KV 命名空间 CONFIG_KV" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return j({ error: "请求体不是合法 JSON" }, 400);
  }

  const list = Array.isArray(body.endpoints) ? body.endpoints : [];
  const clean = list
    .map((e) => ({
      name: String(e.name || "").trim(),
      baseUrl: String(e.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKeys: (Array.isArray(e.apiKeys) ? e.apiKeys : [])
        .map((k) => String(k).trim())
        .filter(Boolean),
      models: (Array.isArray(e.models) ? e.models : [])
        .map((m) => String(m).trim())
        .filter(Boolean),
    }))
    .filter((e) => e.baseUrl);   // 只要求 Base URL；站点名可留空（仅作标签，不参与按模型名的自动选路）

  // name 不允许含 "/"（否则会和 model 路由冲突）。允许同名——同名即视为一个「组」，
  // 调用 组名/模型名 时网关会在该组里按延迟选最优上游并故障转移。
  for (const e of clean) {
    if (e.name.includes("/")) return j({ error: `站点名不能含 "/"：${e.name}` }, 400);
  }

  await env.CONFIG_KV.put("config", JSON.stringify({ endpoints: clean }));
  return j({ ok: true, endpoints: clean });
}
