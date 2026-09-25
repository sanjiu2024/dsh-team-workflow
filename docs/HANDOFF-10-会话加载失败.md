# HANDOFF-10：会话加载失败（重启后对话全没了）

> 症状：重启 dsh 后历史对话全部消失，报
> `stored session "task-1aa8728d-…" is corrupt: session event at seq 28 message must have role "user"`。
>
> 结论：**是 dsh-team-workflow 自己写坏了会话日志**，两个独立根因。已修源码 + 已修数据（158+12 处 / 5 个会话）。

## 1. 为什么必须开一个交接

这不是「某个功能不工作」，是**用户数据被静默破坏**，而且破坏发生在写盘时、暴露在下次重启时。
中间的窗口期没有任何提示 —— 用户看到的一切都正常，直到重启。

两个根因都属于同一类错误：**dsh 对 surface 消息的校验在 append 时不跑，只在重新加载时跑**。

```js
// dsh-session/lib/types/invariant.js —— user/message 没有任何字段约束
case 'user/message':
    break;
```

而重新加载走的是另一条路，校验很严：

```js
// dsh-session/lib/index.js:928 assertMessageEventShape（被 adoptSessionEvent 调用）
if (typeof message["id"] !== "string" || message["id"] === "") throw new Error(`${subject} lacks an identified message`);
if (messageRecord["role"] !== expectedRole) throw new Error(`${subject} message must have role "${expectedRole}"`);
```

一句话：**append 时不校验的字段，必须由写入方自己守住。** 这条教训写进了下面两个修复点的注释里。

## 2. 根因 1：`§N§` 剥不掉 → assistant 消息被写成 `user/message`（158 处）

### 链路

1. `lib/mc-adapter.js` 的 `stripOrdinal` 只锚字符串开头：`/^§\d+§\s*/`。
2. 但 `textOfMessage` 把 reasoning / text / tool-call 各块的 `.text` 用 `\n` **拼成一个串**：

   ```js
   return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
   ```

3. bundle 只给 **text 块**打 `§N§`，不打 reasoning。于是 ordinal 落在拼接串的**中段**
   —— 实测在真实数据里是下标 603 —— `^` 锚点匹配不到，剥不干净。
4. `normText` 比较不相等 → `sameVisible` 返回 false → 已存在的 assistant 消息被
   `alignSurface` 的「最长公共前后缀」判成**新增消息**。
5. 走 append 分支 → `lib/mc.js` 的 `toEventData("user/message", assistantMsg)`：
   当时写的是 `role: message?.role ?? "user"`，**沿用了 assistant 消息自带的 role**。
6. 一条 `role:"assistant"` 的 `user/message` 落盘。append 不校验 → 静默。
7. 重启重载 → `adoptSessionEvent` → `assertMessageEventShape` 抛
   `session event at seq 28 message must have role "user"` → **整个会话加载失败**。

### 修法

**修 1**（`lib/mc-adapter.js`）：逐行剥，不再是只锚开头。

```js
export function stripOrdinal(text) {
	return String(text ?? "")
		.split("\n")
		.map((line) => line.replace(ORDINAL_RE, ""))
		.join("\n");
}
```

**修 2**（`lib/mc.js`）：`user/message` 的 role 不再沿用调用方，强制为 `"user"`。

```js
const role = type === "user/message" ? "user" : (message?.role ?? "user");
```

两处都必要：修 1 让已存在的消息被正确识别（不再产生副本），修 2 保证**即使**产生副本，
形状也是合法的。

### 为什么不是只修 1

修 1 依赖 `stripOrdinal` 永远剥得干净。bundle 是外部依赖，它换一种打 ordinal 的方式
（比如给 reasoning 也打、或打在行中），修 1 就重新失效。修 2 是**兜底**：写盘前强制
形状，任何上游变化都不会再产生坏数据。

## 3. 根因 2：`additionalContexts` 缺 `id`（12 处）

`lib/lens.js` 在 `tools/post-execute` 里往模型上下文塞检查报告：

```js
{ role: "user", content: [...], source: { kind: "plugin", plugin: "team:lens" } }
```

少了 `id`。加载期 `assertMessageEventShape` 要求它是非空字符串，报
`lacks an identified message`。

修法：补 `id: randomUUID()`。

## 4. 修数据

工具：`node scripts/fix-mc-corruption.mjs [--fix]`（不带参数只扫描，有损坏退出码 1）。

修法**只有一种**：只改 `role` / 只补 `id`，其他字段一律不动。试过的两条路都走不通：

| 想法 | 结果 |
| --- | --- |
| 摘掉 `surfaceOp`（让它退回纯日志、不污染上下文） | ✗ `surface-eligible and requires a surfaceOp marker` |
| `surfaceOp: {op:"replace", startSeq:seq, endSeq:seq}` 自替换 | ✗ `startSeq and endSeq must reference earlier events` |

**代价（已知，接受）**：role 被改的那批会作为「多出来的用户消息」留在 surface 上。
内容上它们接近已有的 assistant 消息（本来就是 bundle 重排的产物），所以不影响正确性，
但会多占一些 token。已修的那个会话实测多了 6 条。

