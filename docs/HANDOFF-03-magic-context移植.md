# HANDOFF 03 — magic-context 移植

> 承接 `HANDOFF-02-pi-lens与预设与安装.md`。
> 本阶段只做一件事：把 `@cortexkit/pi-magic-context` 架到 dsh 上，并跑通端到端。
> 结论先行：**能跑，但不是 1:1。** 下面写清哪里是 1:1、哪里是降级、为什么。

---

## 1. 一句话结论

magic-context **装不进 dsh**（它是 pi / opencode / omp 三家的宿主插件，CLI 的
`HarnessKind` 根本没列 dsh）。所以做法是**适配层 + 原封不动的官方 bundle**：
不重写它，只给它一个假 `pi` 对象，把它的能力接到 dsh 的缝上。

移植后**真正生效的能力**：

| 能力 | 状态 | 落点 |
|---|---|---|
| 系统提示注入（记忆块 / 引导语） | ✅ 1:1 | `systemPrompt.section` |
| 数据写入（会话、消息、标签、FTS 索引） | ✅ 1:1 | facade handler → DB |
| 6 个工具 `ctx_search/ctx_memory/ctx_note/ctx_reduce/ctx_expand/todowrite` | ✅ 可用 | `ctx.tools.register` |
| 7 个命令 `ctx-status/ctx-flush/ctx-recomp/...` | ✅ 可用 | `ctx.commands.register` |
| `<session-history>` 历史块注入 | ⚠️ 降级 | 尾部追加（pi 是头部） |
| 历史消息 `§N§` 序号前缀 | ❌ 不落地 | 见 §3，dsh 无此缝 |
| compartment 折叠（历史压缩） | ❌ 不落地 | 同上 |

**核心价值仍然在**：`ctx_search` → `ctx_expand` 链路走 bundle 自带的
raw-message provider，不依赖 surface 改写。所以「搜历史 → 展开原文」是可用的。

---

## 2. 关键机制：`agent/pre-step`

pi 的 `context` 事件是**请求级**的：拿整个消息数组进、出不落盘。
dsh **没有这个缝**。所有可写的地方（`agent/pre-step` 的 append、
session surface 的 `replace`）都写进**持久日志**。

```
dsh-agent-loop/lib/index.js
  :894   await this.dispatch.waterfall("agent/pre-step", {...})
  :1021  buildRequest(...)
  :1166  buildRequest 读 session.surface.replaceGeneration
  :1204  const boundaryMessages = session.deriveMessages()
```

水落契约（`dsh-agent/lib/types/runtime-types.d.ts:313`）：

```ts
'agent/pre-step'(this: Scoped<Agent>, payload: {
  agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal
}, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

`payload.messages` 只是**本轮新认领的收件箱消息**，不是完整历史 ——
所以不能在这里「改写历史」，只能 append 或改 surface。

---

## 3. 踩过的三个硬坑（都实测过，不是读文档猜的）

### 坑 1：`assistant/message` 不可替换

```
Error: assistant/message embeds its source stream
```
`planSurfaceEvent` 只要发现新事件是 `assistant/message` 且带 `sourceEventSeqs`
就直接抛（`dsh-session/lib/index.js:285`）。这是类型级限制。

### 坑 2：`tool/result` 的 data 形状不是 Message

```ts
// dsh-session/lib/types/types.d.ts:351
'tool/result': { turn, step, message: ToolResultMessage, error?, meta? }
```
按 Message 传 → `Cannot read properties of undefined (reading 'content')`。
而且**就算形状对了也不该换**：把 tool/result 节点换成 user/message 会打断
assistant `tool_calls` ↔ tool-result 的配对，供应商直接 400：

```
Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
```

### 坑 3：bundle **原地改**传入的数组

`pi.on("context")` 的 handler 是 `event.messages.push(...)` + 逐条打 `§N§`，
**原地改**。所以：

```js
// ❌ 快照和 before 是同一个对象 → diff 永远为空 → 假成功
const before = session.deriveMessages();
const out = await emit("context", { messages: before });

