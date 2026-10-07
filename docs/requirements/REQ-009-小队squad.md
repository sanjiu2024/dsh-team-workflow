# REQ-009 · 小队（squad）：主 agent 建多个小队、成员一起朝目标推进

> 状态：**已完成**（2026-10-08。§5/§6 的调研与侦察结论都在正文里；验收记录见 §8）
> 起于 2026-10-06。名字叫「小队」而不是「团队」，是因为这个包本身就叫
> `dsh-team-workflow`、系统提示里那一大段叫「团队基线规范」——「团队」在这套东西里
> 已经指**规范**，再拿它指**运行时的一群子 agent**，两边都会看不懂。

## 1. 要做什么

- 主 agent 能创建**小队**。一个小队 = 一个目标 + 一份成员名册 + 一块共享黑板。
- 主 agent 能往小队里**加成员**（成员是子 agent，仍然用现有的 `subagent_std` /
  `subagent_power` / `subagent_max` 创建，小队只负责把「谁在队里、干什么」记下来）。
- 成员一起朝目标推进，**进展写到共享的地方**，别的成员和主 agent 都读得到。
- 主 agent **可以不参与小队的具体产出**：它只当协调者 —— 派活、收结果、汇总、
  决定要不要继续推进；成员的活它不干。
- 主 agent 能**同时建多个小队**，各自的目标、名册、黑板互相独立。
- 入口：**工具为主**（`squad_*`，与 `worktree_*` 同一套路），看状态用 **Web GUI 的
  「小队」面板**（侧栏入口 + 主面板，能进每个成员的会话）。
  **不做 `dsh-team squad` CLI 子命令**：状态在 dsh 进程内存里，另一个进程读不到，
  做出来只会是个永远空的表（详见 §6.1 与 §7）。

## 2. 为什么（不做的后果）

现在派子 agent 是「一次性」的：一次派一个、结果回来就结束。多个子 agent 之间
**不能互相说话**（dsh 的 `send_message` 只允许父↔子），所以：

- 三个子 agent 同时调研同一件事的三个方向，各自的发现**无法汇到一处**，只能都回到
  主 agent 的对话里，靠主 agent 转述 —— 主 agent 的上下文成了唯一的共享内存，
  它一压缩，细节就没了。
- 「谁在队里、谁在干什么、目标推到哪一步」全靠对话记着，跨轮就散。
- 想同时推进几件事（几个目标），只能靠主 agent 自己记住「第 3 轮那个还等着回复」，
  一多就乱。

小队把这三样东西变成结构化的：**目标、名册、黑板**。

## 3. 不做什么

- **不做落盘持久化**：状态只在当前会话有效（主 agent 明确选的）。会话结束/重启后
  小队就没了，**不做**「下次会话把没做完的小队捡起来」。这也是为什么不需要
  `$DSH_HOME/team-workflow/squads/*.json`。
- **不设成员上限**（主 agent 明确选的）。`squad_status` 会显示成员数与在跑数，
  那是**信息**，不是闸门；不拦、不拒。
- **不自动合并成员产出的代码**：合并回主分支永远由主 agent 决定（沿用 REQ-001 的
  worktree 规矩：写代码的成员各用一棵 worktree）。
- **不替代 `subagent_*`**：小队不创建会话、不选档位。成员的创建仍然由主 agent 调
  `subagent_std/power/max`，小队只登记结果。
- **不做预算/成本闸门**：不数 token、不掐轮数。
- **不改 dsh 安装树**（`~/.npm/_npx/...` 那份缓存）。调研结论：**不需要改** ——
  客户端插件（`exports["./client"]`）+ 宿主 HTTP 路由这两条现成机制就够（§6.3），
  所以这一条从「待定」变成「确定不做」。
- **不做成员之间直接对话**：调研结论见 §6.4 —— 技术上够得着，但缺一个 `createUserMessage`
  的产物，试验没做，**不做**；成员之间靠黑板（写进 §7）。

## 4. 验收标准

