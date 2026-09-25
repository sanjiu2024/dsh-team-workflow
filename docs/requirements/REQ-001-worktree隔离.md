# REQ-001 · 写代码的子代理用独立 worktree，写完合回主分支

- **状态**：已完成（2026-09-25）
- **对应版本**：`1.0.0 → 1.1.0`（minor：加能力，改默认行为 —— 新增工具与配置键）
- **提出**：2026-09-25，操作者原话：

  > 给用户需求理清楚要做什么后，写相对应的文档，开发的时候对照相对应的文档进行开发，
  > 并且每个写代码的子agent都是独立的worktrees，写完过后合并到主分支里面

  本文件处理其中第 2、3 条（需求文档 + worktree 隔离）。第 1 条（需求文档流程）
  落在 `team/RULES.md` 与 `docs/requirements/TEMPLATE.md`。

---

## 1. 要做什么

三条，按操作者原话拆开：

1. **需求先成文**：把「要做什么」理清 → 写成文档 → **开发时对照这份文档**。
2. **写代码的子代理各自在独立 worktree 里干活**，互不干扰。
3. **写完把 worktree 的成果合回主分支。**

真正要解决的问题是**并发写代码的互相踩踏**。现状（`team/RULES.md` 现在的写法）是
「两个子代理不得碰同一个文件 + 逐个 `git diff` 审核」，靠人肉协调。worktree 的价值是
让「碰同一个文件」从**禁忌**变成**安全**——各改各的副本，合并时才碰面。

## 2. 为什么（不做的后果）

- 现在派多个写代码的子代理，唯一的安全保障是「你派之前记得不重叠」。漏一次就是两个
  代理交叉污染同一个文件，而**你未必看得出来**——`git diff` 只能让你看到结果，看不到
  「谁覆盖了谁」。这是静默损坏。
- 单子代理也受益：它改坏了可以整份丢弃（删 worktree），不必在主仓库里 revert 一堆
  混合改动（其中可能混着你自己未提交的工作）。

## 3. 不做什么

- **不做 dsh 原生隔离。** dsh 的 `SubagentStartRequest` 没有 cwd 字段、
  `dsh-tool-subagent` 参数表里没有 `cwd`。改不了就是改不了，不假装改得了。
  （硬证据见 §5。）
- **不自动派子代理。** 本工具只提供「建/合/丢 worktree」的**手动闸门**。谁派谁不派、
  几个并行，仍由主 agent 按 `RULES.md` 判断。
- **不动用户主仓库的 `git status`。** worktree 目录靠 `.git/info/exclude` 忽略
  （局部忽略，**不写进 `.gitignore`**，不产生任何仓库变更）。这是硬要求：
  自动更新（`lib/auto-update.js`）看到脏树就跳过，如果 worktree 目录算脏，
  一建 worktree 就永久停掉自动更新。
- **不删用户的分支、不做 force 操作。** 清理 worktree 时若里面有未提交改动，
  git 自己会拒绝（实测退出码 128）；本实现**默认不加 `--force`**，如实把拒绝报出来。
- **不自动提交、不自动推送。** 合并是本地 `merge`，推送永远由人决定（对齐现有
  「子代理不得 commit/push」）。
- **不处理跨 worktree 的依赖安装。** `node_modules/` 不在各 worktree 里（`vendor/`、
  `node_modules/` 已被 `.gitignore` 且 worktree 只检出 tracked 文件）。需要依赖的
  任务得自己在 worktree 里 `npm install`。写进 §7 天花板。

## 4. 验收标准

- [ ] `npm test` 全绿（1.1.0 起共 14 个自检），新增 `scripts/selftest-worktree.mjs` 进 `npm test`
- [ ] 自检**真跑 git**：建真仓库 → 建 worktree → 里面提交 → 合回主分支 → 校验主分支
      内容真的变了
- [ ] 冲突路径真跑：两边改同一文件 → 合并报告冲突 → **主仓库自动 `merge --abort`
      回退到干净状态**（不留在 MERGING 卡死态）
- [ ] 未提交改动路径真跑：worktree 里有未提交文件 → 删除被拒 → **报错不是「已删除」**
- [ ] 反向验证：把「合并前的脏树检查」注释掉 → 对应断言必须变红
- [ ] 反向验证：把「`.git/info/exclude` 忽略」去掉 → 「主仓库保持干净」断言必须变红
- [ ] `package.json` version = `CHANGELOG.md` 首个标题 = `1.1.0`
- [ ] `team/RULES.md` 两处更新：新增「需求文档 → 对照开发」节；子代理节从
      「没有隔离」改成准确描述（dsh 原生没有，本包用 worktree 达到，且**子代理的
      会话 cwd 仍是主仓库**，所以必须给它 worktree 的**绝对路径**）

## 5. 已知约束（侦察出来的硬事实）

