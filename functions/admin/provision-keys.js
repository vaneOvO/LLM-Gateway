// POST /admin/provision-keys —— 用各站点的 access_token 换取真正可用的 sk- 聊天密钥。
// 机制(参考 all-api-hub):new-api 列表 /api/token 返回的 key 中间用 * 打码;检测到打码就调
// 专门的揭示端点 POST /api/token/{id}/key(部分分支用 GET)拿完整 key;new-api 家族 sk- 前缀可选。
// 鉴权(对上游):Authorization: Bearer <access_token> + New-Api-User: <user_id>。
// 鉴权(对本接口):X-Admin-Token == env.ADMIN_TOKEN。
// 入参：{ sites: [{ baseUrl, accessToken, userId, siteType }] }（baseUrl 可带 /v1，会自动取根域调管理接口）
// 出参：{ ok, results: [{ baseUrl, ok, keys?[], group?, tokenName?, error? }] }

function j(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } }); }
function adminOk(req, env) { return Boolean(env.ADMIN_TOKEN) && (req.headers.get("X-Admin-Token") || "") === env.ADMIN_TOKEN; }

function rootOf(u) { let s = String(u || "").trim().replace(/\/+$/, ""); s = s.replace(/\/v1$/i, ""); return s.replace(/\/+$/, ""); }
function isMasked(k) { return /[*•]/.test(String(k || "")); }
function skFmt(k) { k = String(k || "").trim(); return k && !k.startsWith("sk-") ? "sk-" + k : k; }

async function listTokens(root, at, uid) {
  try {
    const r = await fetch(root + "/api/token/?p=0&size=100", { headers: { Authorization: "Bearer " + at, "New-Api-User": String(uid || "") } });
    if (!r.ok) return { ok: false, status: r.status };
    const jd = await r.json().catch(() => null);
    let arr = jd && (Array.isArray(jd.data) ? jd.data : (jd.data && (jd.data.records || jd.data.items)));
    if (!Array.isArray(arr)) arr = [];
    return { ok: true, tokens: arr };
  } catch (e) { return { ok: false, status: -1 }; }
}

async function revealKey(root, id, at, uid) {
  for (const method of ["POST", "GET"]) {
    try {
      const r = await fetch(root + "/api/token/" + id + "/key", { method, headers: { Authorization: "Bearer " + at, "New-Api-User": String(uid || "") } });
      if (!r.ok) continue;
      const jd = await r.json().catch(() => null);
      const k = jd ? ((jd.data && jd.data.key) || jd.key || (typeof jd.data === "string" ? jd.data : null)) : null;
      if (k && !isMasked(k)) return k;
    } catch (e) {}
  }
  return null;
}

async function createToken(root, at, uid) {
  const base = { name: "v", remain_quota: 500000, expired_time: -1, unlimited_quota: true, model_limits_enabled: false, models: "" };
  for (const group of ["auto", "default", null]) {
    try {
      const b = { ...base }; if (group) b.group = group;
      const r = await fetch(root + "/api/token/", { method: "POST", headers: { Authorization: "Bearer " + at, "New-Api-User": String(uid || ""), "Content-Type": "application/json" }, body: JSON.stringify(b) });
      const jd = await r.json().catch(() => null);
      if (r.ok && (!jd || jd.success !== false)) return true;
    } catch (e) {}
  }
  return false;
}

async function provisionOne(site) {
  const root = rootOf(site.baseUrl);
  const at = site.accessToken || "";
  const uid = site.userId || "";
  if (!root || !at) return { baseUrl: site.baseUrl, ok: false, error: "缺少 baseUrl 或 access_token" };

  let lt = await listTokens(root, at, uid);
  if (!lt.ok) return { baseUrl: site.baseUrl, ok: false, error: "列出令牌失败(HTTP " + lt.status + "，可能该 token 不是管理令牌)" };

  const isGeneral = (g) => ["auto", "default", ""].includes(String(g || "").toLowerCase());
  const nameIsV = (n) => String(n || "").trim().toLowerCase() === "v";
  const enabled = lt.tokens.filter((t) => t.status === 1);

  // 优先用你预先建好的、名为 "v" 的令牌
  let chosen = enabled.find((t) => nameIsV(t.name)) || null;

  // 没有 "v" 就新建一个 "v"，再从列表里取它
  if (!chosen) {
    const created = await createToken(root, at, uid);
    if (created) {
      lt = await listTokens(root, at, uid);
      const en2 = (lt.tokens || []).filter((t) => t.status === 1);
      chosen = en2.find((t) => nameIsV(t.name)) || null;
    }
    // 创建失败兜底：用已有的通用令牌 / 任意启用令牌，避免整站失败
    if (!chosen) chosen = enabled.find((t) => isGeneral(t.group)) || enabled[0] || null;
  }
  if (!chosen) return { baseUrl: site.baseUrl, ok: false, error: "无可用令牌且自动创建失败" };

  let key = chosen.key || "";
  if (!key || isMasked(key)) key = (await revealKey(root, chosen.id, at, uid)) || "";
  if (!key || isMasked(key)) return { baseUrl: site.baseUrl, ok: false, error: "无法揭示完整密钥(该分支可能不支持 /api/token/{id}/key)" };

  return { baseUrl: site.baseUrl, ok: true, keys: [skFmt(key)], group: chosen.group || "", tokenName: chosen.name || "" };
}

async function handle({ request, env }) {
  if (!adminOk(request, env)) return j({ error: "管理员令牌无效" }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return j({ error: "请求体不是 JSON" }, 400); }
  const sites = Array.isArray(body.sites) ? body.sites : [];
  if (!sites.length) return j({ error: "没有要处理的站点" }, 400);

  // 并发 3，控制 Cloudflare 子请求数（每站约 2 个：列表 + 揭示）
  const queue = sites.map((s, i) => ({ s, i }));
  const out = new Array(sites.length);
  async function worker() { while (queue.length) { const { s, i } = queue.shift(); out[i] = await provisionOne(s); } }
  const ws = [];
  for (let k = 0; k < Math.min(3, sites.length); k++) ws.push(worker());
  await Promise.all(ws);

  return j({ ok: true, results: out });
}

export const onRequestPost = handle;
