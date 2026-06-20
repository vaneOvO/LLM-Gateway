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
    if (!raw) return { endpoints: [], fallbackModels: [] };
    const c = JSON.parse(raw);
    return {
      endpoints: Array.isArray(c.endpoints) ? c.endpoints : [],
      fallbackModels: Array.isArray(c.fallbackModels) ? c.fallbackModels : [],
      syncSettings: (c.syncSettings && typeof c.syncSettings === "object") ? c.syncSettings : {},
    };
  } catch {
    return { endpoints: [], fallbackModels: [], syncSettings: {} };
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

  // 兜底/降级模型（按顺序尝试）：当请求的模型整组上游都不可用时，自动改用这些
  const fallbackModels = (Array.isArray(body.fallbackModels) ? body.fallbackModels : [])
    .map((m) => String(m).trim())
    .filter(Boolean);

  // 模型列表同步设置（前端用浏览器定时器执行；这里仅持久化）
  const ss = (body.syncSettings && typeof body.syncSettings === "object") ? body.syncSettings : {};
  const num = (v, def, min, max) => {
    let n = Number(v); if (!Number.isFinite(n)) n = def;
    if (typeof min === "number") n = Math.max(min, n);
    if (typeof max === "number") n = Math.min(max, n);
    return n;
  };
  const syncSettings = {
    enabled: !!ss.enabled,
    intervalHours: num(ss.intervalHours, 6, 1, 720),
    concurrency: num(ss.concurrency, 2, 1, 10),
    maxRetries: num(ss.maxRetries, 2, 0, 10),
    rpm: num(ss.rpm, 20, 1, 600),
    burst: num(ss.burst, 5, 1, 100),
    autoSelfTest: !!ss.autoSelfTest,
    selfTestMax: num(ss.selfTestMax, 200, 1, 500),
    selfTestTimeoutMs: num(ss.selfTestTimeoutMs, 15000, 2000, 60000),
    selfTestConcurrency: num(ss.selfTestConcurrency, 12, 1, 32),
  };

  await env.CONFIG_KV.put("config", JSON.stringify({ endpoints: clean, fallbackModels, syncSettings }));
  return j({ ok: true, endpoints: clean, fallbackModels, syncSettings });
}
