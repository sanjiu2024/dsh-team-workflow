# REQ-031 · 把 purge 的移植方式改成更现代、更省 token

- **状态**：进行中（第一批已落地，其余待拍板）
- **对应版本**：`2.12.0` 起（分几批）
- **提出**：2026-10-31，用户原话「最好移植 dsh purge 的改为更现代的办法和更省 token 的办法」

---

## 1. 要做什么

REQ-028 是**照搬**（代码原样搬进来、补丁照打、提示词照注）。这一条要把搬运方式本身改掉：

- **更现代**：能用 dsh 插件 API（cordis 服务 / 系统提示段 / 工具注册 / 事件钩子 / 配置）做到的事，
  就不去打宿主 JS 的补丁；
- **更省 token**：每轮固定进上下文的东西，只留「不读就得错」的骨架，细节改按需加载（skill / 工具查询）。

## 2. 现状量化（2026-10-31 实测）

| 项 | 量 | 每轮代价 | 说明 |
| --- | --- | --- | --- |
| `team/RULES.md` | 12,484 字符 | ≈ 5.7k token | 团队基线，常驻 |
| `~/.dsh/prompt-inject.md`（purge 注入） | 21,803 字符 | ≈ 9.9k token | 破甲人格稿，常驻 |
| `team/REDTEAM.md`（本轮改造前） | 5,477 字符 | ≈ 2.5k token | 红队指挥稿，常驻 |
| 56 个 `redteam_*` 工具定义 | 49,046 字节描述 | ≈ 20k token | **最大头**，每轮随工具表发送 |
| 86 条宿主补丁 | 25 提示词 / 50 代码 / 8 工具 / 3 兼容 | —— | 宿主升级即碎 |

合计固定地板 ≈ **38k token**。

## 3. 第一批（已落地）

**红队指挥稿骨架化**（`team/REDTEAM.md` + `skills/redteam/brief.md`）：

- 常驻只留「不读全文也必须照做」的硬约束：环境前提、指挥职责、派活三铁律、六角色一句话、五阶段、红线；
- 完整稿（汇报口径、什么时候才汇报、预检与降级、报告要素、子代理回报核对）搬进技能 `redteam-brief`，
  模型在开演练前用 `skill` 工具读一次；
- 骨架 5,477 → 1,315 字符，**省 ≈ 1.9k token / 轮**；
- 骨架末尾明确指向技能名 —— 不指向的话模型不知道该去读（自检 `selftest-purge.mjs` 钉住这一点）。

## 4. 待拍板的三批（按性价比排序）

### A · 工具面按角色分层（省 ≈ 15k token / 轮，改动最大）

现状：`redteam-tools` 一行注册 56 个工具，主会话与五个执行角色**共用同一份**工具面。

问题：主会话真正要用的只有 12 个（`engagement_open` / `session_bind` / `session_info` /
`preflight` / `agent_slot` / `asset_query` / `vuln_query` / `sessions` / `score_list` /
`score_report` / `role_prompt` / `attack_chain`），其余 44 个是执行角色的活。

做法（dsh 的正道）：给 `lib/purge/redteam/tools.js` 加 `config.toolGroups`
（`core` / `all` / 角色名），再为五个角色各生成一份子预设（`redteam-recon` … `redteam-internal`），
`tool-subagent-*` 行用 `agentPreset` 指过去。

**代价**：派活方式要变 —— 现在是 `subagent` + 任务第一行 `redteamRole: <code>`；
分层后要按角色选不同的子代理工具（或让 `redteamRole` 决定 preset，需要宿主支持按参数切 preset，
目前不支持）。**这一条要先确认能接受派活方式变化，否则不做。**

### B · 破甲人格稿摘要化（省 ≈ 6k token / 轮，要用户点头）

`~/.dsh/prompt-inject.md` 21.8k 字符每轮全量注入。可改为「常驻 3k 摘要 + 全文作为技能按需读」。

**风险**：这是本机行为的核心设定（语气、边界、越狱后的人设）。摘要化必然改变模型的临场表现，
不是纯技术优化。**要用户明确同意再做**，且要能一键回退（配置项 `purge.promptMode: full|digest`）。

### C · 团队基线拆分（省 ≈ 3k token / 轮，中等风险）

`team/RULES.md` 12.5k 字符里，真正每轮必须遵守的（提交格式、审查分工、目录约定）约 4k；
其余（历史踩坑记录、为什么这么设计）是**人读**的。拆成 `team/RULES.md`（常驻骨架）+
`skills/team-rules/*.md`（细则）。

**风险**：团队规矩最容易「没读就违反」，拆错等于放开约束。要先逐节标注「必读 / 参考」。

### D · 25 条提示词补丁的插件化（不改 token，改可维护性）

86 条里 25 条 `layer=提示词`，改的是宿主提示词装配（identity / sections / 注入顺序）。
其中一部分能用 `systemPrompt.section` + `agent-instructions` 配置达到同样效果 —— 用插件 API 的版本
不会随宿主升级碎。**要先逐条读 patch 的 replacement 才能判定哪些可替代**，不能批量删。

## 5. 验收标准

- [x] 红队稿骨架化：`node scripts/selftest-purge.mjs` 断言「骨架 800–3200 字符 + 指向技能 + 技能含完整四节」
- [ ] A：主会话工具表只剩 core（`selftest-purge` 断言工具数 ≤ 15），五个角色预设各自只挂本职工具
- [ ] B：`purge.promptMode=digest` 时注入 ≤ 4k 字符，`full` 时行为与现在逐字一致
- [ ] C：`npm test` 全绿，且 `team/RULES.md` 骨架 ≤ 5k 字符
- [ ] D：每替掉一条补丁，`purge_status` 的 applied 数减一，且对应行为用自检钉住

## 6. 天花板

- 86 条补丁里「引擎级」那一批（审批 / 沙箱 / 围栏 / hooks）**没有插件 API 可替代** ——
  它们改的是宿主内部判定，只能继续打补丁。这部分的天花板写在 REQ-028 §7。
- 工具面分层做到极致也省不掉「主会话那 12 个工具」的定义（约 4k token）—— 那是调度必需。
