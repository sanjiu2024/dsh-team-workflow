# 变更记录

版本号规则（本项目自定）：

- `package.json` 的 `version` 是**唯一来源**；CLI、`/team-baseline` 都读它，不另存一份。
- 每发一版必须在下面加一节 `## [<version>]`，标题里的版本号要和 `package.json` 逐字一致。
- 自检会核对这两处（`scripts/selftest.mjs` 最后一节）：对不上直接红，避免出现
  「改了版本号忘了记录」或「记了但没改包」这种只有发完包才发现的分叉。
- 递增规则：加能力或改默认行为 → minor；只修 bug → patch；改配置格式且不兼容 → major。

## [1.17.0]

**审查改成两层：std 测，power 判 —— 审查档一个工具都没有**（REQ-012）。

原来的「三层审查」是同一个模型换三个视角，但两层 power 都能自己读文件、自己跑命令 ——
它们会顺着仓库扫到超时（上游 42 次实测，最慢一次 108 轮、80 次 `grep` + 72 次 `read`，
跑满 30 分钟被砍掉）。现在改成按**产物**分工：

- **测**（`subagent_std`，带工具）：跑测试、跑反向实验（拆掉一条修复必须变红）、逐条核实、
  grep 全部调用方。**每完成一块就跑。** 碰信任边界的改动一律派它 —— 一行也能出事故。
- **判**（`subagent_power`，**无工具**）：只凭你贴进 prompt 的材料挑毛病。**只在重大变化
  或写完一个大部分时派。** 它的产物是判断不是验证，每条发现得自己用工具核实。

配置层强制「无工具」，不是提示词里说说：`team/agent-settings.json` 新增
`subagents.toolLessTiers`，`preset install` 给列在里面的档位生成
`toolFilter: { allow: [] }` —— dsh 会把过滤掉的工具**从子代理的提示里去掉、调用直接拒**
（`dsh-subagent` 的 `ctx.tools.restrict`，能力由 `subagent-spawn-in-process` 提供）。
所以 power 那份 prompt 必须**把 diff 贴进去**：它读不到文件。

- `team/RULES.md` 的「## 审查（三层）」整节重写为「## 审查（两层：std 测，power 判）」：
  分工表、两边各自怎么派（两份派单模板）、什么时候派、修复与轮次、略过、成本提醒；
  选档表与角色声明表同步（审查型 = 无工具、测试型 = 带工具）。
- `lib/preset-gen.js` 按 `toolLessTiers` 生成 `toolFilter`；
  `scripts/selftest-preset-gen.mjs` 断言 power 那条行有 `toolFilter: allow: []`、
  std/max 没有（拿真 `standard.patch.yml` 也验一遍）。
- `README.md` 的审查那两处跟着改；`docs/UPSTREAM-SYNC.md` 里两处「不搬上游『review 只跑一次』」
  的理由引的是已废的三层策略，各加一段【2026-10-08 后续】说明结论不变、理由按新节名读。

## [1.16.0]

**小队成员不再走 subagent：小队自己驱动它的循环**（REQ-011）。

成员不是 dsh 的 agent、不是会话：小队自己发 `ctx.llm.stream`、自己执行工具
（`lib/squad-loop.js` + `lib/squad-tools.js`），转录自己存（进程内）。所以成员不出现在
会话列表里、调不到 dsh 的工具、也不占主 agent 的上下文。面板里那个点不动的「进入会话」
换成**只读的「看转录」**（新路由 `/api/team/squad/transcript`）—— 成员不是会话，没有会话可进。

- 工具面：`squad_add` **删**（它唯一的用途是绑外部派出的子代理 id），换成 `squad_spawn`
  —— 派成员就是**当场在后台跑起来**，多派几个就是真并行。`squad_close` 现在会当场掐掉
  还在跑的成员（不会继续烧模型）；`session/disposed` 与插件 `dispose()` 同理。
- 成员的工具 7 个（`read` / `write` / `edit` / `grep` / `glob` / `bash` / `board`），
  前 6 个的文件操作钉在成员自己的 worktree 里（路径越界直接拒），`bash` 走 `ctx.shell`
  并显式带 `sandboxPolicy.workspaceRoot`。循环有护栏：最多 `maxSteps` 步、单步最多 8 个
  工具调用、单条结果截断、超限一律记「卡住」。
- 两条代价如实写进 README 与 REQ-011 §6.4：**成员没有审批通道**（审批硬依赖真实 Session
  的开着的 turn）；**本机 `danger-full-access` 下 dsh 直接跳过 confine**，所以沙箱不构成
  额外保护，真正拦得住的是 fs 工具里的路径检查（`bash` 拦不住）。
- 为什么必须自己实现工具：`ctx.tools.execute` 缺 `agent` 会在**错的 cwd** 里改文件，
  而 dsh 全树没有插件自驱 loop 的先例（唯一驱动路径标 `@internal`）。
- 自检：`scripts/selftest-squad.mjs` 第 5 段把整条循环真跑一遍（假模型流），第 8 段真渲染
  只读转录；新增 `scripts/smoke-squad-llm.mjs`（**不进 `npm test`**，要真 dsh 树）拿真的
  `BlockAssembler` / `createToolResultMessage` 把同一条路径再走一遍 —— 替身与真件分叉时它响。
- 顺手修掉一个真 bug：`globToRegExp` 分几次替换导致 `**/*.js` 一条都匹配不上（见 REQ-011 §8）。

## [1.15.0]

**压缩阈值抬到 70%：不再在 128K 就压**（`compactThresholdRatio` 0.25 → 0.7，mc 20% → 65%）。

改的是默认行为（压缩什么时候触发），所以走 minor。起因是用户真机反馈：
「不要把上下文长度限制到 128k 就会压缩，这样不行」—— 也就是明确选择了 REQ-003 §6 里
当年被否决的那条路。原方案是「mc 压到 20%（102K）抢在 dsh 前面动手、dsh 保持 25%（128K）兜底」；
现在改成 **dsh 70%（358K）/ mc 65%（333K，即 mc 自己的默认值）**，差 5 个点，不变式照旧满足。

- 为什么是 70% 而不是更高：两个上界 —— `scripts/selftest-preset-gen.mjs` 断言阈值 ≤ 400,000
  （460,800 那次「阈值够不着、压缩永不触发」的回归），以及 compaction-basic 的
  `pressureBudget = 窗口 − 输出预留 − headroomTokens`（`tier-max` 预留 64000 → 382,464）。
- 配套撤销：20% 时代的 `history_budget_percentage: 0.45` 失去意义（它的唯一目的是在阈值被压到
  20% 时把绝对预算拉回同量级），模板改为**显式**写回默认 0.15 —— 必须显式写，否则 `mc apply`
  不会去动用户配置里上次写下的 0.45（那时预算会变成 149,760）。
- 代价已知并接受：REQ-003 §6 当年否决这条路的理由就是它 —— 地板平均要爬得更高才有动作，
  cacheRead 约翻倍。已写进 `team/agent-settings.json` 的注释与 REQ-003 的修订节，
  以免日后被当成 bug 回滚。
- 生效要重启：dsh 阈值在预设里（`dsh-team preset install` 重新生成后重启才读），mc 的键
  不在它的实时重载名单里。

## [1.14.0]

**审查纪律：不重要且不危害的发现直接略过**（`team/RULES.md` 新增「### 略过」一节）。

改的是注入每次会话的基线提示词，也就是这套东西的**默认行为**，所以走 minor。
起因是 2026-10-08 小队那次三层审查：9 条发现里真正要命的是 `agent_id` 越权与
「收队还能写」两条，剩下几条（措辞与代码不符、文档承诺了不存在的字段）逐个返工
花掉的轮次比修 P0 还多。

- 判据是**两个条件都满足才略过**：不重要（P2 及以下）**且**不危害。P0/P1、碰信任边界
  （输入校验/鉴权/写盘/执行外部命令）、会丢数据或改坏别人状态或让人得出错误结论的，
  一律修 —— 这类不论多小都修，一行也能出事故。
- 略过**必须留痕**：审查记录里记一行 `P2 · 文件:行号 · 一句话 · 略过`。
  漏了和主动跳过是两回事，后者读的人知道它存在、也知道为什么没修。
- 略过**不减少该跑的层**：「什么时候跑哪几层」照旧，只是报回来的小问题不再逐个返工。
  拿不准算哪一类，按「必须修」处理。
- 第 1 层审查当场补的两处（都是这条规则自己的漏洞）：「审查意见要落到实际改动上」原是无条件句，
  与「可以略过」字面冲突 → 补例外；「记进审查记录」原没写落点 → 点明落在**提交信息正文**
  （有需求文档的在它末尾单列一行「略过未修：」，不占 §8 验收条目 —— §8 只放真跑过的命令与
  输出）—— 留痕没有落点，这条判据自己要防的那种漂移照样会发生。
- `scripts/selftest.mjs` 加断言盯住这两句（判据段被删 → 回到「小问题也逐个返工」；
  「略过不是隐瞒」被省掉 → 变成隐瞒），和既有的「派审查必须给边界」同一种防漂移做法。

## [1.13.0]

**小队（squad）**：主 agent 能建多个小队，每个小队 = 一个目标 + 一份成员名册 + 一块共享
黑板，成员（子 agent）往黑板上写进展，别的成员和主 agent 都读得到（REQ-009）。

```text
squad_new     建队（名字 + 目标）
squad_add     登记成员（给了 agent_id 就绑定，不给就是「待派」）
squad_update  标记 在跑/完成/卡住、补 id/worktree、记一句结论
squad_board   往黑板追加（作者自动判定，不给参数 —— 少一个能撒谎的入口）
squad_status  看一个小队或全部
squad_close   宣布收队（名册与黑板留着，只读）
```

为什么要有它：现在派子 agent 是一次性的，多个子 agent 之间不能互相说话（dsh 的
`send_message` 只允许父↔子），各自的发现只能都回到主 agent 的对话里靠它转述 ——
主 agent 的上下文成了唯一的共享内存，一压缩细节就没了。小队把「目标、名册、进展」
变成结构化的三样东西，且**只在当前 dsh 进程的内存里**（不落盘、跨会话即失效）。

- **权限是认证，不是自报名字**：成员身份按 `exec.agent.id` 反查（== 子会话 id），
  成员只能看自己所在小队、写黑板、改自己那一行的状态与结论；`squad_new`/`squad_add`/
  `squad_close` 只有建队的那个会话能做。外人看不到别人的队，连队名都不出现。
  `agent_id` 是身份字段（决定谁能读写这个小队），**只有所有者能绑** —— 成员能绑的话
  就能把自己那行挂到任意 id 上，等于自己造一个身份。
- **收队 = 只读**：`squad_close` 之后加人/改成员/写黑板一律拒，名册与黑板留着能看。
  不拒的话 `closed` 只是个标签，「关了」的不可逆语义是假的。
- **Web GUI 只读面板**：侧栏「小队」入口 + 主面板，一列小队卡片**点一张展开一张**（不是同时摊开），
  展开后显示成员（角色/状态/任务/worktree 绝对路径/结论），每个成员一行「进入会话」按钮
  直达它的子会话，黑板倒序显示最近 50 条。取数走宿主 HTTP 路由
  （`/api/team/squad/options`、`/squads`），**只有 GET**：
  建队/加人/写黑板全走上面那 6 个工具 —— 路由拿不到认证过的调用者身份，在路由上开写口
  等于把权限判据丢掉。
- 路由沿用与定时任务面板同一道信任栅栏（回环 + 同源，`sec-fetch-site: cross-site` 直接拒）。
  为此把栅栏与 JSON helper 从 `lib/scheduler.js` 抽到新的 `lib/api-http.js`，两边共用一份。
- **`lib/scheduler-client.js` 改名 `lib/client.js`**：dsh 的 `clientExportOf` 只认
  `exports["./client"]` 一个值（一个包只有一个客户端入口），小队面板只能加进同一个文件。
  文件内容不变，只是不再只服务调度器。

不做的（写在 REQ-009 §7）：成员之间**不能**直接对话（缺一个 `createUserMessage` 的产物，
没做 `squad_say`），只能靠黑板；不做 `dsh-team squad` CLI 子命令（状态在 dsh 进程内存里，
另一个进程读不到，做出来只会是个永远空的表）；不落盘、不设成员上限、不做成本闸门。

## [1.12.1]

两处写盘 / 参数加固。都是**既有同型**问题（REQ-008 §7 记过账），收口放在一处而不是只堵新路径：

- `--profile` 的取值限成 `[A-Za-z0-9._-]`，否则直接报错。它会被拼进 `run()` 的 shell
  命令行，也会出现在**打印出来给人复制的命令**里（`重试：…`、`要卸掉：…`）——
  以前 `--profile 'x; rm -rf ~'` 会被 shell 原样解释。
- 写 JSON 一律走新的 `writeJsonAtomic`（临时文件 + `rename`，五处共用）：`writeFileSync`
  是「先截断再写」，中途失败（ENOSPC/EIO/断电）留下的是**半个** JSON，而这些文件
  （`profile/package.json`、调度器配置）坏了 dsh 起不来或者表现为「设置自己变回去了」。
  临时文件用 `"wx"`（必须新建、名字带随机串，防预置符号链接）、写前读回原权限位并在
  `rename` 前补上（换 inode 会把 600 变成 umask 默认）、目标是符号链接时按 `realpath`
  写它指向的那份（跟 `writeFileSync` 的语义一致；悬空链接也穿过链接写，不把链接顶掉）。
