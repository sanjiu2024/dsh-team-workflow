# REQ-023 · `dsh-team doctor`：一条命令体检整条链路

> 状态：进行中 · 提出：2026-10-18（用户原话「你自己想一想要做什么新功能」→ 选中 doctor）

- **对应版本**：`2.6.3 → 2.7.0`（加能力 → minor）
- **动机**：2026-10-18 那次 dsh 0.2.1 适配里，**每一个故障都是手工挖出来的**：底稿要从 asar 里读、
  `toolFilter` 让整份预设判非法、`link:` 判断被 pnpm 的正斜杠骗、预设产物过期没人知道、
  折叠后端挂没挂上只能靠临时 profile 试。这一条把那些排查变成断言。

## 1. 要做什么

`node bin/dsh-team.mjs doctor`：跑一组**只读**检查，逐条打印 ✓/✗/⚠ 与一句话结论，最后给退出码
（全过 0，有 ✗ 则 1）。检查项：

| # | 检查 | 判据 |
| --- | --- | --- |
| 1 | dsh 安装树 | `lib/dsh-install.js` 的 `dshInstallRoots()` 找得到；能读到版本（`dsh/desktop-runtime.json`） |
| 2 | standard 底稿 | `findRc2StandardPatch({ profileDir })` 有结果，且 label 里带 dsh 版本 |
| 3 | 预设产物新鲜度 | 文件存在，且 mtime **不早于** `lib/preset-gen.js` 与 `team/agent-settings.json` |
| 4 | 预设里没有 0.2.1 已废弃的键 | 生成物里 `toolFilter:` / `persona:`（作为 tool-subagent 的配置键）零处 |
| 5 | **预设能被真宿主接受** | 调 `scripts/smoke-preset-tier.mjs`（子进程 + Electron，见下），退出码 0 |
| 6 | profile 接线 | 两个 `link:` 依赖指向本包与预设 bundle（**路径归一化后**比）、都在 `bundles` 里、`node_modules` 里解析得到 |
| 7 | 压缩后端 | 预设里那一行的 `name` 能从 profile 解析到；阈值能回读（`readEffectiveThrift`） |

- 默认体检**当前装到的 profile**（`dsh-team status` 认出来的那个），`--profile <name>` 可指定。
- 第 5 项必须在 **Electron** 里跑（asar 只有 Electron 的 fs 认）：doctor 自己 spawn
  `ELECTRON_RUN_AS_NODE=1 "<安装目录>\DeepSeek Harness.exe" --expose-internals scripts/smoke-preset-tier.mjs`，
  读它的退出码 —— **复用现成脚本，不重写一遍挂载逻辑**。

## 2. 不做什么

- **不自动修**：只报。修是 `preset install` / `dsh-team install` 的事 —— 体检工具顺手改东西，
  下次就没人敢跑了。
- **不动任何配置**、不写盘（第 5 项是子进程只读）。
- **不做 `--json`**：没有消费者。要机器可读的那天再加。
- **不联网**：不查插件最新版本（那是市场的事，而且本机代理时通时断）。
- 不改 `dsh-team status` 的现有输出（有自检钉着它）。

## 3. 验收标准（每条都要能跑）

- [ ] `node bin/dsh-team.mjs doctor` 在本机 **EXIT=0**，七项全 ✓
- [ ] `--profile <不存在的名字>` → 明确报错退出，不是崩栈
- [ ] **反向验证 1**：往预设产物里塞一行 `toolFilter: { allow: [] }` → doctor 第 4 项**变红**、
      退出码 1；逐字节还原后回到 0
- [ ] **反向验证 2**：`touch` 一下 `lib/preset-gen.js` 让产物显旧 → 第 3 项**变红**；
      重新 `preset install` 后回到 0
- [ ] **反向验证 3**：把 profile 里 `dsh-team-presets` 的依赖从 `link:…` 改成别的 → 第 6 项**变红**
- [ ] `npm test` 无新增红（本机既有 4 条环境红不算）
- [ ] `package.json` = `CHANGELOG.md` 首个标题（`2.7.0`）

## 4. 已知约束（查实的硬事实）

| 约束 | 出处 |
| --- | --- |
| 0.2.1 起宿主包在 `resources/app.asar` 里，asar 路径只有 Electron 的 fs 认 | `lib/dsh-install.js` 的 `rawFs` 注释、`scripts/smoke-fold-host.mjs` 头部 |
| `toolFilter` / `persona` 被 0.2.1 废弃，写了整份预设判非法、新会话建不起来 | REQ-022 |
| pnpm 会把 `link:` 依赖写成正斜杠，字面比会误判 | `bin/dsh-team.mjs` 的 `sameLinkPath` 注释 |
| `ctx.loader` 按 profile 基准解析裸标识符，所以本包能解析到、宿主包不能 | 记忆里的 loader 分支结论 |
| 预设是 `preset install` 的产物，**手改会被下次生成覆盖** | `AGENTS.md` §1 |

## 5. 方案

- 新增 `lib/doctor.js`：一组 `checkXxx(ctx)` 纯函数式检查，各自返回
  `{ id, title, level: "ok" | "warn" | "fail", detail }`；doctor 只负责编排与打印。
- `bin/dsh-team.mjs` 加 `doctor` 子命令（照现有子命令的写法），`--profile` 复用现有解析。
- 复用的现成件：`dshInstallRoots` / `findRc2StandardPatch` / `whichDsh`（`lib/dsh-install.js`）、
  `readEffectiveThrift`（`lib/preset-gen.js`）、`sameLinkPath`（`bin/dsh-team.mjs` 里已有，
  需要时提到 lib 里共用，别抄第二份）、`scripts/smoke-preset-tier.mjs`。
- 新增 `scripts/selftest-doctor.mjs`：拿**构造的**检查输入钉住每条判据（不依赖本机安装树），
  并进 `npm test`。

## 6. 天花板（做完之后仍不支持）

- 不查插件是否有新版（不联网）。
- 不体检小队/调度器那半边。
- 第 5 项依赖 Electron 与真安装树：没有 dsh 的机器上会以 ⚠ 跳过，不当成失败。

## 7. 验收记录

（实现与反向验证跑完后填：每条验收标准对应**实际跑过的命令 + 实际输出**。没跑过的不勾。）
