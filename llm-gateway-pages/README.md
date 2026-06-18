# LLM Gateway（Cloudflare Pages 版）

一个部署在 **Cloudflare Pages** 上的轻量 LLM 网关：

- **配置管理面板**（`/`）：在网页上增删上游站点（含公益站）和它们的 key。
- **OpenAI 兼容接口**（`/v1/chat/completions`、`/v1/models`）：给别的工具 / OpenAI SDK 调。
- 上游配置存在 **Cloudflare KV**（服务端），各家 key 不会下发到调用方。

## 目录结构

```
llm-gateway-pages/
├─ public/
│  └─ index.html                     # 配置管理面板（静态前端）
├─ functions/                         # Pages Functions（= Workers）
│  ├─ _middleware.js                  # 全局 CORS / 预检
│  ├─ admin/config.js                 # GET/PUT 配置（管理员令牌鉴权，存 KV）
│  └─ v1/
│     ├─ models.js                    # GET /v1/models
│     └─ chat/completions.js          # POST /v1/chat/completions（按前缀路由+透传，支持流式）
├─ wrangler.toml
└─ README.md
```

## 需要的两个密钥 + 一个 KV

- `ADMIN_TOKEN`：进配置面板、读写配置用。自己设一长串随机值。
- `PROXY_API_KEY`：调 `/v1` 接口用。自己设一长串随机值。
- KV 命名空间，绑定名固定为 `CONFIG_KV`。

---

## 方式 A：连接 Git（几乎全程在控制台，推荐不想装东西的人）

1. 把本目录推到你自己的 GitHub 仓库。
2. Cloudflare 控制台 → **Workers & Pages → 创建 → Pages → 连接到 Git**，选这个仓库。
3. 构建设置：
   - Framework preset：**None**
   - Build command：**留空**
   - Build output directory：**`public`**
4. 创建 KV：**Storage & Databases → KV → 创建命名空间**（名字随意）。
5. 回到该 Pages 项目 → **Settings → Functions → KV namespace bindings** → 添加：
   - Variable name：`CONFIG_KV` → 选你刚建的命名空间。
6. **Settings → 环境变量（Production）** 添加（选「加密 / Secret」）：
   - `ADMIN_TOKEN` = 你的管理员令牌
   - `PROXY_API_KEY` = 你的接口密钥
7. 触发一次重新部署（Deployments → Retry/Redeploy）让绑定生效。

## 方式 B：用 wrangler 命令行

```bash
npm install -g wrangler        # 或全程用 npx
wrangler login

# 1) 创建 KV，并把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]].id
wrangler kv namespace create CONFIG_KV

# 2) 创建 Pages 项目（名字与 wrangler.toml 的 name 一致）
wrangler pages project create llm-gateway

# 3) 设置两个密钥
wrangler pages secret put ADMIN_TOKEN
wrangler pages secret put PROXY_API_KEY

# 4) 部署（functions/ 会被自动包含）
wrangler pages deploy public
```

---

## 用法

部署后访问 `https://<你的项目>.pages.dev/`：

1. 在「连接控制台」填 `ADMIN_TOKEN`，点**连接并载入**。
2. 在「上游站点」里**新增站点**，填：
   - **站点名**：调用前缀，不能含 `/`，比如 `freeapi`、`openai`、`agnes`。
   - **Base URL**：OpenAI 兼容根，一般以 `/v1` 结尾，比如 `https://freeapi.dgbmc.top/v1`。
   - **API Keys**：每行一个，多个会随机轮换。
   - **模型**：每行一个，可留空（填了 `/v1/models` 会列出来）。
3. 点**保存配置**写入 KV。
4. 用「调用测试」填 `PROXY_API_KEY` + `站点名/模型名` 验证。

外部工具按 OpenAI 接口接入：

```bash
curl -X POST https://<你的项目>.pages.dev/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"freeapi/gpt-oss-120b","messages":[{"role":"user","content":"hello"}]}'
```

OpenAI SDK：`base_url = "https://<你的项目>.pages.dev/v1"`，`api_key = PROXY_API_KEY`，`model = "站点名/模型名"`。

---

## 连通测试 & 请求计数

- 每个站点卡片有「**测试连通**」按钮：用当前表单里的 Base URL + 第一把 key 去探测上游 `/models`，返回状态码和延迟（`✓ 200 · 240ms` / `✗ ...`）。可在保存前先测。
- 卡片右下显示该站点的**请求计数**（总数 / ok / err / 最近使用时间）；顶部「刷新统计」「清零统计」。
- 计数在 `/v1/chat/completions` 响应返回后用 `waitUntil` 后台写入 KV 的 `stats` 键，不给调用加延迟。

新增接口：
- `GET /admin/stats`、`DELETE /admin/stats`（管理员令牌）：读取 / 清零计数。
- `POST /admin/ping`（管理员令牌）：连通测试，body `{ baseUrl, apiKey }`。

## 注意事项

- **计数非强一致**：KV 单键写有约「1 次/秒/键」的软限制，且读-改-写在高并发下会丢增量（少计）。自用够用；要精确统计请改用 **Durable Objects**（原子计数）或 **Analytics Engine**（写多读少的指标）。
- **没有自动故障转移**：按 model 前缀路由，`a/gpt-4o` 与 `b/gpt-4o` 是两条独立路由，某站挂了不会自动切。要高可用用 new-api。
- **管理员能看到明文 key**：配置面板返回的是真实 key（方便编辑）。`ADMIN_TOKEN` 务必保密，别把它给别人。
- **Gemini 走 Cloudflare 出口有风险**：请求从 CF 边缘出网，Google 可能封 CF 出口 IP（就是之前遇到的 empty 报错）。OpenAI/Anthropic/DeepSeek/Groq 一般没事。
- **公益站条款**：不少站点禁止二次分发/转卖，自用一般没事，对外服务留意规则。
- 流式（`"stream": true`）已支持，按 SSE 原样透传。