| 标准 | 怎么验（可执行） |
| --- | --- |
| 纯逻辑对 | `node scripts/selftest-squad.mjs`：建队/加成员/成员状态推进/黑板追加/多小队互相隔离/汇总措辞，全绿 |
| 权限真的是认证 | 同一自检第 3 段：所有者 / 成员 / 外人三种视角 —— 外人看不到别人的队（连队名都不出现），成员改不了别人那一行 |
| 面板真能看 | 同一自检第 7 段：真加载 `lib/client.js`（classic script）、真渲染 —— 成员名/任务/状态/worktree/黑板都在，「进入会话」把 `agentId` 交给 `uiWorkspace`，没绑 id 的按钮禁用 |
| 面板取数只走宿主 | 同一自检第 6 段：真调路由处理函数，`/options` 与 `/squads` 200，路径不对 404，**跨站/非回环请求 403** |
| 挂进主套件 | `npm test` 退出码 0、`grep -c "^✗"` = 0，且命令数从 19 变 20 |
| 工具能被 dsh 认 | `node scripts/selftest-tool-schema.mjs` 全绿（新工具进它的清单，schema 合规） |
| 版本号与 CHANGELOG 一致 | `node scripts/selftest.mjs` 里那条「版本一致」断言通过（加能力 → minor） |
| 审查 | 三层全过（第 1 层 `subagent_std`、第 2/3 层 `subagent_power`），意见落到改动上 |

## 5. 已知约束（侦察出来的硬事实）

以下每条都有出处，`文件:行号`。dsh 版本 `0.2.0-rc.2`，检出在
`/home/sanjiu/.npm/_npx/1e7f6d9597241db0/`（下称 CHECKOUT）；本包内的行号截至起草时。

1. **注册工具的写法**（照 `worktree_*` 抄）：
   `ctx.tools.register({ name, description, parameters: toParameterSchema({…}), output: { schema, render }, async execute(args, exec) })`
   → 返回一个 disposer（`lib/worktree.js:658`）；必填参数写在**属性层** `required: true`，
   由 `toParameterSchema` 编译成顶层 `required` 数组（`lib/util.js:186`）。
2. **`execute` 的约定**：返回值是**符合 `output.schema` 的对象**（不是字符串），
   `output.render` 把它转成 text 块；失败**不抛错**，返回 `{ text: "[失败] …" }`
   （`lib/worktree.js:675`、`:721`）。
3. **会话标识拿得到、且跨 turn 稳定**：`exec.agent.id` 就是 SessionId
   （`CHECKOUT/dsh-agent/lib/types/types.d.ts:11-13`），与 `exec.agent.session.id`
   （`CHECKOUT/dsh-session/lib/types/index.d.ts:123`）、`exec.agent.session.header.id`
   同值。`ctx` 上**没有**会话 id，只能从 `exec` 取。
4. **会话销毁事件存在**：`ctx.on("session/disposed", (session) => …)`
   （事件表 `CHECKOUT/dsh-session/lib/types/index.d.ts:52`，先例
   `CHECKOUT/dsh-session-telemetry/lib/index.js:69`）。没有 `session/end` / `session/close`。
   —— 这条是「状态只在当前会话」能做成真的关键：按 session id 存 + 销毁时清。
5. **插件 import 不了 `@deepseek-ai/*`**（软链 + ESM realpath，见 REQ-001 §5）。所以任何
   「魔改 dsh 内部行为」都得走别的路，不能直接调它的内部函数。
6. **dsh 自己的 `send_message` 只允许父↔子**（发给自己的直接子会话或父会话），
   兄弟之间发不了 —— 成员互通只能靠共享黑板，或（若调研证明可行）插件自己注册一个
   投递工具。调研结论见 §6.3。
7. **CLI 要改三处**：分发 switch `bin/dsh-team.mjs:1468`、help `:1052`、
   `dsh-team status` 的模块开关行 `:571`。
