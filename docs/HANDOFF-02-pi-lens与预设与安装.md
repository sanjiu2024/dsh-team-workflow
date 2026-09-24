# 交接文档 02 — pi-lens 落地、预设、装进 tauri

> 承接 `docs/HANDOFF-01-骨架与基线.md`。本轮解决上一轮遗留的最大未决项（pi-lens 怎么落地），
> 并把预设生成和真实 profile 安装跑通。所有结论都是真跑出来的，命令和原始输出贴在下面。

## 本轮目标

1. 决定 pi-lens 的落地方式（上一轮卡在 `@earendil-works/pi-tui` 解析失败）
2. 让 `dsh-team lens install` 产出一个真正能跑的 vendor
3. 跑通 `dsh-team preset install`
4. 装进线上 `tauri` profile

## 结论先行

| 项 | 结论 |
| --- | --- |
| pi-lens 落地方案 | **vendor + 一个 40 行的 pi-tui 替身**，不放 resolve hook、不搬 pi-tui 本体 |
| vendor 体积 | 46MB（`@ast-grep/napi` 系列 7.4MB，其余是 pi-lens 本体） |
| `lens_check` 冷跑 | 已在**真实 dsh 会话**里验证通过 |
| 编辑后自动检查 | 已验证：`tools/post-execute` 注入成功，模型照警告改了代码 |
| 预设 | 已生成并做了静态自证；GUI 端到端需要重启 app |
| tauri 安装 | 已装（`link:` + bundles 追加），待重启生效 |

## 一、pi-lens 的 pi-tui 问题（上一轮的未决项）

### 症状

冷跑 `analyze-cli.js` 直接崩：

```text
pi-lens-analyze failed: Cannot find package '@earendil-works/pi-tui'
  imported from ...\pi-lens\dist\clients\deps\pi-tui.js
```

### 根因

`dist/clients/deps/pi-tui.js` 是**静态**再导出：

```js
export { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
```

静态导入在**模块求值**时就要解析，哪怕这三样只被 TUI 渲染路径用到。
所以"不用 TUI 就不会加载"是错的 —— 只要 `analyze-cli.js` 的依赖闭包走到这里就会炸。

### 试过但否掉的方案

| 方案 | 否掉的原因 |
| --- | --- |
| 把替身塞进 `~/.pi/agent/npm/node_modules/@earendil-works/pi-tui` | **污染 pi 自己的安装树**。pi 运行时真有这个包（`pi-coding-agent/node_modules` 下，v0.87.1），替身会把它遮住，pi 的 TUI 直接回归 |
| 搬 pi-tui 本体（3.2MB + `get-east-asian-width` + `marked`） | 为三个函数搬整棵运行时树，不划算 |
| `--import` resolve hook 映射裸标识符 | 多一个进程级入口要维护，而且 `spawn` 出去的 pi-lens 子进程还得单独传 hook |
| 加真依赖让 pnpm 去装 | 要求机器上有 registry 访问 + 会往 profile 里塞 30MB 依赖树，破坏"零依赖"这条线 |

### 采用方案

**替身放进 pi-lens 自己的 `node_modules`**：

```text
vendor/pi-lens/
  node_modules/
    @earendil-works/pi-tui/     ← 替身（index.js + package.json）
    @ast-grep/{napi,napi-win32-x64-msvc}
    js-yaml/ minimatch/ brace-expansion/ balanced-match/ pidusage/ vscode-jsonrpc/ web-tree-sitter/
```

关键点：**放在 pi-lens 的 `node_modules` 下，不是包根的 `node_modules`**。
Node 从 `dist/clients/deps/pi-tui.js` 往上逐级找 `node_modules`，先命中 pi-lens 自己那层；
放在外层会跑到 pi 的安装树附近，仍然有遮住真包的风险。

替身源码是 `tools/pi-tui-shim.js`，约 40 行，只实现：

- `visibleWidth(text)` —— 简化宽度，"码点 > 0x1100 算 2 列"
- `truncateToWidth(text, maxWidth, ellipsis)`
- `class Text { setText(); render() }`

