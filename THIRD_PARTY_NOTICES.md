# Third-party notices

本仓库主体是 MIT（见 [`README.md`](./README.md) 的「来源与许可」）。本文件记录
**不是**本仓库独立编写的部分：来源、许可、以及改了哪里。

维护规则：只增删改对应小节；`## 保留的上游 NOTICE` 与许可证原文不得改写。

---

## 定时任务调度器（`lib/scheduler.js`、`lib/scheduler-client.js`）

### 直接来源：`dsh-tauri-scheduler`

- 仓库：<https://github.com/dsh-tauri/deepseek-harness-desktop>，`packages/dsh-tauri-scheduler`
- 取用版本：`main` 分支，2026-10
- 许可：MIT（<https://github.com/dsh-tauri/deepseek-harness-desktop/blob/main/LICENSE>）
- **附加条款**：同仓库根目录 `LICENSE.details` 声明了「禁止商用二次开发」，
  并写明与 MIT 冲突时附加条款优先。原文：

  > **No Commercial Secondary Development**: The Software may not be used for
  > secondary development (including but not limited to modification, adaptation,
  > or derivation) for commercial gain, monetary compensation, or as part of a
  > paid commercial product or service. Direct use of the Software itself for
  > commercial purposes remains permitted.

  本仓库的调度器是它的**衍生作品**（derivation）。因此这一条随链条继承：
  内部使用无碍，若要进商业产品或服务，这一点需要先与权利人确认。此处仅陈述
  所读到的条款原文，不构成法律意见。

### 间接来源：`MichengAI/dsh-automation`

- 仓库：<https://github.com/MichengAI/dsh-automation>
- 版本：`0.1.42`，revision `e75499e55d0b8bfe85e04ba5a579080b54edff56`
- 采纳基线：`f1bc91a3437f0b952631a46a8363089587b9ae6a`（`v0.1.32`）
- 许可：**Apache-2.0** — Copyright 2026 MichengAI contributors
- 许可证原文：[`licenses/Apache-2.0.txt`](./licenses/Apache-2.0.txt)

关系是**间接的**：`dsh-tauri-scheduler` 自己的
[`THIRD_PARTY_NOTICES.md`](https://github.com/dsh-tauri/deepseek-harness-desktop/blob/main/packages/dsh-tauri-scheduler/THIRD_PARTY_NOTICES.md)
声明，下列文件改编自该上游 ——

- `src/host/service/executor.ts`（→ 本仓库执行器）
- `src/host/service/options.ts`（→ 本仓库 `listOptions`）
- `src/host/service/permission-presets.ts`（→ 本仓库 `PERMISSION_PRESETS`）
- `src/host/types/index.ts`（→ 本仓库任务/运行记录字段与默认值）
- 若干 `src/client/components/*`（→ 本仓库面板）

而本仓库的移植又以那些文件为蓝本，所以 Apache-2.0 的义务沿这条链继承过来。

### 保留的上游 NOTICE

原文照录（`dsh-tauri-scheduler` 从其上游继承，本仓库继续保留）：

```text
dsh-automation
Copyright 2026 MichengAI contributors

本项目的 TypeScript 源码、构建脚本与项目文档采用 Apache License 2.0。

产品模型参考了 DeepSeek Harness 社区中的独立自动化实践：
- 独立 Session 调度与审计历史 (titanwings/dsh-automation，MIT)

上述参考实现的许可证与版权仍归其原作者所有；本仓库实现为独立编写，不复制其专有代码。
```

### 修改声明（Apache-2.0 §4(b) 要求）

本仓库做的是**重写级移植**，不是逐行翻译。承接自上述来源的文件：

`lib/scheduler.js`、`lib/scheduler-client.js`、`scripts/selftest-scheduler.mjs`、
`team/extensions/scheduler.json`、`docs/requirements/REQ-007-定时任务调度器.md`

主要修改（完整设计见 REQ-007）：

| 方面 | 来源 | 本仓库 |
| --- | --- | --- |
| 语言与构建 | TypeScript + tsdown | 纯 ESM，无 TypeScript、无构建步骤 |
| SDK 宏 | `defineService` / `defineRoutes` / `defineStore` / `definePanel`（`dsh-tauri` 工作区私有） | 按 cordis 插件契约重写 |
| 依赖 | `cron-schedule`、`lodash-es`、`pathe`、`unstorage` | **零依赖**，计划计算与存储自行实现 |
| 客户端面板 | React TSX + `dsh-tauri-ui` + cssr + i18n | 手写 classic script，只用 `react` |
| 存储 | `unstorage` + `fsAtomicDriver`，落在 `<DSH_HOME>/crons/` | 两个 JSON 文件 + 写队列，落在 `<DSH_HOME>/team-workflow/scheduler/`（**不迁移旧数据**） |
| 安装形态 | 桌面版内置插件 | **可选扩展**，默认关闭 |
| 信任边界 | 无（桌面版进程内） | 路由回环栅栏 + `maxPermission` 天花板 + 沙箱/审批正向回读 |

面板与面板交互是有意做的子集：未包含 prefill 桥、模型选择控件、推荐任务、
会话图标、i18n、拖拽排序。宿主侧 `provider` / `model` / `reasoningEffort`
参数仍完整支持。

---

## 相邻但**未使用**的实现

- [`@deepseek-ai/dsh-schedule`](https://www.npmjs.com/package/@deepseek-ai/dsh-schedule) ——
  官方自带定时提醒。**没有使用、也没有参考其代码**：它的语义是把提醒作为
  follow-up 送回**原会话**，本仓库是到点在**全新会话**里跑。工具名不冲突
  （`schedule_*` vs `scheduler_*`）。
- <https://github.com/MichengAI/dsh-automation> 之外的社区自动化实现 —— 未使用。

---

## 宿主依赖

`@deepseek-ai/*`（`dsh-session`、`dsh-sandbox-policy`、`dsh-user-approval`、
`dsh-agent-loop`、`dsh-llm` 等）由宿主 dsh 提供，本仓库**不打包、不修改**其代码，
仅在运行时通过 cordis 服务调用其公开 API。其许可为 MIT（DeepSeek-Harness-MIT）。