8. **工具 schema 自检的强制项**（`scripts/selftest-tool-schema.mjs:48-95`、`:218-235`）：
   `parameters` 必须是合法 JSON Schema（顶层 `type: "object"` + `properties`，
   顶层 `required` 是字符串数组且每项都在 `properties` 里，**属性层不许带 `required`**），
   `output.schema` 合法且 `output.render` 必须是函数，工具名不得重复。新模块**必须自己
   加进自检的安装列表并改 `expectedTools` 计数**（`:197-215`），否则新工具根本不被扫。
9. **`team/extensions/<名>.json` 的 `_说明` 是纯文档**（代码零引用）；`*_FIELDS` 是配置
   白名单校验器，**不声明该键 = 文件里写了也被静默忽略**（`lib/util.js:76-88`）。
10. **插件状态的作用域是进程**：`ctx.effect` 的 dispose 是**插件拆除**，不是会话结束。
    所以按 session id 存 Map + 靠 `session/disposed` 清，是唯一能做到「只在当前会话」的路子
    （先例 `lib/audit.js:91`）。
11. **子代理会话确实拿得到本包注册的工具**（实测，不是推测）：探活子代理的工具清单里有
    `worktree_new/list/merge/drop` 且**实调成功**（返回「没有本工具建的 worktree（仓库里一共
    1 棵）…」），另外它还有 `subagent` / `subagent_std` / `send_message` / `list_agents`。
    → 成员可以自己往共享黑板写、可以自己派自己的子代理、也可以直接给父会话（主 agent）发消息。
    这是「成员一起写同一块黑板」能成立的前提。
12. **agent id 就是子会话的 session id**（同值，不需要映射）：
    父方拿到的 `subagentId` 直接取 `startContinuable(...).childId`
    （`CHECKOUT/dsh-tool-subagent/lib/index.js:527`）；`childId` 由
    `spec.childId ?? brandString(randomUUID())` 产生并作为 `sessionId` 传给
    `ctx.agents.create`（`CHECKOUT/dsh-subagent/lib/index.js:1677`、`:1083`）；agent 的
    `this.id = id`（`CHECKOUT/dsh-agent-loop/lib/index.js:773`）与
    `Session.create(sessionId, …)`（`CHECKOUT/dsh-session/lib/index.js:1710`）同值。
    → **成员的身份可以按 id 认**，不必靠它自报名字（不是信任，是认证）。
13. **成员之间直投在技术上可行，但要绕开 dsh 的 `send_message`**：
    `send_message` 工具定义在 `CHECKOUT/dsh-tool-subagent-control/lib/index.js:23`，
    调 `ctx.subagents.sendMessage`（`:58`）→ `deliverToChild` → `SubagentInbox.deliver`；
    它**限直系父子**且 sender 必须是精确的 live Agent
    （`CHECKOUT/dsh-subagent/lib/index.js:1763`）。可达的替代服务：
    `ctx.get("subagents")`（`CHECKOUT/dsh-subagent/lib/index.js:2834`）、
    `ctx.get("agents")`（`CHECKOUT/dsh-agent/lib/index.js:332`），
    投递形如 `ctx.get("agents").get(id)?.followup(msg)`
    （`CHECKOUT/dsh-agent/lib/index.js:594` + `dsh-agent-loop/lib/index.js:806`）。
    **两个卡点**：① `msg` 必须是 `createUserMessage` 的产物（`dsh-llm`），而我们
    **import 不了 `@deepseek-ai/*`**（见第 5 条）—— 得实测「手搓一个同形状的对象能不能被接受」；
    ② 只有 live 会话在 store 里，归档/idle 的取不到。
    → 这条**先做试验再写代码**，见 §6.4；试验不成立就退回「只靠黑板」并写进 §7。
