# REQ-028 · 把 dsh-purge 完整移植进 dsh-team-workflow

- **状态**：进行中
- **对应版本**：`2.11.0 → 2.12.0`（加能力 → minor）
- **提出**：2026-10-31，用户原话「帮我把 dsh-purge 功能完整移植到这个工作流里面」

---

## 1. 要做什么

把现在以**独立第三方插件**形式装着的 `dsh-purge`（`1.1.72-dsh021rc2.4`，MIT，社区适配版）整体搬进本仓库，
让它成为 `dsh-team-workflow` 的一部分：装本包即得到破甲清洗 + 红队演练台，不再依赖 GitHub release
上的 tgz，也不再需要 profile 里单独列一条依赖。

「完整」指下面这些功能面一个不少：

| 面 | 内容 |
| --- | --- |
| 清洗引擎 | `lib/core.js` 的 86 条宿主补丁（提示词层 / 代码默认值 / 引擎级审批与沙箱 / shim 注入 / override 文件），apply / revert / 状态 |
| 身份与注入 | `lib/identity.js`：系统提示改写、`~/.dsh/prompt-inject.md` 注入、persona 后缀降级、能力协议段、子代理角色捕获 |
| 宿主控制 | 桌面 / Web 两种 surface 的 asar 解包、重启、卸载、更新、重应用（`desktop.js` / `extract-asar.js` / `restart-*` / `reapply.js` / `update.js` / `official-update.js` / `uninstall*`） |
| 工具 | `purge_status` / `purge_apply` / `purge_revert` 三个模型可见工具 |
| 命令 | `/purge`、`/purge-apply`、`/purge-revert`、`/continue` 等 5 条命令 |
| Web 路由 | `lib/index.js` 里 20+ 条 `/purge/...` HTTP 路由（状态页、注入编辑、恢复上一轮等） |
| 红队演练台 | `lib/redteam/**`：事实库（`node:sqlite`）、60 个 `redteam_*` 工具、HTTP 桥、预设与技能落地、评分规则、报告 |
| 资源 | `presets/redteam/**`、`skills/redteam/**`、`scripts/redteam-setup.sh` |
| 客户端 | `client.js`（8.7k 行 ModuleLoader 模块）：Purge 状态页 / 红队演练台面板 / 欢迎页 / 恢复上一轮 UI |
| CLI | `dsh-purge --status/--apply/--revert/--uninstall/--edit`，并入 `dsh-team purge` |

## 2. 为什么（不做的后果）

- 现在这条依赖是 **GitHub release 的 tgz**，上游已停更，社区 fork 的 release 也可能消失；
  一旦链接失效，profile 重装就装不回来，而本机**已经**在跑它的 86 条补丁 —— 恢复不了等于环境废掉一半。
- 本机为它打过**本地补丁**（`lib/index.js` 的 `PURGE_SECTIONS_ON` 幂等修复，见 `scripts/check-purge-inject.mjs`），
  这类改动不在任何仓库里，升级即丢。搬进本仓库才能把它变成受 git 管理、有自检的东西。
- 两份插件并存会各自注入一次系统提示（实测同一段出现 2 份、整行 68,977 字符、每次调用白付约 6.5k token）。
  只有合成一个包，才能从根本上做成一份。

## 3. 不做什么

- **不重写、不"优化"上游行为**：86 条补丁的锚点、替换文本、红队评分规则一律照搬。搬运期间只允许改
  「包根定位」「挂载点」「互斥」「幂等注入」这四类，其他改动都算改行为，另开需求。
- **不改上游的默认开关**：`enabled: true`、`injectOnce: false`（本移植版把 `injectOnce` 的**实现**补上并默认开启，
  因为不补就会重复注入 —— 这是修 bug，不是改行为）、`autoApplyOnStart: false` 等原样保留。
- **不把红队技能并进本包 `skills/` provider**：仍由 `lib/redteam/index.js` 运行时落到 `$DSH_HOME/redteam/skills`，
  避免普通模式技能列表多出 20 个红队技能（现状即如此，不扩大）。
- **不与外部 `dsh-purge` 同时激活**：检测到 profile 依赖里还有 `dsh-purge` 时，本包的 purge 半边整体不挂载，
  只打一条日志 + 在 `dsh-team status` 里标出来。卸载外部包是用户动作，不自动做。
- **不动 `AGENTS.md` 的红队角色稿、`team/RULES.md`**：那是本仓库自己的基线，与 purge 的身份注入是两层，互不合并。
- **不保证 macOS/Linux 桌面路径**：上游只验证了 macOS web；本机是 Windows。桌面换包那套（`#133`）照搬即可，
  不额外适配。

## 4. 验收标准

- [ ] `node -e "import('./lib/purge/core.js').then(m=>console.log(m.ALL_PATCHES.length))"` 输出 `>= 86`
- [ ] `node bin/dsh-team.mjs purge --status` 能列出补丁表与 `installed-rev`，退出码 0
- [ ] `node scripts/selftest-purge.mjs` 全绿：模块可 import、包根定位正确（`presets/`、`skills/redteam/`、
      `cordis.patch.yml` 都指到本包）、插件的 3 个工具 + 5 条命令 + 红队工具表结构齐全、幂等注入补丁在
