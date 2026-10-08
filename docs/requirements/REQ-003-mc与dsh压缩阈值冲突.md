# REQ-003 · mc 与 dsh 压缩阈值互斥导致 mc 空转

> 状态：进行中
> 对应版本：`1.7.0 → 1.8.0`（加能力 minor）
> 提出：用户，2026-09-29。原话：「当我再次给ai发出指令的时候会概率触发 deepseek harness 自带的压缩，并且你这 magic context 也没有剔除上下文之类的」

---

## 1. 要做什么

- **让 magic-context（mc）真正干活**：它每轮都在评估、已经决定好要删哪些旧内容（实测队列里积压 **26 个 `drop` 操作**），但从没执行过一次。
- **让 dsh 自带压缩不再频繁触发**：实测今天 **83 次**，且"发一条指令就可能触发"。目标是让 mc 先动手、dsh 压缩退回应急兜底。
- 落地方式（用户选定）：**入库 + CLI 落地 + 自检锁不变式**。

## 2. 为什么（不做的后果）

两个机制现在**互相排斥，且赢的是笨的那个**：

- dsh 压缩是「把一段旧对话交给 LLM 摘要、整段替换」，粒度粗、每次都是一次完整 LLM 调用、压缩后地板仍有 ~70K。
- mc 是细粒度的：它按 tag 删除旧内容、按 P1–P4 生成分级 compartment、保留 history block 与 protected_tokens。

实测结果：

| 指标 | 实测值 | 说明 |
| --- | --- | --- |
| 今日 dsh 压缩次数 | **83 次** | 全部在 24.4%–25.2% 触发 |
| 压缩后地板 | **65–77K（13–15%）** | 不是 retainRatio 理论上的 25.6K |
| 每周期可用空间 | **~58K** | 128K − 70K 底座（**改前**的算例，即 0.25/128K 时代；§2 全节都是 2026-10-08 前的观测） |
| mc `shouldFire=true` | **0 次**（两个日志全时段） | 历史最高 usage 仅 25.4% |
| mc 排队未执行的 `drop` | **26 个** | `pending_ops` 表 |
| mc 产出过的 compartment | **2 个** | 机制能跑通，只是几乎不被触发 |

不做的话：**每 5–10 轮就吃一次压缩 LLM 调用 + 丢一段上下文**，而 mc 这个更省的机制永远闲着。

## 3. 不做什么

- **不改 mc 的 bundle**（`vendor/pi-magic-context`）——只通过它的配置面调阈值。
- **不做历史积压的自动清理**：那 26 个 `drop` 等阈值生效后由 mc 自己 drain，我们不直接写它的 sqlite。
- **不动 `retainRatio`（0.05）**：压缩后地板偏高是「不可压缩底座」决定的，不是 retainRatio 的问题（见 §5）。
- **不做「按会话动态调阈值」**：一次配好、全家统一，不引入运行时自适应。
- 不保证 mc 的 drop 一定能压住地板——**dsh 压缩仍是兜底**，mc 无效就退回现状（不是更糟）。
- 不改 mc 的 historian 模型配置（`~/.config/cortexkit/magic-context.jsonc` 里已有 `new-api/tier-std`）。

## 4. 验收标准

- [ ] `npm test` 全绿，`selftest.mjs` 新增**不变式断言**：mc 阈值 < dsh 阈值（单位统一换算后比较），反向验证（把 mc 调到高于 dsh）→ 红。
- [ ] 新增 CLI 子命令（`dsh-team mc show` / `dsh-team mc apply`）真跑：`mc apply` 后 `~/.config/cortexkit/magic-context.jsonc` 里出现 `execute_threshold_percentage`，且**原有键（historian.pi.model 等用户配置）不被覆盖**。
- [ ] 合并语义有测试：给一个含用户自定义键的 jsonc，apply 后用户键仍在（反向验证：把合并写坏 → 红）。
- [ ] 落地后实测：mc 的 `pending_ops` 从 26 开始下降、`shouldFire=true` 首次出现、**地板爬到多高才出现第一次压缩**（2026-10-08 起口径反转：改前是 ~14% 爬到 25% 就压，现在是爬到 65% 附近才有动作）（用 `~/.dsh/storages/audit-log` 与 `magic-context.log` 取数，写入 §8）。
- [ ] `package.json` 版本 = `CHANGELOG.md` 首节；README 增「与 magic-context 的阈值关系」说明。

