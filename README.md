# dsh-team-workflow

把 [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow) 的团队基线搬进 **DeepSeek Harness (dsh)**。
一个 npm 包，装完提供：系统提示里的团队规范（含审查分工）、审计日志、上下文节流统计、
rtk 输出压缩、pi-lens 静态检查、上下文超限时的自动会话交接、启动自动更新、
Windows 上可用的 linux 命令工具、子代理的 worktree 隔离、一个 `/review` skill 和 11 个技能（含 `/workflow`：自然语言驱动的开发流程）。

不用 MCP —— 全部走 dsh 的 plugin / skill / command 三个原生面。

> **接口已冻结** —— 哪些东西不会随便改、哪些明确不保证，
> 以及**信任假设**（远端能改全团队 AI 的行为），见 [docs/STABILITY.md](docs/STABILITY.md)。
> 需求与设计文档在 [docs/requirements/](docs/requirements/)。

## 装

```bash
dsh-team install --profile tauri     # 等价于 dsh plugin --profile tauri add link:<本目录>
```

装完**重启 dsh**。然后在会话里跑 `/team-baseline` 自检 —— 它能把它的状态打出来，
本身就说明插件活着。

其他子命令：

```bash
dsh-team status                      # 当前状态：装没装、skills 几个、rtk/lens 在不在
dsh-team skills                      # 列出本包带的技能
dsh-team thrift apply                # 把 ~/.dsh/team-workflow/thrift.json 写进团队预设（真生效的那两行）
dsh-team preset install              # 生成「团队模式」预设（rc.x 下是个 bundle，见下）
dsh-team preset install --default    # 顺带把它设成新会话的默认预设
dsh-team plugins                     # 可选装三个第三方插件（交互式逐项问，默认都不装）
dsh-team patch                       # 思考链/工具行默认展开（改安装树，--restore 可还原）
dsh-team patch --status              # 只看看打没打（认得出 dsh 新旧两种组件形态）
dsh-team uninstall                   # 卸载
```

`--dry-run` 可以加在任何会写盘或调 dsh 的命令上。

> `dsh-team patch` 改的是**安装树**里 `@deepseek-ai/dsh-client-ui-{chat,tool}/lib/client.js`
> 的组件状态（dsh 没给这两个展开态留任何配置入口）。dsh 0.2.0-rc.x 把组件重构成了
> `const X = (0, react.memo)(function X(` + 共享的 `useDisclosure()`，所以它认**两种形态**：
> 老形态改组件里的 `useState(false)`，rc.x 形态给 `useDisclosure` 加 `defaultOpen` 形参、
> 再改三处调用点（终端行在 rc.x 里叫 `StartedBashRow`，`BashRow` 只剩分发）。
> 上游再改就会报「找不到组件」—— 它拒绝猜。npx 缓存被清或 dsh 升级后要重跑一次。

## 可选装的三个第三方插件

`dsh-team install` 装完本包后会**逐个问**要不要顺带装这三个（默认都不装，回车即跳过）。
装完才想装的，用 `dsh-team plugins` 再问一遍；非交互环境不询问，要用 `--with-<key>` 点名：

```bash
dsh-team plugins --profile tauri                 # 交互式问三遍
dsh-team plugins --with-sidebar --with-pet       # 点名，不问
dsh-team plugins --no-plugins                    # 一个都别问
dsh-team status                                  # 三个各是「已装 x.y.z」还是「未装」
```

| key | npm 包 | 是什么 | 许可 |
| --- | --- | --- | --- |
| `sidebar` | `dsh-better-sidebar` | 右侧栏工作台（编辑器 / 文件树 / Git / 侧边对话） | MIT |
| `wallpaper` | `dsh-plugin-wallpaper-engine` | 把本机 Wallpaper Engine 壁纸渲染到界面后面 | MIT |
| `pet` | `dsh-pet` | 桌面宠物（浏览器 overlay，可选 Electron 透明置顶小窗） | MIT，**素材另有条款**：禁商用、二创须署名 |

三条行为上的约定：

- **已经在 profile 里的一律不动**（本机 web profile 里本来就有 `dsh-better-sidebar@0.24.1`，
  这种情况直接跳过并报「已装 x.y.z」）。只有 `--with-<key>` 点名才会升到最新。
- **装不上只警告**：工作流本体照常生效，退出码仍是 0，末尾汇总里给出重试命令。
- **只往带 web 界面的 profile 里装**（这三个都是 `platform: "web"` 的界面插件）。

> 版本对表要注意：`dsh-better-sidebar` 要 dsh ≥ `0.2.0-rc.1`（0.1.7 线得钉 `@0.22.1`），
> `dsh-pet` 明写 `0.1.7-rc.2` 不兼容。**装错版本会被 dsh 启动预检静默禁用**——
> 重启后看不到效果，先查它要求的 dsh 版本。

## 团队预设：rc.x 起由 bundle 承载

dsh 0.2.0-rc.x 换了预设的承载方式：不再是 `$DSH_HOME/.agent-presets/<id>/` 目录，
而是 profile 树里的一行 `@deepseek-ai/dsh-agent-preset` 声明，**且必须由 bundle patch 承载**。
`dsh-team preset install` 会照着当前出厂的
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 现改出一份团队预设，
写进 `<DSH_HOME>/team-workflow/preset-team/`，再挂进 profile。

```bash
dsh-team preset install [--default]   # 生成 + 挂载；--default 顺带设成新会话默认
```

> **别把这条声明放进 profile 的 `cordis.patch.yml`**（2026-10-04 实测踩过）：
> 那样行会出现在组合树里、`--dump-config` 也看得到，但**预设不会被注册**；
> `default: team` 于是指向不存在的预设，会话退化成「无预设」——
> persona / plan-mode 等预设文本全丢，且 host 层被 `dsh-web-app` 设成 disabled、
> 只由预设提供的 `tool-fs`（read / write / edit）、`present`、`ask_user_question`
> 会一起消失。判据：`plugin_manager` 的 `list_plugins` 里有没有 `preset-team`
> 且 `fiberPhase: active`。

与 standard 的差别只有两处：`compaction-basic` 的阈值（团队值），以及 persona 末尾的
「当前模式：团队模式。」。其余逐字照抄，所以 dsh 升级后重跑一次 install 就同步了。

## 装进来的东西

