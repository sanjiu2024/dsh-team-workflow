# AGENTS.md · 给 agent 的项目约定

> **状态**：维护中 · **日期**：2026-11-02 · **版本**：`2.8.0`
>
> 这份文件只写**这个仓库里必须照做**的事：确切命令、代码约定、禁区。
> 「这是什么、怎么用」在 [`README.md`](README.md)；「现在哪里是虚的」在 [`docs/状态.md`](docs/状态.md)；
> 「哪些接口承诺稳定」在 [`docs/STABILITY.md`](docs/STABILITY.md)。三者不重复。

## 1. 确切命令（都是实测过的）

```bash
npm test                              # 全仓自检：链上 26 条 node 自检，EXIT=0 才算过
node scripts/selftest-squad.mjs        # 单跑一条（小队：状态机 / 工具 / 面板 / 权限 / 落盘）
# 档位行能不能被宿主接受（0.2.1 起 toolFilter 被废弃，schema 测不到，必须真挂载）：
#   ELECTRON_RUN_AS_NODE=1 "<安装目录>\DeepSeek Harness.exe" --expose-internals scripts/smoke-preset-tier.mjs
node bin/dsh-team.mjs --help           # CLI 全量用法
node bin/dsh-team.mjs status           # 装到哪个 profile、版本对不对
node bin/dsh-team.mjs bill --date 2026-10-16   # 某天 token 账单（含小队那半）
node bin/dsh-team.mjs squad ls [--all] # 落盘的小队（实时那份在 Web 面板）
```

- **`npm test` 的前提**：magic-context bundle 已装（`dsh-team mc install` 或随 `install` 一起装）。
  没装时 `selftest-mc` / `selftest-surface` 会以「找不到 bundle」失败 —— 在一棵**裸 worktree** 里
  跑就是 21/23，那是环境不是代码。
- **压缩后端**：`team/agent-settings.json` 的 `compactionBackend` —— **默认 `"fold"`**（本包的确定性
  折叠后端，不调 LLM）；显式写 `"basic"` 才用回宿主自带的 compaction-basic（调 LLM 写摘要）。
  改完 `dsh-team preset install` 重新生成预设（要重启 dsh 才生效）。
  这个键**不属于** `compaction` 块 —— 那块的键会原样写进插件 config，插件对未知键直接抛错。
- **改预设不要手改产物**：团队预设是 `dsh-team preset install` 从 `team/agent-settings.json`
  生成的。要改就先改那份 JSON，再 `preset install`（或 `thrift apply`）。直接改预设文件，
  下次重生成就覆盖。
- **本机装法**：这个包以 symlink 装在 dsh profile 的 `node_modules` 下，改完源码即生效；
  `dsh-team install` / `uninstall` 负责挂/摘。

## 2. 代码约定

- **零运行时依赖、纯 ESM**。加依赖要先想清楚：这个包要装进别人的 profile。
- 注释写**为什么**，不写「做了什么」（怎么做看代码）。踩过的坑、否决过的方案都值得写进去。
- **`isRunning(member)` 是「这个成员在不在跑」的唯一判据**（`lib/squad.js` 导出）。
  不要用 `status` 字符串判在跑 —— 2.0.2→2.0.9 的 P1 有一半来自口径不一致。
- **一轮的四个出口都要认轮次身份**：`lib/squad-round.js` 里 `.then` / `.catch` / `onEvent` /
  `.finally` 都先判 `member.running?.abort !== outer`（`finally` 用等价形态）。
  只护一个出口等于没护 —— 这是 8 个 patch 反复踩出来的。
- **成员身上的瞬时状态只有一个字段**：`roundEnd = { kind: "stopped" | "waiting", reason, at }`；
  **跨轮清理只在 `startMember` 一处**（其余是轮内「消费完就清」）。持久结论是 `note`。
- **加配置键要同时加校验器**（`lib/squad.js` 的 `SQUAD_FIELDS`），并让
  `team/extensions/squad.json` 的出厂值过同一条路（有自检钉着：文件与 schema 不许漂移）。
  坏条目**整体拒**并提示，不要悄悄丢掉半条配置。
- **导出面是契约**：`lib/squad.js` 的 31 个导出被 `lib/index.js` / `lib/squad-cli.js` /
  `scripts/*.mjs` 用着。搬内部实现可以，改导出名不行（判据见 `docs/STABILITY.md`）。

## 3. 开工前：先问，派调研，再审计划

**每开始一件新东西，这三步都不能省。**

1. **先问用户**。带着**具体方案**问，不是开放式「你想怎么做」：
   「我打算 A 方案，代价是 X，确认吗？」—— 他才好否。问完把答复写进 REQ 的「要做什么 /
   不做什么」。需求没问清就动手，后面每一轮返工都在为这个猜测付钱。
