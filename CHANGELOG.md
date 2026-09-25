# 变更记录

版本号规则（本项目自定）：

- `package.json` 的 `version` 是**唯一来源**；CLI、`/team-baseline` 都读它，不另存一份。
- 每发一版必须在下面加一节 `## [<version>]`，标题里的版本号要和 `package.json` 逐字一致。
- 自检会核对这两处（`scripts/selftest.mjs` 最后一节）：对不上直接红，避免出现
  「改了版本号忘了记录」或「记了但没改包」这种只有发完包才发现的分叉。
- 递增规则：加能力或改默认行为 → minor；只修 bug → patch；改配置格式且不兼容 → major。

## [0.5.1]

修一个会**清空用户历史对话**的写盘 bug，两个根因。

症状：重启 dsh 后旧对话全部消失，报 `stored session "…" is corrupt: session event at
seq N message must have role "user"`。破坏发生在写盘时，暴露在下次重启时，中间窗口期
毫无提示 —— 所以一直没被发现。

两个根因属于同一类错误：**dsh 对 surface 消息的校验在 append 时不跑，只在重新加载时跑**
（`user/message` 在 invariant 里直接 `break`，而 `adoptSessionEvent` 走的是严格的
`assertMessageEventShape`）。append 时不校验的字段，必须由写入方自己守住。

1. `/` 的 ordinal 剥不掉（`lib/mc.js` / `lib/mc-adapter.js`，158 处）。`stripOrdinal`
   只锚字符串开头，但 `textOfMessage` 把 reasoning 与 text 各块的文本拼成一个串，
   而 bundle 只给 text 块打 ordinal —— 它落在拼接串中段（实测下标 603）而剥不掉。
   于是已存在的 assistant 消息被 `alignSurface` 当成「新增」，再经
   `toEventData("user/message", …)` 把 assistant 的 role 原样写了进去。
   **修两处**：逐行剥；且 `user/message` 的 role 无条件强制为 "user"（兜底，
   防上游改变 ordinal 写法又复发）。
2. 缺 `id`（`lib/lens.js`，12 处）。`additionalContexts` 构造 message 时漏了 `id`，
   加载期报 `lacks an identified message`。

新增（工具与自检）：

- `lib/session-log.js`：按 dsh 自己的方式读写多帧 zstd 会话日志。**不能靠搜 magic
  字节切帧** —— 压缩数据里偶然出现 `28 B5 2F FD` 就会把一行 JSON 劈成碎片（第一版
  修复脚本就这么错过）。改用 dsh 的结构化扫帧（解析帧头再逐块跳），与 dsh 源码里的
  `scanZstdFrames` 逐字节比对过 12/12 一致。
- `scripts/fix-mc-corruption.mjs`：修数据（默认只扫描、退出码 1；`--fix` 才动手，先备份）。
  修法只有一种 —— 只改 role / 只补 id，其他一律不动（摘掉 surfaceOp 会被 dsh 拒：
  `requires a surfaceOp marker`；自替换也不行：range 必须小于自身 seq）。
- `scripts/verify-sessions.mjs`：起最小 cordis、挂 dsh 自己的持久化插件、调
  `readColdSessionLog` —— 走的就是重启后恢复对话那条路。反向验证时逐字复现了用户的
  原始报错，修后 12/12 通过。
- `scripts/selftest-mc-shape.mjs`：形状自检（零依赖，复刻 dsh 的校验判定），已进
  `npm test`。含「压缩流里的假 magic」回归 —— 搜 magic 的实现在这里会红。

另外（本轮的其余清理）：

- `stagePiShim` 的 `new URL` 包了 try/catch（URL 不合法时降级，不再把插件启动拖下水）。
- `toEventData` **删掉三个死分支**：它曾经为 `system/message` / `assistant/message` /
  `tool/result` 预留造法，但三个全写错了 source —— dsh 要求 assistant 是
  `{kind:"model", provider, model}`、tool/result 是 `{kind:"tool", callId}`，而当时
  统一写 `{kind:"plugin"}`。现在只造 `user/message`（唯一实际用到的），把四种类型的
  完整形状写成注释备查，不再预留坏形状。
- 修数据脚本的备份改到会话目录**外**：备份文件名仍以 `session.` 开头，留在原目录会被
  dsh 的会话枚举当成第二个会话扫出来。

## [0.5.0]

### 新增