14. **GUI 里没有会话深链接**（这条决定了「进入某个成员的会话」只能怎么做）：
    入口只有 `http://127.0.0.1:3080/?token=<launchToken>`（`CHECKOUT/dsh-client-connection/lib/index.js:376`、`:405`），
    静态层只渲染 index、其余路径 404（`CHECKOUT/dsh-host-frontend-static/lib/index.js:59`、`:69`），
    前端 bundle 里**没有** `pushState`/`replaceState`/history 路由（`CHECKOUT/dsh-web-frontend/dist/assets/index-*.js` 里
    只有 React 合成事件名 `popstate`）—— `/s/<id>`、`#/<id>`、`?session=` 一律不存在。
    → 面板里「进入某个成员的会话」只能走**客户端 API 切会话**（待 §6.3 调研确认有没有），
    否则退回「面板显示会话 id，人在工作区列表里点」（子会话按 lineage 缩进可见，
    `CHECKOUT/dsh-api-session-controller/lib/types/client/sessions/lineage.js:18-44`；
    父会话行有运行中子代理计数，`CHECKOUT/dsh-client-ui-workspace/lib/client.js:450`）。
    另外 GUI **不设** `X-Frame-Options`（只写 content-type，`CHECKOUT/dsh-host-frontend-static/lib/index.js:73`），
    所以理论上可被同源 iframe 嵌入 —— 但没深链，嵌进去也只是首页，没意义。

## 6. 方案

分两半：**服务端**（小队状态 + 工具，本节 6.1/6.2）与**客户端面板**（6.3，待客户端插件
调研结论）。6.4 是先做试验再决定的一块。

### 6.1 服务端 `lib/squad.js`（状态 + 工具）

**状态**（进程内、按会话隔离，不落盘）：

```js
const squads = new Map();   // ownerSessionId → Map<squadName, Squad>
Squad  = { name, objective, note, owner, createdAt, members: Map<label, Member>, board: [], closed }
Member = { label, role, task, agentId, worktree, status, note, updatedAt }
board 条目 = { at, from, text }
```

- **清理**：`ctx.on("session/disposed", (session) => squads.delete(session.id))`
  —— 这就是「只在当前会话」的落地点（约束第 4 条）。
- **身份解析**：`exec.agent.id` 就是会话 id（约束第 3 条）。两种调用者：
  - **所有者**（建队的那个会话，通常就是主 agent）→ 拿 `squads.get(callerId)`；
  - **成员**（子会话）→ 在全部小队里找 `member.agentId === callerId` 的那一支。
    因为 agent id == session id（约束第 12 条），这是**认证**，不是让成员自报名字。
- **权限**：成员只能**看**自己所在小队、**写**黑板、**改自己那一行**；`squad_new` /
  `squad_add` / `squad_close` 只有所有者能做。成员碰不到别的小队（这也是「多小队互相隔离」
  能被测出来的地方）。两条例外（审查补的，见 §8）：
  - **`agent_id` 只有所有者能绑**：它是身份字段（决定谁能读写这个小队），而 `addMember`
    只能查「这个 id 有没有被别人占」，查不了「这个 id 是不是真的是你」—— 放开给成员
    等于让成员自己造一个身份。成员本来也不需要它：进队时所有者已经绑好了。
  - **收队 = 只读**：`squad_close` 之后 `squad_add` / `squad_update` / `squad_board`
    一律拒（名册与黑板留着能看）。不拒的话 `closed` 只是个标签，「关了」的不可逆语义是假的。

**工具 6 个**（`ctx.tools.register`，形状照约束第 1/2 条）：

| 工具 | 参数 | 干什么 |
| --- | --- | --- |
| `squad_new` | `name`(必), `objective`(必), `note`? | 建队；同会话内重名报错 |
| `squad_add` | `squad`(必), `member`(必), `role`(必), `task`(必), `agent_id`?, `worktree`? | 登记成员；给了 `agent_id` 就绑定，不给就是「待派」 |
| `squad_update` | `squad`(必), `member`(必), `status`?, `note`?, `agent_id`?, `worktree`? | 标记 在跑/完成/卡住、补 id、记一句结论。成员能改**自己那一行**的状态与结论，但**不能**绑 `agent_id`（身份字段，只有所有者能绑） |
| `squad_board` | `squad`(必), `text`(必) | 往黑板追加；`from` **自动判定**（所有者→「主 agent」，成员→它的 label），不给参数 —— 少一个能撒谎的入口 |
| `squad_status` | `squad`? | 看一个小队或全部；无小队时打一句人话 |
| `squad_close` | `squad`(必), `reason`? | 宣布结束（成员与黑板留在内存里，直到会话销毁） |