- `--profile` 后面给空值、或直接跟开关（`--profile --dry-run`）会让参数解析当成「没给」，
  静默落到默认 profile —— 用户以为点了名，实际动的是另一个安装树，改成直接报错。

## [1.12.0]

装工作流时**可选安装三个第三方插件**（REQ-008）：

```bash
dsh-team install --profile tauri     # 装完本包后逐个问，默认都不装
dsh-team plugins                     # 装完才想装：再问一遍同一套问题
dsh-team plugins --with-sidebar      # 点名，不问；已装过则升到最新
```

`dsh-better-sidebar`（右侧栏工作台）、`dsh-plugin-wallpaper-engine`（壁纸引擎）、
`dsh-pet`（桌面宠物）。三条判据是这次改动的重点，全都写成纯函数并被自检钉住：

- **已在 profile 里的不动** —— 本机 web profile 本来就装着 `dsh-better-sidebar@0.24.1`，
  交互式询问直接跳过并报「已装」，不声不响升级别人安装树里的东西是最没道理的副作用；
  只有 `--with-<key>` 点名才算「我要升」
- **非交互环境不猜**（管道 / CI 里 stdin 不是 TTY）—— 跳过并告诉你用哪个 flag 点名，
  而不是替用户答「是」或「否」
- **装不上只警告** —— 工作流本体已经落定，别人家的包装不上不该把它退回去：
  退出码仍 0，末尾汇总里给重试命令，并提示「装错版本会被 dsh 启动预检静默禁用」
- 只往带 web 界面的 profile 里装（三个都是 `platform: "web"` 的界面插件）；
  敲错的 `--with-xx` 直接报错，不静默照跑
- `dsh-team status` 加了「可选插件」一段，逐行报 `已装 x.y.z` / `未装`

第 19 个自检 `scripts/selftest-profile-plugins.mjs`：纯函数判据 + 拿假 `DSH_HOME`
**真跑 CLI**（dry-run 不动安装树、`status` 三行、只读目录造出来的真失败 → 退出码 0
且汇总带重试命令）。两条负向验证都红过：把「显式点名」挪到「已装」之后、
让非交互也去问用户。

## [1.11.1]

定时任务调度器的**审计修复批次**：移植完成后逐项审计 + 三轮三档审查，共 26 个修复提交
（清单与证据逐条见 `docs/requirements/REQ-007-定时任务调度器.md` §8–§14）。要点：

- **工具边界上的假成功**：`nextRunAt` 的 `output.schema` 声明成 `string` 而实际返回数字，
  每一次 `scheduler_create` 都在工具出口抛错；`scheduler_update` 的返回值、`run_now`
  丢弃同批补丁、触发前不查权限天花板（「已触发」把权限拒绝盖住了）同理
- **判据把「观测不到」当成「失败了」**：观测不到 `turn/end` 就判失败、`seq` 读不出来
  就说这一轮没起来 —— 全部改成「宁可宽松但要留证据」（`incomplete` / `noEvents`）
- **下一跳算错**：`interval`/`custom` 被本轮耗时污染、tick 用旧快照盖掉并发写、
  手动触发吃掉将来那一格
- **配置这一路不可信**：插件 config 不过字段校验（`NaN` → 并发不限），且被拒的值
  以前**一个字都不说**；现在整份过一遍 `SCHEDULER_FIELDS` 并留痕，上界按
  「条数 × 单条上限」估
- **读路径说的和实际不是一回事**：`scheduler_list` 看不出「上次跑成什么样」，
  零事件与「跑了但没收尾」报同一句话，面板与服务端两个词

> 这一节是**事后补的**：上面这些修复当时逐个提交但没逐次递增版本号（漏了），
> 所以合并记作一个 patch。规则已写进 `team/RULES.md` 的「提交」一节。

## [1.11.0]

新增**定时任务调度器**（REQ-007），移植自 Tauri 桌面版内置插件 `dsh-tauri-scheduler`。
到点在**一个全新会话**里无人值守跑一段 prompt —— 这是它和官方
`@deepseek-ai/dsh-schedule` 的分界：官方那个把提醒投递回原会话，这个新建会话跑完。
两者可以并存（工具名错开：`schedule_*` vs `scheduler_*`）。

**默认关闭**，要开的人自己开：

```text
dsh-team scheduler enable     # 改 team/extensions/scheduler.json，然后重启 dsh
```

关的时候是**真的关**：一个工具不注册、一条路由不挂、GUI 面板探活失败也不出现。

### 为什么

「每天/每周自动做某事」这类需求在 dsh 里以前只能靠人记着。官方的 schedule 解决的是
「到点提醒我回到那个会话」，不是「到点让模型自己把活干了」—— 后者要求新会话、无人值守
（审批策略 `never`）、跑完留痕。桌面版那个插件正是干这个的，但它是 TS + tsdown + 依赖
workspace 私有的 `dsh-tauri`/`dsh-tauri-ui` 宏，在纯 dsh 里一个宏都用不了，所以整个重写。

### 加了什么

- `lib/scheduler.js`：宿主侧。8 种计划（once/hourly/daily/interval/workdays/weekly/
  monthly/custom）、4 个工具（`scheduler_create` / `scheduler_list` / `scheduler_update` /
  `scheduler_delete`）、一条前缀路由 `/api/team/scheduler`、每秒一跳的调度循环
  （全局并发上限 4、单次运行 30 分钟上限、无重试、无补偿队列）、运行历史留最近 200 条。
  存储 `<DSH_HOME>/team-workflow/scheduler/{tasks,runs}.json`，写走串行队列 + 临时文件
  `rename` 原子替换。
- `lib/scheduler-client.js`：Web GUI 面板（侧栏「定时任务」+ 主区页面）。**手写的、
  零构建**——dsh 的客户端模块只做 `readFileSync` + 原样 HTTP，没有转译器，所以不写 JSX，
  也不 require 任何 baseline 之外的包，样式全内联。
- `team/extensions/scheduler.json`：配置，`enabled: false`。
- `bin/dsh-team.mjs`：`scheduler [status|enable|disable]`。
- `lib/commands.js`：`/team-scheduler` 命令（开关 + 任务列表 + 最近 5 次运行）。
- `scripts/selftest-scheduler.mjs`：见下。

### 刻意与源头不同的地方

1. **不搬 `timeZone` 字段**。源头那个字段是死的（`cron-schedule` 没有时区支持，实际按
   进程本地时区算）。搬一个不生效的字段比不搬更坏。
2. **不引 `cron-schedule`**。daily/workdays/weekly/monthly 直接算下一个本地钟表时点，
   比源头「先拼 cron 表达式再解析回来」更直白，也少一个依赖（本包零依赖）。
3. **修了源头 `custom` 的 bug**。源头校验了 `time` 却从不使用它（occurrence 只由
   anchor + N×天 算），于是「每 3 天的 09:00」实际用的是 anchor 自带的时刻。这里让
   `time` 真正生效，并在自检里钉了回归测试。
4. **一次性任务跑完自动停用**。源头跑完只把 `nextRunAt` 清掉、任务保持启用，于是下一秒
   就落进补算分支报「算不出下一次」（纯噪声），面板上还显示成「启用」。用户要的就是
   「跑一次就完」，关掉它是它本来的生命周期 —— 运行历史里也留着它跑过。

   注意这条**只针对「跑完了」的一次性任务**。其它计划算不出下一次时**不停用**：
   见下面「移植完整性审计后修的 16 处」第 3 条 —— 算不出是一个可能反复出现的计算结果，
   不是一条任务该消失的信号。

5. **不补跑历史**。停机三天后，`interval` / `custom` 只会补跑一次，不是三次。源头那套
   会按原定时刻逐个重放积压，结果是「一开机同时起 N 个真会话」—— 在无人值守场景里这是
   灾难，不是特性（审计第 8 条就是这个）。下一跳越过期就重新对齐到 `now`。

6. **工具返回值把「没跑起来」和「没保存」分开**。源头只有一个错误字段，调用方分不出
   「改动生效了但触发失败」和「改动被拒」。这里拆成 `ok:false`（补丁被拒）与
   `ok:true` + `runError`（补丁已存、触发失败），并且 `run_now` 成功路径**不回**
   `nextRunAt`（那一刻的值马上会被后台那一轮重算，没有正确的数可报）。

另外两个纯扩展（源头没有）：`turnStartTimeoutMs` 可配（下限 50ms），以及「启用着但
算不出下一次」在面板和 `scheduler_list` 里都有显式提示。

另外继承了源头一个刻意的选择：**结果摘要用全量事件快照，不用增量流**。源头
`docs/sync-log.md` 记着这条 —— 增量流缺 `turn/end` 时若不回退全量，失败会被静默记成成功。

### 两个必须知道的风险

- **这是本包唯一碰 dsh 内部 API 的模块**（`ctx.agents.create` / `agentPresets.mount` /
  `setApprovalPolicy` 那一套），会随 dsh 版本漂移。所以它**不进顶层 `inject`**，改用模块内
  `ctx.inject` 条件激活 —— `inject` 里写一个当前 profile 没有的服务会让**整个插件**静默
  不激活，那会把团队基线一起弄没。依赖不齐时只有调度器不激活。
- **无人值守 = 审批策略强制 `never`**。没人能点「同意」，不设 `never` 工具调用会卡死。
  所以创建任务时的 `permission` 是唯一的安全边界，默认 `read-only`，且受
  `maxPermission`（默认 `workspace-write`）天花板约束 —— 见下面「安全边界」第 ⑥ 条。

### 安全边界（第 1/3 层审查后加硬的部分）

这个模块和本包其它模块有一个本质区别：**它会在没人看着的时候自己起会话、自己调工具。**
所以下面几条不是顺手加的防御，是这个功能能存在的前提。详见 REQ-007 §6.6。

- **路由自带栅栏**。dsh 的 web server 自己不鉴权（`dsh-host-webserver` 直接 `listen`，
  全包没有 Authorization / CSRF）。不设栅栏的话，用户浏览器里的任意网页用一个
  `fetch` + `content-type: text/plain`（不触发预检）就能 POST 建任务；DNS rebinding
  更能**读走**全部任务的 prompt 与运行历史。`isTrustedRequest()` 四条判据照抄本机
  同 profile 的第三方插件 `@linxin666/dsh-client-ui-git-graph`：socket 地址回环、
  `Host` 头回环、`sec-fetch-site !== "cross-site"`、`Origin` 与 `Host` 同源。
  **`/options` 探活也拦** —— 客户端拿 403 照样不注册面板，行为与「没启用」一致。
- **沙箱档位钉死，设不上就不跑**。审批策略被强制 `never`，所以 `permission` 是唯一的
  安全边界。`setup` 里 `setSandboxMode()` → `setApprovalPolicy()`，任一失败就 dispose 掉
  刚建的 handle 并把本轮记成 failed —— **绝不在沙箱没设上的情况下把 prompt 发出去**。
  （不用 `permissionPresets.set()`：本机那份预设表只有 `workspace-write` 和
  `danger-full-access`，**没有 `read-only`**，传未知名字还直接抛。）
- **禁止自我繁殖**。`scheduler_*` 是全局工具，无人值守会话一样看得见。不禁掉的话，
  一个 `read-only` 的任务能调 `scheduler_create` 建一个 `danger-full-access` 的新任务 ——
  这就是提权。`setup` 里 `agentCtx.tools.restrict({ deny: [...] })` 掉三个写工具，
  留只读的 `scheduler_list`。
- **任务数上限在写队列里把关**。每个任务到点都起一个真会话，无上限 = 无界建会话。
  「读长度 → 判断 → push」必须在**同一个** `mutateTasks` 回调里，否则并发请求会一起通过。
- **存储坏了不许静默清库**。写路径读文件用 strict 模式：不是合法 JSON 就抛，抛之前
  把坏文件改名成 `<file>.corrupt-<ts>` 留证。原来的「解析失败返回 `[]`」会让下一次写入
  把用户的任务整体覆写成空数组 —— 数据没了，还没有任何痕迹。

**⑥ 权限天花板 —— 栅栏挡不住的那一半。** `tools.restrict` 不是能力边界：一个已经在跑的
无人值守会话手里有 bash，它可以 `curl` 打本机 `/api/team/scheduler/tasks` —— 回环 socket、
回环 `Host`、无 `Origin`、无 `sec-fetch-site`，四条栅栏全过 —— 自己建一个
`permission: "danger-full-access"` 的任务。`restrict` 只约束本会话的工具表，管不到子代理，
更管不到 shell 里的 `curl`。所以边界放到服务端：`maxPermission`（默认 `workspace-write`）
是任务级 `permission` 的天花板，**建**（HTTP 与工具两条路）和**改**（`PUT /tasks` 与
`scheduler_update`）四个口子全过 `checkPermissionCeiling()`。要放开得自己改
`team/extensions/scheduler.json` —— 那是一次有意识的操作，不是模型能顺手做的。

**⑦ 放行判据必须是正向的。** `agentCtx.tools.restrict()` 原来落在设 `setupError` 的
try **外面**，于是 `restrict` 一抛，`setupError` 还是 `undefined`。三步现在在同一个 try
里。

