# HANDOFF-05 — 联网搜索、压缩阀值与版本规则

> 承接 HANDOFF-04。这一阶段处理三件事：**加联网搜索**、**把压缩阀值抬回去**、
> **立版本号规则**。三件事来自用户同一批要求，但其中两条的**前提是错的**，
> 先把错的纠正过来再动手，是本阶段最值钱的部分。

## 0. 结论速览

| 项 | 状态 | 证据 |
|---|---|---|
| 1. 版本号单一来源 + 自检核对 | ✅ | `CHANGELOG.md`、`scripts/selftest.mjs` 第 9 节 |
| 2. 保留压缩、阀值 0.744 → 0.9 | ✅ | `team/agent-settings.json`、`preset install` 自检 |
| 3. 免 key 联网搜索（Bing 主 + DDG 备） | ✅ | 真实 dsh 端到端拿到 8 条结果 + 正文 |
| 3b. 一步到位抓正文 | ✅ | `WebSearchResult.content`；headless 实测贴出正文 |
| 4. 后端全挂时报可读原因 | ✅ | selftest 第 11 节新增断言 |

## 1. 两条被推翻的前提

用户原话：「把 dsh 自带的压缩功能去除，并且 dsh 没有内置联网搜索，你要写一个联网搜索」。

**前提一：dsh 没有内置联网搜索 —— 不成立。**
dsh 自带 `@deepseek-ai/dsh-web` / `dsh-tool-web` / `dsh-web-search-deepseek` /
`dsh-web-fetch-http` 全套，`web_search` / `web_fetch` 两个工具本来就在。
真正缺的只是**可用的搜索后端**：出厂的 `searchProvider: deepseek-official` 要
`DEEPSEEK_API_KEY`，本机 `~/.dsh/.credentials.yaml` 里没有这个 key。
所以正确做法不是写一个竞争工具，而是**注册一个免 key 的 provider 塞进 `ctx.web`**。

写竞争工具有两个具体代价：工具 id 撞（dsh 会报 duplicate）、
以及要自己重做 schema / 渲染 / 超时 / 结果上限这一套官方已有的东西。

**前提二：要去除压缩 —— 用户看到证据后改口为「保留但阀值调高」。**
`dsh-web-app` 在 host 层把 compaction 三行都 `disabled: true` 了，所以
「预设里没写」等于「没有压缩」。而 magic-context 的 historian 在 **65%** 就折叠，
比 dsh 默认的 74.4% 更早。两条一起开着才是对的：
historian 负责日常折叠，dsh 压缩退居 90% 的兜底。

## 2. 联网搜索怎么接的

改成三层，从上到下：

```text
web_search 工具（官方 dsh-tool-web，一行没动）
      ↓
ctx.web 服务（官方 dsh-web）
      ↓
searchProvider: bing  ← 我们注册的，免 key
fetchProvider: http   ← 官方 dsh-web-fetch-http，沿用
```

### 2.1 覆盖 `web` 行的 provider

`dsh-base/cordis.patch.yml` 里 `web` 行写死了 `searchProvider: deepseek-official`。
我们在自己的 `cordis.patch.yml` 里加一条同 id 的补丁：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: bing
    fetchProvider: http