## 5. 已知约束（侦察出来的硬事实）

| 约束 | 证据 | 影响 |
| --- | --- | --- |
| mc 执行门槛 = `execute_threshold_percentage`，默认 65，proactive floor = 65 − 2 = 63% | `vendor/pi-magic-context/dist/index-5tw61yhp.js:7863`；mc 日志 `proactive floor (63%)` | 阈值可配，范围 20–90 |
| mc 唯一配置文件 = `~/.config/cortexkit/magic-context.jsonc`（user scope，已存在） | bundle:2110 `CONFIG_FILE_BASENAME`；`:2125` `configHome()/cortexkit/` | CLI 要合并这个文件，不能整体覆盖 |
| 该文件现只有 `historian.pi.model`（用户配置），无阈值键 | 实测读取 | 必须**深合并**，否则丢掉用户配置 |
| mc 的 `pending_ops` 里 26 个 `drop` 从未 drain | `context.db` 的 `pending_ops` 表 | 阈值生效后应由 mc 自己排空 |
| mc 用 512K 做分母（自己的测量与 audit 地板一致） | mc 日志 `usage=16.3% (83325 tokens)` → 83325/512000 | 两个阈值可直接按百分比比较 |
| dsh 压缩阈值 = **358,400**（0.70 × 512000；2026-10-08 前是 128,000 = 0.25 × 512000） | `team/agent-settings.json` + `lib/preset-gen.js`；rc.x 预设 `~/.dsh/team-workflow/preset-team/cordis.patch.yml` | mc 阈值须低于 **70%** |
| 压缩后地板有 ~70K 不可压缩底座 | 实测：压缩后 65–77K（retainRatio 只保留 25.6K） | 抬高 dsh 阈值会更贵 —— **2026-10-08 仍改选了它**，代价已知并接受（§6 末） |
| mc `compartments` 已有 2 行 | `context.db` | mc 摘要链路能跑通 |
| mc 合并是**深合并 + 逐键回落默认值**（不是整文件替换） | bundle `mergeRawConfigs` `index-5tw61yhp.js:23001-23016`、zod `safeParse` `:23027` | 只写受管键不会丢用户设置 |
| mc 配置用 `jsonc-parser` 解析（支持尾逗号与注释） | bundle `:21354-21366` `{ allowTrailingComma: true, disallowComments: false }` | 就地文本改写必须保注释 |
| **`history_budget_tokens` 会随执行阈值等比缩小** | bundle `resolveHistoryBudgetTokensForPi`：`窗口 × (阈值/100) × history_budget_percentage`（`index.js:30153-30174`） | 降阈值会让 mc 注入历史的能力退化，必须配套补偿 |
| `protected_tokens` **不**随阈值变（用窗口几何的 usableSoft） | bundle `deriveDefaultProtectedTokens` `:8011-8016`；调用点传 `windowGeometry.usableSoft` | 近期内容保护不受降阈值影响 |
| mc 的 drain **不止「usage ≥ 阈值」一条路** | `isCacheBustingPass`/`hasReclaimRide`（`index.js:30860-30894`、`:17056-17058`）：还受 m0 hard fold、explicit flush、published history 触发 | 「达不到阈值」是主因但不是唯一因，§6 如实表述 |
| 紧急 drain 退出线 = `max(0, 阈值−10)` | bundle `EMERGENCY_DRAIN_EXIT_MARGIN = 10` `:10366` | 低阈值下该闩锁行为未实测（§7） |

## 6. 方案

### 调研结论（写这一节前派出的侦察，事实已回填 §5）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| mc 配置怎么合并？ | **逐键回落默认值**（zod schema `safeParse`），只写一个键不会丢其它设置 | bundle `23031-23035` |
| 支持注释吗？ | 支持，用 `jsonc-parser` | bundle `635`、`2021` |
| 改阈值要重启吗？ | **要** —— `execute_threshold_percentage` 不在 46 个实时重载键里 | `LIVE_RELOAD_CONFIG_PATHS`（bundle `7950`） |
| proactive floor 怎么来的？ | 固定 `max(0, 执行阈值 − 2)` | bundle `18173` `PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2`、`18213` |
| 阈值设低了会怎样？ | 低于 20% 被 schema 剪掉并回退默认 65%（fail-safe，不会静默变危险） | bundle `7863` min 20；`23100` 剪枝逻辑 |

