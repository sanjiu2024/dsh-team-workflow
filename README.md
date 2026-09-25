# dsh-team-workflow

把 [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow) 的团队基线搬进 **DeepSeek Harness (dsh)**。
一个 npm 包，装完提供：系统提示里的团队规范、审计日志、上下文节流统计、rtk 输出压缩、
pi-lens 静态检查、一个 `/review` skill 和 10 个技能。

不用 MCP —— 全部走 dsh 的 plugin / skill / command 三个原生面。

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
dsh-team thrift apply                # 把 ~/.dsh/team-workflow/thrift.json 写进 profile patch
dsh-team preset install              # 生成 team 预设（团队压缩阈值 + persona）
dsh-team patch                       # 思考链/工具行默认展开（改安装树，--restore 可还原）
dsh-team uninstall                   # 卸载
```

`--dry-run` 可以加在任何会写盘或调 dsh 的命令上。

## 装进来的东西

| 面 | 实现 | 说明 |
| --- | --- | --- |
| 团队规范 | `ctx.systemPrompt.section`，order 600 | 读 `team/RULES.md`，每次会话注入 |
| 审计日志 | `ctx.on('session/event')` | 落 `<DSH_HOME>/storages/audit-log/<日期>.jsonl`，逐行 JSON，凭证脱敏 |
| 上下文节流 | `session/event` 统计 + 配置 overlay | 压缩本体用 dsh 自带的 compaction / pruner，本包只统计和改阈值 |
| rtk | 系统提示段（order 650）+ `tools/post-execute` | 引导模型走 `rtk`，顺手压 shell 输出（去 ANSI、截头尾） |
| pi-lens | `tools/post-execute` 提示 + `lens_check` 工具 | spawn pi-lens 的 `analyze-cli.js` 做冷启动静态检查 |
| pi-lens 工具集 | `lens_tools` 一个入口工具，按需点亮 | 把 pi-lens 的 12 个代码情报工具（符号搜索、AST 检索/替换、LSP 跳转/引用/hover）接进来。**默认一个都不常驻**：声明体积是每次调用都重发的，全常驻等于地板涨 75%。模型先调 `lens_tools` 点亮，回合结束自动撤销 |
| context7 | `docs` 工具 | 查第三方库官方文档（免 key，直连 HTTP，不走 MCP）。一个工具内部完成「搜库 → 取文档」，因为多一次工具调用 = 多一整个 step，比多注册一个工具贵约 45 倍 |
| 命令 | `/team-baseline` `/thrift` `/audit-log` | `commands.register`，只回显给 UI，不进模型上下文 |
| 技能 | `skills/*/SKILL.md` | 复用 dsh 原生 skill 系统，含 `/review`（用户可调用） |

## 和 pi 版的差异（都是 dsh 的硬约束，不是偷懒）

- **上下文节流不重写消息。** pi 版在 LLM 调用前裁旧推理、精简工具声明、stub 旧工具输出。
  dsh 的 `llm/stream` 拿到的请求是深冻结的，只能替换回调结果、不能改 `options`；
  `tools/pre-execute` 的参数同样深度冻结。所以压缩交给 dsh 自带的
  `dsh-compaction-basic` 和 `dsh-compaction-tool-result-pruner`，本包只做统计 + overlay。
  `/thrift compact|prune` 写的是 overlay，要 `dsh-team thrift apply` + 重启才生效 —— 命令里会直说。
- **rtk 不改写命令参数。** pi 版把 `git status` 重写成 `rtk git status`；dsh 里参数冻结改不了。
  改成往系统提示里塞一段路由说明（跟 `rtk init -g` 装的那个 hook 起同样作用），
  外加 `tools/post-execute` 上的输出压缩。
- **不用管道的钩子。** pi 版 pi-lens 集成依赖 warm MCP IPC 和 Claude Code 的 hook 信封，
  dsh 里这两条都没有。改成冷启动 spawn `analyze-cli.js`，慢一点但能用。
  注意 `--turn-end` 需要 warm 连接，没用；`lsp_navigation` 之类需要 LSP server，
  没装 LSP server 的机器上就是死重量，所以没做。
- **`/review` 是 skill 不是命令。** dsh 的 `commands.register` 不产生模型消息，
  而 `/review` 要模型干活。

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
node scripts/selftest.mjs
```

假 ctx 跑一遍：系统提示段顺序、三个命令、审计落盘与脱敏、节流统计、异常隔离。

## 来源与许可

MIT。

- 团队规范、审计日志、上下文节流、rtk 优化器的设计来自
  [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow)（团队内部项目）。
- `skills/ponytail*` 6 个技能原样取自
  [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) v4.10.0，
  MIT License, Copyright (c) 2026 DietrichGebert，许可证原文见 `skills/ponytail/LICENSE`。
- pi-lens 集成调用的是 [pi-lens](https://www.npmjs.com/package/pi-lens) 4.2.1 的
  `dist/mcp/analyze-cli.js`，未修改其代码。
