# HANDOFF-06 —— magic-context 折叠修好了

承接 `HANDOFF-03`（移植）与 `HANDOFF-04`（上下文减负）。这一阶段只做一件事：
**把「折叠永远不触发」这个 bug 修掉，并留下可复现的证据。**

对应版本：`0.2.2 → 0.2.3`（patch）。

## 1. 症状

插件装进 dsh 之后：

- `systemPrompt.section` 注入生效了（`## Magic Context` 那块能在系统提示里看到）；
- 但 `compartments` 表**恒为 0 行**，折叠从来没发生过一次；
- `~/.dsh/storages/memory/magic-context.log` 里每次触发评估都是同一行：

```text
historian trigger eval: usage=0.0% (0 tokens) [piUsage fallback], checking trigger...
compartment trigger: not firing at 0.0% — below proactive floor (63%)
```

`0 tokens` 是假的 —— 会话明明有上万 token。

## 2. 根因：字段名对不上，且失败时假装 0%

bundle（`vendor/pi-magic-context/dist/index.js`）这样取占用率：

```js
// L29418
piUsage = ctx.getContextUsage?.();
```

然后读的是 **`piUsage.tokens` / `piUsage.percent` / `piUsage.contextWindow`**
（触发评估在 L30390–30430）：

```js
usageContextLimit = isSaneLimit(piUsage?.contextWindow) ? piUsage.contextWindow : undefined;
// …
const fallbackPercentage =
  isSaneLimit(usageContextLimit) && piUsage.tokens > 0
    ? piUsage.tokens / usageContextLimit * 100
    : piUsage.percent;
```

我们适配层原来返回的是 `{ contextWindow, usedTokens }`：

| 字段 | bundle 要的 | 原来给的 |
| --- | --- | --- |
| `piUsage.tokens` | ✓ | ✗ |
| `piUsage.percent` | ✓ | ✗ |
| `piUsage.contextWindow` | ✓ | ✓ |

于是 `percent` 是 `undefined`：

1. 早退判据是 `piUsage.percent === null` → `undefined === null` 为 **false**，所以**不退**；
2. 走 fallback 分支，`piUsage.tokens > 0` 也是 false（`tokens` 同样不存在）；
3. 结果 `usage = undefined ?? 0` → **`0.0%`**。

`0%` 永远低于 63% 的主动折叠下限，所以折叠静默失效。**这就是「注入生效但折叠不动」的全部原因**，
不是架构问题，不是缺 seam。

### 2.1 顺带修掉的第二个坑：`ctx.tokenMeter` 会抛

拿真实数字要走 dsh 官方的 token 计量服务 `ctx.tokenMeter`：

```js
ctx.tokenMeter.measure(session).totalTokens   // ← 抛异常
```

cordis 的 `ctx` 是访问器代理，**没在 `inject` 里声明就直接读会抛**
`cannot get property "tokenMeter" without inject`，**不是返回 `undefined`**。
所以「try 一下不行就算了」的写法其实直接炸。

正确写法是 `ctx.get("tokenMeter")` —— cordis 官方的「不要求 inject 的读取器」
（`@deepseek-ai/cordis/lib/types/reflect.d.ts`）：

```js
get<K>(name: K, strict?): undefined | this[K]   // 读服务但不要求 inject
```

同时**不把 `tokenMeter` 加进静态 `inject`**：静态 `inject` 是「必须有」，加了会让插件
在没有 token-meter 的环境里整体加载失败。用 `ctx.get` 读、拿不到就降级，才是对的。

## 3. 改动

`lib/mc-adapter.js`：

```js
getContextUsage: () => {
  const session = sessionRef.session;
  if (session === null || session === undefined) return null;
  const measure = measureSessionTokens(ctx, session, log);
  if (measure === null) return null;
  const { tokens, contextWindow } = measure;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const percent =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? (tokens / contextWindow) * 100
      : null;
  return { tokens, percent, contextWindow };   // ← bundle 读的就是这三个名字
}
```

新增 `measureSessionTokens(ctx, session, log)`：

- `tokens`：`ctx.get("tokenMeter")?.measure(session).totalTokens`；
  拿不到就退回字符估算 `ceil(chars / 3.5)`（本机没有 `ai-tokenizer`，只能估算）；
  再拿不到就 `null`；
- `contextWindow`：`session.requestContext().contextWindow` → `MC_CONTEXT_WINDOW` → `128000`；
- 两个分开的 `try` 块 —— 直接读抛异常时不能把后面的 `ctx.get` 短路掉。

### 3.1 「宁可跳过，不报 0%」

这是这次最关键的一条设计决定：

- 拿不到数据 → **返回 `null`**，bundle 早退、这一轮不评估；
- **绝不返回 `0%`**。

因为 `0%` 看起来像一个**合法的「上下文是空的」读数**，会让折叠**静默地**永不触发；
`null` 只是「这轮不知道」，下一轮拿到数据照样能触发。
用 `0` 当「未知」是这里唯一真正危险的地方 —— 它把 bug 伪装成了正常状态。

## 4. 证据

### 4.1 单测守门（可反向验证）

`scripts/selftest-mc.mjs` 新增断言：

```text
占用率上报：90000 tokens / 128000 = 70.3%（阈值 63%，会触发折叠）
```

断言三件事：