| 面 | 实现 | 说明 |
| --- | --- | --- |
| 团队规范 | `ctx.systemPrompt.section`，order 600 | 读 `team/RULES.md`，每次会话注入；首行带当前基线版本（读 `package.json`） |
| 审计日志 | `ctx.on('session/event')` | 落 `<DSH_HOME>/storages/audit-log/<日期>.jsonl`，逐行 JSON，凭证脱敏 |
| 上下文节流 | `session/event` 统计 + 配置 overlay | 压缩本体用 dsh 自带的 compaction / pruner，本包只统计和改阈值 |
| rtk | 系统提示段（order 650）+ `tools/post-execute` | 引导模型走 `rtk`，顺手压 shell 输出（去 ANSI、截头尾） |
| pi-lens | `tools/post-execute` 提示 + `lens_check` 工具 | spawn pi-lens 的 `analyze-cli.js` 做冷启动静态检查 |
| pi-lens 工具集 | `lens_tools` 一个入口工具，按需点亮 | 把 pi-lens 的 12 个代码情报工具（符号搜索、AST 检索/替换、LSP 跳转/引用/hover）接进来。**默认一个都不常驻**：声明体积是每次调用都重发的，全常驻等于地板涨 75%。模型先调 `lens_tools` 点亮，回合结束自动撤销 |
| context7 | `docs` 工具 | 查第三方库官方文档（免 key，直连 HTTP，不走 MCP）。一个工具内部完成「搜库 → 取文档」，因为多一次工具调用 = 多一整个 step，比多注册一个工具贵约 45 倍 |
| 命令 | `/team-baseline` `/thrift` `/audit-log` | `commands.register`，只回显给 UI，不进模型上下文 || 会话交接 | `agent/error` + `sessionController` | 上下文超限且 dsh 自救失败时：写交接文档（未完成任务）→ 建新会话 → 把任务注入并开跑 → 旧会话留提示 |
| linux 命令 | `tools.register`（自己 spawn bash） | Windows 上也能跑 `sed`/`grep`/`find`/`awk` 等 linux 命令。`bash` 一次性、`bash_open`/`bash_send`/`bash_close` 持久会话（`cd`/变量/函数保留）。见「## linux 命令」 |
| 自动更新 | 启动时后台跑 git（不阻塞） | 比对远端版本，落后就 `fetch` + `merge --ff-only`。有未提交改动/本地领先时跳过。见「## 自动更新」 |
| 子代理 worktree | `tools.register`（4 个 `worktree_*` 工具） | 写代码的子代理各在独立 worktree 干活，写完合回主分支。dsh 原生没有工作区隔离，本工具包外补足。见 [docs/requirements/REQ-001-worktree隔离.md](docs/requirements/REQ-001-worktree隔离.md) |
| 操控电脑 | `tools.register`（7 个工具）+ 常驻 PowerShell 守护进程 | 截屏看屏幕（图片直回模型）、鼠标点击/移动/滚动、打字/按键。操控期锁鼠标（WH_MOUSE_LL 钩子拦真实输入、放 AI 注入；Ctrl+Alt+L 紧急解锁）。**默认启用**（`enabled:false` 可关），审批为会话级（批准时弹窗会写明连带放行）；守护进程 spool 可被 bash 直写 = 与 bash 同属既有信任边界。见 [docs/requirements/REQ-002-computer操控电脑.md](docs/requirements/REQ-002-computer操控电脑.md) |
| 定时任务 | `tools.register`（4 个 `scheduler_*`）+ HTTP 路由 + Web 面板 | 到点在**全新会话**里无人值守跑一段 prompt（8 种计划）。**默认关闭**，`dsh-team scheduler enable` 开。是本包唯一碰 dsh 内部 API 的模块，靠 `ctx.inject` 条件激活。见「## 定时任务调度器」 |
| 小队 | `tools.register`（6 个 `squad_*`）+ HTTP 路由 + Web 面板 | 主 agent 建多个小队，小队 = 目标 + 成员名册 + 共享黑板。成员是**小队自己驱动的循环**（不是子 agent，不出现在会话列表里），各自钉在一棵 worktree 里干活。状态只在 dsh 进程内存里（不落盘、重启即失效）。见「## 小队（squad）」 |
| 审查 | `team/RULES.md`（注入系统提示） | 两层分工：**std 测**（带工具，每完成一块跑）／**power 判**（`toolFilter: allow: []`，一个工具都没有，只在重大变化或写完一个大部分时派）。见 [team/RULES.md](team/RULES.md) 的「## 审查（两层：std 测，power 判）」 |
| 技能 | `skills/*/SKILL.md` | 复用 dsh 原生 skill 系统，含 `/review`（用户可调用）、`/workflow`（需求→调研→实现→审查→提交的全流程） |

## 和 pi 版的差异（都是 dsh 的硬约束，不是偷懒）

- **上下文节流不重写消息。** pi 版在 LLM 调用前裁旧推理、精简工具声明、stub 旧工具输出。
  dsh 的 `llm/stream` 拿到的请求是深冻结的，只能替换回调结果、不能改 `options`；
  `tools/pre-execute` 的参数同样深度冻结。所以压缩交给 dsh 自带的
  `dsh-compaction-basic` 和 `dsh-compaction-tool-result-pruner`，本包只做统计 + overlay。
  `/thrift compact|prune` 写的是 overlay，要 `dsh-team thrift apply`（或 `dsh-team preset install`）+ 重启才生效 —— 命令里会直说。
  `/thrift show` 显示的是**预设里真在跑**的值；overlay 里还没写进预设的会单独列成「待应用」。
- **rtk 不改写命令参数。** pi 版把 `git status` 重写成 `rtk git status`；dsh 里参数冻结改不了。
  改成往系统提示里塞一段路由说明（跟 `rtk init -g` 装的那个 hook 起同样作用），
  外加 `tools/post-execute` 上的输出压缩。
- **不用管道的钩子。** pi 版 pi-lens 集成依赖 warm MCP IPC 和 Claude Code 的 hook 信封，
  dsh 里这两条都没有。改成冷启动 spawn `analyze-cli.js`，慢一点但能用。
  注意 `--turn-end` 需要 warm 连接，没用；`lsp_navigation` 之类需要 LSP server，
  没装 LSP server 的机器上就是死重量，所以没做。
- **`/review` 是 skill 不是命令。** dsh 的 `commands.register` 不产生模型消息，
  而 `/review` 要模型干活。
