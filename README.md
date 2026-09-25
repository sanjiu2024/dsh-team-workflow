# dsh-team-workflow

把 [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow) 的团队基线搬进 **DeepSeek Harness (dsh)**。
一个 npm 包，装完提供：系统提示里的团队规范、审计日志、上下文节流统计、rtk 输出压缩、
pi-lens 静态检查、上下文超限时的自动会话交接、一个 `/review` skill 和 10 个技能。

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
dsh-team thrift apply                # 把 ~/.dsh/team-workflow/thrift.json 写进 team 预设（真生效的那两行）
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
| 会话交接 | `agent/error` + `sessionController` | 上下文超限且 dsh 自救失败时：写交接文档（未完成任务）→ 建新会话 → 把任务注入并开跑 → 旧会话留提示 |
| linux 命令 | `tools.register`（自己 spawn bash） | Windows 上也能跑 `sed`/`grep`/`find`/`awk` 等 linux 命令。`bash` 一次性、`bash_open`/`bash_send`/`bash_close` 持久会话（`cd`/变量/函数保留）。见「## linux 命令」 |
| 技能 | `skills/*/SKILL.md` | 复用 dsh 原生 skill 系统，含 `/review`（用户可调用） |

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

11 个自检，每个都用假 ctx 跑真实逻辑：系统提示段顺序、三个命令、审计落盘与脱敏、节流统计、
异常隔离、magic-context 折叠、thrift 阈值换算与预设生成、context7、lens 工具集、会话交接、
linux 命令工具。

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

## 来源与许可

MIT。

- 团队规范、审计日志、上下文节流、rtk 优化器的设计来自
  [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow)（团队内部项目）。
- `skills/ponytail*` 6 个技能原样取自
  [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) v4.10.0，
  MIT License, Copyright (c) 2026 DietrichGebert，许可证原文见 `skills/ponytail/LICENSE`。
- pi-lens 集成调用的是 [pi-lens](https://www.npmjs.com/package/pi-lens) 4.2.1 的
  `dist/mcp/analyze-cli.js`，未修改其代码。
