# 上游同步基线 · pi-workflow

本仓库是 [pi-workflow](https://github.com/kurumi1ksllq/pi-workflow) 的 dsh 移植。

**这份文件是定时任务的状态文件。** `上游同步（pi-workflow）` 每 48 小时跑一次，
先读下面「已同步基线」拿到上次同步到哪，再比对上游算出「这次新出来什么」，
把能落地的搬进来，最后把基线改成本次已处理的上游 commit。

没有这份基线，任务每次都只能看到上游的全部内容，无法回答「这次新增了什么」，
会把同样的东西反复搬。契约见 `docs/AUTOMATIONS.md`。

## 已同步基线

- 上游仓库：`https://github.com/kurumi1ksllq/pi-workflow`
- 分支：`main`
- 已同步到：`fe323b0ee136c563a66593e9d5d355372fe8ef03`（v1.14.1，2026-09-29）

下次比对范围就是 `<上面这个 SHA>..origin/main`。

## 怎么判断一条上游更新能不能落地

上游是 **pi** 的扩展生态，本仓库是 **dsh** 的插件包，两条腿不一样。三条例不适用：

1. **pi 的扩展 API 不存在**。pi 扩展能拦截并改「即将发给模型的请求」（裁历史推理、
   精简工具声明、stub 旧工具输出）；dsh 的 `llm/stream` 拿到的请求是**深度冻结**的，
   只能替换回调结果，改不了 `options`。凡是靠「改请求体」实现的更新，一律落不了地。
2. **pi 专属包不搬**。`pi-subagents` / `@juarshar/*` / `git:DietrichGebert/*` 这类是 pi 的
   包生态，dsh 有原生对应物（见 `docs/HANDOFF-00-侦察.md` 第 6 节的对照表），只搬能力不搬包。
3. **pi 的事件形状不同**。上游针对 pi 某版本事件字段的兼容修复（如 `context` 事件不再含
   system 消息），dsh 侧的事件源不是同一个，通常没有对应问题 —— 要单独确认再动手。

能落地的典型是**规范文本、判据、skill 措辞、阈值与默认值**这类不含 pi API 的部分。

## 对照表（上游 → 本地）

| 上游文件 | 本地落点 | 说明 |
| --- | --- | --- |
| `team/RULES.md` | `team/RULES.md` | 团队规范正文，直接对应 |
| `team/agent-settings.json` | `team/agent-settings.json` | 模型档位与压缩阈值 |
| `team/extensions/audit-log.json` | `team/extensions/audit-log.json` + `lib/audit.js` | 审计日志配置与实现 |
| `team/extensions/context-thrift.json` | `team/extensions/context-thrift.json` | 只剩阈值；裁剪本体在 dsh 原生 compaction |
| `team/extensions/pi-rtk-optimizer.json` | `team/extensions/rtk.json` | rtk 输出压缩 |
| `skills/00-core/*` | `skills/*/SKILL.md` | 技能文本 |
| `team/models.template.json` | `team/models.template.json` | 网关 provider 模板 |

## 处理记录

### v1.13.1 → v1.13.3（2026-09-25）

上游范围 3 个提交（`a6da3d8` → `2133451`）：

| 上游变更 | 判断 | 处理 |
| --- | --- | --- |
| `team/RULES.md`：新增「`oracle` 只用于方案拿不准」成本纪律 | ✅ 适用 | **已移植**到 `team/RULES.md`，按我们的档位名改写成 `tier-max` |
| `team/extensions/context-thrift.json`：第二层工具声明裁剪改为默认开 | ❌ 不适用 | 该能力靠「改请求体」实现，dsh 深冻结改不了 |
| `package.json` / `team/packages.json`：`pi-subagents` 升 0.71.0 | ❌ 不适用 | pi 专属包 |
| `extensions/audit-log.ts`：修 pi 0.87 `context` 事件 `sections` 恒 null | ❌ 不适用 | pi 事件形状问题，dsh 事件源不同 |
| `scripts/test-extension.mjs` / `test-audit-extension.mjs`：补断言 | ❌ 不适用 | 护的是 pi 扩展契约 |
| `ONBOARDING.md` / `README.md` / `docs/audit-log.md` | ❌ 不适用 | pi 安装说明 |

结论：**只有一条能落地，已移植**；其余属于 pi 生态，记在这里备查，不再重复评估。

### v1.13.3 → v1.13.5（2026-09-26）

上游范围 4 个提交（`2133451` → `d435961`）：

| 上游变更 | 判断 | 处理 |
| --- | --- | --- |
| `team/RULES.md`：新增「review 只跑一次」 | ❌ 不搬 | 与本地三层审查「修完重跑该层（同一层最多 3 轮）」的**有意设计**冲突；是否改策略属团队决策，不由同步任务代做 |
| `team/RULES.md`：新增「派 reviewer 必须给边界」（范围/禁止项/输出上限/timeoutMs） | ✅ 半搬 | **已移植**前三件到「### 每层怎么派」（审查范围、禁止项、结论 ≤300 字输出上限 + 派单模板同步收紧）。`timeoutMs ≤ 600000` 落不了地：dsh 的 `subagent` 工具没有该参数（`dsh-subagent/lib` 全包无 timeout 字段），已改写为「控轮数靠前三件事」 |
| `scripts/test-extension.mjs`：补断言护住新纪律段 | ✅ 换形落地 | 护的是 pi 扩展本体，不适用；按同样做法在 `scripts/selftest.mjs` 补了对新纪律段的断言 |
| `team/models.template.json`：档位窗口 → 512k/256k + `_contextWindow` 解释键 | ❌ 不搬 | 512k 是**上游网关**（`xn--7ov1ng90a.top`）按 512k 切的事实；本地网关是另一个（`38.76.221.190:3000`），无证据同样切 512k，照搬就是把没核实的事实写进文档 |
| `team/agent-settings.json` / `templates/project-settings.json`：`reserveTokens` 32768 → 65536 | ❌ 不搬 | 依据是 pi 的 `shouldCompact`（触发点 = 窗口 − reserve，须容下 tier-max 64k 输出）。本地压缩已 dsh 化：12800/25600 → 0.9 兜底阈值（由 `lib/preset-gen.js` 消费，historian 在 65% 主力折叠），照搬反而破坏本地设计 |
| `extensions/team-baseline.ts`：存量迁移（窗口/reserve）+ healthCheck 跨文件对账 | ❌ 不搬 | pi 扩展代码（改成员 `~/.pi` 文件）；dsh 侧模板不落盘到成员机器，「团队改模板推不到老成员」这个问题不存在 |
| 附带实测结论：`disableThinking` 不是速效药；reviewer 换 `tier-std` A/B 三轮结论「不换」（异模型审查价值高于速度） | ✅ 无需改码 | 反向确认了本地选档表（审查型 = `tier-power`）；结论记此备查 |

【2026-10-08 后续】上面「review 只跑一次」不搬的理由引的是**当时**的三层审查（「修完重跑该层」）。
审查策略当天改版成两层：**std 测**（带工具）仍**每完成一块**跑，**power 判**（无工具、材料靠主
agent 贴）只在**重大变化 / 写完一个大部分**时派。增量低门槛审查这条设计没变，所以不搬的结论
**仍然成立**，只是理由要按新节名读：「## 审查（两层：std 测，power 判）」。
| `package.json` / `ONBOARDING.md` / `README.md` / `CHANGELOG.md` | ❌ 不适用 | 上游发版说明 |
| `.gitignore`：本地交接文档不进公开仓库 | ❌ 不适用 | 本地相反：HANDOFF 文档是仓库的一部分且被 `UPSTREAM-SYNC.md` 引用 |

结论：**一条能力落地**（审查边界纪律，适配后移植 + 自检断言），版本 1.1.1 → 1.2.0。

### v1.13.5 → v1.14.0（2026-09-26）

上游范围 2 个提交（`d435961` → `e3273db`），主题是 `/audit` 斜杠命令（pi 里一键生成审计报表落盘）：

| 上游变更 | 判断 | 处理 |
| --- | --- | --- |
| `extensions/team-baseline.ts`：新增 `/audit` 命令（探测 python → 跑报表脚本 → 落盘用户目录，参数指纹命名） | ❌ 不搬 | pi 扩展代码（`pi.registerCommand` + `ctx.ui.notify`）；dsh 命令桥只回显不产模型消息，落地得另写一套 dsh 报表命令 —— 是新开发不是同步 |
| `scripts/pi_audit_report.py`（+566 行）：「按模型」别名归并、子代理归因覆盖率、无数据提示透出 | ❌ 不搬 | 解析 pi 审计日志格式的 Python 管线；本地报表是另一条已过审查的 dsh 管线（`scripts/usage-report.mjs`，已自带归因断链分析），照搬等于重写已审查脚本 |
| `scripts/test-audit-command.mjs` / `test-model-alias.py` / `probe-audit-command.mjs` / `simulate-member.sh`：/audit 的测试、探针与成员模拟 | ❌ 不适用 | 护的是 pi 扩展契约 |
| `CHANGELOG.md` / `ONBOARDING.md` / `README.md` / `docs/audit-report.md` / `package.json`（→ 1.14.0） | ❌ 不适用 | 上游发版说明 |

结论：**无可搬条目**，只更新基线（本仓库无能力变更，版本号与 CHANGELOG 不动）。

### v1.14.0 → v1.14.1（2026-09-29）

上游范围 1 个提交（`e3273db` → `fe323b0`），主题是把 reviewer 的触发时机从「每次实现完成后」改成「整个任务收尾时」：

| 上游变更 | 判断 | 处理 |
| --- | --- | --- |
| `team/RULES.md`：「review 只跑一次」扩成「只跑一次，且只在收尾时跑」（多步任务不每步 review，中途自查） | ❌ 不搬 | 与本地三层审查「**每完成一部分** → 跑第 1 层」（`team/RULES.md:307`）的有意设计**同一方向**的冲突 —— 本地分层的意义就是增量低门槛审查，v1.13.5 那轮已对「review 只跑一次」做过同样的不搬判定；是否改审查策略属团队决策，不由同步任务代做 |
| `scripts/test-extension.mjs`：+6 行断言护住上面的新措辞 | ❌ 不适用 | 护的是 pi 注入段里不搬的纪律，纪律不搬断言随之不搬 |
| `CHANGELOG.md` / `ONBOARDING.md` / `README.md` / `package.json`（→ 1.14.1） | ❌ 不适用 | 上游发版说明与安装文档 |

【2026-10-08 后续】同上一节：新策略把**贵的那一边**（power 判）挪到了「重大变化 / 写完一个
大部分」，方向与上游「只在收尾时跑」接近了一半 —— 但 std 测仍每块跑，所以「多步任务不每步
review」这条**仍不搬**。下次同步遇到这条时以 `team/RULES.md` 的现行节为准，别照这段旧理由复述。

结论：**无可搬条目**，只更新基线（本仓库无能力变更，版本号与 CHANGELOG 不动）。