- **交接不切 UI。** 「自动切到新会话」在 pi 版靠 UI 跳转；dsh 里让 UI 换当前会话的
  `sessions.open(id)` 只存在于 `dsh-api-session-controller` 的 client half，
  而本包是纯 host 包（`package.json` 没有 `dsh.client`）。所以做的是
  「建新会话 + 注入任务 + 旧会话里写明去哪」，不假装跳转。

## 压缩分工：magic-context 先动手，dsh 自带压缩兜底

上下文里有两套压缩机制，它们的分工是**一条不变式**：

> **magic-context 的执行阈值 < dsh 自带压缩的阈值**

| | 阈值 | 换算成 token | 干什么 |
| --- | --- | --- | --- |
| magic-context | 65%（主动线 63%） | 333K | 按 tag 细粒度删除旧内容、必要时生成分级折叠摘要 |
| dsh 自带 | 70%（`compactThresholdRatio` 0.7） | 358K | 应急兜底：把一整段旧对话交给 LLM 摘要后整体替换 |

**为什么必须拉开**（2026-09-29 实测）：dsh 若比 mc 先压，它会先把地板压回低位，
mc 的阈值就结构性不可达。实测后果：mc **一次都没出手**（`shouldFire=true` 出现 0 次）、
它排队的 **26 个 drop 操作永远不执行**，而 dsh 一天压 **83 次**。

当时的对策是「把 mc 压到 20%、dsh 保持 25%」（102K / 128K）。**2026-10-08 用户要求
「不要在 128K 就压」，改成 dsh 70% / mc 65%**（358K / 333K）—— 不变式照旧满足（mc < dsh，
差 5 个点），而 mc 回到自己的默认值，那套 20% 的补偿（`history_budget_percentage` 0.45）
也一并撤销回默认 0.15。**代价是已知的**：压得晚 = 地板平均爬得更高 = cacheRead 约翻倍，
这正是当年没选这条路的原因（见 `docs/requirements/REQ-003-mc与dsh压缩阈值冲突.md` 的修订节）。

上界有两个，改这个值时都不能越：自检断言阈值 ≤ 400,000（`scripts/selftest-preset-gen.mjs`，
460,800 那次「阈值够不着、压缩永不触发」的回归）；以及 compaction-basic 的
`pressureBudget = 窗口 − 输出预留 − headroomTokens`（tier-max 预留 64000 → 382,464）。

```bash
dsh-team mc show            # 并排看两边阈值，并判不变式
dsh-team mc apply           # 写入（先校验不变式，不合法就拒绝写）
dsh-team mc apply --dry-run # 只看会改什么
```

> **profile 别打错**：`dsh-team` 的默认 profile 是**写死的 `tauri`**（`bin/dsh-team.mjs:86`），
> 而浏览器里跑的是别的 profile（本机是 `web`，看 `$DSH_PROFILE`）。打错目标时命令
> **不会**报错，只会把预设和配置写到另一个 profile 里去 —— 所以装完之后一律显式写
> `--profile "$DSH_PROFILE"`，生成完再回读一眼生成物里的值（`thresholdRatio` 那一行）。
> （本文档别处的 `--profile tauri` 示例是桌面端场景，照抄到浏览器 profile 上就会打错。）

`mc apply` 只动 `~/.config/cortexkit/magic-context.jsonc` 里的
**两个受管键**（`execute_threshold_percentage` 与 `history_budget_percentage` —— 后者现为 mc 默认
0.15，写它只为覆盖用户配置里可能残留的旧补偿值 0.45），其余字节（你自己写的 historian 配置、注释）原样保留 ——
因为 mc 的配置是深合并 + 逐键回落默认值，没写的键走 mc 自己的默认。
**改完要重启 dsh**（这些键不在 mc 的实时重载名单里）。

> 为什么要连 history 预算一起调：它按 `窗口 × (执行阈值/100) × history_budget_percentage` 算。
> 2026-10-08 之前阈值被压到 20% 时，不补偿会让绝对预算从约 50K 缩到 15K，所以配套设 0.45；
> 阈值抬回 65% 后补偿不再需要，模板显式写回默认 0.15（512000 × 0.65 × 0.15 = 49,920）。

`scripts/selftest-mc-config.mjs` 把这条不变式锁进 `npm test`：
改了任一边的值而两边不再拉开，自检直接红。详见
[docs/requirements/REQ-003-mc与dsh压缩阈值冲突.md](docs/requirements/REQ-003-mc与dsh压缩阈值冲突.md)。

## 自动更新

每次启动 dsh 比对 git 远端与本地的版本，不一致就拉。状态在 `/team-baseline` 里一行。

### 为什么是 git 而不是 npm

本包**不是** npm 安装的，而是**软链**指向开发目录：

```text
~/.dsh/profiles/<profile>/node_modules/dsh-team-workflow -> <本仓库>
```

而且没发布到 registry（`npm view dsh-team-workflow` 404）。所以：

- 「电脑上装的版本」= **这个工作目录** `package.json` 的 version
- 「最新版本」只能从 git 远端取
- 「更新」实质是 `git pull`

按 npm 安装去实现会永远空转。

### 三条安全约束（硬编码，不可配置）

1. **只快进**。先 `fetch` 再 `merge --ff-only`，快进不了就失败 —— 绝不替你决定用哪种
   合并方式。自动把开发者的分支搅了是最恶劣的失败。
2. **工作目录有未提交改动就跳过**。不 stash、不覆盖你正在写的代码；本地领先远端时同样跳过。
3. **不阻塞启动**。检查在后台跑（实测同步返回 16ms，网络全在后台），带 20s 超时，
   失败只影响它自己那一行。

### 生效时机

拉下来的代码在**下次启动 dsh** 时生效，本进程跑的仍是旧代码。

实测 dsh 的 HMR 只监听 `cordis.patch.yml` 一个配置文件（`dsh-app-boot` 的
`watchUserPatches` 是 `hmr.registerConfig(filename, …)`，只重装 patch 层），
**不监听插件源码** —— 所以不会出现「一半新一半旧」的中间态。

### 配置

```jsonc
// team/extensions/auto-update.json
{
  "enabled": true,
  "remote": "origin",
  "branch": "",          // 留空用当前分支
  "timeoutMs": 20000,
  "notifyRestart": true   // 拉到新代码后提示需重启
}
```

### 实现上的几个坑（都有回归测试）

- **不能用 `pull --ff-only`**：多个 dsh 实例同时启动时，并发 `pull` 会报
  `Cannot fast-forward to multiple branches`（实测 3 并发出退出码 128）。改成单独 `fetch` + `merge --ff-only`。