- **上下文压不动时自动交接。** 触发条件是 **dsh 自己的判定**，本包不自造阈值：
  `dsh-compaction-basic` 在 `agent/request-error`（waterfall）上遇到 `CONTEXT_WINDOW_EXCEEDED`
  会压一次并 `{kind:"retry"}`；重试次数用尽（`maxOverflowRetries`，默认 1）或压缩没造成
  实质变化时它 `next()` → `dsh-agent-loop` 抛 LlmError → `throwError()` emit `agent/error`。
  **`agent/error` 只在放弃时才 emit**（自救成功那次从不到这里），所以
  「`agent/error` + `error.code === "CONTEXT_WINDOW_EXCEEDED"`」精确等于「自救已耗尽」。

  那一刻做四件事（`lib/handoff.js`）：

  1. 从会话日志里捡出**最后一条用户请求**（`source.kind === "user"` 的 `user/message`）
     + **最后一次 `todo/write` 快照**。todo 取整份日志里最后一条、**跨 turn 保留** ——
     dsh 自己的 `backscanTodos` 会在 `turn/start` 处停，那是给 UI 显示「当前计划」的语义，
     而交接要的是「这活干到哪了」，跨 turn 的旧清单恰恰最值钱。
  2. 写 `<DSH_HOME>/storages/handoffs/<日期>-<会话id>-<短hash>.md`：原始请求、未完成任务、
     已完成（标清楚「不要重做」）、接着怎么干。会话 id 会消毒 —— 它是可以从外部 adopt
     进来的字符串，不做处理时 id 里的 `../` 能把文档写到目录外。
  3. `sessionController.create`（继承来源会话的 `cwd` / `agentPreset`）+ `prompt`：
     **注入即让新会话自动开跑**，不用人再敲一遍。preset 优先读日志里的
     `agent-preset/selected`（只在运行时切换时 append，且只允许在第一个 turn 之前切），
     拿不到才回落到 `header.agentPreset` —— header 记的是「启动时那个」，切换过就过期了。
  4. 旧会话里 `append` 一条 `user/message`（`source.kind = "plugin"`），写明新会话 id 与文档路径。

  三个设计上的克制：

  - **不给旧会话发 prompt。** 发消息 = 再跑一轮模型调用，而它刚正因为上下文超限失败。
    invariant 对 `user/message` 没有 turn/step 约束（`system/message` 有，turn 闭合后用不了），
    且 `source.kind = "plugin"` 会让 Chat 渲染成 context 行而非用户发言。
  - **一个会话只交一次**，且进程内有总数上限 `MAX_HANDOFFS = 5`。
    按会话去重挡不住 A→B→C（每代新会话都是「新」会话）—— 任务本身一个上下文装不下时
    就会一直建下去。到上限仍写文档、仍给提示，只是不再自动建会话。
  - **不做 UI 自动跳转**：切 UI 当前会话的 `sessions.open(id)` 只在
    `dsh-api-session-controller` 的 client half，而本包是纯 host 包。只建会话 + 点名去哪。

  降级：没有 `sessionController` 的 profile（headless / 精简）里整块关掉并报「待命」，
  不拖垮整包；建会话失败也照样写文档 + 在旧会话里给出手工出路。四条失败路径全不抛。

## [0.4.1]

### 修复

- **`/thrift` 改的阈值从来没生效过，而且 `/thrift show` 会把它显示成「已生效」。**
  两个独立的错叠在一起，所以一直看着像正常：

  - **写不到地方。** `dsh-team thrift apply` 把阈值写进 profile 的 `cordis.patch.yml`，
    目标是 row `dsh-team-workflow`、键名 `pruneThresholdChars` 那一套。但真在跑的是
    **agent 预设**（`~/.dsh/.agent-presets/team/agent.cordis.yml`）里 compaction group 下的
    `compaction-basic` / `tool-result-pruner` 两行 —— 预设是**整份 entry list、没有 patch 层**，
    profile patch 够不到它。而且键名也不对：插件只认
    `thresholdChars` / `headChars` / `tailChars`，对未知键**直接 throw**。
  - **显示假值。** `/thrift show` 打的是自己那份 overlay 文件，所以刚写完看着像已经生效，
    实际重启后一切照旧。

  修法是新增 `lib/preset-gen.js`：把「standard 预设 → team 预设」做成**纯文本进、纯文本出**的
  纯函数（好单独自检），`thrift apply` 与 `preset install` 走同一条生成/校验路径，
  `/thrift show` 从生成好的预设里**回读**真值。

  顺带把两类**会让 dsh 起不来**的值拦在写出之前 —— 这两个插件的 config 是加载期解析的，
  而用户改阈值只是一条 `/thrift`：

  - `retainRatio ≥ thresholdRatio`（`compaction-basic` 会 throw）
  - `thresholdRatio` / `retainRatio` 超出 `(0, 1]`（同一条 `assertRatio`；
    `/thrift compact 2` 与手改 overlay 都能写进来 —— 这是本轮独立审查抓出来的缺口：
    chars 三值拦住了、ratio 没拦住）
  - `headChars + 标记 + tailChars > thresholdChars`（pruner 会 throw；标记 39 个字符，
    照插件源码的 `codePointLength` 算，不是按 UTF-16 长度）
  - 非整数 / 负数阈值

  `/thrift show` 也分开报「生效中」与「待应用 overlay」：没有 overlay 就说没有，
  不再拿内部默认值冒充用户意图。