（初版这里写过一句「`agents.create` 不保证透传 `setup` 的异常」，**那句是错的**，已对着
源码核正：`dsh-agent-loop/lib/index.js:1889` 会 `await` setup，异常由 `setupAndPublish`
重抛，`create()` 因此 reject。落在外面的真实后果是失败文案不准，不是「在没钉沙箱的会话里
发 prompt」。）

但「没记下 `setupError`」本身不是「钉上了」的证据：宿主漂移让 setter **不抛却不生效**、
或让 `agents.create` **根本不调 `setup`** 时，`setupError` 也还是 `undefined`、`create`
照样正常返回。所以放行判据改成**写进去再读回来**：沙箱写完回读会话日志里那条
`sandbox/mode` 事件、审批写完回读那条 `approval/policy` 事件，两者都对上了才置
`pinned = true`，`!pinned` 一律 dispose + failed。

审批也必须回读 —— 它的死法和沙箱不同：沙箱没钉上是越权，审批没设成 `never` 是工具调用
**永远卡着**等人点，而无人值守没人在。读法都对着源码核过（`session.append` 同步，
所以 setter 返回时事件必已在日志里）：`dsh-sandbox-policy/lib/index.js:41`、
`dsh-user-approval/lib/index.js:63-65`。假宿主刻意模仿了「吞异常」「静默不生效」
「压根不调 setup」三种形态，共五局。

**⑦b `read-only` 不拦 exec，有一条 `read-only` → `workspace-write` 的提权链。**
`read-only` 管的是文件写入（read-only 下可写根为空），exec 不受限。所以一个 read-only 的
无人值守会话手里仍有 bash，能 `curl` 本机路由自己建一个 `workspace-write` 的任务。
`tools.restrict` 管不到子代理和 shell，`maxPermission` 只钉得住链的终点。**把
`maxPermission` 设成 `"read-only"` 可当场断掉这条链**；默认给 `workspace-write` 是
实用性取舍，明写出来而不是假装覆盖了。

**⑦c 执行时再查一次天花板。** 只在写口拦 = 只拦新增不拦存量：调低 `maxPermission` 之后，
库里那些旧任务、手工改过的 `tasks.json`、旧版本留下的记录，还能靠 `run_now` / `toggle` /
定时触发重新跑起来。`run()` 开头再查一遍，超了直接 failed 且**连会话都不建**。

**⑧ 手动触发也受并发上限约束。** `trigger()` 原来只查「这个任务在不在跑」，不看
`running.size`。`POST /tasks/run` 和 `scheduler_update` 的 `run_now` 都走它 ——
`maxTasks` 默认 200，也就是能同时起 200 个真会话。

同一轮修掉的正确性 bug（都由自检钉住，含反向验证）：

- `engine.tick` 的补算 `nextRunAt` 原来写在 `readTasks()` 的**副本**上，再
  `mutateTasks(() => {})` 从盘上重读写回 —— 改动被丢掉，于是 `nextRunAt` 为 null 的任务
  **永不触发**，而且 `dirty` 恒真、**每秒全量写盘一次**。现在整个循环在回调里做。
- `execute()` 的 `running.delete()` 不在 `finally` 里，且 `void execute(...)` 没有 `.catch`：
  一次写盘失败就会把任务永久留在 `running` 集合里占着并发名额，未处理的拒绝还能打挂宿主。
- `recoverInterruptedRuns` 无差别把所有 `running` 标成 `interrupted` —— 多开 dsh 时会把
  另一个进程正在跑的那一轮历史污染掉。现在运行记录带 `pid`，只动本进程或已死进程留下的。
- `readJsonBody` 没挂 `close`/`aborted`，客户端断连时 promise 永不 settle（每次漏一个 handler）；
  handler 的兜底 catch 把内部故障也说成 400，现在只有 `BadRequest` 回 400，其余回 500。
- `summarizeEvents` 只判 `content.length > 0`，末条 assistant 消息只含 tool-call 时会把
  前面那条真答案覆盖成空摘要。
- `readJsonBody` 超限时 `reject` 后立刻 `req.destroy()`：socket 一没，那个 400 还没发出去
  就丢了，客户端只看到 `ECONNRESET`，不知道是自己发的包太大。改成排空 + `settled` 标志。
- `execute()` 的 `running.add` + `randomUUID()` 在 try 外面（与注释自述不符）：极端下
  `randomUUID()` 抛会让任务永久留在 `running`、占满 `maxConcurrent`。
- `recoverInterruptedRuns` 只看 pid：pid 会被系统复用，另一个 dsh 崩在任务里、它的 pid
  后来分给了别人，`isProcessAlive` 就永远返回 true，那条记录永远留在 `running`。
  现在加时间兜底（超过 12 小时未结束一律算中断）。
- `resolveWorkspace` 的兜底目录直接用 `path.join(DSH_HOME, config.workspaceFallback)`：
  `workspaceFallback` 写成 `"../.."` 就能让兜底工作目录逃出 `DSH_HOME`。字段校验加
  「拒绝绝对路径与 `..`」，解析后再核一遍落在 `DSH_HOME` 下。
- `validateSchedule` 只回布尔，面板上把「第几分」清空时报的是笼统的「schedule 不合法」，
  指不出字段。补 `explainScheduleProblem()`，报「hourly 需要 minute（0-59 的整数）」。
- `dsh-team scheduler enable/disable` 直接 `writeFileSync` 覆盖配置文件：写到一半被打断
  就留下半个 JSON，而 `readJsonConfig` 遇到解析失败会静默退回内置默认值 ——
  「文件坏了」表现为「调度器自己关了」。改成临时文件 + `rename`。

### 移植完整性审计后修的 16 处（2026-10-06）

「移植完了吗」这个问题问出来之后，逐条对着源头源码重新核了一遍（80 个文件里挑出与
调度语义相关的那几个：`service/scheduler.ts`、`service/task.ts`、
`service/executor.utils.ts`、`tools/update-task.ts`、`utils/schedule.ts`），
再用三档独立审查各扫一遍，发现若干处**不是有意为之、而是抄漏了**的语义差异 —— 都是
「看起来能跑、跑起来也像对的，但和源头行为不一样」这一类。最坏的两处会**骗**：
一处丢掉用户的输入还报成功，一处把跑成功的任务记成失败。

前 6 处是对照源头核出来的，后 10 处是审查 + 修前面几处时**顺手带出来的**（第 7、8 条
就是修第 5 条修过头的产物）。全部列在 `docs/requirements/REQ-007-定时任务调度器.md`
第 11 节，含每条「当初为什么看不出来」。

1. **`scheduler_update` 会丢掉同一批的补丁**（`lib/scheduler.js`）。
   `{task_id, prompt: "新指令", run_now: true}` 里的 prompt 被静默忽略：工具一进
   `run_now` 分支就触发 + 返回，patch 那段根本走不到。**跑的还是旧指令，而工具回 ✅**。
   源头 `update-task.ts:50-62` 是先 `task.update(id, patch)` 再 `scheduler.trigger`。
   改成同样顺序；输出加 `updated` 字段，`render` 能区分「只跑了一次」和「改了也跑了」。

   触发失败那条路径后来（第 14 条）又改了一次口径，见下面：一开始只是把文案从
   「更新失败」改成「更新已保存，但立即运行失败」，但返回值仍是 `ok:false` —— 那等于
   说「这次调用没生效」，调用方照样会重试补丁。

2. **`whenIdle()` 兑现得太早，跑成功的任务被记成失败**（`run()`）。
   `whenIdle()` 说的是「当前没有 driver」，排队的 followup 被取走之前它就会立刻兑现 ——
   于是「followup → 等空闲」这个顺序经常**读到空事件集**，再被「缺 `turn/end` 一律算
   失败」接住，把跑得好好的任务记成 `failed`。源头 `executor.utils.ts:20` 的
   `waitForTurnStart` 就是为这个存在的，移植时漏了。现在 followup 前记下
   `agent.session.seq`，followup 后轮询到 seq 增长（30s 上限 / 10ms 间隔，与源头同值）
   再等结束。

3. **「缺 `turn/end`」的判定口径反了**（`decideRunOutcome`）。原来是「没有 `turn/end`
   一律算失败」，源头是「只有显式的非 `completed` 原因才判失败」—— 核心在异常收尾
   （取消 / 中断 / 崩溃修复）时可能不补写这条事件，拿它判失败会**制造假失败**。
   第 2 条修的是「读到空事件集」，这条修的是「读到空事件集之后的处置」，两处缺一个
   都不行。

   要防的从来不是「没写收尾原因」，是「**拿一个已知的失败当成功**」。所以：
   `reason === undefined` → 成功；`reason` 是 `completed` 以外的东西 → 失败；
   `aborted` → 取消。而「这一轮到底跑没跑起来」改由新的 `started` 单独表达
   （`started === false` 才判失败，文案也分开：`等不到这一轮启动` ≠
   `准备无人值守会话失败`）。

   源头那条「增量丢了 `turn/end` 就回退全量快照」（`docs/sync-log.md`）是**取数**的
   口径，和这里的**判定**口径是两件事 —— 原注释把它们混成了一件。本移植读的本来就是
   全量快照，不存在那条顾虑。

4. **`tick` 补算会静默停用任务**（`tick()`）。算不出下一次（`once` 已过期 / schedule
   不合法）就 `task.enabled = false`。停用是拿一次内部计算去改用户数据，而且**不说
   一声**：用户下次打开面板只看到「已停用」，不知道是谁关的，也不知道原本要跑什么。
   源头 `tick` 在 `occurrence === undefined` 时什么都不做（既不改 `enabled` 也不写盘）。
   改成先在只读副本上算，算得出才进写队列；算不出的跳过并 `log` 一次（`noNextWarned`
   Set 去重，tick 每秒一次不能刷屏）。

   「不静默」后来（第 13、15 条）补了另外两半：只写宿主日志等于没有可见性，面板和
   `scheduler_list` 都得说出来；去重 Set 还得等于**当前**卡住的集合，否则停用再启用后
   永远不再报。

   原来那个「不停用就会每秒全量写盘」的理由是真的，但那是**写法**造成的
   （`mutateTasks` 被无条件调用），不该用改用户数据来绕 —— 顺手把写法改对了，写盘次数
   归零。计划改好后下次 tick 能补算出来并恢复正常。

5. **`interval` / `custom` 的下一跳被本次耗时污染**（`advance()`）。一律用
   `nextOccurrence(schedule, now)` 推下一跳，于是每轮的**耗时被累加进周期**：每 60 分钟
   的任务，每轮跑 5 分钟 → 实际间隔 65 分钟，且每轮再加 5 分钟，越漂越远。源头 `fire()`
   分了两类：`interval` / `custom` 是有固定格子的，从**原定时刻**推下一格
   （`from = kind === 'interval' || kind === 'custom' ? previous : now`）；
   `daily` / `weekly` / `monthly` / `hourly` 本来就是「下一个钟表时点」，继续用 `now`。

6. **启停接口只靠取反**（`POST /tasks/toggle`）。只认 `{id}`，然后在服务端按库里当前
   状态取反；而面板上那个按钮是按**它自己那份快照**画的 —— 另一个窗口、或者 CLI 改过
   之后，标着「停用」的按钮会把任务**启用**。跟源头 `task.toggle(id, enabled)` 一致，
   收显式布尔值：传了就用它（幂等），没传才取反（旧调用方式不至于立刻失效），非布尔值
   → 400 不猜。客户端改成显式传 `enabled: !task.enabled`。

第 5、6 条是核语义时顺手扫出来的，不在最初那份清单里 —— 一起放进来是因为它们和前面
几条同一个来源（对着源头逐条核），拆开反而看不清这批改动的边界。

**后 10 处（审查轮 + 回归轮）**，按严重程度：

7. **修第 5 条修过头：手动触发也按原定时刻算下一跳**（`advance()`）。手动触发不消耗
   计划里的那一格，但 `custom everyDays=7` 手动跑一次会因此静默吃掉一整周。改成只有
   「这一格真被消耗」时（`scheduled === true`）才从原定时刻推。
8. **同一处修过头：长积压按原定时刻逐个重放**。停机三天后 `interval` 会补跑 N 次，和
   REQ-007 第 3 节「不补历史」直接矛盾。下一跳过旧就重新对齐到 `now`。
9. **`tick` 的 `plan` 快照无条件写回**（`tick()`）。写盘要排队，这一会儿任务可能已被
   `advance` 推走 —— 把旧值写回去会让任务**立刻又跑一遍**。改成在写队列里按当下这份
   重判重算，`plan` 只用来决定「有没有活要干」。
10. **`waitForTurnStart` 的判据在三种形状上会给出错的答案**。`NaN` 也是 `number`
    （`NaN <= x` 恒假）→ 循环一次都不进，0ms 就返回，连那次退让等待都没有；`seq` 倒退
    （会话被换掉/重置）→ 白等满 30 秒再判死，把一轮正常的运行记成失败；中途变得读不出
    来 → 同理。三种都收敛到同一条不变式：**观测不到不等于没发生**。
11. **`turnStartTimeoutMs` 不在 `SCHEDULER_FIELDS` 里**，而 `installScheduler` 又在读它。
    `layered()` 会把没登记的键丢掉 ⇒ 值恒为默认，配置里写了被静默忽略，代码却看着像
    支持配置。登记进去（下限 50ms），并加了一条结构断言：`SCHEDULER_DEFAULTS` 的每个键
    都必须有对应的校验函数。