### 验证

```bash
node scripts/verify-sessions.mjs      # 端到端：跑 dsh 真实的重启恢复路径
```

这个脚本不自己复刻校验逻辑 —— 它起一个最小 cordis 应用、挂 dsh 自己的持久化插件、
调 `readColdSessionLog`，也就是**用户重启 dsh 后恢复历史对话走的那条路**。
用户报的错正是从那里抛出来的（`dsh-session-query/lib/index.js:295`）。

结果：**12/12 全部加载成功**。

反向验证过：从含坏数据的备份恢复后，它**逐字复现了用户的原始报错** ——

```text
✗ task-1aa8728d-06ef-4dd5-a979-99dc1159b173
    stored session "task-1aa8728d-…" failed validation:
    Error: session event at seq 28 message must have role "user"
```

修复后再跑，12/12 通过。另外逐事件比对修复前后的文件：**12/12 只差 role/id，零非预期差异**。

> 为什么不用 `adoptSessionEvent` 就够了：它只做**事件局部**校验。实测它只抓到 1 个会话
> （`lacks an identified message`），而 cold-read 抓到 5 个 —— 后者包含跨事件的
> surface 还原，才是真正的加载路径。

## 5. 修数据工具自己踩的坑：多帧 zstd 不能靠搜 magic 切

`~/.dsh/sessions/*/session.v3.jsonl.zstd` 是**多帧拼接**的（dsh 每次 append 写一帧）。
第一版修复脚本用 `Buffer.compare` 搜 `28 B5 2F FD` 切帧 —— 压缩数据里偶然出现这 4 个
字节就会切错，把一行 JSON 劈成 `"9"` `"1"` 这样的碎片。

dsh 自己用的是**结构化扫帧**：解析帧头（magic / descriptor / contentSize / dictID），
再逐块跳（3 字节 blockHeader + payload）。复刻在 `lib/session-log.js` 的 `scanZstdFrames`，
并与 dsh 源码里的同名函数**逐字节比对过 12/12 一致**。

回归测试见 `scripts/selftest-mc-shape.mjs` §6：构造一个含假 magic 的 payload
（压缩后 magic 命中 2 次、真实只有 1 帧），搜 magic 的实现会在此变红。

## 5b. 同类隐患：`toEventData` 的三个死分支（已删）

`toEventData` 原本为四种 surface 类型各留了一个分支，但 `landOnSurface` 只写
`user/message` —— 其余三个从没被调用过，而且**全是坏形状**：

| 类型 | dsh 要求的 source | 当时写的 |
| --- | --- | --- |
| `assistant/message` | `{kind:"model", provider, model}` | `{kind:"plugin"}` ✗ |
| `tool/result` | `{kind:"tool", callId}`（且块里的 toolCallId 要一致） | `{kind:"plugin"}` ✗ |
| `system/message` | 未验证 | `{kind:"plugin"}` ? |

留着它们的风险是具体的：哪天有人启用其中一条，就是**同型事故二号** —— 而且在
append 时同样不会报错。已删掉，把四种类型的完整信封形状写成注释备查。

> 这条是独立审查抓出来的（我原本只把 `tool/result` 当成「一个小瑕疵」）。

## 6. 防复发

| 手段 | 位置 |
| --- | --- |
| `stripOrdinal` 逐行剥 + `role` 强制 | `lib/mc-adapter.js` / `lib/mc.js` |
| `lens` 的 message 带 `id` | `lib/lens.js` |
| 形状自检（复刻 dsh 的校验判定，零依赖） | `scripts/selftest-mc-shape.mjs`，已进 `npm test` |
| 全量会话过 dsh 真实 cold-read 加载路径 | `scripts/verify-sessions.mjs` |
| 结构化扫帧 + 回归测试 | `lib/session-log.js` + 自检 §6 |

已经在 `npm test` 链里，所以**这类写盘形状错误以后会在 CI 里红，而不是在用户重启后红**。

## 7. 天花板 / 未做

- **扫描面只覆盖了 role、id 与可读性** 三类。`assertMessageEventShape` 还要求
  `source.kind` 非空、`content` 是数组等。要全字段覆盖，`verify-sessions.mjs`
  已经能做（它直接走 dsh 的加载路径），但 `fix-mc-corruption.mjs` 只会修
  role/id —— 其它字段的损坏需要新修法。
- **`verify-sessions.mjs` 只在找得到 dsh 安装树时跑**（`DSH_MODULES` 可覆盖），
  找不到就跳过并明说。它读的是本机真实会话目录（只读）。
- **没做自动修复**：`--fix` 是手动跑。让插件在启动时自愈是另一件事，风险也更大
  （改的是用户数据），要单独评估。
- **已修的那批副本仍占一点上下文**：role 被改的条目变成「多出来的用户消息」留在
  surface 上（见 §4），无法在不破坏加载的前提下移除。已修会话实测多 6 条。
