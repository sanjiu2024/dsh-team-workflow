# HANDOFF-08 · 思考链与工具调用的展开

> 阶段：日报薄弱点修复 + UI 展开（第 1 批，只做侦察与定位，**未改任何代码**）
> 上游版本：`pi-workflow 1.13.1`；本包：`dsh-team-workflow 0.3.1`
> 起始 HEAD：`fc56741 docs: 按真机日志修正 HANDOFF-07 的原因判断`
> 本文件记录的是**已确证的结论 + 未落地的方案**，供下一轮直接动手。

---

## 1. 需求原文

用户提了两件事：

1. 看 `docs/usage/2026-09-25.md`（token 用量日报），针对日报指出的**薄弱点**和**建议修复点**做修复。
2. deepseek harness 默认**无法展开思考链（reasoning）**，**工具调用也无法展开** —— 让它们能展开。

**结果**：第 1 件只做了侦察、没动手；第 2 件定位完成、方案已明确但**未落地**。本文件把两者都交接清楚。

---

## 2. 需求 2 的真实结论（先纠正前提）

用户最初描述是「无法展开」。侦察后**该前提不成立**，已用提问澄清：

| 项 | 结论 |
|---|---|
| 思考行能不能展开 | **能**。`ReasoningRow` 硬编码 `expandable: true, expandOnRowClick: true` |
| 工具行能不能展开 | **能**。`ToolRow` 的 `expandable = bodyRaw != null \|\| outputText !== null \|\| card !== null` |
| 真实诉求（用户原话） | **「能展开，但是默认是折叠状态，能不能默认就是展开状态」** |
| `transcriptView` 怎么处理（用户原话） | **「保持 normal，只要求修单行展开」** |

即：**这不是 bug，是默认折叠**。要的是「默认展开」，且**不要**改 `transcriptView`。

---

## 3. 已确证的渲染链路（含证据）

### 3.1 桌面端真实加载的前端

磁盘上只有**一份** chat 渲染器（穷举 `grep -rl ReasoningRow AppData/Roaming AppData/Local` 只有 1 个 `client.js` + 1 个 `.d.ts`）：

```
C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/
  @deepseek-ai/dsh-client-ui-chat/lib/client.js        # 361.4K，真正的渲染器
```

排除项（都验证过，**不是**真凶）：

- `dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`（542.9K）—— 只是**宿主壳**，里面
  `transcriptView` / `compactTranscript` / `foldable` / `ReasoningRow` **计数全为 0**；
  它靠 `window.__ModuleLoader__.load({id, factory})` 在**运行时**动态加载
  `@deepseek-ai/dsh-client-ui-*`，所以壳里没有组件是对的。
- `deepseek-harness-desktop.exe`（28.4M）—— Tauri 外壳，`ReasoningRow` / `transcriptView` /
  `message.think` / `__ModuleLoader__` 计数**全为 0**，不内嵌前端。
- 第三方 `dsh-tauri-ui` / `dsh-better-sidebar` / `dsh-rewind-plugin` / `dshmarket` ——
  都没注册 `conversation.chat.node` / `tool.call.toolview`，没碰 `turn-process`。
  `dsh-tauri-ui` 只注册了
  `conversation.hero.workspace` / `settings.section` / `settings.onboarding` /
  `settings.launcher` / `settings.trigger` / `conversation.chat.turnTail`（纯 CSS 美化）。

### 3.2 思考行的默认折叠点

`dsh-client-ui-chat/lib/client.js`：

```js
function ReasoningRow({ text, running, t }) {
    const [expanded, setExpanded] = (0, react.useState)(false);   // ← 默认折叠
    const summary = (running ? latestLine(text) : firstLine(text)).replaceAll("**", "");
    return ... DisclosureRow({
        open: expanded,
        expandable: true,
        expandOnRowClick: true,
        onToggle: () => { setExpanded((value) => !value); },
        collapsedContent: <摘要行>,
        children: <div className={thinkBody}>{text}</div>          // ← 展开体
    })
}
```

CSS 无异常：`.lcKema_root:not([data-expanded]){contain:size layout;height:calc(24px + …)}`，
展开靠 `data-expanded`，没有 `display:none` 陷阱。

### 3.3 工具行的默认折叠点

`dsh-client-ui-tool/lib/client.js`：

```js
function ToolRow({ ..., bodyRaw, output, ... }) {
    const [expanded, setExpanded] = (0, react.useState)(false);   // ← 默认折叠
    const card = askQuestionBody ?? terminalBody ?? diffBody ?? readBody ?? imageBody ?? searchBody ?? webBody;
    const expandable = bodyRaw != null || outputText !== null || card !== null;
    const open = expanded && expandable;
    return ... DisclosureRow({ open, expandable, expandOnRowClick: true, onToggle: toggleExpand, ... })
}
```

### 3.4 底层的开合原语（可放心依赖）

`dsh-web-frontend` 里的 `DisclosureRow`（导出名 `Yp`）：