`squad_add` / `squad_update` 分开而不是合成 upsert：合成会让「`role`/`task` 有时必填」，
报错信息说不清。

**不做 `/squad` 斜杠命令，也不做 `dsh-team squad` 的状态输出**：状态在 dsh 进程的内存里，
另一个进程（CLI）读不到；面板就是视图。面板若最终做不出来，再补 `/squad` 兜底（见 §7）。

### 6.2 接线

- `team/extensions/squad.json`（配置 + `_说明`，`_说明` 是纯文档）+ `lib/index.js` 里
  `layered("team/extensions/squad.json", SQUAD_DEFAULTS, SQUAD_FIELDS, config.squad)`
  与 `ctx.effect(() => squad.dispose, "team:squad")`。
- 新模块必须加进 `scripts/selftest-tool-schema.mjs` 的安装列表并改 `expectedTools` 计数
  （约束第 8 条），否则新工具不被扫。

### 6.3 客户端面板

调研回来的三条硬事实决定了这一节的形状（约束第 14–18 条）：

1. **一个包只能有一个客户端入口**：`exports["./client"]` 是单文件，dsh 只认它。
   所以小队面板**不能另起一个文件** —— 它和定时任务面板住在同一个文件里，
   于是 `lib/scheduler-client.js` 改名成 `lib/client.js`（改名本身在 CHANGELOG 里说明）。
2. **客户端不能直接问服务端要数据**（没有 Typert Remote 给第三方用的路子），
   只能走宿主 HTTP 路由：`ctx.webServer.register({kind:"prefix", path, handler})`。
3. **UI 扩展点是槽位**：`ctx.slots.register`。面板挂两个槽 ——
   `sidebar.panellist`（入口，`id` 必须等于主面板的 `key`）与 `main`（面板本体）。

**服务端加的只读路由**（都在 `SQUAD_ROUTE_PREFIX = "/api/team/squad"` 下）：

| 路由 | 返回 |
| --- | --- |
| `GET /options` | `{ok, boardLimit}` —— 探活用，面板据此判断「宿主侧是不是把 squad 关了」 |
| `GET /squads` | `{ok, count, squads:[…]}` —— 全部小队（每条带 `owner`，客户端据此分组）。**没有 `me`**：路由拿不到调用者身份（这正是它只读的原因） |

**只有 GET，没有写路由**：建队、加人、改状态、写黑板全部走那 6 个工具，
它们过 `authorize()`（成员/所有者/外人三种视角），而且能拿到 `exec.agent.id` 这个
认证过的身份。HTTP 路由拿不到调用者是谁，**在路由上开写口等于把权限判据丢掉**。
面板是视图，不是第二个入口 —— 这也是它「只读」的原因。

**信任栅栏**：`lib/api-http.js`（从 `scheduler.js` 里原样搬出来的，两个面板共用一份）。
四个条件全满足才放行：回环地址（`127.*` / `::1` / `::ffff:127.*`）、回环 Host、
`sec-fetch-site !== "cross-site"`、Origin 同源。任一不满足 → 403。
负例在自检第 6 段真跑（跨站、非回环都拒）。

**面板里有什么**：一列小队卡片（队名 / 是否已收队 / `N/M 完成` / 黑板条数 / `owner` 会话 id /
目标）。卡片是**点选式**的 —— 点一下展开那一个（`selected` 态），展开后才显示成员与黑板；
一次只展开一个，不是多张同时摊开的折叠卡（一个页面里同时摊开几个小队，成员一多就找不到北）。
展开后成员一行显示 角色·状态·任务·worktree 绝对路径·结论，外加一个**「进入会话」**按钮
（`ctx.uiWorkspace.openSession(agentId)`，成员 `agentId` 就是子会话 id；没绑 id 时按钮禁用
并说明为什么）。黑板倒序显示最近 50 条，带作者与时间。5 秒轮询一次，卸载时清掉定时器
（自检里真断言了「安排的轮询 == 清掉的轮询」，漏一个就是每开一次面板多一个常驻定时器）。