1. 字段名必须是 `tokens` / `percent` / `contextWindow`；
2. `measureSessionTokens` 从 tokenMeter 桩里能取到 `{tokens: 90000, contextWindow: 128000}`；
3. 所有来源都空时返回 `null`，**不能是 `0`**。

**反向验证过**：把字段名改回 `usedTokens` 立刻红：

```text
AssertionError [ERR_ASSERTION]: 必须叫 tokens —— bundle 读的是这个名字
```

### 4.2 真实日志：从 `0.0%` 变成真实增长值

修之前：

```text
historian trigger eval: usage=0.0% (0 tokens) [piUsage fallback]
```

修之后（真实 headless 会话）：

```text
historian trigger eval: usage=11.8% (15079 tokens) [piUsage fallback]
historian trigger eval: usage=12.0% (15300 tokens) [piUsage fallback]
historian trigger eval: usage=12.9% (16518 tokens) [piUsage fallback]
```

### 4.3 决定性证据：在**真实默认 65%** 下真的折叠了一次

先说明**:第一道门（占用率）过了，还有第二道门** —— bundle 要求未折叠的 tail 够大
（`MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12` 或 `MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE = 6000`，
见 `vendor/pi-magic-context/dist/index.js:18175`）。所以光过 63% 还不够，
得是一个**真正长的会话**。这一点是 bundle 自身设计，不是移植缺陷。

跑到长会话后，日志里在 **`executeThreshold=65%`** 下拿到：

```text
[21:57:19] [magic-context][pi] registered historian trigger (model=new-api/tier-std, executeThreshold=65%)
[22:07:46] [magic-context][session-cc69b50b-…] compartment trigger: proactive fire at 63.5% (floor=63% projected post-drop=none target=48.8%)
[22:07:46] [magic-context][session-cc69b50b-…] historian trigger fired (reason=projected_headroom) usage=63.5% — spawning subagent
[22:07:57] [magic-context][session-cc69b50b-…] historian: published 1 compartment(s), 0 fact(s) covering messages 1-85
```

落库确认（直读 SQLite）：

```text
compartments 行数: 2
最近一条: session-cc69b50b-… p1=1053字 p2=377字 p3=136字 p4=52字
```

**这就是「折叠真的会发生」的闭环证据**：占用率 → 过 63% 下限 → 触发 historian →
生成 P1–P4 四级摘要 → 写进 `compartments` 表。

## 5. 排查路上踩到的两个坑（记录一下，省得下次再撞）

### 5.1 `--patch` 只能覆盖已存在的条目，不能插入

```text
dsh: patch: entry "tm-probe" not found
```

`--patch` 覆盖只对**已有条目**生效；要在 profile 里插新行，必须写进 profile 自己的
`cordis.patch.yml` 的 `- insert:` 下。

### 5.2 `execute_threshold_percentage` 的 schema 下限是 20，不是随便填

第一次想临时把阈值压到 15 来提前触发，结果被 schema 静默拒绝、回落默认值：

```js
// vendor/pi-magic-context/dist/index-5tw61yhp.js:7863
execute_threshold_percentage: union([
  number2().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE),
  object({ default: number2().min(20).max(90, …) }).catchall(…)
]).default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE)
```

配置**确实被加载了**（`config loaded from: ~\.config\cortexkit\magic-context.jsonc`），
但值不合规就回落。判断依据是启动那行：

```text
registered historian trigger (model=new-api/tier-std, executeThreshold=20%)   # 合法值 → 生效
registered historian trigger (model=new-api/tier-std, executeThreshold=65%)   # 15 被拒 → 回落
```

另外配置键是**顶层 snake_case**（`execute_threshold_percentage`），不是嵌在
`historian` 块里的 camelCase。排查用的配置已还原成备份，
`diff` 逐字一致，没有残留。

## 6. 已知上限 / 没做的部分

- **折叠的第二道门没动**：未折叠 tail 要 ≥12 条消息或 ≥6000 token。这是 bundle 的
  设计（防止刚开场就折叠），不是缺陷。正常长会话自然会过。
- **本机没有 `ai-tokenizer`**，token 数是字符估算（`chars / 3.5`）。
  所以占用率是**近似值**，触发时机可能比真实值早或晚一点。要精确就得装 tokenizer，
  目前不值当。
- **`compartment` 的产物仍然只能落到 `systemPrompt.section`**（order 700），
  不能改写 surface —— 这条上限在 `HANDOFF-03` 里已经如实记录过，这次没有变化。
- **15 个 bundle 事件处理器仍未逐个验证**，特别是 `session_before_compact`。

## 7. 验证清单（本次全绿）

```text
node scripts/selftest.mjs        → ✓ 版本一致 / 搜索解析 / 异常隔离 …
node scripts/selftest-mc.mjs     → ✓ 适配层把 magic-context 挂起来了
node scripts/selftest-surface.mjs→ ✓ 注入块未重复堆积 (2)
node bin/dsh-team.mjs mc check   → ✓ 完整 runtime 已挂载，context 改写生效
node bin/dsh-team.mjs preset install → 自检：除 compaction 那一行外与 standard 逐字一致 ✓
```

版本：`package.json` `0.2.3`，`CHANGELOG.md` 有 `## [0.2.3]`，自检核对两处一致。