### 落地

> **本节（§6）以下内容是 2026-09-29 的原方案（mc 20% / dsh 25%），已于 2026-10-08 被取代 ——
> 现行为 dsh 70%（358,400）/ mc 65%，见本节末「2026-10-08 修订」。留在这里是为了
> 记住当初为什么这么选、以及当时就知道的取舍。**

**mc 侧降到 20%**（主动线 18% = 92K），**dsh 保持 25%**（128K）作应急兜底。两个阈值之间留 5 个百分点（≈25K token）。

### 配套改动：history block 预算补偿（不是独立调优）

降阈值有个**副作用**：mc 的 history block 预算按 `窗口 × (执行阈值/100) × history_budget_percentage` 算，
阈值一降、默认的 0.15 会让**绝对预算跟着缩水**：

| | 计算 | tokens |
| --- | --- | --- |
| 改前（65%） | 512000 × 0.65 × 0.15 | 49,920 |
| 只降阈值不补偿（20%） | 512000 × 0.20 × 0.15 | **15,360（-69%）** |
| 补偿后（20% × 0.45） | 512000 × 0.20 × 0.45 | 46,080（≈改前的 92%） |

所以模板里同时写 `history_budget_percentage: 0.45`，让绝对预算保持同量级 ——
**降阈值是为了让 mc 先动手，不是为了砍它的历史预算**。自检断言这个补偿不能丢
（丢了会让预算退化到 3%）。注：这是**上限**不是实际注入量。

为什么选 20% 而不是更低：
- mc 的 schema 下限就是 20，再低会被剪掉回退 65%（等于没改）；
- 20% = 102K，此时 mc 已能用 `protected_tokens`（派生值 `clamp(round(0.05×usableSoft), min(16000, …), 64000)`）保住近期内容，不会把刚读的文件立刻删掉。

新增/改动：

| 文件 | 作用 |
| --- | --- |
| `team/mc-config.template.jsonc`（新） | 团队阈值模板（**现为 65% / history 0.15**；注释写的是「为什么这么选」，含 2026-10-08 撤销 20% 那套的理由），`mc apply` 的来源 |
| `lib/mc-config.js`（新） | 纯函数：JSONC 注释安全的顶层键定位与**就地**改写、阈值读取、不变式校验 |
| `bin/dsh-team.mjs` | 新增 `mc show`（并排显示两边阈值 + 判不变式）、`mc apply [--dry-run]`（就地写、写前校验、绝不整体覆盖用户配置） |
| `scripts/selftest-mc-config.mjs`（新） | 35 条断言：JSONC 扫描器（**防嵌套同名键**、防字符串/注释误判、转义引号、尾逗号、幂等）+ 阈值不变式 + **仓库自身两值自洽** |
| `team/agent-settings.json` | 那段解释注释里写着**错误的旧理由**（"压到同一量级"），一并改正 |

为什么不直接改 mc 的 bundle：那是 vendored 第三方代码，改了下次 `mc install` 就被覆盖；而且阈值本来就是 mc 的公开配置面。

为什么用文本级就地改写而不是 `JSON.parse` + 重写：用户配置里有解释性注释（说明 historian 为什么用 tier-std），整份重写会全丢；而 mc 的合并语义是逐键回落，我们只需要动一个键。

### 为什么不选另一条路（抬高 dsh 阈值到 72%）

用户已选此路。另一条（让 mc 在 63% 自然出手、dsh 抬到 72% 兜底）也自洽、且更贴合 mc 原设计（65% 是它的缓存安全线），但代价是地板平均要爬到 ~35%（≈180K）才有动作，cacheRead 约翻倍（当前 ~20% ≈ 100K）。REQ-001 以来的省 token 方向是压低地板，所以选 mc 提前动手。

### 2026-10-08 修订：用户改用「另一条路」（dsh 70% / mc 65%）

上线后用户在真机上提出：**「不要把上下文长度限制到 128k 就会压缩，这样不行」** —— 即明确选择
上面「不选的那条路」。已按此改：

| | 改前（REQ-003 原方案） | 改后 |
| --- | --- | --- |
| dsh `compactThresholdRatio` | 0.25（128K） | **0.7（358,400）** |
| mc `execute_threshold_percentage` | 20（主动线 18%，102K） | **65（主动线 63%，332,800）** |
| mc `history_budget_percentage` | 0.45（20% 的配套补偿） | **0.15（默认，补偿撤销）** |