**面板显示的是「这台 dsh 里全部小队」，不是「当前会话的队」**：`main` 是 keyed 槽、
拿不到 Session 绑定（约束第 16 条），所以服务端把 `owner` 一起发下来，客户端据此分组。
同理**不显示会话标题**（`useSessions` 的 prop 形状没验证过，宁可不显示也不猜）。

**只读面板的暴露面**：能访问宿主 HTTP 端口的本地进程就能读到全部小队内容 ——
和定时任务面板同一个信任模型（都是「本机回环 = 可信」），写在 §7。

### 6.4 `squad_say`：先做试验再决定

成员间直投在技术上可达但要绕（约束第 13 条），两个卡点都只能靠实测：

1. **手搓消息对象行不行**：`followup(msg)` 要的是 `createUserMessage` 的产物，而我们
   import 不了 `dsh-llm`。试验：拿一个同形状的普通对象（`{ role: "user", content: [...] }`）
   投给一个真子会话，看它是被接受还是被拒。
2. **idle 成员能不能被叫醒**：`agents.get(id)` 只对 live 会话有效。试验：等成员跑完一轮
   （idle）再投一次，看能不能起来。

试验成立 → 做 `squad_say(squad, to, text)`（只有成员能用，只能投给同队成员）；
不成立 → 退回「只靠黑板」，把卡点写进 §7，并在工具文案里明说「成员之间不能直发，请写黑板」。

## 7. 天花板（做完之后仍不支持的）

- **成员之间不能直接对话**（`squad_say` 没做）。§6.4 的两个卡点一个都没试：
  `followup()` 要 `createUserMessage` 的产物而本包 import 不了，以及 idle 成员能不能被叫醒。
  成员之间、成员对主 agent，唯一的通道是**黑板**（`squad_board`）。
  工具文案里直说这件事，别让成员以为喊一声队友能听见。
- **只在当前 dsh 进程的会话里活着**。不落盘、不跨会话、跨进程看不到：
  `dsh-team status` 之类的 CLI 输出不了小队状态（§6.1），重启后小队没了。
- **面板只读**。建队/加人/改状态/写黑板/收队都得调工具 —— 面板上没有按钮，
  也没有写路由（理由见 §6.3：HTTP 路由拿不到认证过的调用者身份）。
- **面板不做筛选/排序/搜索**，也不显示会话标题：`main` 槽拿不到 Session 绑定，
  只能按 `owner` 会话 id 分组（§6.3）。
- **绑成员 id 得手工**：`squad_add` / `squad_update` 的 `agent_id` 由主 agent 填，
  面板不能「把某个子会话拖进小队」。填错的表现是按钮点了没反应 —— 所以文案要求
  主 agent 建完成员就把 id 记上。
- **不设成员上限、不数 token、不掐轮数**（§3）。`boardLimit`（默认 500）只裁黑板条数，
  超了就丢最旧的，不拒。
- **面板内容对本机进程可见**：回环 + 同源就是全部防护（和定时任务面板同一模型）。
  小队里有任务描述、worktree 路径、成员结论 —— 都算「本机可读」。
- **不做小队之间的依赖/编排**：多个小队之间没有先后关系，谁先谁后由主 agent 决定。

## 8. 验收记录

全部在 2026-10-08 实跑，Linux（非 win32）。

