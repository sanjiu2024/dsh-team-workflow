# REQ-035 · 移植 dsh-superagent（GitHub 主动代理）

- **状态**：待审
- **对应版本**：`2.21.x → 2.22.0`（加能力 → minor）
- **上游**：`https://github.com/deepseek-ai/dsh-superagent-prototype`（MIT，0.1.0，TS 92 文件 10784 行）
- **提出**：2026-11-08，用户原话「帮我完整移植这个仓库里面的 superagent」＋确认「把能力重写进
  dsh-team-workflow（零依赖纯 ESM）」「监听 dsh-team-workflow 仓库本身（dogfood）」

---

## 1. 要做什么

把 superagent 的**核心闭环**做进本仓库，成为团队模式的一个子系统：

> 监听 GitHub 仓库上「被授权的人提出的请求」→ 按 Policy 判定放行 → 开一张 Ticket →
> 在**它自己的 agent session 和目录**里干活 → 回原对话（评论或 PR）。

四个部件，一个都不能少：

1. **Source**：GitHub 轮询（issue/PR 评论里的指令），可扩展到 Feishu
2. **Policy**：谁能让它干活（白名单 + 规则），以及什么能碰（目录/prepare/禁用命令）
3. **Ticket**：工作项的生命周期（pending → running → needs-human → done/failed）
4. **Panel**：一个「需要人处理」的列表（挂在本仓库已有的工具箱/面板机制上）

## 2. 不做什么

- **不装它的 bundle**（`dsh plugin add link:`），不改它的源码 —— 它是 alpha.2 写的，
  本机 rc.5，且它的 `stateDir` 校验 `pattern(/^\//)`、启停脚本是 Python+fcntl+tmux，
  在 Windows 上本来就得改。重写比适配便宜。
- **不引入它的技术栈**：不用 TypeScript 源码 + tsbuild（本仓库「改完源码即生效」靠的就是
  零构建）；不用 `zod`（宿主有 schemastery，但本仓库约定零运行时依赖）；不用 `node:sqlite`
  （Node 24 有，但本仓库已有 JSON 落盘习惯，且 SQLite 让状态文件不可读）。
- **不引入 React**：它的面板是 React，本仓库 `lib/client.js` 用 `h()` 手写；
  面板按本仓库的 op 机制做，不开新路由。
- **Phase 1 不做 Feishu**：只做 GitHub 一个 Source，但 Source 接口留出来。
- **不做它的 gh wrapper**（`GH_CONFIG_DIR` 隔离）：直接用本机已有的 `gh` + 现有凭据。

## 3. 验收标准（每条都要能跑）

| # | 怎么验 |
| --- | --- |
| A1 | `dsh-team superagent status` 打印：轮询状态、仓库、上次轮询时间、未处理 Ticket 数 |
| A2 | 在 dsh-team-workflow 仓库开一个 issue 并 `@bot` 式留言，**在 Policy 白名单内** → 60s 内出现 Ticket，进入 running |
| A3 | Ticket 执行时**独立 session + 独立 worktree**（不是当前会话），日志能落盘到 `~/.dsh/team-workflow/superagent/` |
| A4 | 执行完**回到原 issue 评论**（贴出它做了什么 + 分支名），Ticket 置 done |
| A5 | Policy 外的人留言 → **不执行**，Ticket 置 rejected，并在面板可见（不静默丢弃） |
| A6 | 面板（工具箱）能看到 Ticket 列表与状态，可手动 retry / cancel |
| A7 | `npm test` 全绿；新增自检覆盖 Policy 判定与 Ticket 状态机（含反向实验） |

## 5. 已知约束（调研结论，2026-11-08）

上游的硬事实（来自 `docs/006-deployment.md`、`src/index.ts:8`、`src/deployment.ts:15-23`）：

- **11 个硬 inject**：`agents`、`sessionController`、`sessionPersistence`、`workspaceRegistry`、
  `permissionPresets`、`tools`、`systemPrompt`、`skills`、`webServer`、`llm`、`subprocess`
- **配置只有 4 个键**（其余全进 settings/SQLite）：`stateDir`（必填绝对路径）+
  `promptMaxChars` / `admissionContextMaxPages` / `admissionContextTimeoutMs`
- **GitHub 身份**靠 `GH_CONFIG_DIR` 的 gh wrapper；**Feishu** 靠 bot-only `lark-cli`
- **Session 固定 `danger-full-access`**（`sessions.ts:152`）；两个 preset 行
  `dsh-superagent-worker` / `-router` 不可禁用，否则 resume 报 `agent-preset/not-found`
- 面板要求 `webServer` 是 loopback 且能注册 `/orchestrator` 前缀，请求要带
  `x-orchestrator-request: 1` + 同源

本仓库能复用的（比上游更省事的部分）：

- `lib/scheduler.js`（2121 行）：**agent 创建 + 沙箱/审批钉死 + 工具 restrict + 落盘** 全是现成的
- `lib/worktree.js`（769 行）：工作区隔离
- `lib/toolbox.js`（432 行）+ `lib/client.js`：面板 op 机制（白名单 + 两段式确认）
- `lib/commands.js`：CLI 命令注册

**Node 的 type stripping 实测结论**（决定写法，2026-11-08 本机 Node 24.21）：

```text
纯类型注解的 .ts 直接 import           → IMPORT_OK function 44
含 enum 的 .ts                         → ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
exports 指向 .ts 的包（实目录装 node_modules） → ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
同一包改用 junction 到 node_modules 外  → SYMLINK_OK
```