- **并发 `fetch` 本身也会失败**，两种形态：git 的 ref 锁（`cannot lock ref`），以及
  Windows 上两进程同时写 object 文件（`unable to write file .git/objects/…: Permission denied`）。
  按瞬时可重试错误做退避重试。修前 15 轮 × 8 并发稳定复现，修后 8/8 全绿。
- **必须校验仓库根就是包目录**：`rev-parse --is-inside-work-tree` 对「包含本目录的
  **外层**仓库」也返回 true。若本包被拷贝（而非软链）进某个 git 项目里，会去动
  **别人的仓库**，而 `merge` 会改写用户的项目文件。
- **并发拿不到 `index.lock` 不报「失败」**，降级成「另一实例正在更新」。

## linux 命令

让 AI 在 Windows 上也能跑 linux 命令（`sed`/`grep`/`find`/`awk`/`wc`/`sort`/`xargs` 等）。

### 为什么不直接打开 dsh 自带的 `tool-bash`

dsh **已经有** `tool-bash`，但出厂预设按平台二选一
（`dsh-agent-presets/presets/standard/agent.cordis.yml`）：

```yaml
- id: tool-bash
  disabled: !!js process.platform === 'win32'   # Windows 上禁用
- id: tool-pwsh
  disabled: !!js process.platform !== 'win32'
```

而 **`ctx.shell` 是单例缝**（`dsh-shell/lib/index.js` 的注释写明「a host composes
exactly one provider of `ctx.shell`」，两个一起挂会因服务重名抛错）。Windows 上这个
单例被 `pwsh-sandbox` 占着，所以**只把 `tool-bash` 打开会得到一个「名叫 bash、实际
跑 PowerShell」的工具** —— 比没有更糟。换执行器则要改 dsh 安装树的预设，升级会被覆盖。

所以本包**自己 spawn bash，只往 `tools` 注册表加工具**，完全不碰 `ctx.shell`。

### 四个工具

| 工具 | 用途 |
| --- | --- |
| `bash` | 一次性。每次全新 shell，`cd`/变量不保留。查文件、跑构建、git 之类 |
| `bash_open` | 开持久会话（同一会话重复调用只复用） |
| `bash_send` | 往持久会话发命令，`cd`/变量/shell 函数跨调用保留 |
| `bash_close` | 收掉持久会话（不收也不泄漏，组合拆除时会自动清理） |

实测（本机 Windows + Git Bash）：

```bash
$ uname -s                 # MINGW64_NT-10.0-26200
$ grep --version | head -1 # grep (GNU grep) 3.0
$ printf 'a\nb\nc\n' | grep -c .   # 3（多行命令正确）
```

持久会话里 `cd /tmp` 之后下一次 `bash_send` 的 `pwd` 仍是 `/tmp`；`export X=1`
和 `myfn() { ...; }` 都跨调用保留。语法错误只会得到一个非零退出码，不会杀死会话。

### 两个形态都做，是因为取舍不同

一次性会话可预测（每条命令互不影响），但「反复 cd 进一个目录」很费 token；
持久会话省 token，代价是**状态会让「这次为什么不通」变难查**。所以两个都给，
模型按场景选。

持久会话的已知天花板：

- **交互式命令不能用**（`vim`、要密码的 `ssh`）—— 会挂到超时，然后会话判死重建。
- **持久会话里 `exit` 会真的关掉会话**（bash 语义如此）。想继续用就重开一个。
- **命令在后台持续写 stdout 会污染下一条命令的输出** —— 彻底解决要上 PTY +
  独立 fd（dsh 的 `tool-bash-persistent` 那么做），本包按「够用」收手。

### 安全边界（重要）

这些命令**不经过 dsh 的 sandbox 管辖** —— 因为绕开了 `ctx.shell` 单例。
（dsh 在 Windows 上的 ACL 后端本身也只声明 `partial` 保证。）要更强的隔离：
把 `team/extensions/bash-linux.json` 的 `enabled` 设为 `false`，改用 dsh 自带的 `pwsh` 工具。

配置：

```jsonc
// team/extensions/bash-linux.json
{
  "enabled": true,
  "mode": "auto",     // auto = PATH 里的 bash（MINGW）；wsl = wsl.exe -e bash（真 Linux 内核）
  "timeoutMs": 120000,
  "maxTimeoutMs": 600000,
  "maxOutputBytes": 65536,
  "maxSessionOutputChars": 16384
}
```

`mode: "wsl"` 走**真 Linux 内核**而不是 MINGW 模拟层，但需要机器装过 WSL 发行版
（`wsl --install`）；没装会在调用时报一条可读的错误。

## 会话交接

上下文压不动时会自动接力。触发条件**复用 dsh 自己的判定**，本包不自造阈值：

- `dsh-compaction-basic` 挂在 `agent/request-error`（waterfall）上，遇到
  `CONTEXT_WINDOW_EXCEEDED` 就压一次并 `{kind:"retry"}`；重试次数用尽
  （`maxOverflowRetries`，默认 1）或压缩没造成实质变化时它返回 `next()`。
- 于是 `dsh-agent-loop` 抛出 LlmError → `throwError()` **emit `agent/error`**。

**`agent/error` 只在 dsh 放弃时才 emit** —— 自救成功的那次是 `retry`，从不到这里。
所以「`agent/error` 且 `error.code === "CONTEXT_WINDOW_EXCEEDED"`」精确等于
「dsh 已经放弃自救」，不需要猜窗口大小、也不用数重试次数。

那一刻做四件事：

1. 从会话日志里捡出**最后一条用户请求** + **最后一次 todo 快照**（跨 turn 保留，
   因为要的是「干到哪了」而不是 UI 的「当前计划」）。
2. 写 `<DSH_HOME>/storages/handoffs/<日期>-<会话id>-<短hash>.md`，未完成任务排在已完成之前。
   文件名里的 id 会先消毒（防 `../` 目录穿越），消毒是有损的，所以尾巴上挂 id 的短 hash 防同名覆盖。
3. `sessionController.create`（继承来源会话的 `cwd` / `agentPreset`）+ `prompt` ——
   **注入即让新会话自动开跑**，不用人再敲一遍。preset 优先读日志里的
   `agent-preset/selected`，拿不到才回落 header（header 记的是「启动时那个」）。
