# AI 雷达 · 候选台账

> 这份是**人写的**。日报在 `docs/radar/YYYY-MM-DD.md`（机器生成，每次覆盖），
> 判据在 `team/radar.json`，去重状态在 `seen.json`。
>
> 一条候选只有在这里出现过，才算「我们真的考虑过」。三个状态：
>
> | 状态 | 含义 | 谁改 |
> | --- | --- | --- |
> | `watch` | 看着，时机没到 | 人判 |
> | `adopted` | 已移植（**必须写 REQ 编号**） | 人，移植完才写 |
> | `ignored` | 判死不感兴趣（写一句为什么，免得三个月后又捡起来） | 人判 |

## 当前台账

| 项目 | 分 | 状态 | 理由 / 落点 |
| --- | --- | --- | --- |
| [ZSeven-W/dsh-game-studio](https://github.com/ZSeven-W/dsh-game-studio) | 99 | watch | 一句话生成可玩的小游戏并跑在 dsh 里。**情报价值 > 代码价值**：证明 dsh 的能力边界能撑完整 app。真要看的是它怎么组织 preset + 多轮工具调用。 |
| [RayJitan/dsh-ima-ragplugin](https://github.com/RayJitan/dsh-ima-ragplugin) | 94 | watch | dsh 插件形态做 RAG（知识库 ↔ 工具）。落点 `lib/index.js`：看它怎么把一个外部知识源包成 MCP 风格工具，再决定我们的 `ctx_search` 要不要学。 |
| [minorun365/unslop-ai-app](https://github.com/minorun365/unslop-ai-app) | 79 | watch | 日文项目，「别写出 AI 味」的 skill 写法。落点 `skills/`：只抄它的 skill 结构（触发词 + 反例 + 自检），不抄内容。 |
| [shanselman/sandbox-mcp](https://github.com/shanselman/sandbox-mcp) | 77 | watch | 给 agent 开一次性 Windows 机器跑测试。和我们的 `worktree_new` 是同一类问题的两种答案，值得对比：它用快照隔离，我们用 git 隔离。 |
| [FJNB5/fujiang-pojia](https://github.com/FJNB5/fujiang-pojia) | 82 | ignored | **无许可证**，禁抄。看一眼它的「激活词 → 行为覆盖」prompt 分层即可，代码不动。 |
| [imsai-sh/fish-pocket](https://github.com/imsai-sh/fish-pocket) | 72 | ignored | Swift 原生端，搬不进这个包。只记一条情报：dsh 已经有人做移动端壳。 |

## 怎么开一条

真要动手时，不要直接改代码：

1. 写 `docs/requirements/REQ-NNN-<主题>.md`（模板 `docs/requirements/TEMPLATE.md`），
   把「要做什么 / 不做什么 / 验收标准」写死；
2. 上面表里的状态改成 `adopted`，填 REQ 编号；
3. 走完 REQ 的四步（复述 → 调研 → 审计划 → 实现 → 审查）再提交。

## 已知误判（判据还在调，看到就当噪音）

- 描述里带 "context" 的 MCP server 会被误判成「上下文管理」，落点指向 `lib/mc.js`。规则已收紧到 `context window` / `context management` / `compaction`，仍会漏。
- `awesome-*` 合集类项目相关性虚高：它们的 README 里堆满了关键词。看到 `awesome` 前缀先降三分。

## 论文台账（2026-11-11 起）

论文不能「搬代码」，只能搬方法。所以这里的 `adopted` 指的是**方法已经落进代码**。

| 论文 | 分 | 状态 | 做法 / 落点 |
| --- | --- | --- | --- |
| [MaxIM: Maximally Informative Incremental Summarization](https://arxiv.org/abs/2611.12825) | 77 | **adopted** | 它把「有界记忆该留什么」定义成**预测未来任务目标的能力**。照这个直觉给 `lib/fold-core.js` 加了 `looksCritical()`：工具输出被首尾裁剪时，把中段的**失败行**（错误/异常/非零退出码/断言）单独捞到最前面。理由很硬 —— 压完只剩「看起来成功了」，下一步会照着错的结论走。 |
| [System Optimizations for Cost-Efficient Agent Harnesses](https://arxiv.org/abs/2611.12122) | 76 | watch | 结论值得记：harness 侧改动对**准确率**几乎无影响，对**成本**能差 2.6 倍。等于给我们现有的 rtk / fold / 节流做法提供了外部依据；它提的「按 trace 定位 token 累积点」我们还没做，值得单开一条 REQ。 |
| [MIRIX-2.0: Multi-Agent Memory System](https://arxiv.org/abs/2611.12068) | 71 | **adopted（①）/ watch（②）** | ① 检索**跑在显式预算下** → 已落进 `lib/session-recall.js` 的 `RECALL_MAX_CHARS`：原来只限条数（30），不限字节，一条 200KB 的工具输出就能把上下文打满；现在按条数**均分** 4 万字符预算，截断必留标记与 `seq=N`。② 合并重复锚点但不重写记录 —— 还没做。 |
| [Skillware: Modular Standard for Sovereign Agents](https://arxiv.org/abs/2611.07652) | 85 | watch | 把 skill 当可分发单元（带版本、权限、依赖声明）。我们 `skills/` 现在是裸 markdown 目录，值得看它怎么定边界。 |

### 2026-11-11 第二轮的判断（看过内容后）

| 条目 | 雷达分 | 我的判断 | 为什么 |
| --- | --- | --- | --- |
| [Boundary Mass in Feature Space](https://arxiv.org/abs/2611.11525) | 90 | **ignored** | 表征诊断，和 agent 工程无关。分数高是因为摘要里堆了 budget/representation 这类词 —— 判据的已知误判，已记在上面。 |
| [SkillCache](https://arxiv.org/abs/2611.10022) | 84 | watch | 「把一次成功调用编译成可重放的 capsule」确实省 token（论文报 81%），但**我们没有 skill 执行器**，我们的 skill 是给模型读的 markdown。要抄得先有执行层，那是 REQ 级。 |
| [Skillware](https://arxiv.org/abs/2611.07652) | 85 | ignored | 它的前提是「skill = 带类型契约的可执行包 + 单测」。我们的 `skills/` 连字段扩展都无处可放（dsh 的 skill loader 只认 name/description），加字段等于死配置。 |
| [Say Shibboleth](https://arxiv.org/abs/2611.12386) | 86 | watch | 从遥测指纹反推攻击方用的模型与 harness。和 `lib/redteam-brief.js` 有点关系，但那是打完之后的取证，不是我们现在缺的环节。 |
| [dsh-ima-ragplugin](https://github.com/RayJitan/dsh-ima-ragplugin) | 94 | watch | dsh 生态里第一个把外部知识库接成工具的插件。我们只有会话检索，没有外部语料 —— 值得读它怎么定义工具边界。 |
| [dsh-game-studio](https://github.com/ZSeven-W/dsh-game-studio) | 99 | 情报 | 一句话生成可玩 app，证明 dsh 的能力边界。代码与我们无关。 |
