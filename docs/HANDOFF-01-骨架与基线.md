# 交接 01 —— 骨架、基线、真实 dsh 验证

对应阶段 **A（包骨架 + 团队规范注入 + 审计日志 + 节流统计 + CLI install）**。
上一份：`docs/HANDOFF-00-侦察.md`。

## 目标回顾

把 pi-workflow 的团队基线搬进 dsh，交付形态是**可安装的 dsh 插件包**：
`dsh.bundle.patch` + `cordis.patch.yml` + `lib/index.js` + `skills/`，
用 `dsh plugin --profile tauri install` 装进 profile。
不用 MCP，不碰用户 pi 安装树。

## 本阶段写完的文件

| 路径 | 作用 |
| --- | --- |
| `package.json` | 包元数据；`dsh.bundle.patch` 指向 `cordis.patch.yml`；**零 dependencies** |
| `cordis.patch.yml` | 两行 insert：`dsh-team-workflow-skills`（skill 目录行）+ `dsh-team-workflow`（插件行） |
| `lib/util.js` | 无依赖工具：路径、hash、截断、配置读取、**脱敏**（4 条规则 + 结构键） |
| `lib/baseline.js` | `ctx.systemPrompt.section({name:'team:baseline', order:600})` |
| `lib/audit.js` | `session/event` → jsonl，字段级 hash/预览，全局脱敏 |
| `lib/thrift.js` | token/缓存/压缩统计 + `/thrift` 命令的实现体 |
| `lib/rtk.js` | rtk 系统提示段（order 650）+ `tools/post-execute` 输出压缩 |
| `lib/lens.js` | pi-lens 冷跑分析 + `lens_check` 工具 |
| `lib/commands.js` | `/team-baseline`、`/thrift`、`/audit-log` |
| `lib/index.js` | `name` / `inject` / `apply()`，逐服务降级 |
| `bin/dsh-team.mjs` | CLI：`install` / `uninstall` / `status` / `skills` / `preset install` / `thrift apply` / `lens install` |
| `team/RULES.md` | 团队规范全文（中文，pi→dsh 改写） |
| `team/extensions/*.json` | 三个扩展的 dsh 扁平配置 |
| `skills/*/SKILL.md` | 11 个 skill |
| `scripts/selftest.mjs` | 无框架自检（假 ctx + 真事件形状） |

## 关键决策

### 1. `inject` 必须列全每个用到的服务

cordis 的 ctx 是 accessor 代理：读未声明的服务**抛异常**，不返回 `undefined`：

```text
Error: cannot get property "systemPrompt" without inject
```

`export const inject = ["commands", "systemPrompt", "tools", "sessions"];`
`apply()` 同步，缺哪个服务就在 apply 时降级跳过那一块。

### 2. `dsh plugin add <路径>` 在路径带空格时必然坏

`dsh.cmd` 是批处理，末尾 `"%NODE%" "%DSH_BIN%" %*`。`%*` 转发会重新解析，
Node 层的引号活不下来，pnpm 收到 `deepseek` / `harness` / `cj` 三个包名。

**做法**：CLI 直接写 profile 的 `package.json` ——
`dependencies["dsh-team-workflow"] = "link:<绝对路径>"`，
并把包名追加进 `dsh.profile.bundles`，再跑
`dsh plugin --profile <n> install`（不带参数）。
JSON 字符串值不过 shell，空格安全。**已实测**。

### 3. 真实事件形状是 `{type, seq, time, data}`

payload 全在 `event.data` 下。读 `event.turn` / `event.usage` / `event.arguments`
一律 `undefined` —— 这会静默产出 `toolName:null`、全零 usage。
`lib/audit.js` 和 `lib/thrift.js` 里统一 `const d = event.data ?? {}`。

踩到的几个形状：

- `tool/call.arguments` 是**原始 JSON 字符串**（模型产出的），要 `JSON.parse`
- `turn/end.reason` 是对象 `{kind:'completed'}`，不是字符串
- **token 计数互斥**：`inputTokens` 只是未命中部分，
  计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`
- `tool/result` 事件**不带工具名** —— 靠 `callId` 回查 `tool/call` 补
- `session.header` 是 `{version, id, createdAt, cwd, isSeeded}`（不是 `formatVersion`）

### 4. `lens_check` 的 schema 有两套不同规则

- `parameters`：标准 JSON Schema，`register()` **不编译**，裸对象原样给模型
- `output.schema`：走 `valueSchemaSpecToJsonSchema` → `allowRequired: false`，
  里面写 `required: true` 直接报 `unsupported JSON schema`

另外 `render` 的签名是 `(args, value)`，不是 `(value)`。

`PostToolDecision` 只有 `{kind:'accept'}` 和 `{kind:'block'}` —— **没有 `deny`**。
`UserMessage.source` 必须是对象：`{kind:'plugin', plugin:'team:lens'}`。

### 5. 其他

- `link:` 不装传递依赖 → 包本身零依赖是对的
- 审计日志的 `seq` 直接用 `event.seq`，能和 session 日志 join
- pi-lens 只走**冷跑 CLI**（`analyze-cli.js`），`--turn-end` 要连它自己常驻的 IPC，冷进程必然 skip
- ponytail 的 `description: >` 折叠块标量 dsh 能正常解析

## 验证结果（都是真实跑出来的）

```text
node scripts/selftest.mjs
  → ✓ 自检通过：系统提示段 / 命令 / 审计落盘与脱敏 / 节流统计 / 异常隔离

node bin/dsh-team.mjs install --profile team-verify
  → ✓ 已装进 profile "team-verify"
     （node_modules/dsh-team-workflow 软链已建）

dsh --profile team-verify "说 ok"          → ok（插件树干净加载）
dsh --profile team-verify "<pwsh 200 行>"
  → 完成

审计日志 C:/Users/Administrator/.dsh/storages/audit-log/<日期>.jsonl
  24 条记录，形状正确：
  system_message  chars 6630（= 系统提示全文含团队规范）
  tool_call       toolName "pwsh"，argsPreview 是命令原文
  tool_result     toolName "pwsh"，resultChars 6292
  assistant_usage input 4944 / cacheRead 3712 / output 2 / total 8658
  turn_end        reason "completed"，lastStopReason "stop"
```

## 已知未做

- `tools/` 之外的东西本轮没动；pi-lens 的 `vendor/` 还没铺
- `--lsp` 那条路在真实 dsh 里还没跑过（本机没 LSP server）
- 团队预设（`dsh-team preset install`）只实现了，没实跑

## 下一阶段（B）

1. 铺 `vendor/pi-lens`（拷贝 + 在 vendor 内塞 `@earendil-works/pi-tui` 桩），
   适配 pi-lens 的 4 个 skill 到 `lens_check`
2. 实跑 `dsh-team preset install`，验证 compaction / subagent 配置生效
3. 装进 live 的 `tauri` profile（用户已批准，需要重启 app）
4. 建 GitHub repo `sanjiu2024/dsh-team-workflow` 并推

## 复现命令

```bash
# 自检
node scripts/selftest.mjs

# 从零起一个干净 profile 验证
rm -rf ~/.dsh/profiles/team-verify
dsh --profile team-verify --from-default-profile headless "noop"
node bin/dsh-team.mjs install --profile team-verify
dsh --profile team-verify "说 ok"
ls ~/.dsh/storages/audit-log/

# 清场
rm -rf ~/.dsh/profiles/team-verify
```
