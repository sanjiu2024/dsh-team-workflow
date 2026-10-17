# REQ-017 · squad 状态机可审查化（拆分 · 字段收敛 · 状态文档）

- 状态：进行中
- 日期：2026-10-16
- 基线版本：2.0.9
- 相关：REQ-016（小队 2.0，19 项增强与七轮独立测的记录）

## 1. 要做什么

一句话：**让「一轮成员循环」这块代码以后改得动、看得住**。三件事，按这个顺序做：

1. **拆 `lib/squad.js`**：把「一轮成员循环的生命周期」搬到新文件 `lib/squad-round.js` ——
   起一轮（`startMember`）、流事件的转录（`onEvent`）、四个收尾出口（`.then` / `.catch` /
   `.finally`）、以及成员工具环境（`env.wait` / `env.say` / `env.check` 的接线）。
   **纯搬移，行为一字不改。**
2. **收敛三个语义重叠的字段**：`stopNote` / `waitNote` / `note` → 两个 ——
   「这一轮为什么结束」（瞬时，跨轮必须清）与「持久结论」（落盘、面板可见）。
3. **补 `docs/状态.md`**：8 个 patch 之后的现状 —— 哪些是设计取舍、哪些是天花板、
   哪些**修了但没断言**。

## 2. 为什么（不做的后果）

- 本轮（2.0.2 → 2.0.9）**8 个 patch、11 个 P1，其中 5 个是我自己前一轮改动引入的**，
  而所有 P1 都集中在同一小块：`startMember` / 四个收尾出口 / `wakeWaiters` / `drainQueue` /
  `requestWait`。它们现在挤在 2347 行的文件里，**改一个出口看不出另一个出口** ——
  这就是「同一件事只护住一个」反复发生的物理原因。
- `stopNote` 与 `waitNote` 语义重叠已经出过一次真事故：停「等待中」成员时写下的 `stopNote`
  没人消费 → 漏给下一轮 → 重派跑完了、结论栏却写着上一轮的「被停掉」（2.0.6 修）。
- 现状散在 CHANGELOG 的 8 节里，接手的人（或三个月后的我）找不到「哪些是故意不做的」。

## 3. 不做什么

- **不动行为**（第 1 项是纯搬移；第 2 项是字段收敛，行为等价性由测试与变异证明）。
- **不加**工具、不加配置项、不改 `team/extensions/*.json` 的 schema。
- **不动** `lib/mc.js` 与 `vendor/`（那是另一件事）。
- **不动** `lib/squad-loop.js`（成员循环本体已经在独立文件里，这次只搬它外围的装配）。
- 不顺手改别的文件；不为了「更整齐」重命名导出（导出面必须逐字不变）。
- 不新增第二个拆分文件（调度/唤醒那部分**这次不拆** —— 等有真实需要再说）。

## 4. 验收标准（可执行）

| # | 验收标准 | 怎么验 |
| --- | --- | --- |
| 1 | 拆分后全仓测试全绿 | `npm test` → EXIT=0，14 个套件 |
| 2 | 小队套件全绿（60+ 条断言） | `node scripts/selftest-squad.mjs` → EXIT=0 |
| 3 | **导出面逐字不变** | 前后各跑一次导出清单（`grep "^export " lib/squad.js`）→ `diff` 为空；且 `lib/squad-round.js` 的导出只被 `lib/squad.js` 用 |
| 4 | `lib/squad.js` 明显变小，且**一轮的四个出口全在新文件里** | `wc -l`：2347 → **≤2150**（实测 2146）；`grep -c "member.running?.abort !== outer" lib/squad-round.js` → 3（`.then` / `.catch` / `onEvent`），`grep -c` 在 `lib/squad.js` → 0 |
| 5 | 三个字段收敛完成 | `grep -c "stopNote\|waitNote" lib/*.js` → **0**；`note` 仍在且语义写进注释 |
| 6 | 字段收敛有反向实验 | 至少 3 条变异（清标记挪位置、终态判据、等待态写入）各自**变红**并逐字节还原 |
| 7 | 状态文档存在且带状态/日期/版本 | `docs/状态.md` 头部有状态、日期、基线版本；含「设计取舍 / 天花板 / 修了但没断言」三节 |
| 8 | 文档与代码一致 | 状态文档里每条「修了但没断言」都能在 `REQ-016 §8` 找到对应；对不上就改文档 |

## 5. 已知约束（动笔前查到的硬事实）