4. 在旧会话里 `append` 一条 `user/message`（`source.kind = "plugin"`），写明新会话 id 和文档路径。

```bash
# 查交接历史
ls ~/.dsh/storages/handoffs/
```

三条刻意的克制：

- **不给旧会话发 prompt。** 往旧会话发消息 = 再跑一轮模型调用，而它刚刚正因为上下文超限失败。
  所以只 `append` 一条消息：session invariant 对 `user/message` 没有 turn/step 约束
  （`system/message` 有，turn 闭合后用不了），Chat 也会把它渲染成 context 行而非用户发言。
- **一个会话只交一次，且总数有上限。** 去重挡不住 A→B→C：每代新会话都是「新」会话，
  任务本身一个上下文装不下时就会一直建下去。所以额外有进程级上限（`MAX_HANDOFFS = 5`）：
  到上限仍写文档、仍给提示，只是不再自动建会话（这时该由人来看）。
  `ponytail:` 去重表是进程内常驻字符串，不回收；真到上万会话再换 LRU。
- **新会话靠 `agentPreset` 和 `cwd` 继承。** 没有 `sessionController` 的 profile
  （headless / 精简）里，这块**整个关掉**并报「待命」，不会拖垮整包。

任一步失败都不抛，只降级并写进 `/team-baseline` 的状态：建会话失败也照样写文档 +
在旧会话里给出手工出路；注入失败则新会话已在、文档已在，人去那边发一条即可。

## 定时任务调度器

到点在**一个全新会话**里无人值守跑一段 prompt。默认关闭：

```bash
dsh-team scheduler enable      # 改 team/extensions/scheduler.json，然后重启 dsh
dsh-team scheduler status      # 看开关与配置
dsh-team scheduler disable
```

会话里用 `/team-scheduler` 看开关、任务列表与最近 5 次运行。

### 和官方 `@deepseek-ai/dsh-schedule` 不是一回事

| | 官方 `dsh-schedule` | 本模块 |
| --- | --- | --- |
| 干什么 | 到点**提醒**你，投递回**原会话** | 到点**干活**，起一个**全新会话**跑完 |
| 工具名 | `schedule_*` | `scheduler_*`（不撞名） |
| 存活 | 宿主级、重启后仍在 | 宿主级、重启后仍在 |

两者可以并存。你要的是「到点让模型自己把活干了」时用这个。

### 计划类型

`once`（一次性）/ `hourly`（每小时第几分）/ `daily`（每天 HH:MM）/
`interval`（每 N 分钟，可锚点对齐）/ `workdays`（工作日）/ `weekly`（每周某几天）/
`monthly`（每月几号）/ `custom`（每 N 天的某个时刻，可锚点对齐）。

**计划不认时区**，一律按宿主进程本地时区算。上游桌面版有个 `timeZone` 字段但它是死的
（底层 `cron-schedule` 没有时区支持），这里没有搬它 —— 搬一个不生效的字段比不搬更坏。

**不做错过补偿队列**：停机三天，`interval` 任务只补跑一次，不是三次。
**不做重试**：一次失败就是失败，等下一个周期。

### 三个必须知道的风险

1. **无人值守 = 审批策略强制 `never`。** 没人能点「同意」，不设 `never` 工具调用会卡死。
   所以创建任务时的 `permission` 是**唯一的安全边界**，默认 `read-only`。设不上就不跑：
   `setup` 里 `setSandboxMode()` → `setApprovalPolicy()`，任一失败就 dispose 掉刚建的
   会话、本轮记 failed，绝不在沙箱没设上的情况下把 prompt 发出去。
   另外无人值守会话里的三个写工具（`scheduler_create` / `scheduler_update` /
   `scheduler_delete`）被 `tools.restrict` 禁掉 —— 不禁的话，一个 `read-only` 的任务
   能建一个更高权限的新任务，那就是提权。只留只读的 `scheduler_list`。

   **但 `restrict` 不是能力边界**：那个无人值守会话手里有 bash，它能 `curl` 打本机
   `/api/team/scheduler/tasks`（回环 socket + 回环 `Host`、无 `Origin`、无
   `sec-fetch-site`，四条栅栏全过）自己建任务。所以边界放在服务端：
   **`maxPermission`（默认 `workspace-write`）是任务 `permission` 的天花板**，
   建（HTTP + 工具两条路）和改（`scheduler_update` + `PUT /tasks`）四个口子全过检查。
   要放开到 `danger-full-access` 得自己改 `team/extensions/scheduler.json`。
   - **放行判据是正向的，不是「没报错」。** 两条边界都**写进去再读回来**：
   `setSandboxMode()` 之后回读会话日志里那条 `sandbox/mode` 事件、
   `setApprovalPolicy()` 之后回读那条 `approval/policy` 事件，两个都对上了才置
   `pinned`，`!pinned` 一律 dispose + 不跑。

   要防的**不是**「抛异常」—— `setup` 抛异常其实**会**让 `agents.create` reject
   （`dsh-agent-loop/lib/index.js:1889` 那个 `await`，加上 `setupAndPublish` 的重抛）。
   要防的是 **setter 不抛却不生效** 和 **`setup` 压根没被调用**：这两种形态下
   `setupError` 也是 `undefined`，只有回读拦得住。审批也必须回读，因为它的死法是
   工具调用永远卡着等人点，而无人值守没人在。

   天花板也一样要在**执行时**再查一遍：只在写口拦 = 只拦新增不拦存量，
   调低 `maxPermission` 之后旧任务还能靠 `run_now` 复活。

   - **`read-only` 不拦 exec，所以有一条 `read-only` → `workspace-write` 的提权链。**
   `read-only` 管的是文件写入（`dsh-sandbox` 里 read-only 的可写根是空的），
   不拦执行命令。一个 read-only 的无人值守会话手里仍有 bash，它能 `curl` 本机
   `/api/team/scheduler/tasks`（四条栅栏全过）自己建一个 `workspace-write` 的任务。
   `tools.restrict` 管不到子代理和 shell，`maxPermission` 只能钉住链的终点。
   **对策是把 `maxPermission` 设成 `"read-only"`** —— 那条链当场断掉。
   默认给 `workspace-write` 是实用性取舍，知道就行。

2. **这是本包唯一碰 dsh 内部 API 的模块**（`ctx.agents.create` / `agentPresets.mount` /
   `setApprovalPolicy` 那一套），会随 dsh 版本漂移。所以它**不进顶层 `inject`** ——
   `inject` 里写一个当前 profile 没有的服务会让**整个插件**静默不激活，那会把团队基线
   一起弄没。改用模块内 `ctx.inject` 条件激活：依赖不齐时只有调度器不激活。