不变式仍满足：mc 65% < dsh 70%，差 5 个百分点（≈26K token）。

**为什么是 70% 而不是更高**：两个上界 —— ① `scripts/selftest-preset-gen.mjs:318-323` 断言
阈值 ≤ 400,000（460,800 那次「阈值够不着、压缩永不触发」的回归）；② compaction-basic 的
`pressureBudget = 窗口 − 输出预留 − headroomTokens(65536)`（`dsh-compaction-basic/lib/index.js:130-132`），
`tier-max` 预留 64000 → 382,464。0.70 在两者之内，且三个档位算出的触发点一致。

**为什么不是本节标题里的 72%**：72% = 368,640，也在上面两条上界之内，所以不是「越不过去」。
取 70% 是为了让余量口径和原方案一致（mc 执行阈值 65% + 5 = dsh 70%），好记也好验；
72% 会把余量拉到 9 点（mc 主动线 63% 到 dsh 70% 已经隔了 7 点），没有额外好处。

**已知并接受的代价**：§6 末段当年否决这条路的理由就是成本 ——「地板平均要爬到 ~35%（≈180K）
才有动作，cacheRead 约翻倍」。现在阈值更高（mc 333K / dsh 358K），地板会爬得更高。
这是用户的明确选择，记录在此以免日后被当成 bug 回滚。

**配套撤销**：20% 时代的 `history_budget_percentage: 0.45` 失去意义（它存在的唯一目的是在
阈值被压到 20% 时把绝对预算拉回同量级）；模板改为**显式**写回默认 0.15 —— 必须显式写，因为
`mc apply` 只写模板里有的键，不写就会把上次 apply 的 0.45 留在用户配置里（预算变成 149,760）。

**生效条件**：dsh 阈值在预设里（`dsh-team preset install` 重新生成后**重启 dsh** 才生效）；
mc 阈值不在 mc 的实时重载名单里，同样要重启。§8 的首日观测口径随之改变：现在要观察的是
「地板能爬到多高才出现第一次压缩」以及 cacheRead 是否如预期上升。

## 7. 天花板（做完之后仍不支持的）

- **只调阈值，不改 mc 的算法**：mc 的 drop 策略、compartment 分级、protected_tokens 派生逻辑都保持原样。
- **不保证 mc 一定压得住地板**：mc 的删除是「按 tag 删旧内容」，遇到「整段都是必须保留的近期工作」时它也会保留。压不住时 **dsh 的 70%（358,400）仍然兜底** —— 最坏情况是 dsh 自己动手做整体摘要，不会更糟（但地板要先爬到 358K 才发生，这正是 §6 末记的代价）。
- **不做历史积压的定向清理**：那 26 个 `drop` 由 mc 自己 drain，我们不直接写它的 sqlite。
- **不自动 apply**：`mc apply` 要人手跑一次（它会改 `~/.config/` 下的用户文件，属于该让用户知情的操作）；插件加载时**不会**偷偷改。
- **改完要重启 dsh** 才生效（`execute_threshold_percentage` 不在 mc 的实时重载名单里）。
- **已作废（2026-10-08）**：~~`history_budget_percentage: 0.45` 是推导值、未实测~~ —— 0.45 是 20% 时代的配套补偿，阈值回到 65% 后已撤销回默认 0.15（§6 末）。该键现在就是 mc 的默认值，不再有「推导值未实测」的问题。
- **已作废（2026-10-08）**：~~低阈值下的紧急 drain 闩锁行为未验证~~ —— 那是 20% 阈值下的问题。现阈值为 65%，`emergencyDrainExitThreshold = max(0, 阈值−10)` = **55%**，与改前一致，无需再验。
- 本环境 mc 从未真正出手过（`compartments` 仅 2 行、`shouldFire=true` 0 次），**阈值生效后的实际压缩效果属首次验证** —— §8 记录首日观测值。

## 8. 验收记录

**2026-10-08 修订（全部真实运行）：**

- [x] 两处自检全绿
      → `node scripts/selftest-mc-config.mjs` → `✓ 自检通过：JSONC 就地改写（保注释/防嵌套/防尾逗号）/ 阈值不变式 / 仓库配置自洽`，EXIT=0
      → `node scripts/selftest-preset-gen.mjs` → `仅通过纯函数那几节（阈值/键名 + rc.x 生成器）✓`，EXIT=0