| 标准 | 实际命令 | 实际输出 |
| --- | --- | --- |
| 纯逻辑对 | `node scripts/selftest-squad.mjs; echo EXIT=$?` | `✓ 自检通过：名册与黑板 / 权限三种视角 / 快照 / 6 个工具真跑（返回值过 schema）/ 装配与会话清理 / HTTP 路由与信任栅栏负例 / 真 socket 端到端（路由挂载 + prefix 匹配）/ 客户端面板真渲染与进入会话` / `EXIT=0`（25 个 `check`） |
| 权限真的是认证 | 同上第 3 段 + 工具层负例段 | 绿。工具层实测：`squad_status` 外人 → `[失败]`；成员改别人那行 / 加人 / 关队 → 各一条 `[失败]`；成员自己写黑板 → 署自己的成员名（不是「主 agent」） |
| 面板真能看 | 同上第 7 段（`new Function("window", clientSource)` 真加载 classic script + 假 React 真渲染） | 绿：成员名/角色/状态/任务/worktree/黑板都在；「进入会话」把 `agentId` 交给 `uiWorkspace.openSession`；没绑 id 的按钮禁用；轮询 `setInterval` 创建数 == 清理数 |
| 面板取数只走宿主 | 同上第 6 段（真调路由 handler）+ 收尾补的**真 socket** 段（`node:http` 起服务、照抄宿主 `match()`） | 绿：`/options`、`/squads` 200 有数据；路径不对 / prefix 本身 404；非回环 / `sec-fetch-site: cross-site` / 异源 Origin / 坏 Host → 403；写方法（POST/DELETE）一律 404 |
| 挂进主套件 | `npm test; echo EXIT=$?` | `EXIT=0`，`grep -c "^✗"` = `0`，命令数 `19 → 20`（`package.json` 的 `scripts.test` 里 `selftest-squad.mjs` 已并入） |
| 工具能被 dsh 认 | `node scripts/selftest-tool-schema.mjs; echo EXIT=$?` | `✓ 自检通过：参数表+output.schema 全量真校验（14 个工具，对齐 dsh 子集）/ 反例可被抓到` / `EXIT=0`（非 win32：bash×4 + worktree×4 + squad×6 = 14；win32 为 21） |
| 版本号与 CHANGELOG 一致 | `node scripts/selftest.mjs`（里面那条「版本一致」） | `✓ … / 版本一致 / …`；`package.json` 1.12.1 → **1.13.0**，`CHANGELOG.md` 顶部新增 `## [1.13.0]` |
| 审查 | 第 1 层 `subagent_std`；第 2/3 层 `subagent_power` | 见下 |

### 审查记录

第 1 层（正确性，`subagent_std`）报 4 条，**全部核实为真并修掉**，且每条都补了会变红的回归断言：

| # | 问题 | 修法 |
| --- | --- | --- |
| P0 | `updateMember` 改 `agentId` 不查重（`addMember` 查了）。成员能把自己那行的 id 改成别人（甚至**别队**成员的）id → `squadOfMember` 首命中歧义：被冒名的人可能被解析到这一行，跨队隔离破 | `updateMember(state, …)` 收 `state`，改绑时复用 `squadOfMember` 查重（改成本行已有的同一个 id 视为幂等） |
| P1 | `authorize(state, owner, "")` 返回 `{ok:true}` 但**没有 `squad`**，而加人/改行/写黑板/关队四个工具直接解引用 → 传 `squad: "   "` 就 TypeError（schema 的 `required` 挡不住空串） | `authorize` 直接拒空名（「不点名」只对 `squad_status` 有意义，而它不走这个函数），顺手删掉那段死分支 |
| P2 | `squad_status` 点了名仍返回名下全部小队 —— 工具描述说「看一个小队或全部」，行为对不上 | `snapshot(state, callerId, name)` 收可选 `name`，点了名只渲染那一个 |
| P2 | `oneLine(patch.status, …).value` 不判 `.ok`：状态超长时报错文案变成「收到的是「undefined」」 | 先判 `.ok`，失败走「状态太长（N 字符 > 40）」 |

修完做**反向实验**确认断言真的抓得住（不是「改了但测不出来」）：

```text
拆掉 P0 的查重 → node scripts/selftest-squad.mjs → EXIT=1，✗ 改成员那一行：… agentId 改绑要查重
还原 P1 的旧行为 → node scripts/selftest-squad.mjs → EXIT=1，✗ 权限：所有者 / 成员 / 外人三种视角
                                                          ✗ 工具：权限负例 —— …
两次实验后恢复 → EXIT=0
```

