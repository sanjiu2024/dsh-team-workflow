# 交接文档 00 — 侦察结论（已完成）

> 本文件是「pi-workflow → dsh 移植」的第一份交接。后续每个阶段完成时新增一份
> `docs/HANDOFF-NN-<阶段>.md`，不改写本文件。

## 0. 一句话目标

把 `https://github.com/kurumi1ksllq/pi-workflow`（pi 的团队工作流包，v1.13.1）
1:1 移植成 **dsh（DeepSeek Harness）原生扩展包**：插件 + skills + CLI + agent preset。
**禁用 MCP**，一律走插件 / skill / CLI。

## 1. 用户已确认的决策（不可再问）

| 项 | 决定 |
|---|---|
| 移植范围 | **全搬**（团队基线 + audit-log + context-thrift + CLI，且不砍件） |
| RULES 注入方式 | 插件 `ctx.systemPrompt.section({name, order, text})`，order = `600`（TEAM_POLICY 预留槽） |
| 交付形态 | 可安装的 dsh 插件包（npm 包 + `dsh.bundle.patch` + `cordis.patch.yml` + `lib/index.js` + `skills/`） |
| rtk 二进制 | **随插件打包**（`tools/rtk.exe`，9.2MB，与 pi-workflow 同做法） |
| pi-lens 范围 | **LSP + ast-grep + 诊断全量 1:1** |
| 安装 | 装进 `tauri` profile，**并上传到 GitHub 仓库** |
| 语言 | 中文交付 |

## 2. 环境事实（已实测）

- 工作目录 `C:/Users/Administrator/Desktop/deepseek harness cj`（空目录，非 git 仓库）
- `git 2.55.0` / `node v24.21.0` / `npm 11.19.0` / `pnpm` **不在 PATH**（但 dsh 内部有 pnpm 11.7.0）
- `gh 2.101.0`，已登录 `sanjiu2024`，token 有 `repo` 权限 ✅
- dsh CLI：`C:/Users/Administrator/AppData/Local/deepseek-harness/bin/dsh.cmd`
- `DSH_HOME = C:/Users/Administrator/.dsh`
- profile：`~/.dsh/profiles/tauri/`
- dsh 安装资源（install anchor）：
  `C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/`
- dsh 内核：`@deepseek-ai/dsh` **0.1.5-rc.3**
- 桌面端 bundle 根（含第三方插件源码）：
  `C:/Users/Administrator/AppData/Local/Deepseek Harness Desktop/resources/node_modules/`

## 3. dsh 扩展点 API（已读 types 确认）

### 3.1 系统提示词段落

```ts
interface PromptSection {
  readonly name: string;        // 重复注册会 throw
  readonly order: number;       // 升序拼接；同序按 name 码点
  readonly text: string | ((ctx: AssembleContext) => string);
  readonly complete?: boolean;  // 全局只能有一个
}
ctx.systemPrompt.section(section): () => void   // 返回 disposer
```

`SECTION_ORDERS.TEAM_POLICY === 600`，**官方保留但无任何一方代码使用** → 团队基线落这里。

### 3.2 工具管道（rtk 与 pi-lens 的挂点）

```ts
'tools/pre-execute'(exec, next): Promise<PreToolDecision>
// PreToolDecision = {kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}
// ⚠️ 注释明写：Input rewriting is excluded（参数已被记录并展示）→ 不能改参数

'tools/execute'(exec, next): Promise<ToolExecutionResult>
// 只能改 exec.signal，call identity 不可变

'tools/post-execute'(exec, result, next): Promise<PostToolDecision>
// PostToolDecision =
//   {kind:'accept', content?: ContentBlock[], additionalContexts?: UserMessage[]}
// | {kind:'accept', value: JsonValue,      additionalContexts?: UserMessage[]}
// | {kind:'block',  feedback: ContentBlock[], additionalContexts?: UserMessage[]}
// ✅ additionalContexts 可注入上下文 → pi-lens 诊断回注走这里
// ✅ content 可替换工具输出 → rtk 输出压缩走这里
```

### 3.3 工具注册

```ts
ctx.tools.register(definition): () => void
// definition 必须带 output: { schema, render }，run_code 名字保留
```
用 `defineTool({name, description, parameters, output, execute})` 构造。

### 3.4 技能注册

```ts
ctx.skills.register(skill): () => void   // 注册进调用上下文的层；provider="runtime" 保留
ctx.skills.registerProvider(create): () => void
```
运行时技能需要 `content`（无 `path` → 无 resourceBase）。
frontmatter 必需 `name` + `description`；调用策略键：
`disable-model-invocation` / `user-invocable`。

### 3.5 命令注册

```ts
ctx.commands.register({name /* 小写无斜杠 */, description, input?: {hint}, recordInput?, handler})
```
**不会产生模型消息** → `/team-baseline` 这类纯展示命令用它；
`/review` 需要进模型 → 做成 user-invocable **skill**。

### 3.6 会话事件（audit-log 数据源）