3. **关着的时候是真关。** `enabled !== true` 时 `installScheduler` 立刻返回：一个工具不
   注册、一条路由不挂、effect 都不起，GUI 面板探活失败也不出现。

### 存储与路由

```text
<DSH_HOME>/team-workflow/scheduler/tasks.json    任务
<DSH_HOME>/team-workflow/scheduler/runs.json     运行历史（留最近 200 条）
```

写走全局串行队列 + 临时文件 `rename` 原子替换。文件不是合法 JSON 时**写路径拒绝并改名
留证**（`<file>.corrupt-<ts>`），不会「按空表读进来再整体覆写」把任务清光。

HTTP 前缀 `/api/team/scheduler`（`GET|POST|PUT|DELETE /tasks`、`POST /tasks/toggle`、
`POST /tasks/run`、`GET|DELETE /history`、`GET /options`、`POST /runs/recover`）。
**每个请求先过信任栅栏**：socket 地址回环 + `Host` 头回环 + `sec-fetch-site` 不是
`cross-site` + `Origin` 与 `Host` 同源，否则 403。dsh 的 web server 自己不鉴权，
不设这道栅栏，用户浏览器里的任意网页（甚至 DNS rebinding）都能读写全部任务与历史。

任务数有上限（默认 200，`maxTasks`），判定和写入在同一个写队列回调里 —— 每个任务到点
都起一个真会话，无上限就是无界建会话。

GUI 面板挂在 `sidebar.panellist` + `main`，是**手写的零构建客户端模块**——
dsh 的客户端模块只做 `readFileSync` + 原样 HTTP，没有转译器，所以不写 JSX，
也不 require 任何 baseline 之外的包，样式全内联。

## 重复输出保护

实时监测模型的思考与正文：同一段至少 **16 字符**连续重复 **4 次**时，自动中断当前 turn，避免循环继续消耗 token。判定是纯字面周期重复，不做语义判断；工具调用循环不在检测范围内。极少数正常引用或示例若恰好完全重复到此阈值，也会被中断。中断保留已生成的安全前缀和排队中的用户输入。可在 `team/extensions/repeat-guard.json` 用 `enabled: false` 关闭。

## 小队（squad）

主 agent 能建**多个小队**，每个小队 = 一个目标 + 一份成员名册 + 一块共享黑板。**主 agent 只当
协调者**：派活、看进展、决定合不合分支，自己不动手。

**成员不是 dsh 的 agent**（REQ-011）。小队自己驱动成员的循环：自己发 `ctx.llm.stream`、
自己执行工具（`lib/squad-loop.js` + `lib/squad-tools.js`）。所以成员不出现在会话列表里、
调不到 dsh 的工具、也**不占主 agent 的上下文** —— 这正是它和 `subagent_*` 的区别。

```text
squad_new     建队（名字 + 目标）
squad_spawn   派一个成员，**当场在后台跑起来**（多派几个就是真并行）
squad_update  手动覆盖成员那一行（状态 / 结论 / 角色 / 任务 / worktree）
squad_board   往共享黑板追加一条（你以「主 agent」的身份写）
squad_status  看一个小队或全部（成员那一行 + 黑板最近几条）
squad_close   收队：**当场掐掉还在跑的成员**，名册与黑板留着（只读）
```

**6 个工具只有建队的会话能调**：成员没有调用方身份（它不是一个 dsh 会话），所以没有
「成员视角」。成员往黑板写东西用它自己的 `board` 工具，作者名由服务端判定 —— 不给参数，
少一个能撒谎的入口。成员的**收工结论会自动记进黑板**，主 agent 通常只需要读。

成员的工具有 7 个：`read` / `write` / `edit` / `grep` / `glob` / `bash` / `board`（`bash` 关掉就是 6 个）。前 6 个的
文件操作全部钉在成员的 worktree 里（路径越界直接拒），`bash` 走 dsh 的 shell 服务并显式带上
沙箱策略（`workspaceRoot` = 那棵 worktree）。成员跑在 `team/extensions/squad.json` 的
`provider` / `model` 上（默认 `new-api` / `tier-std`），`squad_spawn` 可以按成员传 `model` 换档；
循环有护栏（最多 `maxSteps` 步、单步最多 8 个工具调用、单条工具结果截断），到顶就记「卡住」，
不会无限烧。

**两条代价，写在这里以免被当成 bug**：

- **成员没有审批通道。** dsh 的审批挂在「一个开着的真 Session 的 turn」上，成员没有。
  被沙箱拦下就是做不成 —— 成员的提示词里明确要求它把这件事写进结论、不要绕。
- **本机 `danger-full-access` 下，沙箱不构成额外保护。** dsh 在那一档**直接跳过 confine**
  （`dsh-bash-sandbox` 的 `mode === 'danger-full-access'` 分支），所以 `bash` 的实际边界
  只剩「命令自己写的是什么」—— 成员能 `rm -rf`、能读工作区外面的文件、能起外部程序，
  **和主 agent 自己跑 bash 是同一个权限**。唯一还成立的那层保护是 dsh 子进程的**凭据 scrub**
  （`dsh-subprocess` 的 `scrubbedParentEnv`：子进程环境里 `*KEY*` / `*PASSWORD*` / `*SECRET*` /
  `*TOKEN*` / `DSH_*` 全部抹掉，`env` 里读不到 key）。

  **要真隔离就把 `team/extensions/squad.json` 的 `bash` 设为 `false`** —— 成员的工具表里
  不再有 `bash`，只剩钉在工作区里的 `read`/`write`/`edit`/`grep`/`glob`/`board`。
  那是本包唯一能提供的真隔离（**提示词不是隔离**）。默认 `true`，因为要跑测试/构建的成员
  离了它基本干不了活。

  同理，**默认配置下成员的 worktree 不是安全边界**：`bash` 能读写外面。别把成员的根指到
  放着密钥的目录 —— 成员读到的内容会进它的上下文，也就发给了模型 provider。

**状态只在当前 dsh 进程的内存里**：不落盘、重启即失效、别的进程看不到。因此**没有**
`dsh-team squad` 这类 CLI 子命令 —— 那只会是个永远空的表。视图是 Web GUI 面板。

### 面板