→ 结论：**dsh 插件不是「必须 JS」**，但 `.ts` 只在「安装路径 realpath 不在 node_modules 内」
且「不用 enum/namespace/装饰器/参数属性」时能跑。本仓库要**装进别人的 profile**，
别人可能用 `npm i`（实体 node_modules）→ **不能赌**。所以源码仍是 **纯 ESM `.js`**，
类型靠 JSDoc + `// @ts-check`，`npm run typecheck` 跑 `tsc --noEmit`（不产出）。

## 6. 方案

**不逐行翻译，按能力映射到本仓库骨架**：

| 上游部件 | 本仓库落点 | 做法 |
| --- | --- | --- |
| Source（GitHub 轮询） | `lib/superagent/source-github.js` | 新写。`gh api` 拉 issue/PR 评论，按 `since` 增量 |
| Policy | `lib/superagent/policy.js` | 新写。纯函数：`(event, policy) → { allow, reason }` |
| Ticket 状态机 | `lib/superagent/ticket.js` | 新写 + JSON 落盘（`stateDir/tickets.json`） |
| 独立 session 执行 | 复用 `lib/scheduler.js` 的 agent 创建路径 | 已有：沙箱钉死、审批 never、工具 restrict、worktree |
| Prompts / Skills | 复用 `skills/` + `team/RULES.md` | 已有 |
| Web 面板 | `lib/toolbox.js` 加 op + `lib/client.js` 加页 | 已有机制 |
| 命令 | `lib/commands.js` 加 `/superagent` | 已有机制 |

**分期**（每期独立可验收）：

- **Phase 1（本轮）**：Source(github) + Policy + Ticket + 执行 + 回评论 + `/superagent status`
- **Phase 2**：面板（Ticket 列表 / retry / cancel）
- **Phase 3**：Feishu Source
- **Phase 4**：多仓库、prompts 可配、并发上限

**风险与对策**：

- **轮询打爆 API**：默认 60s + `since` 增量 + ETag；`gh api` 有速率头，超限退避
- **它改自己仓库**（dogfood）：执行一律在 **worktree** 里，主工作区不动；PR 由人审
- **安全**：Policy 默认空 → **谁都不能触发**（fail-closed）；白名单只认 `author_association`
  为 OWNER/MEMBER/COLLABORATOR 且 login 在名单里

## 7. 计划审查

（待派 `subagent_power` 审完填）
## 7. 计划审查（2026-11-08，subagent 审，只判断不动手）

**结论：原计划的顺序反了，另有两处必须先解决。** 全部采纳，已按它重排。

### 更简单的路（采纳 3 条）

- ✅ **Issue 标签即 Ticket**：状态机放 `sa:queued/running/done` 标签，本地只留评论 id 游标，
  省掉本地状态机的并发问题。Phase 2 再考虑要不要搬到本地。
- ✅ **Phase 1 先砍 Source**：用 `/superagent run <issue#>` 手工触发，先把最厚的
  「执行 + 回评论」验通；轮询放最后。
- ✅ **必须显式触发词**：已实现（`/agent`，fail-closed）。否则授权人说句「LGTM」
  就起一个 danger-full-access 会话。
- ⏸ **复用 scheduler 的落盘记录当 Ticket**：待验 —— 要先看它的 run 记录能否加
  `trigger/status/link` 三字段，别新写第二份存储。

### 会怎么坏（四条全部写进设计）

- **游标与执行不原子** → 崩在「跑完」与「存游标」之间会重复开 worktree、重复推送、重复评论。
  对策：**先 claim（`comment_id` 幂等键）再 spawn**。
- **`since` 与 ETag 是两套增量**，混用会漏（`since` 不含正文/关闭，304 又不给游标）
  → **只用 comment id 高水位**。
- **「回评论」最可能返工**：未验 scheduler 能否拿到 agent 的**最终输出**（不是运行状态）
  → 排在执行层之后立刻验，拿不到就是隐藏大改。
- **JSON 单写者假设**：轮询/回调/面板三处读改写必丢更新 → **串行队列 + `tmp→rename`**，
  Windows 遇占用会 EPERM，要重试。

### 顺序（已重排）

```text
原：Source → Policy → Ticket → 执行 → 回评论
新：幂等 claim → 执行 + 结果捕获（手工触发）→ 回评论/PR → Source
```

前三步离线可测，不依赖网络。Policy 的入参形态先行定死（人用 GitHub login 标识 +
repo 白名单 + 触发词），它才可能是稳定纯函数 —— 已实现。

### 硬点（两条已落地，三条列为 Phase 1 前置）

- ✅ **凭据不进 agent**：issue 正文是不可信输入，session 又固定 `danger-full-access`；
  推送与发评论交给编排层，agent 只许写 worktree。
- ✅ **只开 PR，不本地合并**：主仓库常年 dirty，`worktree_merge` 会拒，`.git/index.lock` 还会争用。
- ⏳ **fcntl 锁不是 tmux 的附属品**：它防的是同一 `stateDir` 双跑（两个 dsh 窗口、重启残留）；
  去掉必须在 Node 侧补 lockfile + 心跳 —— Phase 1 前置。
- ⏳ **cwd 必须断言 == worktree**：子代理 cwd 继承父会话，只有 squad 被工具层钉住；
  加越界反向测试（`../`、绝对路径）。
- ⏳ **gh 认证开机自检**：`gh auth status` + 所需 scope；后台进程可能拿不到 keyring，
  失败要显式停在「未认证」，不能静默不轮询。

## 8. 验收记录

（Phase 1 完成后填）