```js
function Yp({icon,title,open,expandable,onToggle,expandOnRowClick=false,...}){
    const b = expandable && expandOnRowClick;      // 只有 expandable 且点整行时才绑 onClick/role/tabIndex
    ...
    "data-disclosure-row": true,
    "data-expandable": b || void 0,
    role: b ? "button" : void 0,
    "aria-expanded": b ? open : void 0,
    onClick: b ? onToggle : void 0,
}
```

即：**`expandable:true` + `expandOnRowClick:true` 时整行可点**，行为正确。

### 3.5 `transcriptView` 的确切语义（本轮用户已明说不动它）

- 字段：`ui-chat.transcriptView`，取值仅 `"normal"` / `"compact"`，**dsh 默认 `"compact"`**
  （`DEFAULT_TRANSCRIPT_VIEW_MODE = "compact"`，注释：*Default preserves the compact process
  disclosure introduced by Chat*）。
- 用户当前是 `normal`（`~/.dsh/settings.yaml:56-57`）。
- 它**只影响「过程」折叠区**，不影响单行开合：

```js
const compactTranscript = useTranscriptView((mode) => mode === "compact");
const processWindowReady = … && compactTranscript && …;
const foldable = processWindowReady && (processMember || ownsDisclosure && (…));
const processHidden = controllerInactive || foldable && processMember && !processOpen;
```

`TurnProcessNodeView` 在 `!foldable` 时 **`return null`** —— 这是 `normal` 下「过程折叠行不出现」的
**设计行为**，不是 bug。用户在 `normal` 下看到的每个思考行/工具行都是独立的、**可各自点开**的。

### 3.6 数据侧完全正常（排除「没内容可展开」）

解出真实 session（zstd 多帧，magic `28 B5 2F FD`）后统计：

| session | assistant 消息 | 含 reasoning | 推理字符 | tool-call 块 |
|---|---|---|---|---|
| `task-1aa8728d-…` | 6 | 6 | 7,181 | 6 |
| `session-a1111fb0-…` | 16 | 16 | 40,245 | 18 |
| `session-9f9ce00a-…` | 4 | 4 | 6,857 | 5 |

块形状（UI 直接读这两个字段，完全对得上）：

```json
{"type":"reasoning","text":"Let me understand the task. …"}   // keys: type,text
{"type":"tool-call","id":"call_17f8ed22…","name":"pwsh","arguments":"…"}
```

`toAssistantBlock()` 的映射也无损：

```js
case "reasoning": return { kind: "reasoning", text: block.text };
case "tool-call": return { kind: "tool-call", callId: String(block.id), name: block.name, argsRaw: block.arguments };
```

**结论：数据在、映射在、组件可展开 —— 唯一「问题」是初始 `useState(false)`。**

---

## 4. 现状：没有现成的配置开关

穷举 `dsh-client-ui-chat/lib/client.js`：`defaultOpen` / `defaultExpanded` / `initiallyOpen` /
`expandByDefault` **全部不存在**。全仓 settings namespace 里也没有对应字段
（只有 `transcriptView` 那一个）。

→ **「默认展开」在当前安装的 dsh 版本里，没有任何官方配置入口。**

---

## 5. 待选方案（下一轮动手前需定）

### 方案 A：客户端扩展插件（推荐方向，未验证可行性）

新写一个 dsh **client 端插件**，注册进 `settings.general.item` 或直接接管
`conversation.chat.node` 的 `assistant-step` / `tool-call` key，fork 出「默认展开」版本的行组件。

- 形态参照 `dsh-tauri-ui`：
  ```js
  // package.json
  "dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-layout"], "platform": "web" }, ... }
  // dist/client.cjs
  window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => { … } });
  ```
- **未验证的关键点**：`ctx.slots.register({name, key})` 对**同一个 key 重复注册**时是
  覆盖、追加还是报错。`dsh-client-ui-slots` 这个包在本机**找不到**（`dsh-client-ui-primitives`
  与 `dsh-client-ui-dockkit` 同样只在 `@deepseek-ai` 清单里出现过、无实体目录），
  **必须先定位它的真实实现**才能确认方案 A 可不可行。
- 优点：不动用户安装树（符合「不改用户安装树，用 vendor/插件」的红线）。
- 风险：`ReasoningRow` / `ToolRow` **没有导出**，只能整行替换；且 chat 的内部
  `useChat` store 是 `dsh-client-ui-chat` 私有的，fork 版组件能否拿到同样 props 未知。

### 方案 B：改安装树（**违反既有红线，不推荐**）

