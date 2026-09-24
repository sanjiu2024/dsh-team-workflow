# 变更记录

版本号规则（本项目自定）：

- `package.json` 的 `version` 是**唯一来源**；CLI、`/team-baseline` 都读它，不另存一份。
- 每发一版必须在下面加一节 `## [<version>]`，标题里的版本号要和 `package.json` 逐字一致。
- 自检会核对这两处（`scripts/selftest.mjs` 最后一节）：对不上直接红，避免出现
  「改了版本号忘了记录」或「记了但没改包」这种只有发完包才发现的分叉。
- 递增规则：加能力或改默认行为 → minor；只修 bug → patch；改配置格式且不兼容 → major。

## [0.2.2]

### 修复

- **HTML 解析的两个正则存在 O(n²) 回溯，能把事件循环卡死。**
  `stripTags` 的 `<[^>]+>` 和正文候选容器的 `<[^>]+class="…"` 里，`[^>]` 允许
  跨过下一个 `<`，于是一串 `<` 会让每个位置都向后重扫到串尾。实测：
  8 万个 `<` 要 **11.9 秒**，而正文上限是 10 万字符，畸形页面完全能到。
  改成 `[^<>]` 后 **1ms**。

  这个不算是理论风险：`ctx.web.fetch` 抓的是任意第三方页面，
  正文长度不受我们控制，卡住的是 agent 的事件循环。

- 自检里加了一条守门用例：8 万个 `<` 必须 3 秒内跑完，同时保留
  `class=` 候选容器的真实匹配。已验证它能真的报错（把 `[^<>]` 改回 `[^>]`
  会红），不是一条永远不会触发的断言。

## [0.2.1]

### 修复

- **搜索和抓正文统一走 `ctx.web.fetch`，不再用内置 `globalThis.fetch`**。用 Clash
  TUN + fake-IP 这类透明代理时，Node 内置 fetch 会拿到「0 个响应头 + 乱码正文」
  （本机 3/3 复现，`example.com` 也一样），解析必然出 0 条。官方 fetch provider 用
  undici + dispatcher，走的是同一条路但结果正常，还顺带继承 SSRF 白名单、重定向
  跟到、大小上限和超时。
- **后端全挂时不再静默返回空**，而是返回一段可读的 `content`：试过哪些后端、各自
  失败原因。以前「真没结果」和「后端不工作」在模型眼里长得一样，排查时也一样。
- 死代码清理：删掉被 `fetchDocument` 取代的 `UA` 常量和 `grabBody()`，去掉一处
  永远不会成立的分支（`source.bodyIsHtml`）。

### 已知限制

- 透明代理（fake-IP）环境下要抓正文，得让 dsh 进程看得见 `HTTPS_PROXY`：
  写在 `~/.dsh/.env`（仓库里的 `.env` 会被拒，dsh 只允许启动环境设代理变量）。
  不设也不影响搜索本身，只是正文抓不到。

## [0.2.0]

### 新增

- **联网搜索**：免 key 的搜索 provider（Bing 主、DDG 备），注册进 dsh 的 `ctx.web`。
  dsh 自带的 `web_search` / `web_fetch` 工具本来就是完整的，缺的只是可用的
  provider —— 出厂的 `web-search-deepseek` 要 `DEEPSEEK_API_KEY`，团队网关的 key
  用不了。现在搜索结果会带前几条的**正文**（`WebSearchResult.content`），
  模型一次调用即可拿到摘要 + 正文，不必再逐个 `web_fetch`。
- `team/extensions/web-search.json` —— 搜索后端配置（providerId / fallback /
  正文条数与长度 / 超时）。

### 变更

- **压缩不再删除，改为抬高阀值**：原先默认把 `compaction-basic` / `command-compact` /
  `tool-result-pruner` 整组删掉，现在保留，只把阀值从 0.744 抬到 **0.9**
  （`reserveTokens: 44800 → 12800`，窗口 128000）。理由：magic-context 的 historian
  在 65% 就折叠，dsh 自带压缩退居兜底，不再和 historian 抢上下文；但万一 historian
  不触发，至少有东西防止上下文撑爆。
- `team/agent-settings.json` 的 `compaction.enabled` 恢复为 `true`。必须显式开
  —— dsh 桌面宿主在 host 层把这三行都 `disabled: true` 了，预设里不写就是没有压缩。
- `cordis.patch.yml` 多一层：覆盖 `web` 行的 `searchProvider`。补丁按 bundle 顺序
  逐层叠，`dsh-base` 在我们前面，所以这一层能盖掉出厂的 `deepseek-official`。

## [0.1.0]

首个版本：团队规范注入（`systemPrompt` order 600）、审计日志、上下文节流统计、
rtk 输出压缩、pi-lens 代码智能、magic-context 移植、team 预设、`dsh-team` CLI、
11 个 skill。
