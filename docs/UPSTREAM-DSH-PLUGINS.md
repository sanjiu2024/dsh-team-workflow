# 上游跟踪：`kurumi1ksllq/DSH-plugins`

> **状态**：维护中 · **建立**：2026-11-10 · 由定时任务 `上游插件巡检` **每天 09:00** 检查

这个仓库是「一个 pnpm workspace 里七个独立 DSH bundle」。本文件记录**每个包的判断结论**
和**检查方法** —— 定时任务读它，就不会每次从零开始判断。

## 检查方法

```bash
export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897
cd /d/DSH-plugins 2>/dev/null || git clone --depth 50 https://github.com/kurumi1ksllq/DSH-plugins.git D:/DSH-plugins
git -c http.version=HTTP/1.1 fetch --depth 50 origin main
git log --oneline HEAD..origin/main          # 上次检查之后的新提交
git diff --stat HEAD origin/main             # 改了哪些文件
```

**上次检查到的 commit**：`d4f476b336f50bffb6e4e95b9a7e4fea3172962a`

## 判断标准（三个条件都要满足才移植）

1. **补的是我们的真空** —— 现在没有、且短期内自己写不划算
2. **不带架构冲突** —— 不抢 preset 所有权、不和 `team/RULES.md` 的流程纪律打架、屋不加依赖
3. **本机能验** —— 有可执行的验证路径（单元测试 / 真挂载 / 真 API），不是「看着不错」

**只满足 1 不满足 2 的，走「借鉴」而不是「移植」**：抄它的思路，代码自己写。

## 七个包：当前判断

| 包 | 体积 | 判断 | 理由 |
| --- | --- | --- | --- |
| `dsh-credential-vault` | 314KB / 3053 行源码 | ✅ **已移植**（v2.31.0，`lib/vault/`） | 补真空（gh token / API key 散在三处）。搬后端，UI 自己做 |
| `dsh-websearch-failover` | 239KB | ⏸ **等条件** | 设计对（原生 `ctx.web` 只解析一个 provider，多家可用时抛 `WEB_PROVIDER_AMBIGUOUS`）。但当时本机零个搜索 provider key，装了只有一家 = 没有失败转移。**2026-11-10 新条件**：中转站有 `GET /v1/search`（$0.00125/次，自建 SearXNG）→ 可以当「自定义 HTTP」接进去，那时才有第二家。**接之前先问用户要不要** |
| `dsh-inventory` | 1.3MB / 18595 行源码 | ❌ **不移植** | 价值是「三合一 UI 宿主」，但 18595 行几乎全是客户端分片（`client/10-header.js` … `99-tail.js` 十三个文件）。它的三个页面里只有「保险库」对我们有直接价值，而那个我们自己能做。**已作为独立 bundle 装在 desktop profile**，要用它的面板就用那边的 |
| `dev-flow` | 299KB | 🔶 **借鉴，不移植** | 它解决我们没解决的问题：**Git 层**（分支保护、PR、CI、`.flow` 状态、任务板）。但流程契约走 `systemPrompt.context`（order 21050，`required: true`）**常驻**，和团队基线是两套纪律（它说「两次交互：意图确认 + 是否合并」，我们说「四步：复述→调研→审计划→实现」），模型会不知道听谁的。**要抄的**：分支保护命令、`.flow` 状态格式、任务板怎么分节点 |
| `dsh-deep-ptc-mode` | 862KB / 2230 行 | ❌ **不移植** | 三条硬冲突：① 它是 **preset 插件**（`inject = ['agentPresets']`，`apply` 时自己派生整份预设），和 `preset-gen.js` 的文本 patch 抢同一个 preset id；② 我们已有 team/ralph/workflow 三个模式，它是第四个且不是可选的；③ 它真正值钱的五条「别把用户晾着」的约束，有一条在 rc.5 上是**死代码**（`reachable.mjs` 读 `agent.inbox.nextStep`，而 rc.5 里 `grep -c nextStep` = 0）。**要抄的**：`sleep-lint.mjs`（423 行纯函数，自己写的 shell 词法器）和四条能用的约束，搬进我们自己的 `tools/pre-execute` 钩子（它是 `waterfall(..., {kind:"allow"})`，**能拒绝**） |
| `dsh-auto-delegation` | — | ❌ **不移植** | 委派纪律 + 分档表，我们 `team/RULES.md` 已经有一整套（`subagent_std`/`power`/`fork`、什么活派哪个档、回报必须短）。两套同时注入等于自己跟自己吵 |
| `ecc-agent-presets` | 1.4MB / 8 文件 | ❌ **不移植** | 133 个 ECC 工程 preset 一次性进选择器，会把我们做的三个模式埋掉。1.4MB 里全是 YAML |

## 值得单独抄的东西（不属于任何包）

| 来源 | 内容 | 状态 |
| --- | --- | --- |
| `dsh-deep-ptc-mode/lib/sleep-lint.mjs` | 423 行 shell 词法器：判断命令里有没有**真** sleep（字符串/注释/参数里的文字不算）。纯函数、零宿主依赖 | **未移植**，可搬进 `tools/pre-execute` |
| `dsh-deep-ptc-mode/lib/rules.mjs` | 五条可达性约束的文案 + 判定函数（前台 30s 转后台 / >5s sleep 拒 / run_code 等待拒 / poll 超 3 次拒 / ask 超 300s 拒） | **未移植**，四条可用（第五条依赖 rc.5 没有的 API） |
| `dev-flow` 的 Git 层 | 分支保护命令、`.flow` 状态格式、任务板分列方式 | **未移植**，可进 `skills/workflow` |

## 检查记录

| 日期 | 检查到的 commit | 结论 |
| --- | --- | --- |
| 2026-11-10 | `d4f476b` | 七个包全看完；移植 `credential-vault`；其余见上表 |

## 定时任务的职责边界

每天跑一次（09:00），做这些：

1. `git fetch` + `git log HEAD..origin/main`，没有新提交 → **报告「无更新」就结束**
2. 有新提交 → 看 `git diff --stat` 判断动了哪几个包
3. 对动了的那几个包，**对照上表**：已经是「不移植」的就跳过（除非它的定位变了）
4. 有值得看的改动 → 读 diff，按「判断标准」三条过一遍
5. 满足三条 → 写 REQ + 派调研 + 派审计划 + 实现（走完整流程，不许直接改）
6. 不满足 → 在「检查记录」里追加一行，说明为什么
7. **更新本文件的「上次检查到的 commit」**

**不许做的事**：不许因为「它更新了就移植」——更新不等于有用。也不许跳过 REQ 直接改代码。

**成本约束**：每天跑一次，绝大多数日子应该是「无更新 → 一句话结束」。
真有更新才展开读 diff；读也只看**动了的那几个包的 diff**，不要把七个包全读一遍。
一次巡检超过 20 步就停下来报告当前结论，别硬跑完 —— 明天还会跑。