直接改 `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 的 `useState(false)` → `useState(true)`。

- 优点：一行、必然生效。
- 缺点：改用户安装树；桌面端升级/修复安装即丢失；此前已定红线
  **「Never mutate the user's pi install tree — vendor instead」**，同类问题不该破例。
- 若用户明确接受一次性 hack，必须先备份该文件并写进本文档的「已知偏离」清单。

### 方案 C：先不做，给用户 `transcriptView: compact`

回到 dsh 默认值，用官方「过程折叠区」把一轮的思考+工具收成一行，点开看全部。
**用户已明确拒绝**（选了「保持 normal，只要求修单行展开」），故排除。

---

## 6. 需求 1：日报薄弱点侦察（只侦察，未修）

日报：`docs/usage/2026-09-25.md`（生成脚本 `scripts/usage-report.mjs`，均他人（用户第二个会话）所写）。
数据源：`~/.dsh/storages/audit-log/2026-09-25.jsonl`（10,669 行）。

### 6.1 日报给出的关键数字

- 会话 94 / 轮次 99 / 步 1,450 / 模型请求 1,437 / 工具调用 1,936 / 结果 2,009 / 工具错误 74
- 计费输入 78,647,221（未命中 3,916,597 + cacheRead 74,730,624 + cacheWrite 0）
- 输出 1,083,050；**推理 reasoning = 0**；缓存命中 95.0%
- 平均 prompt 54,730；**峰值 120,887（窗口 128k 的 94.4%）**
- 耗时：模型等待 76.5% / 工具执行 23.5%

### 6.2 日报指出的薄弱点

| 项 | 数字 |
|---|---|
| 工具结果占计费输入 | **87.3%**（read 放大后 33.5M / 42.7%，同一文件最多读 **47 次**） |
| `ctx_memory` 错误率 | **73.9%** |
| `ctx_search` 错误率 | **72.7%** |
| `ctx_note` 错误率 | **85.7%** |
| `ctx_reduce` 错误率 | **71.4%** |
| `todo_write` 错误率 | 16.7% |
| read 平均大小 | 7,224 字符/次；单条最大 58,335 字符 |
| 重复调用浪费 | 约 210,653 字符 |
| rtk 合规 | 94.2%（56/966 未走 rtk） |
| 14 步缺时间戳 | — |
| 建议 | read 会话内缓存、联网搜索查询缓存 |

### 6.3 `ctx_*` 高错误率的侦察结果（**未定根因**）

- 审计日志**不记错误正文**：`tool_result` 只有 `isError:true`、`errorCode:null`、
  `resultChars`、`resultSha256`。
- 从 `tool_call` 侧 `argsPreview` 看到的失败形状：
  `ctx_memory {action:get, ids:[1..20]}`、`ctx_note {action:read, filter, limit}`、
  `ctx_search {query, limit}`、`ctx_memory {action:write, category, content}`。
- 脚本统计到 ctx_* 失败样本 38 条（临时脚本里 `lim` 未定义报错，属脚本 bug，不影响统计）。
- **下一步需要**：拿到真实错误正文。可行做法是自己复现调用（用 `tools/mc-probe.mjs`
  或 `createPiFacade` 直驱 `ctx_*` 工具），而不是从审计日志反推。

### 6.4 已建 todo（均 pending，未动）

- #25 侦察 dsh TUI 的思考链/工具调用渲染 ← **本文件即其产出**
- #26 修 `ctx_*` 工具的高错误率
- #27 落地 read 重复读取的抑制

### 6.5 附带发现：日报的「reasoning = 0」与事实矛盾

日报统计 `reasoning tokens = 0`，但 §3.6 已证明 session 里 reasoning 字符几十万。
原因未查（怀疑是 provider 返回的 usage 里没有 reasoning token 字段 / 日报读错字段名）。
**这是一条独立的待查项**，与「默认展开」无关，但会污染日报的推理统计。

---

## 7. 本轮排除的错误方向（避免下一轮重走）

1. **「`transcriptView: normal` 导致展不开」** —— 错。`normal` 只关掉「过程」折叠区，
   单行不受影响。曾据此改过 `~/.dsh/settings.yaml`，**已用备份还原为 `normal`**
   （`cp /tmp/settings.bak ~/.dsh/settings.yaml`，还原后 `transcriptView: normal` 已复核）。
2. **「桌面端用的是另一份前端」** —— 错。exe（28.4M）、`dsh-web-frontend`（宿主壳）、
   第三方 bundle 均已逐一验证，磁盘上只有一份 `dsh-client-ui-chat/lib/client.js`。
3. **「数据里没有 reasoning 块」** —— 错。§3.6 已实测出大量 reasoning 块。
4. **「`DisclosureRow` 拦住了点击」** —— 错。`b = expandable && expandOnRowClick` 逻辑正确。

---

## 8. 交接清单

- **代码改动**：本阶段 **0 行**（仅一次 `settings.yaml` 试改并已还原，工作树 `git status --short` 干净）。
- **HEAD**：`fc56741`，与 `origin/master` 一致。
- **下一轮第一件事**：先定位 `dsh-client-ui-slots` 的真实实现（本机 `find` 不到其目录），
  确认同 key 重复注册的语义 —— 这直接决定方案 A 可行与否。
- **若方案 A 不可行**：回来问用户，是否接受方案 B（改安装树）这种一次性 hack；
  不要擅自破「不改用户安装树」的红线。
- **需求 1（日报修复）**：仍未动手。建议顺序 `ctx_*` 根因（需先复现拿错误正文）→
  read 会话内缓存 → 搜索查询缓存。注意 read 缓存是**改工具的共享行为**，
  先 `grep` 全部调用方再动（团队规范）。