- [x] 全量测试全绿：`npm test` → 20 个套件全部通过，EXIT=0
- [x] 预设真的重新生成、新值真的写进去了（不是从配置推断的）
      → `dsh-team preset install --profile web` → `✓ 团队预设已就位：/home/sanjiu/.dsh/team-workflow/preset-team → profile "web"／已应用 5 处团队设置`
      → 回读生成物 `~/.dsh/team-workflow/preset-team/cordis.patch.yml:81-82`：`thresholdRatio: 0.7`、`retainRatio: 0.05`，同块 `auto: true`
- [x] mc 的用户配置真的改了
      → `dsh-team mc apply` → `execute_threshold_percentage：20 → 65`、`history_budget_percentage：0.45 → 0.15`（原件备份到 `magic-context.jsonc.bak`）
      → `dsh-team mc show` → `mc 65% < dsh 70%，余量 5 个百分点`、`history block 预算：0.15 → 约 49920 tokens`
- [x] 第 1 层审查 3 轮：首轮报 6 条（P1 两条 —— §5 表仍写 25%/128,000、§7 仍写「dsh 的 25% 兜底」；P2 四条 —— §5「故不选」、§7 两处 0.45/20% 的作废项、§8 判据写反、§8 缺本次记录）；第 2 轮复核再报 7 条（1 必须修 —— §4 验收标准里还有**第二份**写反的判据；6 条 P2 是措辞与指路牌）；第 3 轮闭环。全部已改。

**2026-09-29 实测（全部真实运行）：**

- [x] `npm test` 全绿，新增 `scripts/selftest-mc-config.mjs`（第 17 段）
      → `node scripts/selftest-mc-config.mjs` → `✓ 自检通过：JSONC 就地改写（保注释/防嵌套/防尾逗号）/ 阈值不变式 / 仓库配置自洽`，35 条断言全过
- [x] **不变式反向验证**：把模板阈值改成 30%（高于 dsh 的 25%）→ 红
      → `✗ 仓库：模板里的 mc 阈值与 agent-settings 的 dsh 阈值真满足不变式`
      `发出去的配置自相矛盾：mc 阈值(30%) 不低于 dsh 压缩阈值(25%)：dsh 会先动手，mc 排队的操作永远不执行`
      → 恢复 20% 后绿
- [x] `mc show` 真跑：改前正确报出「mc 未设置（默认 65%）、dsh 25%、现在 dsh 会先动手」
      → `node bin/dsh-team.mjs mc show`
- [x] `mc apply --dry-run` 真跑：报出将改哪个文件、值怎么变、其余键保持原样
- [x] **`mc apply` 真跑**：`~/.config/cortexkit/magic-context.jsonc` 写入 `"execute_threshold_percentage": 20`
      → 输出：`execute_threshold_percentage：未设置（默认 65） → 20`、`mc 主动线：18%  dsh 压缩阈值：25%`、提醒重启
- [x] **用户已有键与注释未被覆盖**（验收关键项）
      → apply 后实测：`"execute_threshold_percentage": 20,` 插在最前，`historian.pi.model = "new-api/tier-std"` 与全部解释注释**逐字保留**
- [x] `mc show` 复看：`✓ 阈值已拉开（mc 20% < dsh 25%，余量 5 个百分点）`
- [x] JSONC 扫描器边界：嵌套同名键不被误改、字符串/行注释/块注释里的同名内容不算键、转义引号不错位、空对象不产生尾逗号、重复 apply 幂等
- [x] 自查 mc 的真实行为（决定阈值该设多少）
      → mc 日志 `not firing at 16.3% — below proactive floor (63%)`；`shouldFire=true` 全时段 **0 次**；`context.db` 的 `pending_ops` **26 个 drop 未执行**、`compartments` 仅 2 行
- [x] **history 预算补偿真生效**：模板含 `history_budget_percentage: 0.45`，`mc apply` 真写进用户配置
      → `mc show` 输出：`history block 预算：0.45 → 约 46080 tokens（改前 65%×0.15 ≈ 49920）`
- [x] 补偿键也在受管列表里（CLI 真会写它）
      → 实测把用户配置改回 0.15 → `mc apply` 报 `history_budget_percentage：0.15 → 0.45` 并写入成功