- [ ] `node scripts/selftest-purge.mjs` 的反向断言：把 `lib/purge/index.js` 里的幂等补丁删掉，自检必须变红
- [ ] `npm test` 全绿（新增一条 `selftest-purge.mjs` 进链）
- [ ] `dsh-team status` 显示本包版本 `2.12.0`，且能识别「外部 dsh-purge 仍在安装 → purge 半边已让位」
- [ ] 真机验证：重启 dsh 后 `purge_status` 只剩一份注入（`scripts/check-purge-inject.mjs` 的 ② 报告 `最多 1 条`），
      红队面板/`redteam_*` 工具仍可用
- [ ] `docs/状态.md` 记一笔；`CHANGELOG.md` 有 `## [2.12.0]`；`THIRD_PARTY_NOTICES.md` 补 MIT 署名与来源仓库

## 5. 已知约束（侦察出来的硬事实）

| 约束 | 证据 | 影响 |
| --- | --- | --- |
| purge 是 4 个 cordis 插件行，不是 1 个 | `dsh-purge/cordis.patch.yml:1-70` | 本包 `cordis.patch.yml` 要插 4 行，`package.json` 要 4 个 exports |
| 一个包只有一个客户端入口 | `lib/client.js:5-6`（引 `dsh-client-modules/lib/index.js:171-181`） | purge 的 8.7k 行 client 只能并进本包 `lib/client.js`，不能另开文件 |
| 内部大量按字面量 `"dsh-purge"` 判定（段名 / 依赖名） | `lib/identity.js:113,286`、`lib/uninstall.js:39`、`lib/core.js:754` | **不能**把内部标识改名；只能改挂载名与包根 |
| 包根定位靠 `import.meta.url` 相对层数 | `lib/reapply.js:6`、`lib/update.js:15`、`lib/redteam/index.js:27`、`lib/redteam/ui.js:54`、`lib/redteam/skill-availability.js:112`、`lib/core.js:7578` | 搬进 `lib/purge/` 后这些层数全部要 +1 |
| 状态目录是 `$DSH_HOME/dsh-purge/`（与包名无关） | `lib/core.js:1487,2088,6373,8217` | 本机已有状态天然共享，不需要迁移 |
| 外部依赖只有 `yaml`（且只出现在注入文本里，不是 import） | `lib/core.js:4103,4108` | 零运行时依赖成立，不用改 package.json dependencies |
| 上游一处 `injectOnce` 配置键**没有实现** | `lib/index.js:307` 区段与本地补丁 diff | 移植版必须实现，否则重复注入 |
| 红队 store 用 `node:sqlite` 的 `DatabaseSync` | `lib/redteam/store-core.js:8` | 要求 node ≥22.19（本包 engines 已是） |
| 本机桌面 profile 是 `desktop`，不是 `web` | `~/.dsh/profiles/desktop/package.json` | 互斥检测与路径候选要把 `desktop` 放第一位 |

## 6. 方案

1. **原样搬运**：`cp -r` 上游 `lib/*` → `lib/purge/`（含 `redteam/`），`presets/` → `presets/`，
   `skills/redteam/` → `skills/redteam/`（仅作为运行时落地的源，**不**并入 provider 的 customSkillDirs），
   `scripts/redteam-setup.sh` → `scripts/`，`bin/dsh-purge.js` → `bin/purge-cli.mjs`。
2. **改包根层数**：上表 5 处 `import.meta.url` 相对层数各 +1；`ui.js` 里写死的
   `node_modules/dsh-purge/skills/redteam` 候选改成 `dsh-team-workflow`。
3. **幂等注入**：把本地补丁（`PURGE_SECTIONS_ON`）正式并进 `lib/purge/index.js`，并把
   `injectOnce` 默认改为 `true`（同时保留配置可关）。
4. **挂载**：本包 `cordis.patch.yml` 追加 4 行（`dsh-team-workflow/purge`、`.../purge/redteam`、
   `.../purge/redteam/store`、`.../purge/redteam/ui`）；`package.json` 的 `exports` 与 `files` 同步。
5. **互斥**：`lib/purge/gate.js` 检测 `<DSH_HOME>/profiles/*/node_modules/dsh-purge/package.json` 或
   profile `package.json` 的 dependencies 里是否有 `dsh-purge`；有则 `lib/index.js` 不 `installPurge()`，
   并导出 `purgeGate()` 给 `dsh-team status` 展示。
6. **CLI**：`bin/dsh-team.mjs` 加 `purge [--status|--apply|--revert|--uninstall|--edit]` 子命令，直接调
   `lib/purge/core.js`，不另起进程。
7. **客户端**：purge 的 `client.js` body 以 IIFE 形式并入本包 `lib/client.js`，共享同一份 `require`；
   本包 `apply` 里先装团队面板再装 purge 面板，任一半抛错不影响另一半。
8. **自检**：`scripts/selftest-purge.mjs` 断言包根定位、模块可导入、工具/命令/路由清单、幂等补丁存在，
   并做一次反向变异（删补丁 → 必红）。

## 7. 天花板（做完之后仍不支持的）

- 上游停更：dsh 下次改宿主结构时，86 条补丁的锚点仍会失效，得手工对齐（与搬不搬进来无关）。
- 卸载流程（`lib/purge/uninstall.js`）仍按 `dsh-purge` 这个**包名**删 profile 依赖；移植后它删的是外部包，
  不是本包。真正卸载本包仍走 `dsh-team uninstall`。这是已知的不一致，已在 `docs/状态.md` 记录。
- 红队事实库仍是进程级单例 + `$DSH_HOME/redteam` 单库，多机不共享。

## 8. 验收记录

（收尾时填）
