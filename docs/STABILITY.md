# 稳定性承诺

> 1.0.0 起，这份文件说明**哪些东西不会随便改**、哪些**明确不保证**。
> 判据只有一条：**改了会不会让使用方（人、脚本、AI、别的包）要跟着动。**
> 要跟着动 = 对外接口；不用动 = 内部实现。

## 承诺稳定（改动会按语义化版本递增）

### 模型可见的工具名与参数

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `bash` | `command` `description` `workdir` `timeoutMs` | 一次性 linux 命令 |
| `bash_open` | `workdir` | 开持久会话 |
| `bash_send` | `command` `description` `timeoutMs` | 往持久会话发命令 |
| `bash_close` | — | 关持久会话 |
| `docs` | 见工具内 schema | 第三方库文档查询 |
| `lens_check` | `file` `cwd` `lsp` | 单文件静态体检 |
| `lens_tools` | 见工具内 schema | 按需点亮 pi-lens 工具集 |
| `thrift` | 见工具内 schema | 上下文节流 |
| `worktree_new` | `name` `base` `description` | 给子代理建独立 worktree（`name` 必填） |
| `worktree_list` | `description` | 列出 worktree 及各棵的脏/净 |
| `worktree_merge` | `name` `message` `description` | 合回主分支（冲突自动回退） |
| `worktree_drop` | `name` `force` `keepBranch` `description` | 删 worktree（默认不 `--force`） |

**改工具名或删参数 = major。** 模型侧的历史会话会引用它们，改名等于让旧会话失效。
**加可选参数 = minor。** 加必填参数 = major（旧调用会失败）。

### 命令

`/team-baseline`、`/thrift`、`/audit-log`。改名字或去掉 `/thrift` 的子动作 = major。

### 配置键

`team/extensions/*.json` 里的键（共 11 个文件：`audit-log` `auto-update` `bash-linux`
`context-thrift` `context7` `handoff` `lens-tools` `magic-context` `rtk` `web-search`
`worktree`）。

- **改键名或删键 = major**（任何人写过的覆盖文件会静默失效）
- **加键 = minor**（必须给默认值，不给默认值就是 major）
- `_` 开头的键是给人看的说明，任何时候都可能改，**不要依赖**

覆盖方式：用户在自己仓库放同名文件 / 通过 `apply(ctx, config)` 传 `config.<模块名>`。
叠加顺序固定为「内置默认 ← 用户文件 ← 传入 config」，这个顺序本身也是稳定的。

### CLI

`dsh-team <install|uninstall|status|skills|lens|mc|patch|preset|thrift|help>`。
删子命令或改已有子命令的语义 = major；加子命令 = minor。

### 落盘路径与格式

| 位置 | 内容 |
| --- | --- |
| `<DSH_HOME>/storages/audit-log/<日期>.jsonl` | 审计日志，逐行 JSON |
| `<DSH_HOME>/storages/handoffs/<日期>-<id>-<hash>.md` | 交接文档 |
| `.dsh/.agent-presets/team/agent.cordis.yml` | 生成的 team 预设 |

这些是**给人读、给外部脚本取数**的，所以要稳定。**字段只增不减**；确实要改格式，
就同时留一份旧的（或明确发 major 并在 CHANGELOG 里写迁移办法）。

行格式的稳定性是**追加式**的：新增字段不破坏按字段名取值的读取方。

## 明确不保证（不是疏漏，是选择）

- **`lib/` 下的模块划分与内部函数**。这是实现细节。唯一例外是 `package.json` 的
  `exports` 里暴露的路径 —— 目前只有 `.`（`lib/index.js`）。
