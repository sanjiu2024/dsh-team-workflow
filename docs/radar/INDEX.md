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