| 约束 | 证据 | 影响 |
| --- | --- | --- |
| 子代理会话 cwd 无法指定 | `dsh-subagent/lib/index.js:505` `childSessionMeta()` 写死 `cwd: parentHeader.cwd`；`SubagentStartRequest`（`dsh-subagent/lib/types/types.d.ts:136`）无 cwd 字段 | **无法**让子代理的 cwd 落在 worktree。只能把 worktree 绝对路径写进 task 提示 |
| `SubagentCapabilities` 无 worktree | `dsh-subagent/lib/types/types.d.ts:122-128`：只有 `agentOptions/outputSchema/depthLimit/toolFilter/persona` | dsh 原生不提供隔离，本工具是包外补足 |
| 本包 import 不了 `@deepseek-ai/*` | 实测：插件是软链 `~/.dsh/.../node_modules/dsh-team-workflow -> Desktop/deepseek harness cj`；ESM `import "@deepseek-ai/dsh-subagent"` → `ERR_MODULE_NOT_FOUND`（ESM 走 realpath）；`createRequire(import.meta.url)` 同样失败 | **不能**注册自定义 `SubagentProvider`（那要 `startInProcessRun` 等内部符号）。只能用 `ctx.tools.register` + `execFile` 调 git CLI |
| 沙箱把写权限限制在 workspaceRoot | `dsh-sandbox-policy/lib/index.js:103` `workspaceRoot`；`dsh-base/cordis.patch.yml:211-212` `mode: workspace-write`、`workspaceRoot: process.cwd()`；`dsh-tool-fs/lib/index.js:649` 文件工具按 `sandboxPolicy.workspaceRoot` 解析 | worktree **必须放在仓库内部**（`.dsh-worktrees/`），放仓库外（如 `~/.pi/agent/worktrees`）会被沙箱拒绝写入 |
| 嵌套 worktree 会被主仓库当未跟踪目录 | 实测：`git worktree add .dsh-worktrees/x` 后主仓库 `?? .dsh-worktrees/` | 必须忽略，否则自动更新的脏树检查一建 worktree 就停摆 |
| 主分支一动，`merge --ff-only` 就失败 | 实测：worktree 提交后主分支也提交 → `merge --ff-only` 报 `Diverging branches can't be fast-forwarded`，退出码 1 | 用 `merge --no-ff`；`--ff-only` 只在主分支没动时成立，不能当默认 |
| 合并冲突会**卡住主仓库** | 实测：冲突后 `.git/MERGE_HEAD` 存在，`p.json` 带 `<<<<<<<`；主仓库有未提交改动时冲突**不会**丢那些改动 | 冲突必须自动 `merge --abort`（实测能干净回退），否则下次会话面对一个半合并的仓库 |
| worktree 有未提交改动时 git 拒绝删除 | 实测：`git worktree remove` → `fatal: contains modified or untracked files, use --force to delete it`，退出码 128 | 默认不加 `--force`，把拒绝如实报给模型 |
| `.git/info/exclude` 单独就够 | 实测：无 `.gitignore` 时写 `info/exclude` → 主仓库 `git status` 干净、`.gitignore` 未被创建 | 用它，**不碰 `.gitignore`**（那是 tracked 文件，改了就是仓库变更） |

## 6. 方案

新增 `lib/worktree.js` + `team/extensions/worktree.json`，注册 4 个工具：

| 工具 | 作用 |
| --- | --- |
| `worktree_new` | 建 worktree（`git worktree add <repo>/.dsh-worktrees/<slug> -b <branch>`）+ 确保 `.git/info/exclude` 忽略了该目录 |
| `worktree_list` | 列出（`git worktree list --porcelain`），含每个的脏/净状态 |
| `worktree_merge` | 合回主分支（`merge --no-ff`；冲突 → 自动 `abort` 并报冲突文件） |
| `worktree_drop` | 删 worktree + 删分支（默认**不加** `--force`，有未提交改动就报错） |

设计要点：

- **纯函数单列**（`slugOf`/`parseTopLevel`/`parseWorktreeList`/`isDirty`/`classifyMerge`/
  `admitMerge`/`conflictDetail`/`guarded`/`worktreePathFor`/`branchFor`/`renderList`/
  `msysToNative`），逻辑分支都能单测，不依赖真 git。
- **分支命名**加前缀（`dsh-wt/<slug>`）避免撞用户既有分支；建之前先用
  `git rev-parse --verify` 查重。
- **所有 git 调用走 `execFile` 数组传参**（不过 shell）；**并用 `-c core.hooksPath=`
  抑制用户仓库的 hook** —— 同 `lib/auto-update.js` 的理由（自动跑用户的
  `post-checkout` 等属越权）。
