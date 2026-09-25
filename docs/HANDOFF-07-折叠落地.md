# HANDOFF-07 —— 折叠终于真的落地了

承接 `HANDOFF-06`。前一阶段修的是「折叠**不触发**」（`getContextUsage` 恒返回 0%），
这一阶段修的是**它的下一环**：折叠触发了、historian 交付了，但**历史一条没少**。

对应版本：`0.3.0 → 0.3.1`（patch）。

## 1. 症状

上层观察到的是：「你这移植的 magic-context 上下文长度还是会碰到 deepseek harness 自带的上下文压缩啊」。

拆开看是三个独立的事实叠在一起：

1. **折叠确实触发了**：`magic-context.log` 里能看到 `compartment trigger: proactive fire`、
   `historian trigger fired`、`historian spawned pid=…`，`compartments` 表也有行。
2. **摘要也进了系统提示**：`## Magic Context` 那段里能看到 compartment 内容。
3. **但历史长度没变**：`session.deriveMessages()` 的消息条数在折叠前后**一样**，
   dsh 自带的 `dsh-compaction-basic` 照旧按自己的 `thresholdRatio` 触发。

也就是说：**折叠算出来的东西只走到了「提示词」这一侧，没有走到「消息数组」这一侧。**

## 2. 根因

`lib/mc.js` 的 `landOnSurface` 里有一行早退：

```js
if (change.kind !== "append") {
    stats.skipped += 1;
    continue;
}
```

dsh 的 surface 只有两种写操作 —— `append` 和 `replace`。这一行把 **`replace` 整个跳过了**，
而折叠恰恰就是一次 `replace`（N 条旧消息 → 1 条占位）。所以：

- 追加注入块：正常落地（`append` 分支）；
- 折叠历史：**永远被跳过**。

这就是「摘要进了提示词、历史没短」的全部原因。

### 2.1 为什么当初会写成这样（这个前提是错的）

`HANDOFF-03` 里写的结论是「surface 的 `replace` 在 dsh 上落不了地」，理由有三条。
重新核对 `dsh-session/lib/index.js` 之后，三条里**只有一条成立**：

| 当初的理由 | 复核结果 |
|---|---|
| 每轮重打 `§N§`，上一轮前缀成了真历史 → 无界增生 | **真问题**，解法是写 surface 前先把 `§N§` 剥掉（比对时也剥，剥完不算差异） |
| 把 `tool/result` 换成 `user/message` 会打断配对、服务端 400 | **前提错了**。`assertToolResultRewrite`（`index.js:345`）只在**替换事件本身是 `tool/result`** 时才约束配对；替换事件是 `user/message` 时不看这个。真正的约束是「切口必须工具配对平衡」—— 换一下切口就行，不是不能换 |
| `assistant/message` 不可替换 | **成立**，但只影响「1→1 内容改写」，不影响「N→1 折叠」 |

所以正确的结论是：**不是落不了地，是只能落一种形状**。而这一种形状（N→1 折叠）
恰恰就是我们要的那个 token 收益 —— 也就是 dsh 自带压缩的同款写法。

## 3. 改了什么

### 3.1 `lib/mc-adapter.js` —— `alignSurface` 重写

原来用**位置对位**比对，bundle 一重排（头部插块 + 打 ordinal）就认不出来，只能整段放弃。

现在用 **最长公共前缀 + 最长公共后缀**，在**剥掉 `§N§` 之后**的指纹上算：

- 前缀之后、后缀之前的这段，就是「变了的部分」；
- 输出**最多一个** `{kind:"replace", start, end, midA, midB, note}`，加若干 `{kind:"append"}`；
- 剥掉的 `§N§` 不产生差异 —— 这正是「同一条消息不算变更」的实现。
- 新增导出：`ORDINAL_RE` / `stripOrdinal` / `normText` / `isInjection`；`sameVisible` 改成 ordinal 无关。

**替换载体要剥掉 `§N§`**：折叠占位符优先复用 bundle 给的那条消息原文，而它带着
`§9§` 这种 ordinal。原文照写进持久日志 → 下一轮 bundle 再打一层 → `§10§ §9§` ……
每轮长一点，永不收敛。所以写入前先剥（比对照样剥），剥完不算差异，闭环才闭合。

