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
- 已同步到：`213345175f3c5aff1495e9df90e41bf08c8a42fe`（tag `v1.13.3`，2026-09-25）

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