- **`slug` 必须消毒**（复用 `handoff.js` 的教训）：只允许 `[a-z0-9-]`，防目录穿越。
- **合并前先查主仓库是否脏**：脏就拒（不 stash、不覆盖用户改动），理由同 auto-update。
- **不 `git push`、不 `git commit`**（`merge --no-ff` 会自己产生合并提交；若不想产生，
  用户可自行 `--squash`，本次不做）。

## 7. 天花板（做完之后仍不支持的）

- **子代理的会话 cwd 仍是主仓库。** 它必须用 worktree 的**绝对路径**（`read`/`edit`/
  `bash workdir`）。如果它「顺手」用相对路径，会改到主仓库——这一条只能靠
  `RULES.md` 的提示和主 agent 的 `git diff` 审核兜住，**工具层面拦不住**。
- **worktree 里没有 `node_modules`。** 需要构建/测试的任务得先自己装。
- **不做 `git push`、不做变基、不做 squash 合并。**
- **一个 worktree 一个分支**，不支持多 worktree 共用分支（git 本身也禁止）。
- **不处理子模块。** 含 submodule 的仓库建 worktree 可能失败，如实报 git 的错。
- 沙箱模式若被用户设为 `read-only`，建 worktree 会被拒——这是用户的策略，不绕过。

## 8. 验收记录

全部实跑。命令都是本仓库根目录下执行的。

- [x] `npm test` 全绿，共 **14 个自检**（含新增的 `selftest-worktree.mjs`）
      → `npm test` → 退出码 `0`
- [x] 自检真跑 git（建真仓库 → 建 worktree → 里面提交 → 合回）
      → 自检 §2 的 ①②③④ 真的建/提交/合并，并断言主分支**真拿到了文件**
- [x] 冲突路径真跑 + 主仓库自动 `merge --abort`
      → 自检 §2 **⑤**（危险路径）：两边改同一行 → 报 `CONFLICT` → 断言
      `.git/MERGE_HEAD` 不存在、`git status` 干净、`app.js` 无 `<<<<<<<`、内容仍是主分支的
- [x] 未提交改动路径真跑：删除被拒，报错不是「已删除」
      → 自检 §2 **⑥**：`worktree_drop` 返回 `ok:false, reason:"dirty"`，目录与文件**都还在**
- [x] 反向验证：去掉合并前的脏树检查 → 对应断言变红
      → 把 `if (!admitted.ok)` 改成 `if (false)` → 「真跑 **⑦** 主仓库脏时拒绝合并」变红
- [x] 反向验证：去掉 `.git/info/exclude` 忽略 → 「主仓库保持干净」变红
      → 让 `ensureExcluded` 直接返回 → 「真跑 **①②⑧⑫**」共 **4 条**变红

补充的反向验证（审查提出的问题，修完后加的回归）：

- [x] 去掉 `dirtyUnknown`（git status 失败当成干净）→ 「真跑 ⑬」变红
- [x] 去掉 `worktree_list` 的 `error` 字段 → 「真跑 ⑭」变红
- [x] `slugOf` 改回「先修尾再截断」的错误顺序 → 「真跑 ⑮」变红
- [x] 去掉 `base` 的 `-` 开头校验与存在性检查 → 「真跑 ⑯」变红
- [x] 去掉 `force` 的「不可逆」文案 → 「真跑 ⑰」变红
- [x] 去掉冲突 `abort` → **3 条**变红；`worktree_drop` 默认加 `--force` → 「真跑 ⑥」1 条变红
- [x] 去掉 `abort` 失败时的诚实文案（又谎称「已回退」）→ 「conflictDetail」变红
- [x] `package.json` version = `CHANGELOG.md` 首个标题 = `1.1.0`
      → `node -p "require('./package.json').version"` → `1.1.0`；
      `grep -m1 "^## \[" CHANGELOG.md` → `## [1.1.0]`；`scripts/selftest.mjs` 版本一致性一节绿
- [x] `team/RULES.md` 两处更新
      → 新增「## 需求与设计文档」节；「### 子代理可以写代码」改为 dsh 原生无隔离 +
      本包 worktree 补足 + 子代理会话 cwd 仍是主仓库的坑 + 非 git 仓库的退路

### 三个我没做到、但已记入文档的

1. **子代理会话 cwd 仍是主仓库**（dsh 改不了）——只能靠 task 提示 + 主 agent 审核。
   已写进 §7、`RULES.md`、`worktree.json` 的说明。
2. **worktree 里没有 `node_modules`** —— 要构建/测试得先自己装。
3. **反向验证的教训**：第 1 轮有一个反向验证**没变红**，但我当时是把它当成功的。
   原因是只测了纯函数、没测**调用点**（`dirtyUnknown` 只在 `worktreeMerge` 里生效）。
   改法：用损坏的 `.git/index` 真让 `git status` 失败（退出码 128），把调用点也测上。
   ——「反向验证没变红」本身就是一个发现，不能当通过。