**替换载体用 `user/message` + 一句短占位**（`[magic-context] 已折叠 N 条历史；摘要见系统提示的 compartment 区。`），
不把摘要正文再抄一遍 —— 摘要在系统提示里已经有一份，抄进来就是纯重复 token。

### 3.2 `lib/mc.js` —— `landOnSurface` 重写

顺序和三处约束（都要同时成立）：

1. **折叠（replace）必须在追加注入块之前做**。append 会改 `surface.nodes`，
   之后算出来的切口表就错位了 —— 这正是原来 `mismatch=1` 的来源。
2. **切口必须工具配对平衡**。切在 assistant `tool-call` 与它的 `tool/result` 中间，
   会把 `tool/result` 变成孤儿 → 服务端 400。做法是**向内收缩**到最近的合法切口
   （`while (start <= end && !cuts[start]) start += 1;` / `while (end >= start && !cuts[end + 1]) end -= 1;`），
   收缩掉的那几条继续可见。宁可少折，不可折错。
   判定用官方的 **`toolPairingBalancedBefore/After`**（`@deepseek-ai/dsh-compaction` 导出）；
   本仓的 `balancedCuts` 是它的本地等价实现（同一套 `eventDelta` 语义）。
3. **node 0 若是 `system/message` 要跳过**（`assertSystemHeadRewrite` 要求头节点只能被
   `system/message` 覆写），另外 `surfaceOp` 对象必须**恰好 3 个键**（`op`/`startSeq`/`endSeq`）。

新增诊断字段 `stats.reason`（`mid-kept-N` / `seq-mismatch` / `no-balanced-cut` / `no-shrink` / `append-threw`），
并且**把落地结果写进日志**：

```text
[mc] 折叠已落地：6 条 → 1（surface 30 → 20）
[mc] 注入块已落地 2 个（未折叠：no-shrink）
```

之前折叠没发生时一个字都不打，用户只能猜。这一条本身就是可观测性修复。

### 3.3 `stagePiShim` 的静默失败

`new URL("tools/pi-shim/", base)` 在 `base` 形如 `file:///…/repo`（**不带尾斜杠**）时，
会把最后一段当文件名替换掉 → 变成 `…/tools/pi-shim/`，于是**永远找不到源目录**、
返回 `null`、historian 子进程永远起不来。

现象很具有误导性：日志里是 `Model "new-api/tier-std" not found` —— 看起来像模型配置错了，
实际是**我们的伪 CLI 根本没上线，跑的是真 pi**。

包根 URL 带不带尾斜杠都是合法的传参，函数自己归一化：

```js
const base = packageRootUrl.href.endsWith("/") ? packageRootUrl : new URL(`${packageRootUrl.href}/`);
```

## 4. 证据

### 4.1 单测：`scripts/selftest-fold.mjs`（三个场景，跑真 `Session`）

| 场景 | 构造 | 期望 |
|---|---|---|
| A | 干净边界，折前 6 条 | 正常折叠，`folds=1` |
| B | 切口落在配对中间（但恰好平衡） | 仍能折 |
| C | 尾部切口不平衡（`end` 指向带 `tool-call` 的 assistant） | **向内收缩**后折叠，不产生孤儿 |
| D | 占位符原文带 `§9§` | 落地后 surface 上**不得出现任何 `§N§`** |

结果：`缩短 7→4 / 7→6 / 7→5 / 7→2`，四个场景**配对完整、相邻正确**、全部通过。

**回归守卫已实测会红**（两处，各自验证过）：

- 把收缩那行 `while (end >= start && !cuts[end + 1]) end -= 1;` 注释掉 → 场景 C 报
  `配对完整 ✗ (孤儿 0/1)`、退出码 1；
- 把 carrier 的 `stripOrdinaled(mid[0])` 换回 `mid[0]` → 场景 D 报
  `未泄漏 §N§: ✗`、退出码 1。

两处恢复后退出码均为 0。
（团队要求：守 regression 的测试必须被证明**能因回归而失败**，不能只证明它现在绿。）

