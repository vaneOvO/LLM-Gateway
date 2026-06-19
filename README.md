# LLM Gateway（Cloudflare Pages 版）

部署在 Cloudflare Pages 上的轻量 LLM 网关：

- **配置管理面板**（`/`）：在网页上增删上游站点（含公益站）和 key，可「测试连通」「拉取模型」。
- **OpenAI 兼容接口**（`/v1/chat/completions`、`/v1/models`）：给别的工具 / OpenAI SDK 调。
- 上游配置存在 **Cloudflare KV**（服务端），各家 key 不下发到调用方。

## 目录结构（index.html 在根，零控制台构建配置）

```
llm-gateway-pages/
├─ index.html                        # 配置管理面板（放在根 → 根路径 / 直接可访问）
├─ functions/                         # Pages Functions（= Workers），和 index.html 平级
│  ├─ _middleware.js                  # 全局 CORS / 预检
│  ├─ admin/
│  │  ├─ config.js                    # GET/PUT 配置（管理员令牌鉴权，存 KV）
│  │  ├─ stats.js                     # GET/DELETE 请求计数
│  │  ├─ ping.js                      # POST 连通测试
│  │  └─ upstream-models.js           # POST 拉取上游模型列表
│  └─ v1/
│     ├─ models.js                    # GET /v1/models（聚合）
│     └─ chat/completions.js          # POST /v1/chat/completions（路由+透传，支持流式）
└─ README.md
```

> 没有 `wrangler.toml`、没有 `public/` 子目录。这样：
> 1. 默认输出目录就是仓库根，`index.html` 在根 → `/` 直接打开，**不用在控制台设 Build output directory**。
> 2. 没有 wrangler.toml → 控制台的「绑定」「环境变量」由你在面板里管,不被文件锁定。
> 3. `functions/` 在根、和 index.html 平级,Pages 自动探测并编译,与输出目录无关。

## 需要的两个密钥 + 一个 KV（都在控制台设）

- `ADMIN_TOKEN`：进配置面板、读写配置用。
- `PROXY_API_KEY`：调 `/v1` 接口用。
- KV 命名空间,绑定名固定为 `CONFIG_KV`。

## 部署（连接 Git，全程控制台）

1. 把本目录推到 GitHub 仓库（`index.html`、`functions/` 在仓库根）。
2. Cloudflare → **Workers & Pages → 创建 → Pages → 连接到 Git**,选该仓库。
3. 构建设置：
   - Framework preset：**None**
   - Build command：**留空**
   - **Build output directory：留空 / 默认（根）**——因为 index.html 已经在根,不要填 `public`。
4. 创建 KV：**Storage & Databases → KV → 创建命名空间**。
5. 项目 → **Settings → Functions → 绑定** → 添加 KV：变量名 `CONFIG_KV` → 选命名空间。
6. 项目 → **Settings → 环境变量（Production，选加密）**：加 `ADMIN_TOKEN`、`PROXY_API_KEY`。
7. **重新部署一次**（绑定/环境变量只对新部署生效）。

> 生产域名 `<项目>.pages.dev` 指向「当前生产部署」。若访问的不是最新,去 Deployments 确认最新那条标着 Production；若在 Preview,打开它 →「…」→ Promote to production。改完强刷浏览器（Ctrl/Cmd+Shift+R）。

## 用法

访问 `https://<项目>.pages.dev/`：

1. 填 `ADMIN_TOKEN`,点**连接并载入**。
2. **新增站点**,填：
   - **站点名**：调用前缀,不能含 `/`,如 `freeapi`、`openai`。
   - **Base URL**：OpenAI 兼容根,**填到 `/v1` 为止,不要带 `/models`**,如 `https://freeapi.dgbmc.top/v1`。
   - **API Keys**：每行一个,多个随机轮换。
   - **模型**：可手填,或点**拉取模型**自动填入。
3. 点**保存配置**。

按钮分工：**测试连通**=看端点/key 通不通；**拉取模型**=列出并填入可用模型；底部**调用测试**=验证某个 `站点名/模型名` 真能出内容。

外部按 OpenAI 接口接入：

```bash
curl -X POST https://<项目>.pages.dev/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"freeapi/gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

OpenAI SDK：`base_url = https://<项目>.pages.dev/v1`,`api_key = PROXY_API_KEY`,`model = 站点名/模型名`。

## 自动选路（直接用模型名调用）

- 调用时 **`model` 直接写模型名**（如 `gemini-3.5-flash`），网关会在**所有「列出了该模型」的上游**里:
  1. 按 `1/延迟` 加权随机挑一个（既偏向低延迟,又把负载分摊到各家 = 负载均衡）;
  2. 失败（连接错误或非 2xx）就**自动切下一个**,失败的上游冷却 30 秒;
  3. 命中的上游写在响应头 `X-Upstream` 里,方便排查。
- 想让多家自动负载均衡/故障转移到同一个模型,只要在这几家的「模型」列表里**都填上这个模型名**即可(站点名相同或不同都行)。
- 仍兼容显式指定：写 `站点名/模型名` 会优先在该站点(组)里选；`模型列表留空` 的上游视为通配,作为兜底候选。
- 每个上游按 baseUrl 单独统计调用数/成功/失败/延迟,显示在面板每个站点右下。

## 注意事项

- **Base URL 不要带 `/models`**：只填到 `/v1`,代码会自己拼 `/models`（拉取模型）和 `/chat/completions`（转发）。带了 `/models` 会变成 `/v1/models/...`,全错。
- **绑定/环境变量是项目级、跨部署保留的**,不用每次重填；但改动只对**新部署**生效,改完要重新部署一次。
- **没有自动故障转移**：按 model 前缀路由,某站挂了不会自动切。要高可用用 new-api。
- **管理员能看到明文 key**：面板返回真实 key,`ADMIN_TOKEN` 务必保密。
- **计数非强一致**：KV 单键写有 ~1次/秒 限制,高并发会少计。要精确用 Durable Objects / Analytics Engine。
- **Gemini 走 CF 出口有风险**：Google 可能封 Cloudflare 出口 IP。其他家一般没事。