12. **`decideRunOutcome` 的文案硬编码模块常量**。配了别的值时（自检故意配 20ms），报错
    会说一个**没发生过的**数字。
13. **「启用着但算不出下一次」只有一行宿主日志**。用户没有理由去翻宿主日志，所以实际
    可见性是零：他会以为任务在跑，几个月后才发现一次都没跑过。面板加橙色徽标，
    `scheduler_list` 加 ⚠️ 一行。
14. **`scheduler_update` 的返回值说假话**。补丁存了、只有触发失败时回 `ok:false`
    （等于说「这次调用没生效」→ 重试补丁 / 以为没落地）；`run_now` 成功路径回一个
    **马上要变**的 `nextRunAt`（`trigger` 只是 `fireAndForget`，返回时后台那一轮还没
    走到 `advance`；「触发后重读存储」也修不了 —— `execute` 的第一个 `await` 就在
    `advance` 之前，同步读到的必然是旧值）。改成 `ok:true` + 单独的 `runError`，
    `run_now` 路径回 `nextRunAt: null` 并在 render 里指明去 `scheduler_list` 查真值。
15. **`noNextWarned` 只增不减**。任务停用/删除后条目留着 ⇒ 再变回卡住时**永远不再报**，
    「只报一次」实变成「一次都不报」—— 而那条日志正是「保持启用但不再触发」唯一的信号
    （13 那次才补上面板提示）。改成每次 tick 让它等于当前卡住的集合；清理那一步还必须在
    「有没有要补的」那个 guard **外面**，因为任务从卡住变停用时 guard 正好变假。
16. **`decideRunOutcome` 的 `cancelled` 参数恒为 false**。唯一给它赋值的地方紧接着就
    `return { status: "failed" }` 了，是条死分支（取消只有 `reason === "aborted"` 一条
    活路径）。删掉。

每一处都单独一个提交（共 14 个提交盖 16 条），各自带回归测试和**负向验证**（把修复换回
旧实现，对应断言必须变红；换回来必须全绿）。`npm test` 退出码 0，断言块 64 → 71。

**写负向验证时前提搞错，测试就是摆设** —— 这一轮栽了两次，都记在 REQ-007 第 11 节：
第 15 条的测试第一版把「停用」放在「卡住」**之前**（那时去重集合里本来就没有条目，
改不改都过），第 9 条第一版的并发值取了 `now + 10min`（正好等于 `plan` 自己会算出的值，
新旧代码都是绿的）。

### 三档审查后的第 2 轮修复（2026-10-06）

上面那轮修完之后又跑了一遍三档审查（正确性 / 整体性 / 安全），再修 8 处，一个提交一件事、
各自带负向验证（共 8 个提交）。清单和教训在 REQ-007 第 12 节，这里只留最值得记的三条：

1. **自检里会有「从来没跑过」的断言，而且它显示全绿。** `check(` 是同步包装器，传一个
   `async` 回调时 promise 没人接：实测把它改回 `check` 并在块末尾写一个文件，文件根本
   没被创建，而**退出码是 0**。同步的 `process.exit` 发生在那个 async 体跑完之前 ——
   第一个 `await` 之后的断言一直只是装饰。
2. **最贵的一处是 schema 说假话**：`nextRunAt` 声明成 `string`，实际返回数字，而 dsh 会
   拿 `output.schema` 校验工具的**返回值**，不符就抛 —— 每一次成功的 `scheduler_create`
   都在工具边界失败。测试当时还把错的类型**钉住**了（`deepEqual` 那个 `string`），所以
   它一直是绿的。现在补了「真实返回值跑一遍自己的 schema」的检查。
3. **同一类错会在相邻处各犯一次**：触发时不查权限天花板、`turnStartTimeoutMs` 只在一处
   校验，都是「校验只补了一半」。修法统一为「收口到一个函数，所有入口走它」。

两处判据跟着实现改了（文档原来和代码相反）：缺 `turn/end` 判**成功** + 留
`incomplete`/`noEvents` 证据；「启用着但算不出下一次」在面板和 `scheduler_list` 都要说
出来。

### 三档审查查出来的问题（第 3 轮修复，2026-10-06）

同一轮三档审查里三份结论都确认核心修复的判据没写反，但也查出 3 处，各自一个提交
（`227146c` / `a1562a9` / `e315f74`），清单在 REQ-007 第 13 节。最值得记的一条：

**「修掉被指出的那一个」不等于「把这一类修掉」。** 第 2 轮已经写下「校验只补了一半，
要收口到一个函数」，可紧接着这一轮又只补了 `turnStartTimeoutMs` 一个字段 ——
插件配置那一路（`layered()` 的 `...override`）**不过** `SCHEDULER_FIELDS`，于是
`maxConcurrent: NaN` 就是「并发不限、无界起真会话」，`historyLimit: NaN` 就是「`runs.json`
无界增长」，`runTimeoutMinutes: 1e9` 就是「单轮占着名额 24.8 天 + 时间兜底失效」。
既然缝是「整份配置没校验」，就得**整份过一遍**，不是再补一个字段。

另外两处都是「读路径说的和实际不是一回事」：`scheduler_list`（agent 唯一的读路径）
把「进程被杀留下的那条」吐成英文原文，把「零事件」和「有事件但没收尾」报成同一句话；
以及手动触发之后的 `nextRunAt`，注释和用户可见的提示都还停在早退修复**之前**的行为上。

查了但**决定不改**的三处（`permissionRank` 对缺失权限按最严处理、`run_now` 无限速、
天花板只在手动路径拦）连同理由写进 REQ-007 §7。

### 再跑一遍三档审查（第 4 轮修复，2026-10-06）

三档审查在修完之后又各跑了一遍该层。这次 4 个提交（`4ceee2d` / `d090067` ×2 件事 /
`74d4aff`），清单在 REQ-007 第 14 节。最值得记的一条：

**收口之后要问「还剩什么乘积没算」。** 上一轮堵的是「值非法」，可**合法值之间相乘**
照样能失控：`historyLimit` 的上界当时只看条数（10 万），没看单条记录有多大
（`summary` 4000 + `error` 2000 字符），也没看 `mutateRuns` 每次都是整份读改写 ——
10 万条就是 GB 级 `runs.json`，每跑完一个任务重写一遍。校验一个数值上界时，要看
它乘上什么才是真正的资源占用。

另一半是「静默」：被拒的配置值以前**一个字都不说**，`tickMs` 配成 2 小时会静默变成
1 秒（触发频率差 7200 倍），配置人只会觉得「我明明配了」。修法仍然是在共享处收一次
（`readJsonConfig` 报「值在文件里但没被采纳」，`layered()` 把 `ctx.logger.warn`
真的接下去 —— 以前传的是 `() => {}`，留痕是空转）。

### 自检

`scripts/selftest-scheduler.mjs` 八段、77 个断言块：计划纯函数（8 种 + 边界）、
任务构造与补丁、存储（原子写 / 历史裁剪 / 串行队列 / 坏文件留证 / 恢复中断记录）、
事件摘要与结论判定、`engine.tick` 的落盘与终态、**假宿主装配 + 真跑 HTTP 路由**
（含信任栅栏、任务数上限并发、断连收敛、500 vs 400）、4 个工具的参数表与
`output.schema` 全量校验、客户端面板（用 `new Function` 真加载那份 classic script）。

最后两段是重点：这个功能最大的风险不是算错时间，是「默认关的时候没真关」
「依赖不齐的时候把整个插件拖死」「路由被跨站调用」「无人值守会话把自己提权」——
纯函数一条都测不出。

八条负向验证（写进 REQ-007 §8）：

- 把 `anchoredOccurrence` 的 `Math.floor(...) + 1` 改成 `Math.round(...)`（即不再取
  「严格大于 from」的刻度）→ 2 条自检变红，退出码 1；还原后退出码 0。
- `enabled=false` / `enabled` 缺失 / `enabled=true` 但依赖不齐 → 工具 0、路由 0、
  effect 0；依赖齐备 → 工具 4、路由 1、effect 2；无 `webServer` → 工具 4、路由 0。
- 把 `engine.tick` 还原成旧写法 → 2 条自检变红；还原后退出码 0。
- 把 `agentCtx.tools.restrict` 移回设 `setupError` 的 try 外面 →
  「沙箱钉不上就绝不发 prompt（P0 回归）」变红；还原后退出码 0。
- 摘掉 `insertTask` 与两条 update 路径上的 `checkPermissionCeiling()` →
  「权限天花板：建和改都不许越过 maxPermission」变红；还原后退出码 0。
- 把放行判据从 `pinned` 改回「没记下 `setupError`」→ 「沙箱钉不上就绝不发 prompt」
  的 `setupNotCalled` 那一局变红；还原后退出码 0。
- 摘掉 `run()` 开头的 `checkPermissionCeiling()` → 「执行时也查天花板」变红；
  还原后退出码 0。
- 摘掉 `setApprovalPolicy` 后面那段回读 → 「沙箱钉不上就绝不发 prompt」的
  `silentApproval` 那一局变红；还原后退出码 0。

## [1.10.1]

修 magic-context 把会话写坏、**重启后整段历史打不开**的 bug
（`SessionFormatError: system/message requires a protected first surface head`）。

### 为什么

dsh 规定 surface 的首节点必须是 `system/message`（受保护头）。但 `agent/pre-step`
跑在 `step()` **之前**，新会话那一刻 surface 还是空的 —— `system/message` 要等
pre-step 返回后才由 agent-loop 落。magic-context 却在这一刻把两个
`<session-history>` 注入块直接 append 到了空 surface 上，于是它们抢到了第 0、1 个
节点位置，本该受保护的系统提示成了「后面才来的」，重载时被校验直接拒掉。

真正的杀伤力在**时机**：`session.append` 完全不校验这类关系，校验只在**重载**时跑。
所以坏形状安静地写了好几天，直到用户重启（或续聊）才爆 —— 而那一刻正是他最需要
那段历史的时候。本机 25 个会话里 19 个中招，凡是装过 magic-context 又续聊过的全部报废，
而且**每次续聊都在新写一个坏形状**。

### 修了什么

- `lib/mc.js`：`landOnSurface` 在 surface 还没有受保护头时**本轮不落地**
  （`reason: "no-protected-head"`）。注入块本来就是每轮从 DB 重算的，推迟一轮不丢内容，
  下一轮自然补上 —— 这是最便宜的一刀，不用去碰 agent-loop 的回合结束判定。
- `scripts/fix-surface-head.mjs`（新增）：修已经坏掉的日志。把那两个空占位块原地降级成
  `plugin:magic-context/session-history-injection` + `ignorable: true`（dsh 对未知
  ignorable 类型直接跳过 —— 保留 seq、时间与 payload，不重排序、不重新编号），
  并重算被波及的 compaction span 与 replace 范围。写盘前用 dsh 自己的加载期校验复验，
  不通过就不写；备份写到会话目录外。只认那两个空占位块，别的一律拒修。
- `scripts/selftest-fold.mjs`：新增场景 E，用真的 `Session` 钉住这个不变式
  （空 surface 不许落地；老写法「静默写坏」这件事本身也被断言）。
- `scripts/verify-sessions.mjs`：原来硬编码 Windows 安装树路径，改成共享的
  `findDshModules()` 自动定位；`scripts/e2e-fold.mjs` 同样的问题一并改掉
  （它此前在本机根本跑不起来，测试链里也够不到）。
- `lib/session-log.js`：`writeSessionLog` 改成**同目录临时文件 + `rename` 原子替换**
  （再 fsync 文件与目录；`rename` 的上一行做一次 CAS 核对）。以前是原地截断重写，
  中途被杀/写满会留下半截会话日志 —— 那才是真正没救的那种坏法。两个修复脚本都走这个函数。
- `lib/session-log.js`：新增共享的 `heldOpen()`（Linux 扫 `/proc/<pid>/fd`，按 dev/ino 比）。
  `scripts/fix-mc-corruption.mjs` 用同一个 `writeSessionLog`（rename 换 inode），
  所以也补上同一道并发判据 —— 否则它会把 dsh 正在追加的那批事件写进已被换掉的旧 inode，
  静默丢事件；顺带把它的口径对齐 `fix-surface-head.mjs`（尾部截断的会话不再整文件重写、
  跳过的会话计入退出码、写后复验、备份目录权限复核）。`fix-surface-head.mjs` 的拒修条件
  也收紧到「首节点正好是那两个占位块」，且拒修只打类型与块数、不打正文。

## [1.10.0]

子代理的档位改成**钉在工具行上** —— 这是 dsh 0.2.0-rc.2 上唯一还成立的做法。

### 为什么

团队规范一直说「按角色选档」（reviewer→tier-power、oracle→tier-max），
但那套是 pi 的机制：`~/.pi/agent/settings.json` 的 `subagents.agentOverrides`。
dsh 0.2.0-rc.2 **完全不读它** —— 2026-10-05 全树 grep `agentOverrides` /
`disableThinking` 零命中，本包也只有 `preset-gen.js` 读这个文件、且只读
`compaction`。也就是说这份档位映射**一直是死的**，只是没人发现：
规范里写着「你必须显式传 provider/model」，而实测传了直接报
`child model selection is disabled for this tool instance`。

