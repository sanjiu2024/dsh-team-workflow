# REQ-034 · 一键切换 Ralph 循环 / Workflow 编排模式

- **状态**：进行中
- **对应版本**：`2.18.0 → 2.19.0`（加能力 → minor）
- **提出**：2026-11-01，用户原话「添加新的功能，就是能一键切换ralph循环模式，和workflow模式」
  ＋追问后补充「点击按钮就可以切换，并且重切」「这两个是新模式」

---

## 1. 要做什么

把 `ralph` 和 `workflow` 做成**两个独立的 agent 预设**，不是提示词开关：

- **`ralph` 模式**：编排工具只有 `ralph`（一个目标反复迭代，每轮开一个干净子代理），
  预设里**没有** `tool-workflow`
- **`workflow` 模式**：编排工具只有 `workflow`（写 JS 脚本扇出多个子代理），
  预设里**没有** `tool-ralph`
- 两者都完整继承团队预设的其余能力（压缩阈值、子代理档位、红队工具、tool-result-pruner…）

三个入口，同一个后端动作：

1. **`/mode` 命令**：`/mode list` 看三个模式，`/mode ralph|workflow|team` 切过去
2. **工具箱面板两个按钮**：点一下就切（会话级，走 REQ-030 的换模式路径）
3. **`dsh-team preset install`**：一次生成三份预设产物

## 2. 不做什么

- **不做原地切换**。宿主 `AgentPresetRegistry.select()` 在会话开始后直接抛
  `agent-preset/locked`（`dsh-agent-preset-registry/lib/index.js:753-770`），
  preset 决定工具面与 persona，中途换会让同一份 transcript 的前后两半属于两套工具。
  沿用 REQ-030 已验证的「开新会话 + 交接预填 + 归档旧会话」路径，**不试图绕开宿主限制**。
- **不动 `team` 预设**。它仍是默认模式；两个新模式是并列的第三、第四个。
- **不把 `ralph` 塞进 `team`**。ralph 会常驻一个子代理循环，和 workflow 的编排语义冲突 ——
  这也正是要做成两个预设而不是一个开关的原因。
- **不做 UI 自定义编排**：按钮只是 `switchSessionPreset` 的薄封装，参数写死，不开任意入口。

## 3. 验收标准（每条都要能跑）

| # | 怎么验 |
| --- | --- |
| A1 | `dsh-team preset install` 后 `~/.dsh/team-workflow/preset-ralph/cordis.patch.yml` 与 `preset-workflow/cordis.patch.yml` 都存在 |
| A2 | 两份 YAML 的 preset `id:` 分别是 `ralph` / `workflow`，`preset-team` 那份仍是 `team` |
| A3 | ralph 的 YAML 含 `dsh-tool-ralph`、**不含** `dsh-tool-workflow`；workflow 反之（自检断言） |
| A4 | `/mode list` 列出 team / ralph / workflow 三个；`/mode ralph` 返回新会话 id 且交接文本已预填 |
| A5 | 工具箱面板出现「Ralph 循环」「Workflow 编排」两个按钮，点击返回 `ok: true`（无会话时给明确错误） |
| A6 | `npm test` 全绿 |

## 5. 已知约束（侦察结论，2026-11-01）

- 两个都是**工具**不是模式：`dsh-tool-ralph`（371 行，inject `workflowEngine`+`subagents`）、
  `dsh-tool-workflow`（442 行）
- 出厂 standard 预设里**有** `workflow-ptc` + `tool-workflow`，**没有** `tool-ralph`
- 一个 bundle 只能声明一个 preset（`package.json` 的 `dsh.bundle.patch` 指向单个 YAML）
  → 两个新模式各要一个 bundle 目录
- 工具箱 POST handler **拿不到 sessionId**，必须前端随 body 传
- 命令 handler 拿不到 agent ctx，`tools.restrict` 只在 agent 创建时可用 → 只能走换预设

## 6. 方案

1. `lib/preset-gen.js` 加 `MODE_PRESETS` 常量与 `generateModePreset(pristine, { mode, ... })`：
   先跑 `generateTeamPreset`，再把 `tool-workflow` 行换成 `tool-ralph`（或反向留空），
   最后改 preset 声明的 `id/name/description`
2. `bin/dsh-team.mjs`：`preset install` 写三份 bundle 并各自挂进 profile
3. `lib/commands.js`：`/mode` 命令 → `switchSessionPreset`
4. `lib/toolbox.js`：`mode.ralph` / `mode.workflow` 两个 op（`args: null`，自己调 switch）
5. `lib/client.js`：面板加两个按钮，body 带 `sessionId`