第 2 层（整体性，`subagent_power`）：3 条，全部落到改动上。

| # | 问题 | 修法 |
| --- | --- | --- |
| P1 | 本文档 §6.3 写 `GET /squads` 返回 `{ok,count,squads,me}`，实际 `snapshotAll()` 只有 `squads/count` —— 路由拿不到调用者身份，`me` 本来就是编的 | 改文档（并写清「没有 `me`」及其原因），不是给路由补一个假字段 |
| P1 | 文档状态还是「进行中」、§8 还是「待填」，与已完成的代码/CHANGELOG 不一致 | 本节 + 状态头改成「已完成」 |
| P2 | 文档承诺「按小队分组的折叠卡」，实际是**点选式**卡片（一次展开一个），没有折叠交互 | 改文档描述实际形状（README 同步改） |

第 3 层（安全 / 破坏性，`subagent_power`）：2 条，都补了防护 + 回归断言。

| # | 问题 | 修法 |
| --- | --- | --- |
| P1 | 成员能用 `squad_update` 把自己那行绑到**任意**未占用的 `agent_id` 上。`addMember` 只查「有没有被别人占」，查不了「这个 id 是不是真的是你」—— 等于成员能自己造一个身份：填中某个真实会话 id，那个会话就凭空获得本队的读写权（跨会话越权） | 工具层：非所有者传 `agent_id` 一律拒（身份字段只有所有者能绑）。成员本来不需要它 —— 进队时所有者已经绑好了 |
| P1 | `squad_close` 之后 `squad_add` / `squad_update` / `squad_board` 照样能改 —— 「关」没有不可逆语义，`closed` 只是个标签 | 三个写函数（`addMember` / `updateMember` / `appendBoard`）开头一律 `if (squad.closed)` 拒，共用一句 `closedDetail` |

反向实验（同样确认断言抓得住）：

```text
拆掉「收队只读」+「成员不得绑 id」→ node scripts/selftest-squad.mjs → EXIT=1
  ✗ 收队：关掉之后成员与黑板还在，但**一切写操作都拒**（只读），重复关要拒
  ✗ 工具：权限负例 —— 外人看不到、成员改不了别人那行、成员关不了队
恢复 → EXIT=0
```

第 3 层同时明确「没找到」的部分：HTTP 栅栏绕过、跨队读、路径/命令注入、原型污染、
密钥泄露、外部输入触发的不可逆破坏 —— 都没有。

**收尾时补的一条真环境验证**（不在审查里，是自己探活时发现的）：

```text
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3080/api/team/squad/squads
HTTP 401   （对照：/api/team/scheduler/options 也是 401 —— 那个模块当时是关的）
```

401 的 body 是纯文本 `unauthorized`，而我们的响应一律是 `sendJson` 的 JSON，
所以这个 401 **不是我们的 handler 发的**。查 `dsh-host-webserver/lib/index.js:229-245`：
宿主 `handle()` 命中已注册路由就直接调 handler，**自己不鉴权**；没命中的才落到
fallback（SPA dist server），而那个 fallback 未认证时回 401。结论两条：

1. **栅栏是这条路由唯一的保护** —— 宿主不会替我们挡（这反过来证明了 §6.3 那个栅栏是承重的，不是装饰）；
2. 当前那个 dsh 进程早于 `lib/squad.js` 存在，所以路由没注册、面板要**重启 dsh** 才出现。

因为手搓的 `req` 绕不过「路由到底挂没挂上、宿主 prefix 匹配对不对」这两件事，
自检里补了一段**真 socket** 端到端（`node:http` 起服务 + 照抄宿主 `match()` 的语义 +
真 header）：`GET /squads` 200 有数据、`GET /options` 200、`POST` 404（没有写路由）、
跨站 `sec-fetch-site` 403、异源 `Origin` 403、坏 `Host` 403、prefix 本身 404。

收口后重跑：`node scripts/selftest-squad.mjs` → `EXIT=0`；`npm test` → `EXIT=0`，
`grep -c "^✗"` = `0`。