替身的结果只进报告文本，不参与光标定位，所以宽度算法不用精确到 `get-east-asian-width` 的程度。

### 依赖树为什么必须一起拷

pi-lens 把 `@ast-grep/*` 声明成 **optional peer**：它从**自己**的 `node_modules` 往上找。
只拷 pi-lens 本体的话，`@ast-grep/napi` 仍然解析不到 —— 因为它不在 pi-lens 的祖先链上
（源码树里它们是兄弟目录）。

只拷 `napi` 和 `napi-win32-x64-msvc`，**不拷 `@ast-grep/cli`**：后者 99MB，
里面是两个 50MB 的 `ast-grep.exe` / `sg.exe`；analyze-cli 走的是 NAPI 绑定，用不到 CLI 二进制。

### 验证

冷跑一个故意写坏的文件：

```text
$ node tools/../vendor/pi-lens/dist/mcp/analyze-cli.js --file=bad.js --cwd=$D
🔎 pi-lens: bad.js — 0 blocking, 2 warning(s), 0 advisory(ies)
  ⚠ L1 no-unused-vars: Variable 'password' is declared but never used. ...
  ⚠ L3 no-unused-vars: Catch parameter 'e' is caught but never used. (no-unused-vars)
```

带 `--lsp` 也通（8 秒，起一次 TS LSP）：

```text
🔎 pi-lens: bad.js — 0 blocking, 2 warning(s), 1 advisory(ies)
  ⚠ L1 typescript:6133: 'password' is declared but its value is never read.
```

注意 `--lsp` 在没有 LSP server 的机器上会慢或超时 —— 所以 `installLens` 里 `--lsp` 默认关，
只统计不阻塞。

## 二、`lens install` / `lens check` 的行为

`bin/dsh-team.mjs`：

- `findLens()` —— 找**能直接跑**的 pi-lens，顺序 `vendor` → `~/.pi/agent/npm` → `~/.pi/npm`。给运行时和 `lens check` 用。
- `findLensSource()` —— 找**可拷贝**的源，**排除 vendor 自己**。给 `lens install` 用。

这两个分开是踩坑踩出来的：合成一个函数时，第二次执行 `lens install` 会把 `vendor/pi-lens`
当成源，先 `rmSync` 删掉、再想从已删的目录拷 —— `ENOENT`。

`lens install` 是幂等的（连跑两次结果一致）。`lens check [文件] [--lsp]` 真跑一次 analyze-cli，
`run()` 把子进程的 stdout/stderr 透传到终端，退出码非 0 就 fail。

## 三、真实 dsh 会话里的验证

### `lens_check` 工具

```text
$ dsh --profile team-verify "用 lens_check 工具检查 _lensprobe.js（不要加 lsp），把返回的报告原文贴出来。"

`lens_check`（未加 lsp）返回原文：

🔎 pi-lens: _lensprobe.js — 0 blocking, 2 warning(s), 0 advisory(ies)
  ⚠ L1 no-unused-vars: Variable 'secret' is declared but never used. ...
  ⚠ L3 no-unused-vars: Catch parameter 'e' is caught but never used. (no-unused-vars)
```

### 编辑后自动检查

让模型用 `write` 建一个带未使用变量的文件，审计日志里能看到：

```text
seq 17  tool_call      write
seq 18  tool_result    write
seq 23  user_message   source=plugin/team:lens
        「[pi-lens 自动检查]
        🔎 pi-lens: _autoprobe.js — 0 blocking, 1 warning(s), 0 ...」
seq 25  tool_call      edit          ← 模型照着警告改了代码
```

两条链路（工具 + 编辑后注入）都通了。

## 四、预设

`dsh-team preset install` 把 standard 预设拷到 `~/.dsh/.agent-presets/team/`，
按 `team/agent-settings.json` 的 `compaction` 改一行：