```ts
'session/event'(session, event): void   // @mode emit
```
事件形状：`assistant/message {turn, step, message, stream, usage?, interrupted?}`、
`assistant/attempt {turn, step, stream}`、`tool/call {turn, step, callId, name, arguments}`、
`tool/result`、`turn/start`、`turn/end`、`compaction/start`、`compaction/end`。

### 3.7 bundle patch 机制

`package.json`：
```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```
`cordis.patch.yml`：
```yaml
- insert:
    - id: <row-id>
      name: <包名>
      config: {...}          # 可选
```
`!!js` 可用 `baseUrl` 指向包内文件（已由 `dsh-tauri-pet` 验证）：
```yaml
customSkillDirs:
  - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```
bundle 按 `dsh.profile.bundles` 顺序应用，profile 自己的 `cordis.patch.yml` 最后（用户覆盖层）。
`reconcilePlugins` 会自动把声明了 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`。

## 4. pi-lens —— **不是重写，是复用**（关键发现）

pi-lens 有一个独立的、非 MCP 的 CLI 入口，可直接 spawn：

**`node_modules/pi-lens/dist/mcp/analyze-cli.js`**

用法（已实测通过）：
```bash
node <pi-lens>/dist/mcp/analyze-cli.js --file=<path> [--cwd=<dir>] [--lsp] [--hook] [--turn-end]
```
- `--lsp`：启用 TypeScript LSP 类型检查（冷启动约数十秒，之后有缓存）
- `--hook`：输出 Claude Code PostToolUse JSON 信封
- 默认 `no-lsp`，走快跑器（tree-sitter 结构、ast-grep 安全、biome/ruff/oxlint、复杂度）
- **exit code 恒为 0**（advisory，不阻塞编辑）

实测输出：
```text
🔎 pi-lens: tsproj\a.ts — 1 blocking, 1 warning(s), 1 advisory(ies)
  🔴 L2 typescript:2322: Type 'number' is not assignable to type 'string'.
  ⚠ L2 typescript:6133: 'r' is declared but its value is never read.
  ⚠ L2 no-unused-vars: Variable 'r' is declared but never used. ... (no-unused-vars)