### 测试

- `scripts/selftest-preset-gen.mjs` —— 覆盖换算与出厂默认、非法组合必须在写出前拦住、
  键名映射到插件真键名、生成物改到真在跑的那两行、多处改动互不覆盖、
  回读抗嵌套同名诱饵、`/thrift show` 区分生效值与待应用。
  找不到 dsh 安装树时**跳过第 3 节并明说跳过了什么**，不只印「全部通过」。

## [0.4.0]

### 新增

- **`dsh-team patch`：思考链与工具行默认展开。** 这两处的展开态是组件内的
  `useState(false)`，dsh 没有配置入口、行组件也没导出，所以只能就地改安装树里的
  `@deepseek-ai/dsh-client-ui-{chat,tool}/lib/client.js`。只动 3 个组件
  （`ReasoningRow` / `ToolRow` / `BashRow`），其余折叠行（压缩、系统提示、设置面板）不碰；
  `transcriptView` 保持 `normal`。
  改前留原始备份（`~/.dsh/team-workflow/patch-cache/`），`--restore` 能逐字节还原。
  还原只回滚「当前内容仍是它写进去的那版」的文件，用户手改过或 dsh 升级换过的一律跳过。
- 顺带把 CLI 里 4 处裸 `JSON.parse` 收敛成一个 `readJson()`：文件格式坏了报清楚是哪个文件，
  不再是裸 `SyntaxError` 崩栈。

## [0.3.1]

### 修复

- **magic-context 的折叠终于真的落地了**（上层报的现象是「上下文长度还是会碰到 dsh 自带的压缩」）。

  根因是落地函数里一行早退：```js
  if (change.kind !== "append") { stats.skipped += 1; continue; }
  ```
  dsh 的 surface 只有 `append` 和 `replace` 两种写操作，而这行把 **replace 全跳过**了，
  于是 historian 折出来的摘要只进了系统提示，**历史消息一条没少** —— dsh 自带的压缩照旧按
  自己的阈值触发。折叠等于白算。

  改对的地方不止「别跳过」这一处，还有三个必须同时成立的前提：

  - **切口必须是工具配对平衡的**。切在 assistant 的 `tool-call` 和它的 `tool/result`
    中间，会把一条 `tool/result` 变成孤儿，服务端直接 400。原来只是「大致对齐」，
    现在按平衡点**向内收缩**到最近的合法切口（收缩掉的那几条继续可见，不折 —— 宁可少折不可折错）。
  - **顺序**：折叠必须**先于**追加注入块。append 会改 `surface.nodes`，之后算出来的
    切口表就错位了（这是原来 `mismatch=1` 的来源）。
  - **`§N§` 必须在比对前和写入前都剥掉**。bundle 每轮重打 ordinal，不剥的话
    「上一轮的前缀」会被当成真差异，一轮轮叠下去就是无界增生（还会出现 `§1§ §1§`）。

- **折叠占位符会把 `§N§` 带回 surface，形成无界增生**。折叠后的占位符优先复用 bundle 给的
  那条消息原文，而 bundle 每轮按位置重打 `§N§`。原文里带着 `§9§` 写进持久日志，下一轮
  bundle 再打一层 → `§10§ §9§` …… 每轮长一点，永不收敛。修法是在**写入前剥掉** `§N§`
  （比对照样剥），剥完不算差异，闭环才闭合。

  顺带把落地结果**写进日志** —— 之前折叠没发生时一个字都不打，用户只能猜。