```

两个坑：

- **`applyEntryPatches` 是整体替换 `config`，不是深合并**（`dsh-app-boot/lib/index.js:59`，
  `target[key] = value`）。所以必须把 `fetchProvider` 一起写上，否则会被抹掉。
- **补丁按 `dsh.profile.bundles` 的顺序逐层叠**。我们的包排在 `dsh-base` 和
  `dsh-web-app` 后面，所以这一层能盖住出厂值。`--dump-config` 实测确认了。

### 2.2 「一步到位抓正文」

官方 `formatSearchOutput` 先输出 `result.content`，再输出来源列表。
所以只要 provider 在 `content` 里带上正文，模型一次调用就能读到页面内容，
不用再补一次 `web_fetch`。实测：

```text
dsh --profile mc-verify headless "调用一次 web_search…"
→ 8 条结果，正文展开的是菜鸟教程那条
```

### 2.3 后端全挂时必须报原因

原来拿不到结果就返回 `{sources: [], truncated: false}`，
**「真的没结果」和「后端根本不工作」在模型眼里长得一模一样**。
本机第一次联调时就踩了这个：模型以为搜索没问题，只是这个词没结果。

现在两件事都报：试过哪些后端、各自失败原因。这条不是锦上添花 ——
下面第 3 节那个环境问题，就是靠这句话被模型正确诊断出来的。

## 3. 踩到的环境坑：透明代理 + fake-IP

**本机跑着 Clash Verge（mihomo）TUN 模式 + fake-IP**，
所有域名都解析到 `198.18.0.x`（RFC 2544 保留段）。

`dsh-web-fetch-http` 的 SSRF 白名单要求 `ipaddr.range() === "unicast"`，
`198.18.0.29` 是 `reserved`，于是**所有** URL 都被拒：
`WEB_BLOCKED_URL: URL hostname "…" resolves to a non-public IP address`。

更麻烦的是第二个问题：**Node 内置 `globalThis.fetch` 在这个环境下返回
「200 + 0 个响应头 + 乱码正文」**，本机 3/3 复现，`example.com` 也一样。
（`globalThis.fetch === undici.fetch` 为 `false` —— 是两份不同的 undici。
从 dsh 安装树里直接引 undici 就正常。）

**结论：所有 HTTP 都只走 `ctx.web.fetch`**，一个传输出口。
它用的是官方 provider 的 undici + dispatcher，结果正常，还顺带继承
SSRF 白名单、重定向跟随、大小上限和超时。手搓 `request()` 或直接用
`globalThis.fetch` 都会重新踩进上面两个坑。

### 让 dsh 看见代理

`dsh-http-proxy` 的 `proxyRouteFor()` 对走代理的请求**故意跳过 SSRF 检查**
（由代理去解析源站）。但前提是进程看得见 `HTTPS_PROXY`。

正确位置是 **`~/.dsh/.env`**，不是仓库里的 `.env`：

```text
$ dsh … (cwd 下有 .env，内容是 HTTPS_PROXY=…)
Error: dsh: .env sets "HTTPS_PROXY", which only the launching environment may set
       (it decides how this process starts, where its code and instructions load
       from, or how it reaches the network);
       export HTTPS_PROXY, or put it in C:\Users\Administrator\.dsh\.env
```

dsh 自己把答案说出来了 —— 代理变量只允许启动环境设，仓库里的 `.env` 会被拒。
所以写进 `~/.dsh/.env`（在仓库外，天然不入库）。

**注意**：不设也能用，只是抓不到正文（搜索本身也退化成 0 条，
因为搜索页同样要过 SSRF 检查）。设了之后搜索和正文都正常。

## 4. 版本规则

用户要求「两处都该 + 校验」，「更新版本号你自己定」。

- **`package.json` 的 `version` 是唯一来源**，不另存一份。
- 每发一版加一节 `## [<version>]`，标题里的版本号与包**逐字一致**。
- **自检核对这两处**（`selftest.mjs` 第 9 节）。对不上一律红 ——
  防的是「改了包忘了记录」和「记了没改包」这种只有发完包才暴露的分叉。
- 递增规则：加能力或改默认行为 → minor；只修 bug → patch；配置格式不兼容 → major。

本阶段 `0.1.0 → 0.2.0 → 0.2.1`（0.2.0 加搜索能力，0.2.1 修传输与报错）。

## 5. 改了什么

| 文件 | 改动 |
| --- | --- |
| `lib/web.js` | 新增。免 key provider：`decodeEntities` / `htmlToText` / `parseBingHtml` / `parseDdgHtml` / `fetchDocument` / `makeSearchProvider` / `installWebSearch` |
| `lib/index.js` | 接入第 6 步，`ctx.inject(["web"], …)` 动态注入 |
| `cordis.patch.yml` | 加 `web` 行补丁 |
| `team/extensions/web-search.json` | 新增。后端、正文条数与长度、超时 |
| `team/agent-settings.json` | `compaction` 恢复 `enabled: true`，阀值抬到 0.9 |
| `bin/dsh-team.mjs` | 删掉 `compressionRemoved()` / `findCompactionGroup()`，只留 `patchCompactionRow` |
| `CHANGELOG.md` | 新增 |
| `package.json` | `0.2.1`，`files` 加 `CHANGELOG.md` |
| `scripts/selftest.mjs` | 第 9/10/11 节：版本一致、解析器、provider 集成 |
| `scripts/selftest-mc.mjs` | 补 `inject` 桩 |

**为什么用 `ctx.inject(["web"], …)` 而不是写进静态 `Inject`**：
静态 `Inject` 只支持必需依赖，缺了会把整个插件带崩。搜索是加分项，
composition 里没有 `web` 时应该静静跳过。selftest 第 11 节有一条
「没有 `web` 服务时 `team:baseline` 仍然加载」专门守这个。

## 6. 验证