侧栏多一个「小队」入口，主面板是一列小队卡片（队名 / 是否已收队 / `N/M 完成` / 黑板条数 /
`owner` 会话 id / 目标），**点一张展开一张**：展开后才显示成员与黑板。成员一行显示
角色 · 状态 · 任务 · worktree 绝对路径 · 结论 · 转录条数，外加一个**「看转录」**按钮 ——
点开就地渲染这个成员循环的每一步（模型说了什么、调了哪个工具、结果是什么）。

为什么是「看转录」而不是「进入会话」：成员不是 dsh 会话，没有会话可进。转录是小队自己的
数据，走只读路由取（`/transcript?owner=&squad=&member=`，三件套缺一不可 —— 小队名只在
所有者的表里唯一）。转录**只读、不落盘**，每个成员最多留 200 条、单条正文最多 8000 字符（内存护栏）。

取数走宿主 HTTP 路由 `/api/team/squad/options`、`/api/team/squad/squads`、`/api/team/squad/transcript`，
**只有 GET，没有写路由**：建队/派成员/改状态/写黑板全走上面那 6 个工具。原因是路由拿不到
认证过的调用者身份（`exec.agent.id` 只有在工具调用里才有），在路由上开写口等于把权限
判据丢掉。每个请求先过与调度器面板同一道信任栅栏（回环 + 同源 + 非 `cross-site`，
共用 `lib/api-http.js`），否则 403。

**面板显示的是这台 dsh 里全部小队**，不是「当前会话的队」—— `main` 槽是 keyed 的，
拿不到 Session 绑定，所以服务端把 `owner` 一起发下来让客户端分组。同理不显示会话标题。

**信任边界：本机的其它进程也在里面。** 三个路由只校验「回环 socket + 同源 Host/Origin +
非 `cross-site`」，**没有会话鉴权** —— 本机任何一个进程 `curl 127.0.0.1:3080/api/team/squad/squads`
都能读到所有小队的目标、成员任务、worktree 路径与模型转录。这与调度器面板同一档（同一个
`lib/api-http.js` 栅栏），并且是**只读**的：没有任何写路由，改状态一律走那 6 个工具。

天花板（完整清单见 REQ-011 §7）：成员之间**不能**直接对话，只能靠黑板；面板只读；
不设成员上限、不数 token、不做成本闸门；不自动建 worktree、不自动合并分支 —— 都由主 agent 决定。

## 依赖

零 `dependencies` / `peerDependencies` —— 插件只用 `node:*` 内置模块。
可选外部件：

- `tools/rtk.exe`（随包，找不到就回落到 PATH 上的 `rtk`，再找不到就关掉 rtk 那两块）
- pi-lens：按 `vendor/pi-lens` → `~/.pi/agent/npm/node_modules/pi-lens` → `~/.pi/npm/node_modules/pi-lens`
  顺序找，找不到就关掉 lens 那两块。仓库里**不**提交 pi-lens（vendor/ 已 gitignore），
  要随包走就跑一次 `dsh-team lens install`：它把 pi-lens 本体、运行时依赖树和一个
  `@earendil-works/pi-tui` 替身一起拷进 `vendor/pi-lens`（约 46MB）。
  `dsh-team lens check [文件]` 可以真跑一次 `analyze-cli.js` 验证。

  > 为什么要替身：pi-lens 里 `clients/deps/pi-tui.js` 对 `@earendil-works/pi-tui`
  > 是**静态**导入，只在渲染路径用得到（`visibleWidth` / `truncateToWidth` / `Text`），
  > 但模块求值就会执行。pi-tui 本体是 pi 自带的 3.2MB 运行时包，为三个函数搬整棵树不值，
  > 所以放一个约 40 行的替身（`tools/pi-tui-shim.js`）到 pi-lens 自己的 `node_modules` 下。
  > 它只保证 API 存在、宽度算法够终端显示用，不参与任何真实渲染。

## 自检

```bash
npm test
```

19 个自检，每个都用假 ctx 跑真实逻辑：系统提示段顺序、四个命令、审计落盘与脱敏、节流统计、
异常隔离、magic-context 折叠、thrift 阈值换算与预设生成、context7、lens 工具集、会话交接、
会话消息形状、linux 命令工具、启动自动更新、worktree 沙箱、工具参数 schema、操控电脑守护进程、
mc 与 dsh 的压缩阈值不变式、定时任务调度器、可选第三方插件的安装判据。

后几个会**真跑外部程序**（真 bash、真 git 沙箱、真 PowerShell 守护进程与鼠标钩子），
不以「桩返回了新值」为凭据。

`scripts/selftest-handoff.mjs` 盯的是「错了会怎样」最狠的四条：

1. **触发条件精确** —— 只有 `CONTEXT_WINDOW_EXCEEDED` 才交接，限流/认证/网络错误一律不动
   （跟着交接 = 无故打断用户正常会话）；只有 message 文本像、没有结构化 code 也不交接。
2. **一个会话只交一次** —— 否则新会话再溢出会无限建会话。
3. **内容取舍** —— 注入新会话的文本必须短且只带未完成任务（它一进去就是第一条消息，
   太长会把新会话也顶爆）；会话 id 里的 `../` 不能把文档写到目录外。
4. **四级降级不炸** —— 无 `sessionController`、建会话失败、注入失败、旧会话写不进去
   各自都要有出路，且都不抛。

`scripts/selftest-bash-linux.mjs` **真跑 bash**（没装 bash 的机器会跳过并明说），守的几条是：

1. **持久会话真的持久** —— `cd`、`export`、`myfn() {}` 都要跨 `bash_send` 保留。
   这是持久会话唯一的存在理由，不验它等于没测。
2. **多行命令不被拆开 / 引号不被吃掉** —— 这两条都是真踩过的坑（单引号拼接方案
   把 `printf 'a\nb\nc\n' | grep -c .` 拆成了三条命令）。
3. **语法错误不杀死 shell** —— 否则一次误输入就丢掉整个会话状态。
4. **stderr 也受上限约束** —— 真 bug：原来只截 stdout，一个猛写 stderr 的命令
   会把上下文顶爆（实测超限 16 倍）。
5. **超时后进程能自己退出** —— 真 bug：`taskkill` 没 `unref`、stdio 管道没关，
   超时路径会引住事件循环，跑完不退（在 dsh 里就是关不干净）。这条**另起子进程**
   验证，因为 `_getActiveHandles()` 里泄漏的是 Socket 而不是 ChildProcess。
