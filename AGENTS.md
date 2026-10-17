# AGENTS.md · 给 agent 的项目约定

> **状态**：维护中 · **日期**：2026-10-16 · **版本**：`2.3.0`
>
> 这份文件只写**这个仓库里必须照做**的事：确切命令、代码约定、禁区。
> 「这是什么、怎么用」在 [`README.md`](README.md)；「现在哪里是虚的」在 [`docs/状态.md`](docs/状态.md)；
> 「哪些接口承诺稳定」在 [`docs/STABILITY.md`](docs/STABILITY.md)。三者不重复。

## 1. 确切命令（都是实测过的）

```bash
npm test                              # 全仓自检：链上 23 条 node 自检，EXIT=0 才算过
node scripts/selftest-squad.mjs        # 单跑一条（小队：状态机 / 工具 / 面板 / 权限 / 落盘）
node bin/dsh-team.mjs --help           # CLI 全量用法
node bin/dsh-team.mjs status           # 装到哪个 profile、版本对不对
node bin/dsh-team.mjs bill --date 2026-10-16   # 某天 token 账单（含小队那半）
node bin/dsh-team.mjs squad ls [--all] # 落盘的小队（实时那份在 Web 面板）
```

- **`npm test` 的前提**：magic-context bundle 已装（`dsh-team mc install` 或随 `install` 一起装）。
  没装时 `selftest-mc` / `selftest-surface` 会以「找不到 bundle」失败 —— 在一棵**裸 worktree** 里
  跑就是 21/23，那是环境不是代码。
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

## 3. 测试与审查

- **每条断言都要有能咬住它的变异**：改坏 → 跑 → **必须变红** → 逐字节还原。
  没变红只有两种可能：**代码多余**，或**断言位置错**（例如把断言放在「一轮跑完之后」，
  那时字段已被收尾清掉，看什么都对 —— 空断言）。逐个查，别默认是前者。
- **假替身要照真实类型定义来**，别按自己的想象造：第十轮独立测逮到的 P0 就是——假 engine 伪造了
  宿主没有的 `text` 字段，于是套件把**错字段钉死**，改成正确的 `snippet` 反而变红。写假替身时
  先去看宿主的 `.d.ts`。
- **假替身保证不了「缝」对**：照 `.d.ts` 造替身只保证**字段**对，保证不了**这条路在真实宿主里存在**。
  REQ-018 ② 的第一版把过滤挂在 `agent/pre-step` 上，假 ctx 演得全绿 —— 而模型侧消息数组是
  `deriveMessages()` 现场从 surface 导出的，中间没有钩子，那段代码在真实宿主里**是空操作**。
  判据：**改的是宿主真的会读的那份数据吗？** 拿不准就去读宿主的调用链（或真实宿主里跑一次）。
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

## 4. 发版流程

1. 改 `package.json` 的 `version` + 在 `CHANGELOG.md` 加一节 `## [<version>]` —— **同一次提交**。
   自检会核对这两处（`scripts/selftest.mjs` 最后一节），对不上直接红。
2. 递增规则：**只修 bug → patch**；**加能力或改默认行为 → minor**；**配置格式不兼容 → major**。
   纯文档 / 纯测试 / 纯重构**不动版本号**。
3. 提交后**打标签** `git tag -a vX.Y.Z -m "…"` —— 版本已提交却没有同名标签，自检会红。
   推送时带上标签（`git push origin master vX.Y.Z`）。
4. 一次提交只做一件事；顺手改的另开一个提交。标题 ≤50 字符，正文写**为什么**。

## 5. 禁区

- **密钥 / token / 连接串一律不进仓库**，用环境变量；`.env` 永不进 git。
- **不要按进程名杀 node**：dsh 自己就是 `node`，`taskkill /IM node.exe /F` 会把宿主一起杀掉
  （无报错、无崩溃记录）。清理残留要按命令行特征过滤。
- **不要 `git add -A`**：用显式路径。`team/extensions/scheduler.json` 里的 `enabled` 是
  **本机开关，故意不提交**（别人拉下来是关的，别当成 bug）。
- **不手改 vendor 产物**：`vendor/pi-magic-context/` 与 `lib/mc.js` 是上游 bundle 的拷贝，
  升级靠重新同步，不在这里打补丁。
- 破坏性操作（删文件、改 schema、`--force`、强制推送）先确认再动手。

## 6. 本机环境事实

- dsh `0.2.0-rc.2`；本包以 symlink 装在 `~/.dsh/profiles/web/node_modules/` 下。
- **`web_search` / `web_fetch` 在本机挂**（`HTTP_PROXY=127.0.0.1:7897` 拒连）→
  直连绕过：`env -u HTTP_PROXY -u HTTPS_PROXY curl -sL '<url>'`。
- `roles.审查` 默认是降级链 `["tier-power","tier-std"]` —— 本机 `tier-power` 报 503，
  会自动退到 `tier-std`（换档写进成员结论栏）。