// ✅ 传一份、留一份
const snapshot = structuredClone(session.deriveMessages());
const out = await emit("context", { messages: structuredClone(snapshot) });
```

这个坑伪装成「适配层工作正常」，实际什么都没变。

### 为什么最后不做 replace（额外发现）

把 pi 的 `context` 输出铺到 surface 上，每轮都会：

1. 重打一遍 `§N§` —— 上一轮的输出已经成了真历史，下一轮再叠一层，**无界增生**；
2. 重排数组（system 提到最前）—— 与 dsh 自己的顺序管理打架。

实测第二轮 `before` 里 `[0][1]` 就是第一轮的注入产物，且被再次编号。
**这不是「再调一下就好」，是模型不匹配。**

---

## 4. 落地实现

### 4.1 系统提示注入（唯一干净的 1:1）

bundle 的 `before_agent_start` 返回 `{systemPrompt}`，纯字符串拼接、零副作用。
dsh 原生 `systemPrompt.section` 正好对应。

**坑**：`PromptSection.text` 的类型是 `string | ((ctx) => string)` —— **不是 Promise**。

```ts
// dsh-system-prompt/lib/types/index.d.ts:60
readonly text: string | ((context: AssembleContext) => string);
```

bundle 的 handler 是 async，直接当 `text` 会崩：`text.indexOf is not a function`。
而且 `AssembleContext` 只有 `{scope?, signal?}`，**拿不到当前 systemPrompt**。

解法：闭包里异步刷新，`text` 同步吐缓存值。

```js
let mcBlock = "";
const refreshBlock = async () => {
  const out = await facadeRef.emit("before_agent_start",
    { type: "before_agent_start", systemPrompt: "", prompt: "" });
  mcBlock = typeof out?.systemPrompt === "string" ? out.systemPrompt.trim() : "";
};
if (inner.systemPrompt?.section) {
  inner.systemPrompt.section({ name: "magic-context:block", order: 700, text: () => mcBlock });
}
void refreshBlock();
```

时序：`agent/pre-step` 在 `step()` 的 `systemPrompt.project` 之前，所以那里
刷新完，同轮提示就是新的。

### 4.2 `landOnSurface` 只做一件安全的事

```js
// 只 append bundle 新产生的 <session-*> 注入块，按文本去重。
for (const change of alignSurface(before, after)) {
  if (change.kind !== "append") { stats.skipped += 1; continue; }
  for (const message of change.messages) {
    const text = textOfMessage(message).trim();
    if (seen.has(text)) { stats.skipped += 1; continue; }   // 去重
    seen.add(text);
    session.append("user/message", toEventData("user/message", message), { surfaceOp: "append" });
  }
}
```

### 4.3 存储隔离（Phase 1）

上游的守卫：共享库 + 机器上有老 build 的 pi 在跑 → **fail-closed 拒绝启动**。

```js
// 上游判断「是不是默认共享库」
if (!XDG_DATA_HOME && MAGIC_CONTEXT_TEST_DATA_DIR) return false;  // → 不是
```

只换 `MAGIC_CONTEXT_STORAGE_DIR` **没用**（仍被判为共享库）。
`MAGIC_CONTEXT_TEST_DATA_DIR` 是上游自己留的隔离通道。

```js
process.env.MAGIC_CONTEXT_STORAGE_DIR  = dir;
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
```

代价：关掉 embedding provider（Phase 1 用不到）。

---

## 5. 验证证据

### 自检（可重复）

```
node scripts/selftest.mjs           ✓ 系统提示段 / 命令 / 审计落盘与脱敏 / 节流统计 / 异常隔离
node scripts/selftest-mc.mjs        ✓ 适配层把 magic-context 挂起来了
node scripts/selftest-surface.mjs   消息序列真的变了 ✓ / 含 <session-history> 注入 ✓
                                    ordinal 未污染 surface（预期）✓ / 注入块未重复堆积 (2) ✓