- **`stagePiShim` 在包根 URL 不带尾斜杠时静默失败**。`new URL("tools/pi-shim/", base)`
  在 base 形如 `…/repo` 时会把最后一段当文件名替换掉，于是永远找不到源目录、
  historian 子进程永远起不来（表现为 `Model "new-api/tier-std" not found`）。
  包根 URL 带不带斜杠都合法，函数自己归一化。

### 测试

- `scripts/selftest-fold.mjs` —— 三个场景跑真 `Session`：干净边界、切口落在配对中间、
  尾部切口不平衡。第三个场景专门守上面那条「向内收缩」——**把收缩那行注释掉，
  这个场景必须变红**（已实测：`孤儿 0/1`，退出码 1；恢复后绿）。
- `scripts/e2e-fold.mjs` —— 端到端跑**真 bundle + 真 historian**（真子进程、真模型），
  不是桩。实测：`before=30 bundle=18 final=20 folds=1`，无孤儿、无悬空。

### 已知天花板（说清楚，不是遗漏）

- **`context` 的请求级变换映射不过来**。dsh 的 surface 只表达「N→1 折叠」，表达不了
  「把每条消息原地重写成压缩文本」：`assistant/message` 带 `sourceEventSeqs` 直接抛，
  其余类型要求被遮蔽的节点**恰好一个**且内容逐字相同（只有 `tool/result` 允许改内容）。
  所以 pi 上的「逐条内容改写」在 dsh 上没有对应写法。
- **一轮最多落一次折叠**。一次 replace 会改 surface 下标，同轮再算就不可信。
  historian 是分段推进的，一轮一次够用，所以这是设计不是限制。
- 模型在 surface 上看不到 `§N§`（我们主动剥了）。但 `ctx_expand` 的 ordinal 读取走
  bundle 自带的 raw-message provider，**不依赖 surface**，`ctx_search` → `ctx_expand` 链路照旧。

## [0.3.0]

### 新增

- **两个无人值守的定时任务**，契约在 `docs/AUTOMATIONS.md`：
  - `用量日报`（每天 09:00）—— 汇总前一天的 token 消耗与耗时，写 `docs/usage/`
  - `上游同步（pi-workflow）`（每 48 小时）—— 比对上游、把能落地的搬进来

  DSH 面板调度器把任务 prompt 存在 `<DSH_HOME>/crons/tasks`，那是个**在 git 外面**的
  JSON 文件，改不动也审不了、删了还没处恢复。所以任务 prompt 只留一句话指向契约文档，
  真正的步骤写进仓库：跟代码一起进 git、可评审可回滚，任务被清掉也能照着补回来。
- `scripts/usage-report.mjs` —— 把一天的审计日志汇总成一份 markdown 日报
  （token 口径、耗时归因、放大倍数、重复读统计）。
  它**顶替不了判读**：「慢在哪一步」「token 耗在哪一步」「值得加什么」只有模型能做。
  反过来也不能让模型直读取数 —— 一天的原始日志约 3.97M 字符（≈1.13M token 粗估），
  是这份产出的报告的 **314 倍**，而实测峰值 prompt 才 128k，物理上读不进来。
  所以分工是：脚本取数、任务的 AI 判读。
- `docs/UPSTREAM-SYNC.md` —— 上游同步的**状态文件**，记「已同步到哪个 commit」。
  没有它，48 小时一轮的任务每次都只能看到上游的全部内容，答不出「这次新出来什么」，
  会把同样的东西反复搬。

### 变更

- `team/RULES.md` 新增「`tier-max` 只用于方案本身拿不准」一节，移植自上游 pi-workflow v1.13.3。
  依据是上游的实测：最贵档的缓存读单价是标准档的 **166 倍**、输出单价 67 倍，
  一次约等于 50 次标准档调用；它 09-22 那批 29 次调用里有 26 次实际在做审查 —— 那是
  `tier-power` 的活。判据给成一句话：**能把问题写成「A 还是 B，为什么」才派**。

### 修复