### 4.2 端到端：`scripts/e2e-fold.mjs`（真 bundle + 真 historian）

不是桩。真 `stagePiShim` 上线伪 CLI → 真 `createPiFacade` → 真 `resolveBundle` 加载
`vendor/pi-magic-context` → 真 historian **spawn 真子进程、真调模型**。

```text
pi 伪 CLI: C:\Users\Administrator\.dsh\team-workflow\pi-shim
bundle 已挂载：工具 6 个
bundle context: 30 → 32
historian 交付 1 个 compartment（7s）
轮1: before=30 bundle=18 final=20 folds=1 悬空=0 孤儿=0
轮2: before=21 bundle=21 final=21 folds=0 悬空=0 孤儿=0
轮3: before=22 bundle=22 final=22 folds=0 悬空=0 孤儿=0
e2e ✓ 折叠落地 1 次
```

关键数字：**bundle 把 30 条压到 18 条**（这是 historian 交付后 bundle 自己的 `trimPiMessagesToBoundary`
`messages.splice` 干的），**`final=20`** 是折叠落地后 dsh surface 的真实长度（18 条 + 2 个注入块），
`folds=1`、**无孤儿、无悬空**。

### 4.3 真 dsh 里 `agent/pre-step → landOnSurface` 路径确证是活的

跑真 `dsh --profile mc-verify headless`，解压 `~/.dsh/sessions/<cwd>/session-*/session.v3.jsonl.zstd`
（**多帧 zstd**：按魔数 `28 B5 2F FD` 切帧、逐帧解，单次 `zstdDecompressSync` 只能拿到第一帧
的 211 字符，会误判成「日志是空的」）：

```text
事件 69 条 · 带 session-history 的注入块 9 处 · replace 0
```

注入块 9 处 = `landOnSurface` 的 append 分支**在真 dsh 里确实执行了**。
`replace 0` 只是因为这轮会话占用率才 11%→17%，没到 bundle 的三道触发闸。

### 4.4 bundle 的折叠确实会缩短数组（决定 replace 路径是否被行使）

顺 `vendor/pi-magic-context/dist/index.js` 追到真正的删除点：**`trimPiMessagesToBoundary`
（`index.js:24038`）**，结尾是 `piMessages.splice(0, …)`（`24080-24125`），
调用者 `replayCompletePiPrefix`（`25057`）/ `injectM0M1Pi`（`25096`）/ `25259`。

条件是 `row.cached_m0_last_baseline_end_message_id` 指向的边界**必须仍在 live compartment 里**
（`trimPiMessagesToCachedBoundary` 里的 `boundaryIsLive`）—— 也就是说
**只有存在 compartment 时才删消息**。`e2e-fold.mjs` 的 `30 → 18` 就是这条路径的实测。

结论：**replace 路径在生产里是被行使的**，不是死代码。

## 5. 真机日志：修复前的证据链

修复之前，真机（tauri profile）的日志把「折叠白算」这条链完整记了下来。

**折是折过 2 次的**（不是从没触发）：

```text
2026-09-24T21:50:21Z  compartment trigger: proactive fire at 79.2% (floor=63%)
2026-09-24T21:50:21Z  historian trigger fired — spawning subagent
2026-09-24T22:07:46Z  compartment trigger: proactive fire at 63.5% (floor=63%)
2026-09-24T22:07:46Z  historian trigger fired — spawning subagent
```

DB 里也确有 2 行（`compartments` = 2，创建于 21:51:53Z / 22:07:57Z，即本地 05:51 / 06:07）。

**但历史没有变短**，于是用量一路顶到 **92.0%**，超过 dsh 自带压缩的
`thresholdRatio: 0.9`（= 115,200 tokens），审计日志里压缩照常开火：

```text
compaction_prune  2026-09-25T04:45:43+08:00
compaction_start  2026-09-25T04:46:06+08:00
compaction_end    2026-09-25T04:46:39+08:00
compaction_start  2026-09-25T05:34:39+08:00
compaction_end    2026-09-25T05:34:54+08:00
compaction_start  2026-09-25T05:42:46+08:00
```