2. **同时派调研子代理**（`subagent_std`，带工具）。两条并行、各管一半：
   - **相关技术**（用哪个库、上游怎么解决、版本/API/许可）→ 结论带来源和日期
   - **项目现状**（要动的模块有没有现成轮子、入口在哪、谁在调用）→ 结论 `文件:行号`

   查回来的填进 REQ §5「已知约束」和 §6「方案」。**计划里如果有没查过的假设，
   写下去的每一句都在猜。**
3. **计划写完，再派一个子代理审它** —— `subagent_power`（无工具，材料要你贴）。只问三件事：
   - **有没有更简单的路**：这件事非这么做不可吗？现成的轮子 / 原生能力 / 上游方案有没有漏掉？
   - **这个计划会怎么坏**：哪一步最可能返工？哪个假设其实没验过？
   - **顺序对不对**：有没有「做完 A 之前必须先做 B」的隐含依赖？

   给它的材料：目标（要做什么 / 不做什么）、方案全文、已知约束。**不给「我们讨论过什么」**
   —— 那样它会顺着我们的思路走。要求它回答成「A 还是 B，为什么」，不要泛泛的「可以考虑更充分」。

   它的结论是**判断不是验证**：每条你自己用工具核一遍再动。有分歧就改计划；没分歧就在
   REQ §6 末尾记一句「计划已审，无异议」。

例外（说清楚为什么不用走这三步，再动手）：改一两行的、纯问答、事实已经清楚的。

## 4. 测试与审查

- **每条断言都要有能咬住它的变异**：改坏 → 跑 → **必须变红** → 逐字节还原。
  没变红只有两种可能：**代码多余**，或**断言位置错**（例如把断言放在「一轮跑完之后」，
  那时字段已被收尾清掉，看什么都对 —— 空断言）。逐个查，别默认是前者。
  **顺序要紧：变异要在改动已提交之后做** —— `git checkout -- <file>` 还原的是 **HEAD**，
  工作区里未提交的改动会被一起冲掉（2026-10-19 实测：`lib/squad.js` 五处改动被冲掉，而提交
  照发，master 上 selftest 引用了不存在的符号、整套崩）。还原后 **sha 不一致要当场停下**，
  不能继续提交。
- **假替身要照真实类型定义来**，别按自己的想象造：第十轮独立测逮到的 P0 就是——假 engine 伪造了
  宿主没有的 `text` 字段，于是套件把**错字段钉死**，改成正确的 `snippet` 反而变红。写假替身时
  先去看宿主的 `.d.ts`。
- **假替身保证不了「缝」对**：照 `.d.ts` 造替身只保证**字段**对，保证不了**这条路在真实宿主里存在**。
  REQ-018 ② 的第一版把过滤挂在 `agent/pre-step` 上，假 ctx 演得全绿 —— 而模型侧消息数组是
  `deriveMessages()` 现场从 surface 导出的，中间没有钩子，那段代码在真实宿主里**是空操作**。
  判据：**改的是宿主真的会读的那份数据吗？** 拿不准就去读宿主的调用链（或真实宿主里跑一次）。
- **假替身的「输入数据」也要照真实造，参数语义也要真按**：同一个坑的第三种形态 —— REQ-018 ② 的 P0
  是「检索语料就是本会话日志，而 checkpoint 自己也在里面」，可假 engine 的语料是外部字符串、
  还忽略 `filters`，于是这个**真实宿主里的空操作**在套件里全绿。假替身别只照类型，还要照
  **它会看到什么数据、参数怎么起作用**。
- **假 ctx 要照 cordis 的访问器语义造**：`ctx` 是代理，**没 `inject` 的服务读一下就抛**
  （`cannot get property "x" without inject`），不是返回 undefined。REQ-018 ① 的 P0 就是：假 ctx 把
  `loader` 当普通属性给了，于是「插件在真实宿主里加载即抛」套件全绿。**服务要么按 inject 清单给，
  要么就抛**；拿不准的用真 cordis 起一个上下文跑（`scripts/smoke-fold-host.mjs` 是现成范例）。
- **验证器本身也会骗人**：变异脚本的匹配串写错（比如 `grep -qF "x"` 几乎必然命中）会让
  「全部咬住」变成假象。改完验证器先用一个已知会红的例子试它。
- **变异锚点必须唯一，且要跳过注释行**：`s.replace(old, new, 1)` 会命中**文件头注释里引用的
  同一行代码**，于是代码根本没动、你以为「这条没咬住」——而那是假的（REQ-018 ② 撞过一次）。
  规矩：按**行**取锚点、丢掉以 `*` / `//` 开头的行、断言**恰好命中一行**且整行唯一，
  改完再断言文件真的变了。