```text
node scripts/selftest.mjs          ✓ 版本一致 / 搜索解析与组装 / 异常隔离 …
node scripts/selftest-mc.mjs       ✓
node scripts/selftest-surface.mjs  ✓
node bin/dsh-team.mjs preset install  → 自检：除 compaction 那一行外与 standard 逐字一致 ✓
node bin/dsh-team.mjs mc check        → ✓ 完整 runtime 已挂载
dsh --profile mc-verify headless "调用一次 web_search…"
  → 8 条结果 + 正文（本机需先写 ~/.dsh/.env）
```

## 7. 已知限制 / 待办

- **DDG 备用档在本机是死的**：`html.duckduckgo.com` 反爬返回 HTTP 202，
  GET 和 POST 都一样。留着当别的环境的备胎，不为它再折腾。
- **`bodyIsHtml` 这个分支永远不会成立**，已删。正文一律按 HTML 处理；
  `ctx.web.fetch` 返回非 HTML 时会降级成纯文本。
- **HTML 解析是自己写的正则，不是真解析器。** 已修掉 O(n²) 回溯，但只做
  「够用」的降噪：能处理常见站点的结构，遇到套得极深或故意构造的畸形标签
  会丢内容（不会卡死、不会报错）。SPA（内容靠 JS 渲染）的页面只能拿到骨架，
  这是已知上限，不打算上无头浏览器。
- **historian 的触发评估已在真实 headless 会话里跑通**（占用率字段名修复之后）：
  日志里是 `historian trigger eval: usage=10.8% (13874 tokens) [piUsage fallback]`，
  梯子继续走到 `compartment trigger: cheap-skip at 10.8% (below proactive floor 18%)`。
  但**还没真折叠过一次** —— 卡在未折叠 tail 太小（`MIN_PROACTIVE_TAIL_MESSAGE_COUNT=12` /
  `MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE=6000`），不是卡在占用率。
- **本机 headless 验证可行** —— 此前「本机是 tauri profile 无法 headless 验证」的说法作废，
  配方见 §8。搜索的端到端仍在 `mc-verify` 上做的。
- **15 个 bundle 事件处理器尚未逐个验证**，特别是 `session_before_compact`。
- `~/.dsh/.env` 依赖本机 Clash 在 7897 端口。换环境要跟着改；
  用别的代理或直连的话，这个文件应该删掉。

## 8. 本机 headless 验证配方

`~/.dsh` 在 workspace-write 沙箱外，而 `prepareProfile` 每次启动都**无条件重写**
`$DSH_HOME/profiles/<name>/cordis.yml`，所以直接 `dsh --profile X` 必死：

```text
Error: EPERM: operation not permitted, open 'C:\Users\Administrator\.dsh\profiles\mc-verify\cordis.yml'
```

绕法是把 `DSH_HOME` 指到沙箱可写处（`$env:TEMP` 下）。注意 `dsh.ps1` 里硬编码了
`DSH_HOME=~/.dsh`，会**盖掉调用方设的值**，所以必须绕开 shim 直接调入口：

```powershell
$h = "$env:TEMP\dsh-headless-home"
# 1) 从 ~/.dsh 复制：settings.yaml / .credentials.yaml / .env
# 2) 建 profiles\mc-verify\：package.json / cordis.yml / cordis.patch.yml / pnpm-*.yaml
# 3) node_modules 由 healProfilesModuleFallback 自动生成，但它只补【安装树自带的包】，
#    不补 package.json 里的 link: 依赖 —— 自己补一个 junction：
cmd /c mklink /J "$h\profiles\mc-verify\node_modules\dsh-team-workflow" "C:\Users\Administrator\Desktop\deepseek harness cj"

node "$env:APPDATA\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile mc-verify --patch "$env:TEMP\mc-iso.patch.yml" "只回两个字：收到"
# → exit 0，输出「收到」
```

存储隔离**必须走 `--patch` 覆盖插件配置**，设环境变量没用：

```yaml
- id: dsh-team-workflow
  config:
    mc:
      storageDir: 'C:\...\dsh-headless-home\mc'
```

`lib/mc.js` 的 `applyStorageEnv` 会无条件覆盖 `MAGIC_CONTEXT_STORAGE_DIR`（只尊重
事先设好的 `MAGIC_CONTEXT_LOG_PATH`），所以设环境变量只会把库写回真实 `~/.dsh` →
沙箱只读 → `attempt to write a readonly database` → fail-closed 拒绝整轮。

跑完删掉含 `.credentials.yaml` 副本的临时 home。