**这就是用户看到的现象**：magic-context 折了 2 次、摘要也进了系统提示，
用量还是撞到 92%、dsh 自带压缩还是开火 —— 因为折叠从没落到 surface 上，
历史一条没少。（上面这些压缩时刻都早于本次修复的提交时间 09:03，属于旧构建。）

## 5.1 修复后应该看到什么

修复落地后，同样是这两次折叠，日志里会多出：

```text
[mc] 折叠已落地：N 条 → 1（surface X → Y）
```

且用量应在 63% 附近被压回去，**不再爬到 90%** —— 这样 dsh 自带的压缩就只
在 90% 兜底，平时不抢 historian 的活。**这一条需要在真机上确认**（下面的下一步写了怎么验）。

## 5.2 复现测试时的观测（解释清楚，别误读）

用 `mc-verify` profile 压测时另有一套观测，和真机不同，记下来免得误判：

- 曲线 `11.3% → 12.3% → 17.0% → 49.0% → 50.4%`，停在同一句
  `not firing at 50.4% because unsummarized tail from 1 is too small`；
- 那是把`execute_threshold_percentage` 压到 20% 的测试配置下的现象 ——
  那个 profile 里历史总量才 ~62k tokens，可折头部 ~58k，触发闸的门槛与真机不同；
- `MC_CONTEXT_WINDOW` 在 `requestContext()` 能给出窗口时**不参与换算**（真 dsh 恒返回 128000），
  所以「压窗口」这个手段在真机无效，只能靠真堆内容。

**这些是 bundle 的触发闸行为，不是落地 bug** —— 落地的正确性由 4.1/4.2 单独证明。

## 6. 明确的天花板（说清楚，不是遗漏）

- **`context` 的请求级变换映射不过来**。dsh surface 表达不了「把每条消息原地重写成压缩文本」：
  `assistant/message` 带 `sourceEventSeqs` 直接抛；其余类型要求被遮蔽节点**恰好一个**
  且内容逐字相同（只有 `tool/result` 允许改内容）。这是 pi 上 magic-context 的主力机制，
  在 dsh 上是真天花板。**能落地的只有 N→1 折叠**，而那正好是停掉 dsh 自带压缩的那一刀。
- **一轮最多落一次折叠**。一次 replace 改 surface 下标，同轮再算不可信。historian 分段推进，
  一轮一次够用。
- **模型在 surface 上看不到 `§N§`**（我们主动剥了）。但 `ctx_expand` 的 ordinal 读取走
  bundle 自带的 raw-message provider（`readPiSessionMessages`），**不依赖 surface**，
  `ctx_search` → `ctx_expand` 链路照旧可用。
- **bundle 中段保留 M>1 条时跳过本轮折叠**（`mid-kept-N`）。一次 N→1 表达不了 N→M，
  不猜、不乱序，只落注入块。这是诚实跳过，不是失败。

## 7. 测试

```bash
node scripts/selftest-fold.mjs   # 三个场景 + 平衡切口守位（秒级）
node scripts/e2e-fold.mjs        # 真 bundle + 真 historian（分钟级，要能调模型）
```

`npm test` 现在跑 4 个自检：`selftest.mjs` / `selftest-mc.mjs` / `selftest-surface.mjs` / `selftest-fold.mjs`。
`e2e-fold.mjs` 单列 `npm run test:fold`（它要 spawn 真子进程 + 真调模型，不适合进默认 test）。

## 8. 下一步

- **观察**：真会话堆到 63% 以上、第 2/3 道闸满足时，日志里应出现
  `[mc] 折叠已落地：N 条 → 1（surface X → Y）`。
- **可能要做**：把 bundle 的 `execute_threshold_percentage` 从 65 调到 50 左右，
  让折叠先于 dsh 自带的 `0.9 thresholdRatio` 发生 —— 否则两边都等对方，谁都不动。
  这一条**需要实测定标**，不是拍脑袋。
- 用户需重启桌面应用确认：`/team-baseline` 的 mc 行、11 个 skill、`team` 预设挂载、
  子代理自选档、`web_search`。