```

### 真机端到端

```
dsh --profile mc-verify headless "只回答两个字：收到"
→ 收到        （无 400）
```

### DB 侧硬证据

系统提示注入**真的生效**（修复前 `system_prompt_hash` 全空）：

```
session_id                        hash                              tokens  counter
session-6316410c-78ce-4065-b3da   7aca8b0e4332df031f4d6a077ec7e14c  1384    0
session-42fbc531-e2d6-4cf4-9eb5   7aca8b0e4332df031f4d6a077ec7e14c  1384    4
session-d76bc194-5b86-4980-9dba   7aca8b0e4332df031f4d6a077ec7e14c  1384    4
```

数据摄取**按会话隔离**：

```
source_contents 24   session_meta 6   tags 24   message_history_index 5
按会话: 5 个 session_id，各 4~6 条
```

独立库：`~/.dsh/storages/memory/cortexkit/magic-context/context.db`
（`schema_migrations` max **90**，与 bundle 的 `LATEST_SUPPORTED_VERSION` 一致）。

---

## 6. 调试方法（值得复用）

`ctx.logger.info` 在 headless 里**看不见**；audit-log 只记白名单事件类型。
所以临时加了个 `writeDiag` 写 `C:/tmp/dsh-mc-diag.log`。

**这一招救了这个阶段**：因为 `lib/mc.js` 当时漏了 `import * as fs from "node:fs"`，
`writeDiag` 里的 `ReferenceError` 被 `catch {}` 吞了 —— 诊断代码**静默失效**，
看起来像「handler 根本没触发」。补上 import 后才看到真相。

诊断已清理（`writeDiag` 及其调用全删，`fs` import 一并移除）。

---

## 7. 已知天花板 / 未做

| 项 | 说明 |
|---|---|
| `§N§` 不在模型可见的历史上 | 模型不能直接引用序号；`ctx_expand` 靠 bundle 内部 provider 仍可用 |
| compartment 折叠未落地 | 历史不会被压缩 —— 长会话依赖 dsh 自己的 compaction |
| `<session-history>` 在尾部而非头部 | 语义偏移，但内容一致 |
| 15 个 handler 只接了 `context` + `before_agent_start` | 其余（`message_end` / `tool_*` / `session_*`）实测数据已在入库，走的是 facade 默认路径；尚未逐个核对 |
| embedding provider 关闭 | Phase 1 用 `MAGIC_CONTEXT_TEST_DATA_DIR`，代价见 §4.3 |
| 共享库未切换 | 见 §8 |

---

## 8. 共享库切换（Phase 2，待用户操作）

用户已确认：**先独立库跑通，再切共享**。现在独立库已跑通。

切共享前必须：
1. 用户关闭两个还在跑的 pi 进程（PID **22736 / 42508**，持有共享库）；
2. `npx @cortexkit/magic-context@latest doctor` 把共享库 v85 → v90；
3. 去掉 `MAGIC_CONTEXT_TEST_DATA_DIR`（只留 `STORAGE_DIR` 指向共享路径）。

共享库现状：`~/.local/share/cortexkit/magic-context/context.db`
41,328,640 B，`schema_migrations` max **85**（bundle 要 **90**）。

> ⚠️ **不要按进程名杀 node** —— pi 自己就是 `node.exe`。
> 按命令行特征过滤：
> ```powershell
> Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
>   Where-Object { $_.CommandLine -like '*<特征>*' } |
>   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> ```

---

## 9. 本阶段改动文件

| 文件 | 改动 |
|---|---|
| `lib/mc.js` | 头部注释重写（写明结论与天花板）；`toEventData` 补 `tool/result` 形状；`landOnSurface` 收窄为「只去重追加注入块」；接 `systemPrompt.section`；诊断代码清理 |
| `lib/mc-adapter.js` | `alignSurface` 改位置对齐；`textOfMessage` 导出；`toDshParameters` 返回完整 JSON Schema + 剥 TypeBox 标记 |
| `scripts/selftest-surface.mjs` | 断言更新为当前契约（ordinal **不**落地、注入块不重复） |
| `vendor/pi-magic-context/` | 官方 0.43.0 bundle（gitignored，`dsh-team mc install` 重建） |

---

## 10. 下一步

1. 逐个核对 15 个 handler 的 dsh 侧对应，确认没有漏（尤其 `session_before_compact`）。
2. 让 `/team-baseline` 命令展示 mc 行（`magic-context：开 工具 N 改写 N 尾部注入 N 跳过 N`）。
3. 用户重启桌面端 → 确认 `/team-baseline`、11 个 skill、`/thrift` `/audit-log`、`team` 预设。
4. 重派 reviewer 复核（上一轮 1800s 超时，无报告）。
5. 与用户确认是否执行 Phase 2（切共享库）。