rc.2 的模型选择是 Host 运行时设置（`subagent-model-selection-settings`）：界面上
勾开关 + 填允许模型列表，主 agent 就能显式传 `provider`/`model`。注意它**按顶层会话采样**
（`modelSelectionSettings` 的语义是「每个新顶层会话采样一次、子会话继承」），
所以老会话会一直沿用创建时的判定 —— 实测撞到的 `child model selection is disabled`
就是这个原因，不是配置写错。两条路都留着：钉死的工具行不受开关影响，开关开着时
普通的 `subagent` 也能显式选档（见 team/RULES.md 的选档那节）。

### 改法

团队预设里给每一档挂一条独立的 `subagent` 工具行，`agentOptions` 写死
provider + model —— **调用哪个工具 = 选了哪一档**，不依赖任何界面开关：

| 档位 | 工具名 | 用在哪 |
| --- | --- | --- |
| `tier-std` | `subagent_std` | 侦察、读代码、常规实现、三层审查的第 1 层 |
| `tier-power` | `subagent_power` | 审查、调研、多文件改动 |
| `tier-max` | `subagent_max` | 质疑方案、架构决策、难 bug |

驱动它的是 `team/agent-settings.json` 的 `subagents.tierTools`
（`{std, power, max}` → 团队网关的模型别名）+ `subagents.provider`。
原来的 `agentOverrides` 已删除（死键）；没配 `tierTools` 的成员不会因此生成失败。

`modelSelectionSettings` **故意不写**（等于关）：往这几条工具行传
`provider`/`model` 会明确报错，而不是被静默盖过 —— 报错比「以为选上了」好。

规范里的选档表、三层审查表、调用形状示例全部跟着改（`team/RULES.md`）。

### 验证

- `selftest-preset-gen` 新增断言：档位行按 settings 生成、插在 `tool-subagent-fork`
  之前、`toolName`/`model` 拼写正确、没配就不加行；生成器自带的「逐条撤回去必须
  逐字节等于出厂文件」自检覆盖了这一块。
- 真机 `dsh-team preset install` 后，`--dump-config` 里能看到三条
  `tool-subagent-std` / `-power` / `-max`。
- 顺手修一个小别扭：默认预设已经是 team 时，`preset install` 不再提示
  「想让它成为默认」。

## [1.9.2]

第二轮 rc.2 适配：修掉 3 个真 bug、1 个功能级坏掉、1 个静默失效，并让自检在这台机器上真的能跑。

### 修了什么

| 现象 | 位置 | 根因 |
| --- | --- | --- |
| 自动交接后新会话空着不动 | `lib/handoff.js:297` | rc.2 的 `SessionController.prompt(request, signal)` 第一句就是 `signal.throwIfAborted()`，我们只传了 request → 必抛 TypeError 被 catch 吞成「注入失败」。新会话建了、文档写了，任务进不去 |
| `/thrift show` 恒报「读不到生效值」 | `lib/thrift.js:98` | 还在读 0.1.x 的 `.agent-presets/team/agent.cordis.yml`；rc.x 的落点是 `<DSH_HOME>/team-workflow/preset-team/cordis.patch.yml` |
| 多实例启动时误报「检查失败」 | `lib/auto-update.js` | 不只是少认一句文案：`runGit` 只取 stderr **第一行**当 message，而并发 fetch 失败时第一行是正常的 `From <url>` 摘要，真正的 `error: … incorrect old value provided` 在后面 → 重试判定不认，给用户看的原因也是错的 |
| 删除带改动的 worktree 时安全提示丢了 | `lib/worktree.js:549` | 脏工作区判定只认英文；zh_CN 下 git 报「包含修改或未跟踪的文件，使用 --force 删除」。删除仍被拒（没丢数据），但「有未提交改动」这个提示没了 |
| 「预算」不是硬上限 | `lib/bash-linux.js:227` | 丢整块的循环对「单块自己就超预算」不生效（实测残留 62KB vs 预算 32KB）。改成入口先按尾部切到 budget（复用 `clipTail`） |

### 自检

`npm test` 是 `&&` 链，**断在 `selftest-surface` 就停了** —— 17 个自检只跑到 3 个。根因是几个脚本把打包版桌面端的历史路径写死当默认值。

- 新增 `scripts/dsh-modules.mjs`：定位安装树的探测顺序与 CLI 一致（`DSH_MODULES` → PATH 上的 `dsh` → profiles 共享层），拿不到时**明说跳过了哪几节**。
- `tool-schema` 的工具条数按平台算（computer 是 Windows-only，非 win32 是 8 个）。
- `bash-linux` 的 cwd 用例按平台分开：Windows 验「MSYS 路径要变原生」，非 Windows 用 realpath 比对。
- `selftest-handoff` 的假 `sessionController` 改成照抄 rc.2 契约（`prompt(request, signal)` + `throwIfAborted`）—— 之前它只收一个参数，所以上面那个必现 bug 一次都没被抓到。反向验证过：拆掉 signal 这一行，自检立刻红。

本机 17 个自检全绿，`npm test` 一条链跑到尾。

### 文档

`team/RULES.md` 与 `team/agent-settings.json` 里还在教人写 `contextWindow` /
`compactThresholdRatio` 当 dsh 的压缩键 —— rc.x 的 `compaction-basic` 没有这两个键，
且**对未知键直接抛错**（整个 dsh 起不来）。我们的文件没炸只是因为有 `preset-gen` 映射。
同时更正了「缺 contextWindow 会退回 128000」那段 pi 时代的语义，并把不存在的
`dsh-team thrift show` 改成 `/thrift show`。

## [1.9.1]

`dsh-team patch` 在 dsh 0.2.0-rc.x 上修好了：思考链和工具行又能默认展开了。

### 现象（2026-10-04 实测）

两条叠在一起：

1. `dsh-team patch --status` 直接报「找不到 dsh 客户端 bundle；dsh 装在哪？」——
   连文件都摸不到；
2. 就算摸到了，rc.x 里也打不上：上游把组件重构了。

### 根因一：发现逻辑只看 profile

`discoverBundles` 只在 `$DSH_HOME/profiles/*/node_modules` 里解析 `@deepseek-ai/*`。
但 web profile 的客户端 bundle **不在 profile 里**（那份 node_modules 只有本插件），
是从安装树（npx 目录）解析的。现在补上了 `installRoots`：从 PATH 上的 `dsh`
反推安装树，跟 `preset install` 用的是同一条路子。

### 根因二：rc.x 的组件换了实现

| 插件原来认的 | rc.x 实际 |
| --- | --- |
| `function ReasoningRow(` 在行首 | `const ReasoningRow = (0, react.memo)(function ReasoningRow(` |
| 组件体内 `const [expanded, setExpanded] = useState(false)` | 抽成共享 hook：`const { expanded, toggle } = useDisclosure();`，组件体内一个 `useState(false)` 都没有 |
| 终端行是 `BashRow` | `BashRow` 只剩分发器，持状态的是 `StartedBashRow` |
| — | `useDisclosure` 定义在 chat bundle，以 **prop** 传给 tool bundle 里的 ToolRow / BashRow |

所以补丁改成认两种形态：

- **老形态（0.1.x）**：改组件里的 `useState(false)` —— 行为不变。
- **rc.x 形态**：给 `useDisclosure(version = 0)` 加一个 `defaultOpen` 形参，
  初始 `expandedVersion` 取 `defaultOpen ? version : null`（于是
  `expanded = expandedVersion === version` 为真，toggle 逻辑不用动）；
  再改三个目标组件各自的调用点 `useDisclosure()` → `useDisclosure(0, true)`。
  组件窗口按锚点切，所以 `ChatGroupSeat` / `QuestionToolRow` 这些同样调
  `useDisclosure()` 的行不受影响。

顺带修的两处：

- 组件名支持 `altName`，并在两个都命中时**挑窗口里真有展开态的那个**
  （rc.x 的 `BashRow` 名字还在，光看名字会挑到分发器）。
- `--status` 之前拿 apply 函数的返回值当现状，会把没打的报成「已打补丁」；
  拆出 `disclosureHookStatus` 单独判。

### 验证

- `selftest-patch.mjs` 新增 rc.x 一节：memo 包装 + 共享 hook + 分发器改名，
  并断言「不碰别的组件」「重复打报 already」「老形态仍然认」。
- 本机真跑 `dsh-team patch`：两个文件四处全绿（思考链 / 展开默认值 / 工具行通用 /
  工具行终端），`--status` 复检一致，文件里能 grep 到
  `useDisclosure(version = 0, defaultOpen = false)` 与两处 `useDisclosure(0, true)`。

## [1.9.0]

`dsh-team preset install` 在 dsh 0.2.0-rc.x 上真正可用，并修一个「装了但没生效」的坑。

### 现象（2026-10-04 实测）

按老实现（把预设写成 `$DSH_HOME/.agent-presets/team/` 目录）装完，预设列表里根本
看不到「团队模式」：连「standard 预设目录」都找不到 —— rc.x 里那个目录已经没了。

### 根因：预设的承载方式变了

dsh 0.2.0-rc.x 起，预设不再是目录，而是 profile 树里的一行
`@deepseek-ai/dsh-agent-preset` 声明；**并且这行必须由 bundle patch 承载**。
dsh 自带 skill `editing-cordis-compositions` 的原话：旧目录 "Nothing reads that directory any more"。

把同一条声明塞进 profile 的 `cordis.patch.yml`（这条弯路走过，别再走）：

- 行会出现在组合树里，`--dump-config` 也看得到；
- 但**预设不会被注册**（`plugin_manager list_plugins` 里没有 `preset-<id>` 那一行）；
- `default: <那个 id>` 于是指向不存在的预设，会话退化成「无预设」：
  persona / plan-mode 等预设文本全丢（系统提示 20911 → 18070 字），且 host 层被
  `dsh-web-app` 设成 disabled、只由预设提供的 `tool-fs`（read / write / edit）、
  `present`、`ask_user_question` 一起消失。

换成 bundle 承载后同一份内容：roster 里 `fiberPhase: active`，一切正常。

### 实现