- **修了但没断言**的地方要**如实记**进 `docs/状态.md` §4，不要当成已验收。
- 每完成一块派 `subagent_std` 测（带工具、跑测试、跑反向实验）；重大变化再派
  `subagent_power` 判（无工具，材料要你贴）。**该跑的审全过再提交。**
- 子代理**没有工作区隔离**：要写代码/做变异的一律先 `worktree_new`，把**绝对路径**写进它的
  task，并明确要求它对文件用绝对路径（它的 cwd 仍是主仓库）。
- **`worktree_new` 建的是干净 checkout**：它**不含**你工作区里未提交的改动。要审未提交的改动，
  要么先提交，要么在 task 里明确要求「从主仓库只读拷贝这几个文件进来」（独立测第九轮就撞上了这点）。

### 收尾辩论赛：无记忆找 bug，有记忆修

**每件东西做完、提交之前，来一场辩论赛。** 两个子代理，一个不带记忆、一个带：

1. **无记忆的找 bug** —— 用 `subagent`（干净上下文）。**不给项目上下文**：不贴这段对话、
   不解释「为什么这么设计」、不提我们已经知道什么。只给它三样：这东西是什么、代码在哪（绝对路径）、
   怎么跑起来。它没有我们的假设，才看得见我们看不见的洞。
   要求它按严重度列：`文件:行号 · 问题 · 为什么这是问题（什么情况下会炸）`。
2. **有记忆的修** —— 用 `subagent_fork`（继承本会话）。把第 1 步的清单**原样**贴给它，
   让它逐条核实再动手：真 bug → 修 + 加断言（改坏的必须变红）；判断错的 → 说明理由，
   记进审查记录的「略过未修」。

**为什么是这两个人**：同一个模型、同一份上下文，看不出自己的假设错了；而完全不懂项目的人
又修不动。所以分工 —— 新鲜的眼睛找，熟悉的手修。**顺序不能反**：先让没记忆的说完，
有记忆的再上场；反过来会先被我们的解释说服，等于没问。

**和「审查（两层）」的分工**：`subagent_std` / `subagent_power` 审的是**代码质量与接口一致性**；
辩论赛审的是**「一个不知道我们在干什么的人，会不会一眼看出这里不对」**。两者都跑，不是二选一。

## 5. 发版流程

1. 改 `package.json` 的 `version` + 在 `CHANGELOG.md` 加一节 `## [<version>]` —— **同一次提交**。
   自检会核对这两处（`scripts/selftest.mjs` 最后一节），对不上直接红。
2. 递增规则：**只修 bug → patch**；**加能力或改默认行为 → minor**；**配置格式不兼容 → major**。
   纯文档 / 纯测试 / 纯重构**不动版本号**。
3. 提交后**打标签** `git tag -a vX.Y.Z -m "…"` —— 版本已提交却没有同名标签，自检会红。
   推送时带上标签（`git push origin master vX.Y.Z`）。
4. 一次提交只做一件事；顺手改的另开一个提交。标题 ≤50 字符，正文写**为什么**。

## 6. 禁区

- **密钥 / token / 连接串一律不进仓库**，用环境变量；`.env` 永不进 git。
- **不要按进程名杀 node**：dsh 自己就是 `node`，`taskkill /IM node.exe /F` 会把宿主一起杀掉
  （无报错、无崩溃记录）。清理残留要按命令行特征过滤。
- **不要 `git add -A`**：用显式路径。`team/extensions/scheduler.json` 里的 `enabled` 是
  **本机开关，故意不提交**（别人拉下来是关的，别当成 bug）。
- **不手改 vendor 产物**：`vendor/pi-magic-context/` 与 `lib/mc.js` 是上游 bundle 的拷贝，
  升级靠重新同步，不在这里打补丁。
- 破坏性操作（删文件、改 schema、`--force`、强制推送）先确认再动手。

## 7. 本机环境事实

- dsh `0.2.1-rc.5`（2026-10-31 从 rc.2 升级）；本包以 symlink 装在 `~/.dsh/profiles/desktop/node_modules/` 下。
  `web` 那个 profile 目录已经不存在了，别照旧笔记去找。档位模型走 `opencode-go`。
- **本机有 bash，只是曾经不在 PATH 上**（2026-10-19 查实并修）：Git for Windows 自带
  `C:\Program Files\Git\bin\bash.exe`（`usr\bin\bash.exe` 也在，跑起来是 `MINGW64_NT-10.0-22631`），
  但 Machine 与 User 的 PATH 都只有 `C:\Program Files\Git\cmd`（那是给 `git.exe` 的），**没有 `Git\bin`**。
  所以任何走 PATH 找 bash 的工具都报「PATH 里找不到 bash；Windows 上装 Git for Windows 即有」——
  那是**配置问题不是缺软件**。已把 `C:\Program Files\Git\bin` 追加进 **User** PATH；
  **已运行的 dsh 进程环境不会更新，必须重启 dsh 才生效**（子进程继承宿主的 env）。