- **用量日报脚本的四处契约边界**（都在实测中抓出来的）：

  - **不存在的日期会静默生效**。`--date 2026-02-30` 原先直接拿去拼文件名读日志，
    读不到就报「当天没有审计日志」—— 把「你写错了日期」伪装成「那天没数据」。
    现在做往返校验（`new Date("2026-02-30T12:00:00")` 格式化回来对不上就报错）。
  - **空日志天会写出一份空报告**。退出码 3 表示「当天没有审计日志」，原先这个分支
    还会写一个文件出去，于是「没数据」变成仓库里一个空壳日报，第二天再跑还得先删它。
    现在退 3 只往 stderr 写一行，不碰磁盘。
  - **缺值的 flag 被当成真值用**。`--window` 后面不带数字时，解析出来的值是 `true`，
    被当作窗口参数继续算，算出一个没人能解释的数。现在带值的 flag 在入口统一校验，
    缺值直接退 1 并指名是哪个。
  - **`--out` 与 `--out-dir` 同时给会互相覆盖**。两者都要写 markdown，谁赢取决于
    代码顺序而不是用户意图。现在同时给直接退 1 报错，让人自己选一个。
  - 顺带删掉了报告里的「生成时间」行：它让同样的输入产出不同的文件，
    日报无法复现、无法 diff。日报的价值在数字，不在「这份是什么时候生成的」。

## [0.2.3]

### 修复

- **magic-context 的占用率上报字段名写错了，导致折叠永远不触发。**
  适配层 `getContextUsage()` 原来返回 `{contextWindow, usedTokens}`，
  但 bundle 读的是 `piUsage.tokens` / `piUsage.percent` —— 名字对不上，
  `percent` 是 `undefined`，于是每次触发评估都拿 `0 tokens` 去比阈值，
  日志永远停在 `usage=0.0% ... below proactive floor (63%)`，
  `compartments` 表恒为空。现在改成 bundle 读的那三个名字
  （`tokens` / `percent` / `contextWindow`），并且**拿不到就返回 `null` 直接跳过**，
  不再假装 `0%`：`0%` 看起来像一个合法的「上下文是空的」，会让折叠静默失效，
  而 `null` 只是这一轮不评估，下一轮拿到数据照样能触发。
- 适配层读 `ctx.tokenMeter` 改用 `ctx.get("tokenMeter")`。cordis 的 `ctx` 是访问器代理，
  没 `inject` 时直接读会**抛异常**（不是返回 `undefined`），原来的写法必然抛。
  同时把 `tokenMeter` 留在静态 `inject` 之外，装在没有 token-meter 的环境里也不会挂。
- `scripts/selftest-mc.mjs` 加守门用例：断言字段名必须是 `tokens`/`percent`/`contextWindow`，
  以及 `percent` 要能算对（90000/128000 = 70.3%，高于 63% 的触发下限）。
  这个用例已反向验证过 —— 把字段名改回 `usedTokens` 会红。
- **桥接层给 bundle 传了精简 ctx，6 个 `ctx_*` 工具 + 7 个 `/ctx-*` 命令全部是死的。**
  bundle 的工具第一件事就是 `ctx.sessionManager.getSessionId()`，精简 ctx 上没有
  `sessionManager`，每次都抛 `TypeError` 被包成 `isError`。之所以一直没被发现，是因为
  报错长得像「工具本身有问题」：审计日志里 `ctx_memory` 17/17、`ctx_search` 8/8、
  `ctx_note` 6/6、`ctx_reduce` 5/5 全是失败，且结果长度**恒为 67 字节**、sha256 完全相同。
  现在改传 `facadeCtx` —— 它的 `sessionManager` 是跟着 `sessionRef` 走的 getter，
  agent 出现后自动是真 session。
- **工具/命令的返回值契约修了两处，修之前内容一个字都到不了模型。**
  一是 `execute` 的返回值必须过 `output.schema` 校验再由 `render` 出文本，
  原写法 schema 声明 object、`execute` 返回字符串、`render` 返回 `undefined`，
  模型收到 `tool "ctx_note" returned invalid output`；二是 pi 用返回值里的 `isError`
  表示失败、dsh 用抛错表示失败，不转换的话 bundle 那 7 处 `isError: true` 全变成
  成功结果，审计日志从此查无此错。
- **7 个 `/ctx-*` 命令的正文要靠捕获窗口捞回来。**
  pi 的命令 handler 不 return 正文，正文走 `pi.appendEntry` / `ctx.ui.notify`；
  dsh 恰好相反，只认 handler 返回值。不开捕获窗口，命令是 `kind: "success"` 配空字符串。
  实测 `/ctx-status` 本来算出了完整状态面板，桥接层把它丢了。

### 说明

- 折叠的第二道门（未折叠 tail 要够大：≥12 条消息或 ≥6000 tokens）是 bundle 自身的
  设计，不是移植缺陷；正常长会话到这个量级自然会过。

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