- `lib/squad.js` 现有 **30 个导出**，被 `lib/index.js`、`lib/squad-cli.js` 与 `scripts/*.mjs` 引用
  → 搬移时**只能搬内部实现，不能动导出名**。
- 一轮循环用到的协作者都在 `installSquad` 的闭包里（`config` / `ctx` / `persistSquad` /
  `drainQueue` / `wakeWaiters` / `runningCount` / `isRunning` / `roleToolsFor` /
  `memberToolsFor` / `requestWait` / `deliverSay` / `markAcceptance` / `appendBoard` /
  `userMessage` / `formatReport`）→ 搬出去必须**显式注入**（`deps` 对象），否则会掉进循环依赖。
- `member.running` 现在一个对象兼三职（句柄 / `aborted` 标记 / `startedAt`）；
  `isRunning(member)` 是**全仓唯一**的「真在跑吗」判据（2.0.9 统一），搬移时不许分叉。
- 字段现状：`stopNote` 6 处、`waitNote` 7 处、`note` 39 处；`stopNote` **不落盘**（不在
  `compactSquad` 白名单里）。
- 上一轮独立测已声明两处**不可达/未覆盖**（`.catch` 的身份护栏、`requestWait` 的轮次守卫）
  → 这次搬移**不许**把它们顺手删掉。

## 6. 方案与实现记录

### 块 1 · 拆 `lib/squad-round.js`（纯搬移，2026-10-16）

- **搬了什么**：`startMember` 整块（原 `lib/squad.js:1467-1705`，239 行）→ 新文件
  `lib/squad-round.js`（257 行，含头注释）。squad.js 只留一个**函数声明**包装
  （`startRound(deps, squad, member, opts)`）—— 用函数声明而不是箭头 `const`，
  因为上面的 `drainQueue` 也会调它，声明会提升（箭头 `const` 会撞 TDZ）。
- **依赖怎么给**：`deps` 显式注入 21 个键（`config`/`ctx`/`persistSquad`/`drainQueue`/
  `wakeWaiters`/`roleToolsFor`/`requestWait`/`deliverSay`/`markAcceptance`/`appendBoard`/`log`/
  `boardLimit`/`usageLine`/`TRANSCRIPT_LIMIT`/`TRANSCRIPT_TEXT_MAX`/`MAX_BOARD_TEXT`/
  `memberSystemPrompt`/`memberTaskText`/`policyFor`/`loadKit`/`budgetLeftFor`），
  **不从 `squad.js` import**（两个文件互相 import 会成环）。跨模块的
  `LOOP_DEFAULTS`/`addUsage`/`messageText`/`runMemberLoop`/`memberToolsFor`/`runMemberTool`/
  `formatReport`/`parseReport` 由新文件**直接 import**（都在 `squad-loop.js`/`squad-tools.js`/
  `squad-report.js` 里）。
- **怎么验搬移是忠实的**：把新文件正文去掉 `deps.` 前缀后与原块逐行 diff → **只差 1 行**
  （`ctx,` → `ctx: deps.ctx,`，那是简写属性必须展开，有意为之）。
- **踩到的坑（值得记）**：漏依赖不是靠"看"能看全的 —— 我先后漏了 `policyFor`/`loadKit`/
  `budgetLeftFor`（闭包函数）与 `MAX_BOARD_TEXT`（模块级常量）、`LOOP_DEFAULTS`（模块级 import）。
  最后是靠**跑 + 打印 `result.reason`** 收敛的（静态扫两遍都没扫全）。教训：搬移类改动，
  静态检查只能当辅助，**跑起来**才是判据。
- **顺带逮到一个脆测试**：`scripts/selftest-squad.mjs` 的 `tick()` 用 `setImmediate`，
  而模块图多一层就要多一个 tick —— 那个测试自己的注释早就写着「加载器多一层 await 就会让
  『spawn 一返回就有请求』这个假设失效，那是测试太脆，不是产品错」。改成宏任务
  （`setTimeout(0)`）在**共享处**修一次，40 个连带失败全消。
- **验证**：`npm test` EXIT=0（14 套件）；`selftest-squad.mjs` 全绿；导出名 31 → 31 **逐字一致**。

### 块 2 · 字段收敛

（做完填）

### 块 3 · `docs/状态.md`

（做完填）

## 7. 天花板

（做完填）

## 8. 验收记录

（做完填：每条验收标准对应**实际跑过的命令 + 实际输出**）