- **standard 预设底稿要从 `resources/app.asar` 里读**（0.2.1 起）：PATH 上第一个 `dsh` 是启动器目录
  （`%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd`），祖先里没有那些包，`app.asar.unpacked` 也没解
  `dsh-web-app`。查找在 `lib/dsh-install.js`（自己解析 asar 头部，零依赖），候选顺序「真实安装」优先 ——
  本机 `.dshbin` 那个历史 junction 指向 **0.2.0-rc.2** 的旧底稿，先命中它会静默生成缺三条新行的预设。
  自检 `selftest-preset-gen.mjs` 的 2c 节跑真底稿；装了 dsh 却读不到 = 红。
- **0.2.1 起 CLI 不能碰 Electron 独占管理的 profile**：`dsh plugin --profile desktop install` 会被拒
  （`profile "desktop" is managed exclusively by the Electron application`）。所以 `preset install`
  在 profile 已经接好（dependencies + bundles + node_modules 都在）时直接跳过那一步 —— 那一步失败
  只说明它本来就不该跑，**不影响预设已生效**。
- **`web_search` / `web_fetch` 在本机挂**（`HTTP_PROXY=127.0.0.1:7897` 拒连）→
  直连绕过：`env -u HTTP_PROXY -u HTTPS_PROXY curl -sL '<url>'`。
- **本机 `dsh-team preset install` 会在最后一步失败**（`dsh plugin --profile tauri install` →
  `cannot resolve profile bundle "dsh-tauri"`）：那是 **tauri** profile 自己的依赖缺，跟本包无关。
  预设文件在这之前**已经写好**（web profile 用 `link:` 指着它），所以那一步失败不影响生效 ——
  别把它当成「预设没更新」。
- **0.2.1 起 `dsh-tool-subagent` 废弃了 `toolFilter` 与 `persona`**（`lib/index.js:355` 挂载期直接抛）：
  写它们会让整份预设判非法、**新建会话失败**（`agent-preset/invalid: …`）。替代是「另开一份没有工具行的
  预设 + 档位行 `agentPreset` 指过去」，生成逻辑在 `lib/preset-gen.js`，钉它的测试是
  `scripts/smoke-preset-tier.mjs`（真 cordis + 真宿主插件，带反向对照）。**`Config` schema 不拦这两个键**，
  拿 schema 验等于没验。
- `roles.审查` 默认是降级链 `["tier-power","tier-std"]` —— 本机 `tier-power` 报 503，
  会自动退到 `tier-std`（换档写进成员结论栏）。
- **`fs-observation-policy` 挂在 `dsh-base`（宿主基础层），不在 Agent 预设里**（2026-10-31 查实）。
  它的作用是「改文件前必须先读过、读过之后文件不能再变」——症状就是 transcript 里
  「读取 → 编辑 → 读取 → 编辑」：每次 edit 之后想再 edit 同一文件，模型得先 read 一遍拿新观测态。
  **只在 `preset-gen` 里摘预设那行等于没摘**（我 10-30 干过，行为一点没变）。
  正解是在 **profile 层**禁用，不改宿主源码：

  ```yaml
  # ~/.dsh/profiles/<名字>/cordis.patch.yml 末尾
  - id: fs-observation-policy
    disabled: true
  ```

  改完要重启 dsh。判据：同一会话里连续两次 `edit` 中间不 `read`，第二次不该报
  `file has not been read` / `FS_NOT_OBSERVED`。
- **原生工具不能同名覆盖**：`dsh-tools` 的 `NamedEntries` 在重名时**直接抛**
  `tool "<name>" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)`。
  要在不改源码的前提下改工具行为，只有三条路：
  ① 该工具所在插件行的 `config`（`dsh-tool-fs` 就有 `read`/`readImage`/`write`/`edit`/
  `readLimit`/`readMaxLineLength`/`readMaxBytes`/`readStreamMinSize`）；
  ② 把某个策略插件行 `disabled: true`（上面 `fs-observation-policy` 就是这条）；
  ③ 关掉原生工具，用**另一个名字**注册自己的（模型看到的是新名字）。
  想「包住执行」而不换名字，用钩子：`tools/pre-execute` / `tools/execute` / `tools/result` /
  `tools/post-execute`（本包的 `rtk` 与 `lens` 已经在用 `tools/post-execute`）。
  注意 `tools/pre-execute` 拿到的是**深冻结**的参数，只能读不能改（`lib/rtk.js` 注释里有记录）。
