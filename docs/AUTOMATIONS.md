# 定时任务契约

本仓库有两个无人值守的定时任务，都由 DSH 面板插件 `dsh-tauri-panel-scheduler` 驱动
（存在 `<DSH_HOME>/crons/tasks`，**不是 Windows 计划任务**：DSH 桌面端没运行时不会执行）。

两者的任务 prompt 都只有一句话，指向本文件对应小节。这样契约跟代码一起进 git、
可评审可回滚，`<DSH_HOME>/crons/tasks` 被清掉也能照着补回来。

| 任务 | 调度 | 契约 |
| --- | --- | --- |
| `用量日报` | 每天 09:00（宿主本地时区） | 本文件「每日用量日报」 |
| `上游同步（pi-workflow）` | 每 48 小时 | 本文件「上游同步（pi-workflow）」 |

两个任务都会改本仓库并推送，所以共用文末的「公共纪律」。

---

## 每日用量日报

汇总**前一天**的 token 消耗与耗时。口径与算术由 `scripts/usage-report.mjs` 负责（已过审查）；
**判读只有 AI 能做**，脚本替不了。

取数用脚本、不用 AI 直读原始日志：一天的审计日志约 3.97M 字符（≈1.13M token 粗估），
是脚本产出报告的 **314 倍**，本机峰值 prompt 才 128k —— 直读物理上读不进来。

### 步骤

1. **取数**（确定性，不要自己重算）

   ```bash
   node scripts/usage-report.mjs --date yesterday --out-dir docs/usage
   ```

   - 退出码 `3`：当天没有审计日志 → 直接结束，不写文件、不提交、不推送
   - 退出码 `0`：已写出 `docs/usage/<日期>.md`（stderr 会打印路径）
   - 其他退出码：失败 → 把 stderr 原文贴进最终报告后结束，不要继续

   若 `docs/usage/<日期>-判读.md` 已存在 ⇒ 这天已经做过，直接结束。

2. **判读**（这步只有你能做）

   读 `docs/usage/<日期>.md`，写 `docs/usage/<日期>-判读.md`，必须含四节：

   - **慢在哪一步**：用「模型等待 / 工具执行 / 其他」的墙钟占比指名瓶颈在哪侧；
     若有工具的 p90 明显高于中位，指出来
   - **token 耗在哪一步**：用放大倍数表，指名哪几个工具、哪些重复读贡献了最多计费输入
   - **值得加的功能**：写成可执行的改动项，**每条要能落到具体文件**（硬要求）
   - **本日结论**：三句话以内

   数字一律引用脚本产出、保留原值，不要自己重算。拿不准就不写，写「数据不足」。

3. **顺手修**（可选，条件不满足就不要改代码）

   若第 2 步发现了「小、可验证」的问题 —— 例如报告里显示同一个文件一天被重读 36 次、
   某条提示词在诱导浪费 —— 可以修，但必须**全部**满足：

   - 依据已写进第 2 步的判读文件
   - 只碰 `team/` 与 `skills/` 下的文件，最多 2 个
   - `scripts/` 与 `lib/` **一律不许改** —— 那两处是已过审查的实现，发现问题就写成建议
   - `node scripts/selftest.mjs` 必须通过

   不满足就只写建议，不动代码。**不许为了让改动看起来成功而放宽这条。**

4. **提交与推送**（只 add 本任务改动的文件，禁止 `git add -A` / `git add .`）

   ```bash
   rtk git add docs/usage/<日期>.md docs/usage/<日期>-判读.md
   rtk git commit -m "docs: 用量日报 <日期>"
   rtk git push
   ```

   第 3 步有代码改动就**另开一个提交**（一次提交只做一件事）。

### 最终报告（一行）

`日期 / 计费输入 tokens / 缓存命中率 / 模型等待占步墙钟比例 / 是否已推送`

---

## 上游同步（pi-workflow）

上游 = `https://github.com/kurumi1ksllq/pi-workflow`，每 48 小时检查一次有没有新东西值得搬。

状态文件 = `docs/UPSTREAM-SYNC.md` 的「已同步基线」。**没有它这活干不了** ——
它回答的是「这次新出来什么」，不是「上游有什么」。

### 步骤

1. **取基线**：读 `docs/UPSTREAM-SYNC.md`，取「已同步基线」里的 commit SHA，记为 `BASE`。
   文件不存在或 `BASE` 取不到 → 结束，在报告里说明，不要动手。

2. **取上游最新**

   ```bash
   rtk git ls-remote https://github.com/kurumi1ksllq/pi-workflow refs/heads/main
   ```

   记为 `REMOTE`。`REMOTE == BASE` ⇒ 上游无新提交，不做任何修改、不提交、不推送。

3. **拿材料**：把上游克隆到 `%TEMP%\pi-workflow-sync`（已存在就 `git fetch` 后复用），然后

   ```bash
   rtk git -C <目录> log --oneline --name-status BASE..REMOTE
   rtk git -C <目录> show REMOTE:<path>     # 需要看具体内容时
   ```

   **禁止把整个上游树读进来** —— 只看 `BASE..REMOTE` 变动的那些文件。

4. **逐条判断能不能落地**，依据 `docs/UPSTREAM-SYNC.md` 的「怎么判断」与「对照表」。
   拿不准就不搬，记原因。

5. **只有真的改了本仓库的文件才算「有更新」**

   - 有更新：按第 4 步改本地文件；把基线改成 `REMOTE`（记 SHA/tag/日期）；
     把没搬的条目和原因加进对照表（只允许往表里加行）；
     按 `CHANGELOG.md` 顶部规则递增 `package.json` 的 `version`（加能力 minor / 只修 bug patch）；
     在 `CHANGELOG.md` 加一节 `## [<新版本>]`，写清从上游搬了什么、为什么。
   - 没得搬但上游确有新提交：只更新基线和对照表。
   - 无新提交：什么都不做（第 2 步已结束）。

6. **提交前自检**

   ```bash
   node scripts/selftest.mjs
   ```

   红了就 `rtk git checkout -- .` 回滚全部改动，不提交、不推送，把原始报错贴进报告。

7. **提交与推送**

   ```bash
   rtk git add <具体文件>
   rtk git commit -m "<type>: <中文标题，≤50 字>"
   rtk git push
   ```

### 最终报告（一行）

`上游 BASE→REMOTE / 搬了什么 / 没搬什么及原因 / 新版本号 / 是否已推送`

---

## 公共纪律

两个任务都无人值守，**没有人在旁边**：

- 不要问问题，不要用 `ask_user_question`，拿不准就按契约保守处理
- 审批策略被强制设为 `never`，任何需要审批的动作都会被直接拒绝 —— 别去试
- 只 add 自己改动的文件，禁止 `git add -A` / `git add .`
- 禁止 `git push --force`、禁止改别的任务正在用的文件
- `git push` 被拒 → `rtk git pull --rebase` 后重试一次；再失败就停下如实报告
- 不许改本文件（`docs/AUTOMATIONS.md`）：契约要人改，不要自己改自己的规矩
- 单轮有 30 分钟上限，超时会被中断 —— 别做需要长时间等待的事