6. **命令读 stdin 不会吞掉协议** —— 真 bug：命令自己读 stdin（`read`、要密码的
   `ssh`）会吃掉后面的协议行（含哨兵），导致输出错位到下一次调用。
   靠 `eval ... < /dev/null` 隔离。

`scripts/selftest-scheduler.mjs` 守的是「默认关的时候有没有真关」和「依赖不齐会不会连累
本包其余模块」—— 这两条纯函数一条都测不出，所以它造一个**假宿主**真跑装配，再**真跑一遍
HTTP 路由**（假 req/res，不发真请求）：

1. **`enabled=false` / 缺失 → 零注册** —— 工具 0、路由 0、effect 0。
   字符串 `"true"` 也不算开（`enabled` 只认真布尔）。
2. **依赖不齐 → 同样零注册** —— 复刻 cordis 的语义：`inject` 里缺一个服务就不回调。
   不这么写，一个缺失的服务会把整个插件拖死。
3. **依赖齐备 → 工具 4、路由 1、effect 2**，且每个工具的 `output.schema` 都不带
   `required`（dsh 的校验器会直接拒），nullable 字段用 `oneOf`。
4. **存储真写** —— 原子写不留临时文件、40 个并发 `mutate` 一条不丢（证明队列真串行）、
   历史裁到上限且留的是最新的、`mutate` 抛错后队列不死。
5. **结论判定** —— 没有 `turn/end` 一律算失败（上游 `docs/sync-log.md` 记的那条：
   否则「跑一半断了」会被记成成功）。
6. **`custom` 的 `time` 真的生效** —— 上游那个 bug 的回归测试。

7. **信任栅栏** —— 5 种非本机来源（远程 socket / 非回环 `Host` / `sec-fetch-site:
   cross-site` / 跨源 `Origin` / 缺 `Host`）全部 403，且 `tasks.json` 根本不被创建；
   同源回环放行。dsh 的 web server 自己不鉴权，这是唯一拦住「恶意网页建任务」和
   「DNS rebinding 读走全部 prompt」的东西。
8. **任务数上限扛并发** —— 10 个并发 `POST` 只建出 3 个（上限判定和 `push` 在同一个
   写队列回调里，先读再判再写会一起通过）。
9. **坏文件不清库** —— 读路径降级返回 `[]`，写路径抛错并改名成 `.corrupt-<ts>` 留证。
10. **`engine.tick` 的补算真落盘** —— 老 bug：在 `readTasks()` 副本上改、再
    `mutateTasks(() => {})` 重写，改动被丢掉 → 任务永不触发 + 每秒全量写盘。
11. **客户端面板真加载** —— 用 `new Function("window", src)` 跑那份 classic script，
    探活 200 时确实注册了 `sidebar.panellist` + `main`，404 时注册数为 0。
12. **沙箱钉不上就绝不发 prompt** —— 假宿主刻意模仿 `agents.create` 吞掉 `setup` 异常
    的行为，让 `restrict` / `setSandboxMode` / `setApprovalPolicy` 各自单独抛一次，
    再加「档位设了但日志里没事件」（静默不生效）与「`setup` 压根没被调用」
    （宿主漂移）两局：五局都必须整轮失败、`followup` 调用数为 0、handle 被 dispose。
13. **权限天花板四个写口 + 一个执行口都拦** —— HTTP 建 / HTTP 改 / 工具建 / 工具改的
    `danger-full-access` 全部被拒且不落盘；把 `maxPermission` 放开后全部放行。
    另外直接塞一条超天花板的任务给执行器（模拟旧存量），必须 failed 且**连会话都不建**。

另外做八条负向验证（记录在 REQ-007 §8）：把 `anchoredOccurrence` 的
`Math.floor(...) + 1` 改成 `Math.round(...)`（不再取「严格大于 from」的刻度）→ 自检变红；
把 `engine.tick` 还原成旧写法 → 自检变红；把 `tools.restrict` 移回设 `setupError` 的
try 外面 → 自检变红；摘掉 `checkPermissionCeiling()` → 自检变红；把放行判据从 `pinned`
改回「没记下 `setupError`」→ 自检变红；摘掉 `run()` 里的天花板检查 → 自检变红；
摘掉审批回读 → 自检变红；还原后都绿。

`scripts/selftest-auto-update.mjs` 建**临时 git 仓库**真跑 fetch/merge，守的几条是：

1. **有未提交改动时不覆盖** —— 这是整个功能风险最高的一条：写一句自己的代码，
   让远端前进，验证既没拉、内容也没被动。
2. **本地领先时不动** —— 只做快进，不合并、不重置用户的分支。
3. **包目录在外层仓库内时跳过** —— `--is-inside-work-tree` 对外层仓库也返回 true；
   不查仓库根就会去改写**别人的项目**。
4. **并发不互相踩** —— 多个 dsh 实例同时启动。真 bug：并发 `fetch`/`pull` 会因 ref 锁
   和 object 文件权限失败（Windows 上稳定复现）。
5. **失败不抛** —— 远端不可达、分支不存在、超时，都要变成一条可读状态，
   而不能影响启动。

## 来源与许可

MIT。

- 团队规范、审计日志、上下文节流、rtk 优化器的设计来自
  [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow)（团队内部项目）。
- `skills/ponytail*` 6 个技能原样取自
  [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) v4.10.0，
  MIT License, Copyright (c) 2026 DietrichGebert，许可证原文见 `skills/ponytail/LICENSE`。
- pi-lens 集成调用的是 [pi-lens](https://www.npmjs.com/package/pi-lens) 4.2.1 的
  `dist/mcp/analyze-cli.js`，未修改其代码。
- **定时任务调度器**（`lib/scheduler.js`、`lib/client.js`）移植自
  [dsh-tauri/deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop)
  的 `packages/dsh-tauri-scheduler`，而那个包又改编自
  [MichengAI/dsh-automation](https://github.com/MichengAI/dsh-automation)（**Apache-2.0**）。
  本仓库是重写级移植（去掉了 TypeScript、构建步骤与全部依赖）。来源链条、
  修改声明与许可证原文见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
  与 [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)。

  > ⚠️ 直接来源那个桌面版仓库的 `LICENSE.details` 带**「禁止商用二次开发」附加条款**，
  > 而本仓库的调度器是它的衍生作品。内部使用无碍；若要进商业产品，先确认这一条。