- [x] 自检覆盖补偿不能丢：删掉模板里的 `history_budget_percentage` → 断言「模板要有 history_budget_percentage」红
- [x] 多键一起写：注释与用户键保留、幂等、不写 `undefined`
- [x] 确认配置文件位置与合并语义（决定能否只写一个键）
      → bundle `CONFIG_FILE_BASENAME = "magic-context"`、`configHome()/cortexkit/`；zod `safeParse` 逐键回落默认值

**三层审查报出并修掉的问题（都是真缺陷，逐条已加自检）：**

- [x] **P0（第 1 层）**：文件不存在时 `before` 取的是模板（值已是目标值）→ 计划恒空 →
      报「已是目标值」但**文件根本没创建**，mc 仍跑默认 65%。新成员跑 apply 看到 ✓ 却什么都没发生。
      修：文件不存在时一律计入计划（`planMcApply`，CLI 与自检共用）；现在真创建文件（实测）。
- [x] **P1（第 3 层）**：插入点用 `indexOf("{")`，不校验根 → 数组根 / 注释里含 `{` 时会
      **静默写出坏 JSON 并报成功**。修：`rootObjectStart()` 用扫描器跳过空白/注释/BOM 后校验根必须是 `{`；
      拒绝空文件、纯注释、数组根。
- [x] **P1（第 1 层 + 第 3 层）**：`scanValue` 字面量分支的分隔符集不含 `/` → `20 /* 为何 */` 的
      区间吞掉注释，读值变 NaN（误报未设置）、写入时**删掉用户的注释**。修：分隔符集加 `/`、`[`。
- [x] **P2（第 1 层）**：重复键只改第一个，而 JSON 取**最后**一个 → 「改了但没生效」。修：读取最后一个；
      写时**所有**出现处都改（从后往前替换，偏移不失效）。
- [x] **P2（第 1 层）**：`Number("") === 0` → 空值（`"k":` / `"k": ""`）被读成 0，误报「已设置 0%」。修：空值先返 null。
- [x] **P2（第 3 层）**：无备份。修：首次真写前把原件复制到 `.bak`（只在不存在时建，保留**最初**那版）；实测备份内容是原件 65 而不是新值。
- [x] **P2（第 3 层）**：`mkdirSync/writeFileSync` 无 try/catch，磁盘满/无权限时裸栈。修：包 try/catch 走 `fail()` 并提示备份位置。
- [x] **P1（第 2 层）**：`dshCompactionPct()` 只读团队默认，**忽略 `/thrift compact` 写的 overlay** →
      成员覆盖过阈值后，`mc show` 显示、`mc apply` 校验的 25% 与真实生效值脱节，可静默复现 mc 空转。
      修：改为调用 preset-gen 的 `resolveThriftConfig`（overlay > 团队默认 > 推导），与 `preset install`/`thrift apply` 同一优先序、同一份代码。
- [x] **P2（第 2 层）**：`mc show` 里 `window = 512000` 硬编码。修：读团队设置的 `compaction.contextWindow`。
- [x] **P2（第 2 层）**：REQ 写「19 条断言」与实际不符。修：按实测改为 35 条。

**顺带修掉的两个自检脆弱点（都不是产品 bug，但会让自检假红）：**

- `fakehuman`（自检专用的人事件模拟）原用**相对位移**，会受 Windows 指针加速影响 ——
  同一个 `dy` 连续调用走出的距离不同。改为绝对坐标（`mouse_event` 的 `dwExtraInfo` 恒为 0，
  仍是合格的「人」事件）。
- 「AI 没被拦」原用「blocked 计数不变」断言，会被偶发的人事件噪声弄成假红
  （实测跑出过 `blocked 221 → 229`，而机制是对的）。改为守护进程新报的 **`injected` 计数**
  （带 MAGIC 标记、被放行的事件数）上升 —— 免疫人的活动。修后连跑 4 次全绿。

**首日效果观测（重启后填）**：

- [ ] 重启 dsh 后，mc 日志出现 `shouldFire=true`（阈值生效的第一个证据）
- [ ] `pending_ops` 从 26 开始下降（mc 真在 drain 积压的 drop）
- [ ] 当日 dsh 压缩次数显著低于改前的 83 次
- [ ] 地板**爬到多高**才出现第一次压缩（改前是 ~14% 爬到 25% 就压；现在预期到 333K/65% 附近才有动作）
- [ ] cacheRead 是否如预期上升 —— 这是这条路的**代价**（§6 末），要看到它才能确认代价的量级