- **`vendor/` 下的任何东西**。那是 pi-lens 的规则与 bundle，跟着上游走，本包不改也不保证。
- **`docs/` 与 `CHANGELOG.md` 的措辞**。改文档不算接口变更（文档写错该改就改）。
- **内部生成的中间产物**（magic-context 的存储目录、缓存等）。删掉就该重建，不该被依赖。
- **具体的日志文案与状态行**。`/team-baseline` 输出的那一行行是给人看的，
  措辞会随信息完善而变 —— 要拿它做自动化，请用 `dsh-team status` 而不是解析命令输出。
- **默认值本身的数值**（超时、上限、阈值）。改数值影响的是行为不是接口，
  按 minor 走；但如果某个默认值是你依赖的，请在配置里显式写死，别依赖默认。

## 信任假设（必读）

1.0.0 起，本包有一个**必须说清楚**的信任链：

```text
team/RULES.md（仓库里的文本）→ 注入每次会话的**系统提示**
lib/*.js           （仓库里的代码）→ 在 dsh 进程里**执行**
         ↑
    git 远端（启动时自动拉）
```

也就是说：**能把代码合进这个仓库的人，能改变全团队 AI 的行为，也能在本机执行代码。**
这不是本包引入的新风险（任何自动更新都是这个模型），但因为「写进系统提示」比一般依赖
更直接，所以要写明：

- **远端 = 受信发布方。** 自动更新（`lib/auto-update.js`）会把远端拉下来的文本与代码
  投入使用。只能指向你信任的仓库（配置里的 `remote` 指向的远端）。
- **RULES.md 是提示注入的天然载体。** 它本身就在系统提示里，而它的内容又能通过
  `git pull` 自动更新 —— 所以「往系统提示里塞指令」只需要一次合入。
  这是设计如此（团队规范本来就要自动分发），不是漏洞；但**别把它的来源搞成不可控的**。
- **`mc` 的折叠摘要也是注入面。** `lib/mc.js` 会把 magic-context 的历史折叠摘要拼进
  系统提示（order 700）。那些摘要由模型生成、内容源于会话 —— 所以外部内容迟早会
  以摘要形式回到系统提示里。这是「用摘要省 token」的固有代价，不假装它不存在。
- **不自动改全局配置。** 本包不改 `~/.dsh` 下除自己 storages 之外的设置；
  CLI 的 `install` / `patch` 都要人手动跑（有明确的子命令，不会在启动时发生）。
- **不跑用户的 git hook。** 自动更新做快进时传 `-c core.hooksPath=`，不会触发用户仓库
  为手动 git 操作配的 `post-merge` / `post-checkout`（那些可能做部署、跑迁移）。

如果你不接受「远端可以改我的系统提示」这个前提，把
`team/extensions/auto-update.json` 的 `enabled` 设为 `false` —— 那就不存在自动拉取，
更新变回你手动 `git pull`。

## 依赖与平台

- **零运行时依赖**。`package.json` 的 `dependencies` 保持为空（`vendor/` 里的东西
  是可选的、按需装载的，缺了会自己关掉）。**哪天要加运行时依赖，那是 major 级决策。**
- **宿主侧**：`package.json` 没有 `dsh.client` —— 本包不提供 UI 半边。
  需要浏览器的能力（例如自动切会话 UI）**不会**加进来，加进来会改变包的形态。
- **平台**：Windows 是首要目标（团队实际环境），Linux/macOS 应能跑但未逐项验证。
  dsh 的 `ctx.shell` 单例在 Windows 上被 pwsh 占着，所以本包自己 spawn bash
  （`lib/bash-linux.js`）—— 这个绕法本身是稳定的。

## 1.0.0 意味着什么

- 上面「承诺稳定」那几类**已经收敛**，后续按语义化版本管理。
- **不代表功能不再增加。** 1.0.0 是「接口冻结」，不是「功能冻结」：新模块、新工具、
  新配置键都会继续加（minor），只是不会偷偷改掉你已经在用的东西。
- **不代表经过完整验证。** 测试是 14 个自检（其中几个真跑外部程序），
  覆盖的是已知场景与已踩过的坑；没有覆盖的不代表没问题。