```yaml
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        thresholdRatio: 0.744      # 1 - 32768/128000
        retainRatio: 0.1563        # 20000/128000
        auto: true
```

### 补的坑

`team/agent-settings.json` 上一轮**漏拷了**，导致 `readTeamSettings()` 返回 `{}`、
compaction 补丁静默空转 —— 生成的预设和 standard 一模一样，还不报错。
现已补上（`team/agent-settings.json`）。

### 验证方式（重要：headless 验不了预设）

试过三种"动态验证"，全部无效，记录在此避免后人重走：

1. 把 `agent-presets.default` 改成不存在的 id → headless 照常回 "收到"（不报错）
2. 往预设 YAML 追加一个不存在的插件行 → 照常回 "收到"
3. 往预设 YAML 追加坏缩进 → 照常回 "收到"

原因（已定位到源码）：`dsh-agent-presets` 只在 **host 组合（`base.cordis.yml` + `web.cordis.yml` /
tauri）** 里；`--dump-config --profile headless` 里根本没有这个包，`headless` 模板也不含它。
所以 headless 跑的是空全局层，预设文件被完全忽略。

**换成静态自证**：把补丁块换回原文，必须逐字节等于 standard 的 `agent.cordis.yml`。
`cmdPresetInstall` 现在跑这个断言，输出：

```text
  自检：除 compaction 那一行外与 standard 逐字一致 ✓
```

GUI 侧的端到端确认需要重启 app —— 留待用户重启后看 `/team-baseline`。

## 五、装进 tauri

```text
$ node bin/dsh-team.mjs install --profile tauri
$ 写 C:\Users\Administrator\.dsh\profiles\tauri\package.json
$ dsh plugin --profile tauri install
✓ 已装进 profile "tauri"（...\tauri\node_modules\dsh-team-workflow）；重启 dsh 后生效
```

`--dump-config --profile tauri` 确认补丁层已合成：

```yaml
# == dsh-team-workflow
- id: dsh-team-workflow-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    providerName: dsh-team-workflow
    customSkillDirs:
      - !!js process.getBuiltinModule('node:url') .fileURLToPath(baseUrl + 'skills/')
- id: dsh-team-workflow
  name: dsh-team-workflow
```

**待办：重启桌面 app**（PID 32328），然后在空会话里确认：
`/team-baseline` 能列出规范、11 个技能出现在技能表里、`/thrift` `/audit-log` 在命令表里。

## 六、本轮改动清单

| 文件 | 改动 |
| --- | --- |
| `tools/pi-tui-shim.js` | 新增。pi-tui 替身（40 行） |
| `bin/dsh-team.mjs` | `lens install` 重写（拷依赖树 + 写替身）；新增 `lens check`；`findLens` / `findLensSource` 拆分；`patchCompactionRow` 返回块信息；`cmdPresetInstall` 加逐字自证 |
| `team/agent-settings.json` | 新增（补拷遗漏） |
| `README.md` | 依赖一节改写，说明 vendor / 替身 / 为什么 |
| `docs/HANDOFF-01-骨架与基线.md` | 修 lint（裸代码块加语言、表格分隔行） |
| `.gitignore` | 未变（`vendor/` 已忽略；`tools/pi-tui-shim.js` 随包提交） |

删掉的：`scripts/_depwalk.mjs`（一次性依赖遍历脚本）。

## 七、下一步

1. 重启 app，GUI 里确认预设 + 技能 + 命令
2. 建 GitHub 仓库 `sanjiu2024/dsh-team-workflow` 并推送（`vendor/` 不入库，README 已说明 `lens install`）
3. 看 `pi-simplify@0.2.3` 是否在移植范围内（还没读）
4. 按基线规范补一次 reviewer 审查

## 复现命令

```bash
cd "C:/Users/Administrator/Desktop/deepseek harness cj"
node scripts/selftest.mjs
node bin/dsh-team.mjs lens install
node bin/dsh-team.mjs lens check lib/util.js
node bin/dsh-team.mjs preset install
node bin/dsh-team.mjs install --profile tauri
```