- `lib/preset-gen.js` 新增 `generateRc2TeamPreset`：**照着当前出厂的
  `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 现改**，只动四处
  （文件头注释 / 声明块 / persona 模式标识 / compaction 阈值），其余逐字照抄，
  并做「逐条撤回去必须逐字节等于出厂文件」的自检 —— dsh 升级不会让它失真。
- `preset install` 自动识别布局：rc.x 走 bundle（落在
  `<DSH_HOME>/team-workflow/preset-team/`，再挂进 profile 的 dependencies + bundles），
  0.1.x 仍走旧目录。
- 新增 `--default`：把 `agent-preset-registry` 的 `default` 切到 `team`
  （带备份、幂等）。默认预设本来就是**设置字段**，写这里等价于在界面里设默认，只是不用人点。
- `thrift apply` 在 rc.x 下改为重生成整份 bundle；校验仍走 `resolveThriftConfig`，
  非法值在写出之前拦住。
- persona 末尾多一行「当前模式：团队模式。」—— 让模式在系统提示里可见。

### 验证

- `selftest-preset-gen.mjs` 新增一节：小样本 + **出厂原文件**两条路都跑，断言只改该改的、
  阈值可回读、非法值被拦住、生成幂等。
- 本机真跑：`dsh-team preset install --profile web --default` → bundle 落盘、
  `--dump-config` 五个预设含 `team`、roster 里 `preset-team` = enabled/active。

## [1.8.1]

修一个「装上就每轮都失败」的 bug：dsh 0.2.0-rc.2 的 format v4 不再接受 `source.kind: "plugin"`。

### 现象（2026-10-04 实测）

装进 profile 后 `dsh verify "Reply with exactly: OK"` 必挂，稳定复现：

    dsh: format v4 message requires a producer-owned source kind

同一个 profile 卸掉插件立刻通过，所以不在 dsh 自己身上。

### 根因

dsh 0.2.0-rc.2 起消息来源进入 format v4：`source.kind` 必须是**生产者自己的名字**，
逐字写 `"plugin"`（旧式 `{kind:"plugin", plugin}` 包装）会被
`assertV4MessageSources` 直接拒掉。插件有三处还在写旧形状：

- `lib/mc.js` —— magic-context 注入块，**每一轮请求**都会走
- `lib/lens.js` —— 编辑后的 pi-lens 报告，**每一次编辑**都会走
- `lib/handoff.js` —— 交接时往旧会话留的提示

### 修法

三处统一改成 `plugin:<名字>`，与 dsh 自带 v3→v4 迁移
（`dsh-session-format-v3-to-v4` 的 `producerKind`）对旧值产出的 kind 逐字一致。
`scripts/selftest-handoff.mjs` 原来断言的正是旧形状，一并改成断言 v4 契约
（断言意图不变：不能是 `"user"`）。

### 验证

headless 真跑：注入块落盘为 `plugin:magic-context`、编辑钩子落盘为
`plugin:team:lens`，两轮均 exit 0；审计日志里能查到这两条 `source`。

## [1.8.0]

修一个「两个配置各自都合法、合起来才错」的 bug：magic-context 与 dsh 自带压缩的阈值互斥。

### 现象（2026-09-29 实测）

用户报：「再次给 ai 发出指令的时候会概率触发 dsh 自带的压缩，并且 magic-context 也没有剔除上下文」。

- dsh 自带压缩一天触发 **83 次**，全部在 24.4%–25.2%（正是 `compactThresholdRatio` 0.25 的位置）；
- magic-context 的 `shouldFire=true` 在全部日志里出现 **0 次**，历史最高 usage 仅 **25.4%**；
- mc 的 `pending_ops` 里 **26 个 `drop` 操作排队从未执行**，`compartments` 表只有 2 行。

### 根因

mc 的默认执行阈值是 **65%**（主动线 = 阈值 − 2 = 63%），而 dsh 的压缩阈值是 **25%**。
dsh 每次都先把地板压回低位 → mc 的 63% **结构性不可达**，它排队的删除也就一直排不上队。

（如实说清归因边界：mc 的执行门不止「usage ≥ 阈值」这一条 —— 还有 m0 hard fold、
explicit flush、published history 等路径。阈值是**主因**，不是唯一因；但实测 26 个 drop
一个都没执行，且所有可观测信号都指向阈值互斥。）

而 dsh 压得也不便宜：压缩后地板只从 128K 掉到 **~70K** —— 系统提示 + 工具声明 + 摘要本身约有
**70K 不可压缩底座**，每个周期只有 ~58K 可用空间，所以约 5–10 轮就又撞线。这才是「发一条指令
就触发压缩」的真身：不是概率，是地板大多数时间就停在 100–128K 区间。

### 修法

**mc 先动手，dsh 退回应急兜底**（用户选定）：

| | 阈值 | token | 分工 |
| --- | --- | --- | --- |
| magic-context | 20%（主动线 18%） | 102K | 按 tag 细粒度删除旧内容 |
| dsh 自带 | 25% | 128K | 兜底：整段摘要替换 |

新增：

- `team/mc-config.template.jsonc` —— 团队阈值模板（含为什么是 20% 的注释）；
- `lib/mc-config.js` —— JSONC **注释安全**的顶层键定位与就地改写、阈值读取、不变式校验；
- `dsh-team mc show` / `mc apply [--dry-run]` —— 并排显示两边阈值、写前校验不变式（不合法拒绝写）；
- `scripts/selftest-mc-config.mjs`（第 17 段自检）—— 把不变式锁进 `npm test`。

### 另一件事：history 预算的配套补偿

降阈值有个容易被忽略的副作用：mc 的 history block 预算按
`窗口 × (执行阈值/100) × history_budget_percentage` 算（bundle `resolveHistoryBudgetTokensForPi`），
**阈值一降、绝对预算跟着缩水**：

| | 计算 | tokens |
| --- | --- | --- |
| 改前（65% × 0.15） | 512000 × 0.65 × 0.15 | 49,920 |
| 不补偿（20% × 0.15） | 512000 × 0.20 × 0.15 | **15,360（-69%）** |
| 补偿后（20% × 0.45） | 512000 × 0.20 × 0.45 | 46,080（≈改前的 92%） |

所以模板里连 `history_budget_percentage: 0.45` 一起写 —— 降阈值是为了让 mc 先动手，
不是为了砍它的历史预算。自检断言这个补偿不能丢。

`mc apply` 只动 `~/.config/cortexkit/magic-context.jsonc` 里**受管的那两个键**，
其余字节（用户自己写的 historian 配置、注释）逐字保留（mc 的配置是深合并 + 逐键回落默认值，
没写的键走 mc 自己的默认）。**改完需重启 dsh**（这些键不在 mc 的 46 个实时重载键里）。

### 为什么用文本级就地改写而不是 JSON.parse + 重写

用户配置里有解释性注释（historian 为什么配 tier-std），整份重写会把注释全丢掉。扫描器是
注释与字符串安全的，并且**只认顶层键** —— 嵌套的同名键（mc 支持 per-model 配置）不会被误改。

### 三层审查（每层都报出了真缺陷，全部修掉并逐条加自检）

- **P0（第 1 层）**：文件不存在时 `before` 取的是模板（值已是目标值）→ 计划恒空 →
  报「已是目标值」但**文件根本没创建**，mc 仍跑默认 65%。新成员跑 apply 看到 ✓ 却什么都没发生。
  修：文件不存在时一律计入计划；现在真创建文件（实测）。
- **P1（第 3 层）**：插入点用 `indexOf("{")` 不校验根 → 数组根 / 注释里含 `{` 时
  **静默写出坏 JSON 却报成功**。修：改用扫描器定位并校验根必须是 `{`。
- **P1（第 1 层）**：`scanValue` 的分隔符集不含 `/` → `20 /* 为何 */` 的区间吞掉注释，
  读值变 NaN、写入时**删掉用户的注释**。修：分隔符集补 `/` 与 `[`。
- **P1（第 2 层）**：`dshCompactionPct()` 只读团队默认、**忽略 `/thrift compact` 的 overlay** →
  成员覆盖过阈值后 show/apply 与实际生效值脱节。修：改走 preset-gen 的 `resolveThriftConfig`（同一优先序、同一份代码）。
- **P2**：重复键只改第一个（JSON 取最后一个 → 改了但没生效）、`Number("")` 把空值读成 0、
  无备份、写失败裸栈、`mc show` 硬编码窗口 512000 —— 全部修掉。

### 顺带修掉两个会让自检**假红**的脆弱点

- `fakehuman`（自检的人事件模拟）原用相对位移，受 Windows 指针加速影响（同一个 dy 距离不同）→ 改绝对坐标。
- 「AI 没被拦」原用「blocked 计数不变」断言，会被偶发人事件噪声弄假红（实测 `blocked 221 → 229`，而机制是对的）
  → 改用守护进程新报的 `injected` 计数（带标记、被放行的事件数）上升。修后连跑 4 次全绿。

### 附带修掉：操控电脑的「锁鼠标」几乎没生效

用户反馈「锁不了鼠标，顶多让鼠标慢一点」（2026-09-28）。逐项实测查清：

- **拦截机制本身是有效的**：外部进程高频注入 400 个非标记事件 → **400/400 全被拦、光标不移**。
  问题不在拦不拦得住。
- **真因是锁的窗口太窄**：锁只在工具调用的瞬间生效，而模型两次操作之间会思考几秒到几十秒。
  原来的 **15 秒**空闲窗口意味着「模型一想事，锁就松了」——
  用户去碰鼠标时绝大多数时刻锁都是关的，感受上就是「根本没锁」。
  默认窗口改为 **2 分钟**（`idleUnlockMs`，可配），并加自检断言防回退（≥60s）。
  立即取回鼠标：`Ctrl+Alt+L`。
- **钩子移到独立线程**跑紧消息循环（文件轮询留在主线程）。原设计里两者共用主线程：
  虽然实测没测出吞吐问题（把 `Sleep(15)` 加回消息循环后比值仍是 0.85 —— LL 钩子的回调
  由系统**直接**调用，不受消息循环 sleep 影响），但结构上仍不该让钩子回调和文件 I/O 抢线程。
- **自检不再依赖光标落点**：这台机器实测有 ~34 个合成鼠标事件/秒的噪声（光标不动、只发事件），
  位置断言必然假红。改用守护进程自报的 `blocked` / `injected` / `passed` 三个计数。
- **未验证项（诚实标注）**：以上全部用**注入事件**（`mouse_event`）验证。
  若真实鼠标/触控板走 Raw Input 或厂商驱动**直接**移动光标，`WH_MOUSE_LL` 可能拦不住 ——
  这需要真机手动确认，已写进 REQ-002 §7 天花板。

### 验证

17 段自检全绿；反向验证（把模板阈值改成 30% > dsh 的 25%）→ 不变式断言红。
详见 [REQ-003](docs/requirements/REQ-003-mc与dsh压缩阈值冲突.md) §8 的逐条实测记录（含三层审查逐条修复）。

## [1.7.0]

操控电脑**默认启用**（`team/extensions/computer.json` 的 `enabled` 默认 `true`）。

### 为什么

用户 2026-09-27 要求「默认启用电脑操控」——不再需要手改配置重启。
连带影响：
- 7 个工具声明进入每次调用的地板（默认开的代价，`enabled:false` 可随时关）；
- **不预热**：安装时不 spawn 常驻进程（懒启动，首次实操才冷启动 ~1s）。
  安装期 spawn 是副作用，会污染任何 `apply()` 过的进程；
- 非 Windows 恒不注册（platform 检查在 enabled 之前，行为不变）。

### 顺带修掉的两个真 bug（默认启用把它们暴露出来）

1. **`fs.watch` 拴死事件循环**：紧急解锁原先靠 `fs.watch` 监听守护进程写的事件文件，
   而 Windows 上 `fs.watch` 的句柄 **`unref()` 无效** —— 结果任何 `apply()` 过的进程
   （含 `npm test` 整条自检链）跑完都退不出去，卡到超时。
   改用 `ensureArmed()` 每次实操前查一次 `status`（权威、已是 P2 的兜底路径）；
   daemon 仍写 `out/event-emergency.txt` 作证据文件。
   代价：每次操控多一次 spool 往返（~20ms）。
2. **自检互相污染**：`selftest-mc` / `selftest-context7` 也 `apply()` 整包，
   默认启用后会各留一个守护进程 → 后跑的 computer 自检被别的实例钩子拦掉。
   这些自检不测 computer，显式 `computer: { enabled: false }`。

自检同步翻转：「默认关零工具」→「默认启用 7 工具 + 显式关零工具」
（反向验证：默认改回 false → 红）。审批/锁/门禁行为不变。
全量 16 段连跑 2 次 EXIT=0、无残留守护进程。

## [1.6.1]

修复 1.6.0 插件加载失败（dsh 启动报 `unsupported JSON schema`）。

### 为什么

`ctx.tools.register()` 对 `output.schema` 跑 `assertSupportedJsonSchema`，只认标准
JSON Schema；`screenshot` 的 output.schema 照抄了 dsh-tool-fs 内部方言（property 内
`required: true`、`required` 不是数组）→ 校验拒绝 → 插件树加载失败 → dsh 启动失败。
自检只扫了 7 个工具的 `parameters`、没扫 `output.schema`，所以没兜住。

修：shotOut 改标准数组 `required`；`selftest-tool-schema` 补上「15 个工具的
output.schema 全量真校验 + output 必须有 schema/render」，反向验证（方言塞回去）
→ screenshot 红。

## [1.6.0]

操控电脑（computer use）：AI 能看屏幕、动鼠标、敲键盘，操控期自动锁定鼠标。
新增 7 个工具（`screenshot` / `cursor_position` / `mouse_move` / `mouse_click` /
`scroll` / `type_text` / `key_press`），**默认关**，`team/extensions/computer.json`
的 `enabled` 设 `true` 才注册（仅 Windows）。

### 为什么这么设计

- **参考对象是 Anthropic computer use**：调研确认 Codex 根本没有操控电脑插件
  （降级调研：无联网，基于内部知识，见 REQ-002 §5），最接近的两家里 Anthropic
  的动作集与安全设计最完整：模型只发指令、宿主执行、截图回传。
- **锁鼠标用注入标记钩子**：常驻 PowerShell 守护进程装 WH_MOUSE_LL，armed 时
  放行带 `dwExtraInfo=0x44534843` 标记的 AI 注入、拦截人的真实输入 —— 人完全锁死、
  AI 零延迟，不需要管理员权限。Ctrl+Alt+L 紧急解锁，空闲 15s 自动还鼠标；
  钩子进程死 = 自动解锁（外部进程天然 fail-open），检测父进程退出自退不留孤儿。
- **审批**：dsh approval 首次 `allowed-once` 后本会话放行；无审批服务 / 拒绝 /
  取消一律拒绝（fail-safe）。截屏同样要审批（看见全屏与操作同级）。
- **图片直回模型**：截图 → `attachments.saveImage` → `render` 出 `[text, image]`
  ContentBlock；模型路由不支持 image 输入时拒绝执行（照 dsh-tool-fs 门禁）。
- **文件 spool 通信**：宿主与守护进程之间用 in/*.cmd → out/*.out 文件往返，
  没有线程、没有行协议，超时弃单重启即可，不存在流错位。

验收：16 段自检全绿（含真跑守护进程：armed 拦 fakehuman、放行 AI 注入、真截 PNG、
dispose 杀进程）；REQ-002 §8 逐条记录。坑：Windows PowerShell 5.1 读无 BOM 的
UTF-8 中文脚本按 GBK 解码会假报解析错 → 脚本必须带 UTF-8 BOM 写入。

## [1.5.0]

系统提示注入开头带一行当前基线版本。

### 为什么

模型报问题、对文档、判断行为时，不知道自己跑在哪个基线上，只能猜；
旧版行为会被当成现状，升级后也不自知。所以每次会话注入 RULES.md 时，
第一行就是 `> 当前基线版本：dsh-team-workflow vX.Y.Z（以 package.json 为准）`。

版本在注入时从 `package.json` 读（唯一来源），不写死在 RULES.md 里 ——
否则每次发版两处漂移，正是 CHANGELOG 头部那条规则要防的事。
自检第 1 节加断言：注入文本里的版本号与 package.json 逐字一致，对不上红。

## [1.4.0]

`/workflow` skill：把整套开发流程写成自然语言，模型读了就能照着走。

### 为什么是一个 skill 而不是写进 RULES.md

规则（RULES.md）是**常驻**的——每次调用都注入，每加一段都是所有调用的固定成本
（上一节刚算过：一段 629 token 的规则，乘 2822 次调用就是 180 万）。

而流程是**按需**的：只有开工时才需要，一个任务用一次。skill 正好这个语义——
dsh 按 description 匹配，用到才加载，不用不占 token。所以：

- **RULES.md** 放规则本身（判据、边界、选档）——常驻，短
- **`skills/workflow`** 放顺序和闸门（哪一步、产出、过关判据）——按需加载

两处分工写在 skill 开头：「规范原文以 RULES.md 为准，冲突时以 RULES.md 为准」——
避免上次三层审查抓到的那类「两处各写一份、写矛盾了」。

### 流程的五道闸门

每步有**产出**和**过关判据**，判据没过不进下一步：

1. 判定（改两行的不走全流程）
2. 需求 → REQ 文档（三节：要做什么/不做什么/可执行的验收标准）
3. 写计划前先派调研回来（技术→调研型带来源；项目→侦察型文件:行号）
4. 对照 REQ 实现（子代理用 worktree，绝对路径写进 task）+ 三层审查
5. 验收（§8 逐条填真实输出）→ 提交 → 发版

### 验证

`selftest.mjs` 加第 12 节：钉住 frontmatter（name/description/name 语法——dsh 对
不合格的 skill 是**打一行 warn 然后静默忽略**，目录还在但模型永远看不见）与
五道关口段。反向验证：删文件 → 红；删 description → 红。

`dsh-team skills` 能列出 `/workflow`（skill-filesystem 自动发现 bundle 的
`skills/` 目录，不需要手动注册）。15 个自检全绿。

### 顺手补的：压缩修复生效实测

同时拉了 09-26/27 的 token 用量，验证上一版（1.2.1）的压缩阈值修复真生效：

| | 09-26 修复前 | 09-26 修复后 | 09-27 今天 |
| --- | --- | --- | --- |
| 峰值地板 | 343,453 | 134,152 | **129,703** |
| 压缩触发 | 0 次 | — | **16 次** |

峰值降 **62%**，压缩从「从不触发」变成「每到阈值就折」。

## [1.3.0]

写计划之前，先派子代理把事实调研回来。

### 规则

`team/RULES.md` 新增「### 写计划前：先派调研回来」（在「## 需求与设计文档」里，
紧挨着 §6 方案）：

- **相关技术**（用哪个库、上游怎么解决、版本/API/许可）→ 调研型，结论带来源和日期
- **项目现状**（要动的模块有没有现成的轮子、入口在哪、谁在调用）→ 侦察型，结论 `文件:行号`

两个可并行、各管一半；查回来的填进 §5 已知约束，**从查到的事实出发写计划，
不是从印象出发** —— 印象里「大概能行」的那几条，正是将来要返工的那几条。

为什么不单列一节：派发时机的清单（「### 其余派发时机」）已经存在，规则再放一份
就变成两处维护、容易写矛盾（1.0.0 那轮三层审查抓出的 P1 正是这类自相矛盾）。
所以只在计划的落点写一次，免派情形回指原清单。

`docs/requirements/TEMPLATE.md` 的 §6 同步加一句（模板是计划的实际填写处，
在那里提才提醒得到），`scripts/selftest.mjs` 加断言护住这个纪律段
（沿上游 v1.13.5「派审查必须给边界」同款做法，删了就红）。

## [1.2.1]

把压缩阈值从「永远不触发」修回真能触发，一天省下约三成 cacheRead。

### 症状：两处阈值同时失效，而且不报错

拉 2026-09-25/26 的审计日志（2822 次调用）算了一笔账：

```text
总消耗    273,344,294  (cacheRead 占 98%)
最大地板      343,453
```

而实际生效的压缩阈值是 **460,800** —— 从来没够着过，**压缩一次都没触发**。

### 根因一：`agent-settings.json` 的 compaction 缺 `contextWindow`

`resolveThriftConfig` 回退到硬编码 128000，于是：

```text
baseThreshold = 1 - 12800/128000 = 0.9
tier-std 真实窗口 = 512000  →  阈值 460,800
```

窗口写错不是「差不多就行」：它把阈值推到了实测地板的三倍以上，等于**静默关掉压缩**。
`retainRatio` 也跟着算错（保留量语义从 0.2×128000 变成 0.05×512000）。

### 根因二：团队声明的阈值从来没被读过

`resolveThriftConfig` 只读用户 overlay（`~/.dsh/team-workflow/thrift.json`），
**不读 `settings.compaction`** —— 所以团队在配置文件里写多少都不会生效。

两个坑叠在一起，加上 `context-thrift.json` 里还写着一个第三值，
「显示的」、「声明的」、「实跑的」是三个数。现在统一到一处。

### 定值：用真实数据算，不拍脑袋

按这两天 2822 次调用的真实 floor 序列做模拟（下限 = keepRecentTokens）：

| ratio | 阈值 | 省 | 折叠次数 | 每次折叠换来的省 |
| --- | --- | --- | --- | --- |
| 0.20 | 102K | 48.3% | 19 | 694 万 |
| **0.25** | **128K** | **34.9%** | **9** | **1061 万** |
| 0.30 | 154K | 31.5% | 4 | 2156 万 |
| 0.90（修前） | 460K | **0%** | 0 | — |

取 **0.25**：既有三成多的收益，又不会「刚展开就被折掉」——
保留 128K 足够容纳「读文件 + 改代码 + 跑测试」这种一轮几十 K 的连续操作。
更高的 ratio 每次折叠效率更高，但触发机会太少（0.5 只剩两成收益）。

### 另一个数量级：长 turn

同一次分析里发现，**79% 的消耗来自两个长 turn**（各跑 300+ 步，地板从 24K 爬到 343K）。

反直觉的是**工具输出不是主因**：两天全部工具结果约 226 万 token，而总量 2.73 亿，
相差 **120 倍**（工具结果中位数仅 534 字符）。真正的主项是「地板 × 调用次数」。

已写进 `team/RULES.md` 新增的「## 上下文成本（token）」：成本公式、
「一个 turn 不要跑过 ~80 步」的硬规则、以及阈值配置的两个必写键。

### 测试

`scripts/selftest-preset-gen.mjs` 原来把 bug 锁在了测试里 —— 它硬断言
`thresholdRatio === 0.9`，而那正是「缺 contextWindow 时算出来的错值」，所以一直绿着。
改成断言**团队声明的值真被写进预设**，并加一条「阈值必须 ≤ 400K」的回归
（依据：实测最大地板 343,453）。反向验证：把 `contextWindow` 读取去掉，测试变红。

15 个自检全绿；`dsh-team preset install` 后预设里是 `thresholdRatio: 0.25`。

## [1.2.0]

同步上游 pi-workflow `2133451..d435961`（v1.13.3 → v1.13.5，4 个提交）。一条能力落地：

### 搬了什么

- **「派审查必须给边界」纪律**（`team/RULES.md`「审查（三层）·每层怎么派」）：派任何一层
  审查都必须写明**审查范围**（哪几个文件/哪个 diff）、**禁止项**（不全仓 grep、不探索目录、
  不读范围外文件、不跑命令）、**输出上限**（结论 ≤300 字，按 P0/P1/P2 列），派单模板同步收紧。
  依据上游 42 次 reviewer 实测：无边界任务一路扫到超时（最慢 108 轮、80 次 `grep` + 72 次
  `read`、跑满 30 分钟被砍，97-100% 时间耗在模型生成上），边界写死后轮数从上百掉回个位数。
- 上游原版第四件事 `timeoutMs ≤ 600000` **没有照搬**：dsh 的 `subagent` 工具没有该参数
  （`dsh-subagent/lib` 全包无 timeout 字段），改写为「控轮数靠范围、禁止项与输出上限」。
- `scripts/selftest.mjs` 补一条断言护住新纪律段（沿上游 v1.13.5 的做法）。

### 没搬什么

512k 窗口与 `reserveTokens=65536` 是**上游网关**（`xn--7ov1ng90a.top`）的事实 + pi 的
`shouldCompact` 语义 —— 本地网关不同（`38.76.221.190:3000`）、压缩数值已 dsh 化
（0.9 兜底阈值由 `lib/preset-gen.js` 消费）；存量迁移与 healthCheck 对账是 pi 扩展代码，
dsh 侧模板不落盘到成员机器；「review 只跑一次」与本地三层审查「修完重跑该层（最多 3 轮）」
的有意设计冲突，是否改策略留给团队。逐条原因见 `docs/UPSTREAM-SYNC.md` 处理记录。

## [1.1.1]

修一个从 0.6.0 就存在的线上 400：`bash` 等 8 个工具的 `parameters` 不是合法 JSON Schema。

### 症状

用户会话直接报：

```text
Invalid schema for function 'bash':
{"description":"这条命令做什么，5-10 个词的简短说明（显示给用户看）。",
 "type":"string"} is not of type "string"
```

### 根因

dsh 的 `ctx.tools.register()` 要的是**编译好的 JSON Schema**。「属性表 DSL」
（`required: true` 标在属性上）只对 `defineTool()` 有效 —— 它会调
`parameterSchemaSpecToJsonSchema()` 把 DSL 编译成 `{type:"object", properties, required:[...]}`。

本包不走 `defineTool`（import 不了 `@deepseek-ai/*`），于是 DSL 被**原样透传**：

- `register()` 只校验 `output.schema`，**不碰 `parameters`**
- `schemaOf()`（`dsh-tools/lib/index.js:2934`）把 `parameters` 一字不改发给 provider

所以顶层既没有 `type: "object"` 也没有 `properties` 包装。而参数名恰好叫
`description` 时，它在 JSON Schema 里是**注解关键字**（值必须是字符串），
我们给的是对象 → provider 400。

影响面：`bash` / `bash_open` / `bash_send` / `bash_close` / `worktree_new` /
`worktree_list` / `worktree_merge` / `worktree_drop`，共 8 个工具。
（`docs` / `lens_check` / `lens_tools` 一直用的是完整 JSON Schema 字面量，不受影响 ——
这也说明仓库里两种写法共存了很久，只是 DSL 那种一直没被真机校验过。）

### 为什么以前的自检测不出来

各 `selftest-*.mjs` 里的 `tools.register` 是**假实现**（只把 definition 存进 Map），
从不校验 schema。所以这个 bug 从 0.6.0 活到了 1.1.0，自检一直是绿的。

### 修法

新增 `toParameterSchema()`（`lib/util.js`）：把属性表 DSL 编译成 dsh 要的 JSON Schema
（`required: true` 收集进顶层数组、属性自身不再带 `required`、补 `type:object`
与 `properties`），已是 JSON Schema 形态时**原样返回** —— 两种写法共存，
既有的 `context7`/`lens`/`lens-tools` 不受影响。8 个工具统一过它，一处修全好。

新增 `scripts/selftest-tool-schema.mjs`：**不再用假 register**，而是照 dsh 的
`assertSupportedJsonSchema` 子集真校验每个工具的 `parameters`，并带反例断言
（确保这个自检真能抓到那个 bug）。

### 验证

- 用 dsh **自己的** `assertSupportedJsonSchema` 逐个验：8/8 合法；
  修复前那份参数被它拒（`command is not a supported keyword`）
- 反向验证：把 `toParameterSchema` 退化成「原样返回」→ 新自检 6 条变红
- 15 个自检全绿

## [1.1.0]

需求先成文、开发时对照；写代码的子代理各自在独立 worktree 里干活，写完合回主分支。

### 需求与设计文档（`docs/requirements/`）

以前「要做什么」只存在于对话里。对话一长就被压缩掉，于是出现两种典型失控：需求
在实现中悄悄膨胀（「顺便把这个也加了吧」），以及收尾时没人记得当初的边界在哪。

现在有一套模板（`docs/requirements/TEMPLATE.md`）和一条硬要求：动手前写
`REQ-NNN-<主题>.md`，开发期间对照它，收尾时逐条填 §8 验收记录（**没跑过的不能勾**）。

模板里最要紧的三节是「要做什么 / 不做什么 / 验收标准」：
前者用用户自己的话说，中者划边界，后者**必须可执行** —— 写不出「怎么知道做完了」
就说明需求还没想清楚。规则写进 `team/RULES.md` 的「## 需求与设计文档」。

### 子代理的 worktree 隔离（`lib/worktree.js`，4 个工具）

真正的动机是**并发写代码互相踩是静默损坏**：`git diff` 只看得到结果，看不到谁覆盖了谁。

先说清做不到的事 —— **dsh 没有原生隔离，这是能力缺失，不是配置问题**：

- `SubagentCapabilities` 里只有 `agentOptions/outputSchema/depthLimit/toolFilter/persona`，
  **没有 worktree**（`dsh-subagent/lib/types/types.d.ts:122`）
- 子代理会话 cwd 写死继承父会话：`childSessionMeta()` 的 `cwd: parentHeader.cwd`
  （`dsh-subagent/lib/index.js:505`），而 `SubagentStartRequest` 根本没有 cwd 字段
- 本包也接管不了子会话创建：插件是软链，ESM 走 realpath，`import "@deepseek-ai/*"`
  报 `ERR_MODULE_NOT_FOUND`，注册不了自定义 `SubagentProvider`

所以做成**包外补足的手动闸门**，只用 `ctx.tools` + git CLI：
`worktree_new` / `worktree_list` / `worktree_merge` / `worktree_drop`。

四个安全属性都是真跑出来的，不是设计的：

- **建在仓库内**（`.dsh-worktrees/`）。沙箱把写权限限制在 `sandboxPolicy.workspaceRoot`
  （= `process.cwd()`），放仓库外会被拒写。
- **靠 `.git/info/exclude` 忽略，不碰 `.gitignore`。** 这是硬要求：不忽略的话主仓库
  变脏，而自动更新看到脏树就跳过 —— 一建 worktree 就永久停掉自动更新。用 `info/exclude`
  而不是 `.gitignore` 是因为后者是 tracked 文件，改它就是仓库变更。
- **冲突自动 `merge --abort`。** 实测冲突会让主仓库卡在 `.git/MERGE_HEAD`，
  不 abort 的话下次会话面对一个半合并的仓库。
- **默认不加 `--force`。** 有未提交改动时 git 自己会拒绝删除（退出码 128），
  这正是要的：宁可报错，不静默丢掉还没合并的工作。

另外用 `merge --no-ff` 而不是 `--ff-only` —— 实测主分支只要动过（比如你自己的提交），
`--ff-only` 就报 `Diverging branches can't be fast-forwarded`，它只在主分支没动时成立。
合并前查脏 + 查 `MERGE_HEAD`，脏就拒绝（不 stash、不覆盖用户改动，同 auto-update）。

**两个天花板必须知道**：① 子代理的**会话 cwd 仍是主仓库**（dsh 改不了），所以建完
必须把 worktree 的**绝对路径**写进它的 task；它若用相对路径就会改到主仓库，
**工具层面拦不住**。② worktree 里没有 `node_modules`，要构建/测试得先自己装。

自检 `scripts/selftest-worktree.mjs` 真跑 git（建-隔离-合并-冲突回退-拒删-拒并），
四条安全机制都反向验证过：去掉 `info/exclude` → 4 条断言变红；去掉冲突 abort →
3 条变红；去掉合并前查脏 → 2 条变红；`worktree_drop` 默认加 `--force` → 1 条变红。

### 规范更新

`## 子代理` 那一节改写：「没有隔离」的说法要准确 —— dsh 原生没有，本包用 worktree 补足。
并且补上**不是 git 仓库时的退路**：回到「两个子代理不得碰同一个文件」，
隔离不在时那是唯一的安全保障。

## [1.0.0]

第一个正式版。这一版两件事：新增「三层审查」规范；把接口面冻结下来。

### 三层审查（team/RULES.md）

原来只有一句「实现完成后必须派审查型审查，最多 3 轮」。实测跑下来有个固有盲区：
审的人只能看到作者想让它看到的东西 —— 同一个模型、同一份上下文、同一套假设，
看不出自己的假设错了。所以拆成三层，每层负责**不同类别**的错：

| 层 | 视角 | 档位 | 专抓 |
| --- | --- | --- | --- |
| 1 | 正确性 | `tier-std` | 逻辑错、边界、空值、并发、异常被吞 |
| 2 | 整体性 | `tier-power` | 跨部分接口不一致、根因没修透、漏改的调用方 |
| 3 | 安全 / 破坏性 | `tier-power` | 丢数据、越权、注入、不可逆副作用 |

触发：每完成一部分跑第 1 层（改了共享代码则追加第 2 层）；全部做完三层全跑。
第 3 层**不是「更严的第 2 层」**，它问的是完全不同的问题：「这段代码最坏能把什么弄没？」

普通审查仍是 `tier-power`（见「选档」表），只有三层审查的第 1 层用 `tier-std` ——
靠便宜换来「每个增量都跑得起」。已实测：显式传的 `model` 会盖过 `~/.pi/agent/settings.json`
里 `subagents.agentOverrides` 的档位，所以第 1 层不需要改全局设置。

这份规范**自己也被这份规范审了**：第 1 层（`tier-std`）抓出 2 条 P1 —— 规范自身
自相矛盾（「必须派审查」vs「改一两行的不必派」、「三层全过才允许提交」vs 小改动
只跑第 3 层）；第 2 层（`tier-power`）又抓出 1 条 P1 残留（「只跑第 3 层」这条规则
被引用但它本体没写进「什么时候跑哪几层」）。都已修。

### 稳定性承诺（docs/STABILITY.md）

1.0.0 的意义是**接口冻结**，所以把「什么不会随便改」写清楚：

- **承诺稳定**：模型可见工具名与参数（1.1.0 起共 12 个，见 `docs/STABILITY.md`）、
  3 个命令、配置文件里的键（1.1.0 起 11 个文件）、CLI 子命令、
  落盘路径与格式（字段只增不减）。改工具名/删键/删子命令 = major。
- **明确不保证**：`lib/` 内部模块划分、`vendor/` 任何东西、文档措辞、中间产物、
  日志文案、默认值数值。
- **依赖与平台**：零运行时依赖（加运行时依赖是 major 级决策）；纯 host 包
  （没有 `dsh.client`）；Windows 首要、Linux/macOS 未逐项验证。
- 1.0.0 **不代表功能冻结**（新模块/新工具/新配置键会继续加，按 minor），
  **也不代表经过完整验证**（13 个自检覆盖的是已知场景与已踩过的坑）。

### 本轮从自动更新里又修掉的 4 处

第 1 层（正确性）在复查自动更新时抓出来的：

- `git status` 读不出来时原来**当成干净树** —— 那是危险方向（脏树的保证是「不拉」，
  「读不出」当成干净就会去拉）。改成按脏处理并说明原因，文案与「真有改动」区分开。
- 分叉（ahead 与 behind 同时 > 0）时文案只报「领先」，看不出已分叉。
- `installAutoUpdate` 的 `config` 没有默认值，`config` 为 `undefined` 时会在 try 外同步抛。
- 一处注释声称「后面 decideUpdate 会因 dirty 跳过」，但那一步 `dirty` 可能为 false。

另外把三处「pull --ff-only」的文档措辞改成「fetch + merge --ff-only」
（实现早就改了，文档没跟上 —— 第 2 层抓的）。

## [0.7.0]

新增启动时自动更新：每次启动 dsh 比对 git 远端与本地的版本，不一致就拉。

为什么是 git 而不是 npm：本包**不是** npm 安装的，而是**软链**指向开发目录
（`~/.dsh/profiles/<profile>/node_modules/dsh-team-workflow -> 本仓库`），
而且没发布到 registry（`npm view` 404）。所以「电脑上装的版本」就是**这个工作目录**
`package.json` 的 version，「最新版本」只能从 git 远端取，"更新"实质是 `git pull`。
按 npm 安装去写会永远空转。

三条安全约束（硬编码，不可配置）：

1. **只快进**。先 `fetch` 再 `merge --ff-only`，快进不了就失败 —— 绝不替你决定用哪种
   合并方式。自动更新把开发者的分支搅了是最恶劣的失败。
2. **工作目录有未提交改动就跳过**。不 stash、不覆盖你正在写的代码（你确认过的取舍）。
   本地领先远端时同样跳过。
3. **不阻塞启动**。整个检查 fire-and-forget，带 20s 超时；实测 `installAutoUpdate`
   同步返回 16ms，网络全在后台。失败只影响自己那一行状态，绝不拖垮启动。

生效时机是**下次启动**：实测 dsh 的 HMR 只监听 `cordis.patch.yml` 一个配置文件
（`dsh-app-boot` 的 `watchUserPatches`），不监听插件源码 —— 所以拉下来的 JS 不会
半途热加载，没有「一半新一半旧」的中间态。

实现上踩掉并留了回归测试的坑：

- **不能用 `pull --ff-only`**。多个 dsh 实例同时启动时，并发的 `pull` 会报
  `Cannot fast-forward to multiple branches`（实测 3 并发出退出码 128）。改成
  先单独 `fetch`（只读）再 `merge --ff-only`。
- **并发 `fetch` 本身也会失败**，而且有两种形态：git 的 ref 锁
  （`cannot lock ref`），以及 Windows 上两个进程同时写 object 文件
  （`unable to write file .git/objects/…: Permission denied`，实测必现）。
  按瞬时可重试错误做退避重试（15→480ms，共 6 次）。修前 15 轮 × 8 并发稳定复现失败，
  修后 8/8 次全绿。
- **必须校验仓库根就是包目录**。`rev-parse --is-inside-work-tree` 对「包含本目录的
  **外层**仓库」也返回 true —— 若本包被拷贝（而非软链）进某个 git 项目里，会去
  fetch/merge **外层仓库**，而 `merge --ff-only` 会改写用户自己的项目文件。
  这条是独立审查抓出来的，后果最重。
- **并发合并拿不到 `index.lock` 时不报「失败」**，降级成「另一实例正在更新」—— 
  用户看到红色失败会去查一个并不存在的问题。
- **远端没有配置的分支时提前报**，否则会一路走到 merge 才失败，错误指向 merge，
  看不出真实原因。

配置（`team/extensions/auto-update.json`）：`enabled` / `remote` / `branch`（留空用当前分支）
/ `timeoutMs` / `notifyRestart`。状态在 `/team-baseline` 里有一行。

不引 semver 依赖：本项目版本号规则就是三段数字（见本文件头部），自己比较即可。
版本号比对不作为决策依据（拉不拉完全由 ahead/behind 决定），只当诊断哨兵：
commit 一致但版本号不同时会提示人工看一下。

## [0.6.0]

新增 linux/bash 命令工具：Windows 上也能跑 `sed`/`grep`/`find`/`awk`/`xargs` 这些 linux 命令。

背景：dsh **已经有** `tool-bash`，但出厂预设按平台二选一（`tool-bash` 在 win32 禁用）。
而且**不能只把它打开** —— `ctx.shell` 是单例缝（`dsh-shell` 的注释写明「a host composes
exactly one provider of ctx.shell」，两个一起挂会因服务重名报错），Windows 上这个单例
被 `pwsh-sandbox` 占着。所以打开 `tool-bash` 会得到一个「名叫 bash、实际跑 PowerShell」
的工具 —— 比没有更糟；而换执行器要改 dsh 安装树的预设，升级会被覆盖。

做法：本包自己 spawn bash，只往 `tools` 注册表加工具，不碰 `ctx.shell`。
四件：`bash`（一次性，每次新 shell）/ `bash_open` / `bash_send` / `bash_close`（持久会话，
`cd`、变量、shell 函数跨调用保留）。两个形态都给，因为取舍不同：一次性可预测但反复 `cd`
费 token，持久省 token 但状态会让「这次为何不通」变难查。

`mode: "wsl"` 可改走 `wsl.exe -e bash`（真 Linux 内核而非 MINGW 模拟层），
需机器装过 WSL 发行版；没装会报一条可读错误。

实现上踩过并修掉的坑（都留了回归测试）：

- **持久会话不能用 `bash -i`**。实测 `-i` 在管道下会回显输入 + 吐提示符 + 带 ANSI，
  而回显的脚本文本就含自用的哨兵串，会在错误位置提前匹配。改用 `bash -s`（非交互，
  同样是**一个进程**，所以状态照旧保留）。
- **命令必须 base64 编码后再 eval**，不能单引号拼接。单引号方案在三种输入上全错：
  多行命令被拆成多条（`printf 'a\nb\nc\n' | grep -c .` 返回错结果）、函数定义
  无法跨调用保留、命令自带单引号时转义链易错。
- **`shellQuote` 曾被写坏**：转义结果漏了反斜杠，任何含单引号的字符串都会跑错。
  自检改成**用真 shell 验往返**，不比对字面串（抄转义层数会假绿）。
- **stderr 曾被无界输出**：只对 stdout 调了截断，且收集预算是「先判后推」——
  实测 `head -c 2MB /dev/urandom | base64 >&2` 一次送来 65536 字节，而配置上限 4096，
  超了 16 倍且完全没截。改成「推后判 + 滚动裁剪」，且 stdout/stderr 各给一半预算。
- **超时/中止后不报伪退出码**：那是 `taskkill` 的退出码不是命令的，报出来会误导模型。
- **超时杀树后进程退不出去**：`taskkill` 是 fire-and-forget 且没关 stdio 管道，
  实测超时路径会留下 Socket 引住事件循环 —— 脚本跑完不退（退出码 124），
  在 dsh 里就是「关不干净」。修法：`unref()` taskkill + `destroy()` 两侧管道。
  回归测试**另起子进程**看它会不会自己结束 —— `_getActiveHandles()` 里泄漏的是
  Socket 而不是 ChildProcess，查错对象就查不出来（试过）。
- **`pwd -W` 而不是 `$PWD`**：`$PWD` 在 Git Bash 里是 MSYS 路径（`/c/Users`），
  而 Node 在 Windows 上 `spawn({cwd})` 要原生路径（`C:/Users`）—— 拿 MSYS 路径去
  起新 shell 直接 ENOENT。这会静默堵死超时后的会话重建，而且错误文字指向 bash
  （『找不到 bash』），极难查。

安全边界说清楚：这些命令**不经过 dsh 的 sandbox 管辖**（因为绕开了 `ctx.shell` 单例；
dsh 在 Windows 上的 ACL 后端本身也只声明 `partial` 保证）。要更强隔离就把
`team/extensions/bash-linux.json` 的 `enabled` 设为 `false`，改用 dsh 自带的 `pwsh`。

已知天花板：交互式命令（`vim`、要密码的 `ssh`）会挂到超时；持久会话里 `exit` 会真的
关掉会话（bash 语义）；后台进程持续写 stdout 会污染下一条命令的输出。

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