```

### 唯一宿主耦合

`dist/clients/deps/pi-tui.js` 里 `export {Text, truncateToWidth, visibleWidth} from "@earendil-works/pi-tui"`。
dsh 侧没有 `@earendil-works/pi-tui` → **需要随包带一个 stub**，6 行：

```js
export const visibleWidth = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
export const truncateToWidth = (s, w) => String(s).slice(0, w);
export class Text { constructor(t){ this.text = String(t); } toString(){ return this.text; } }
```
（已实测：加了 stub 后 `--lsp` 全链路跑通。）

### pi-lens 依赖（npm 上的 `pi-lens@4.2.1`，16 个包，已实测可装）
`@ast-grep/cli@^0.45`, `@ast-grep/napi@^0.45`, `js-yaml`, `minimatch`, `pidusage`, `vscode-jsonrpc@^9`, `web-tree-sitter`
→ **LSP 能力自带**（`vscode-jsonrpc` + 内部 `clients/lsp/*`），不需要 dsh 提供 LSP 基础设施。

### pi-lens 附带资产
- 4 个 skill：`pi-lens-ast-grep`、`pi-lens-lsp-navigation`、`pi-lens-write-ast-grep-rule`、`pi-lens-write-tree-sitter-rule`
- `rules/`：ast-grep-rules、tree-sitter-queries、typos、rule-catalog.json
- `grammars/` + `vendor/grammars`：13 个 tree-sitter wasm
- 本机语言服务器：只有 `rust-analyzer`；TypeScript 走内置 tsserver（pi-lens 自带）

## 5. rtk —— 能力边界

- 二进制：`C:/Users/Administrator/AppData/Roaming/npm/rtk.exe`（9.2MB），
  副本已在 `pi-workflow/tools/rtk.exe`
- 子命令：`ls tree read smart git gh glab aws psql pnpm err test json deps env find diff log dotnet docker kubectl oc summary grep rg init wget`
- pi 侧 rtk 的两种模式：`rewrite`（改 bash 命令）+ `outputCompaction`（压缩输出）
- **dsh 侧只能在 post-execute 改输出**：`{kind:'accept', content:[...]}` 可替换工具输出
- 参数重写不可行（types 明确排除）→ 用等价手段：post-execute 里改输出 + 插件自带 rtk 引导
- `rtk init -g` 的 shell hook 机制与 dsh 无关，**不要装**（会写坏用户 shell 配置）

## 6. pi-workflow 待移植清单

| 源文件 | 内容 | dsh 落点 |
|---|---|---|
| `team/RULES.md` | 63 行团队规范全文 | systemPrompt section，order 600 |
| `team/packages.json` | 9 个第三方包 pin | ❌ 不移植（pi 专属生态），改为 dsh 对应物 |
| `team/agent-settings.json` | provider/model/compaction/subagents 覆盖 | 映射到 dsh settings.yaml + preset |
| `team/models.template.json` | newapi 网关 provider 模板 | 移植为模板，仅缺失时补 |
| `team/extensions/audit-log.json` | `{enabled, maxFieldChars:2000, recordFullPrompt:false}` | 插件 Config |
| `team/extensions/context-thrift.json` | `{enabled, keepRecent:0, toolPruning{...}, toolOutputStub{...}, logStats}` | 插件 Config + 映射到 dsh 原生 compaction |
| `team/extensions/pi-rtk-optimizer.json` | `{enabled, mode:'rewrite', ...}` | 插件 Config（rewrite 降级为 output compaction） |
| `team/mcp.template.json` | MCP 模板 | ❌ 明确丢弃 |
| `skills/00-core/commit-convention` | 提交规范 | `skills/commit-convention/SKILL.md` |
| `skills/00-core/team-baseline-feedback` | 基线问题上报 | `skills/team-baseline-feedback/SKILL.md` |
| `skills/backend/api-review` | 接口审查 | `skills/api-review/SKILL.md` |
| `skills/frontend/ui-review` | 界面审查 | `skills/ui-review/SKILL.md` |
| `prompts/review.md` | `/review` 提示词 | user-invocable skill `skills/review/SKILL.md` |
| `extensions/team-baseline.ts` (1102 行) | RULES 注入 + 各种补装 + 自更新 | 只保留 RULES 注入；补装逻辑交给 CLI |
| `extensions/audit-log.ts` (807 行) | JSONL 审计日志 | 重写为 dsh 插件（session/event） |
| `extensions/context-thrift.ts` (448 行) | 上下文瘦身 | 映射到 dsh 原生 compaction + `/thrift` 命令 |

**pi 第三方包的 dsh 对应物**（不搬包，搬能力）：

| pi 包 | dsh 现状 |
|---|---|
| `pi-context-view` | dsh 原生 `dsh-token-meter` + client context-meter ✅ |
| `@juicesharp/rpiv-ask-user-question` | dsh 原生 `dsh-tool-ask-user` ✅ |
| `@juicesharp/rpiv-todo` | dsh 原生 `dsh-tool-todo` ✅ |
| `@ocodista/pi-token-bloat` | dsh 原生 `dsh-compaction-basic` + `dsh-compaction-tool-result-pruner` ✅ |
| `pi-subagents` | dsh `dsh-subagent` + `dsh-tool-subagent`，但**无具名角色** → 写进 preset 或改 RULES 措辞 |
| `git:DietrichGebert/ponytail@v4.10.0` | 纯 skill，直接搬 ✅ |
| `pi-simplify` | 待读 |
| `pi-rtk-optimizer` | 插件化（见 §5） |
| `pi-lens` | 复用 analyze-cli（见 §4） |

## 7. 已探明的其它 dsh 事实

- `skill-filesystem` 扫描根（rank 升序）：100 `<project>/.dsh/skills`、
  200 `<project>/.agents/skills`、300 `customSkillDirs`、400 `<dshHome>/skills`、
  500 `<agentsHome>/skills`（默认 `~/.agents`）、600 BUNDLED
- 格式：`<root>/<name>/SKILL.md`（**只扫一层**）或扁平 `<name>.md`
- `includeDefaultRoots` 默认 **true**
- `~/.dsh/AGENTS.md` 与项目 `AGENTS.md` 由 `dsh-agent-instructions` 加载，
  但在 tauri profile 里 **`disabled: true`**
- `~/.dsh` 现存：`.credentials.yaml` `.harness.pid` `.plugin-backups` `profiles`
  `sessions` `settings.yaml` `storages` `ungrouped` —— **无 AGENTS.md，无 `.agent-presets`**
- `~/.dsh/profiles/tauri/`：`cordis.patch.yml`(217B) `cordis.yml`(223B)
  `package.json`(2.0K) `pnpm-lock.yaml` `pnpm-workspace.yaml`
- module fallback：`PROFILE_MODULE_FALLBACK_DIR = ".dsh-module-fallback"`，
  `healProfilesModuleFallback()` 在宿主启动时惰性创建
- `dsh --profile tauri --dump-config` 可只读预览（exit 0）
- 预设根：`<dshHome>/.agent-presets/<id>/{preset.yml, agent.cordis.yml}`，
  id 规则 `/^[a-z0-9][a-z0-9-]*$/`，内置预设优先（用户无法覆盖 `standard`）
- **无 LSP 包**、**无 ast-grep 包**（dsh 侧）
- ⚠️ **不要按进程名杀 node**：`taskkill /IM node.exe /F` 会把宿主一起杀掉；
  清理一律按命令行特征过滤（见 §安全）

## 8. 下一步（阶段 A）

1. 搭包骨架：`package.json` / `cordis.patch.yml` / `lib/index.js`
2. 移植 `team/RULES.md`，用 systemPrompt order 600 注入
3. 移植 4 个 skill + `review` skill（扁平化目录）
4. `/team-baseline` 命令（纯展示）
5. **产出** `docs/HANDOFF-01-骨架与基线.md`

## 9. 安全红线（团队基线，移植后仍适用）

- 密钥 / token / 连接串不进仓库，用环境变量；`.env` 永不进 git
- 破坏性操作（删文件、强推、改 schema、drop 表）先确认
- **不要按进程名杀 node**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*<项目特征>*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
