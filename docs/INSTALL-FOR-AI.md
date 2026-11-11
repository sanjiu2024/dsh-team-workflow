# 安装手册（给执行安装的 AI）

> **读者是 agent，不是人。** 每一步都给「命令原文 / 期望输出 / 不符合时怎么办」。
> 不要跳步，不要凭印象补参数，**任何一步的期望输出对不上就停下来**，按该步的「失败时」处理。
>
> 人读的版本在 [`README.md`](../README.md) 的「装」一节；这份是把它展开成可执行序列。

---

## 0. 先确认这四件事（缺一不可）

| # | 检查 | 命令 | 期望 | 不符合怎么办 |
| --- | --- | --- | --- | --- |
| 1 | Node 版本 | `node -v` | `v22.19.0` 或更高 | 装 Node 22.19+。本包 `engines` 就是这么写的，低了会在运行期炸在 `structuredClone` 之类的地方 |
| 2 | dsh 已装 | `dsh --version`（或看 `~/.dsh/profiles/`） | 至少有一个 profile 目录 | dsh 没装就先装 dsh，本手册不覆盖那一步 |
| 3 | git 可用 | `git --version` | 任意版本 | 自动更新功能依赖它；没有也能装，但要关掉 auto-update |
| 4 | bash 可用 | `bash -c 'echo ok'` | `ok` | Windows 上装 Git for Windows，并把 `C:\Program Files\Git\bin` 加进 **User** PATH（只有 `Git\cmd` 是不够的） |

四条全过再往下。**任一不过，先解决它**，不要带着问题装 —— 装完发现插件不加载，排查成本比现在高十倍。

---

## 1. 拿到代码

```bash
git clone <仓库地址> dsh-team-workflow
cd dsh-team-workflow
```

已经有目录就跳过。**装完后的所有命令都在这个目录里跑。**

确认一下你拿到的是能装的东西：

```bash
node bin/dsh-team.mjs --help
```

期望：第一行是 `dsh-team <版本号>`，下面有 `install` / `uninstall` / `status` / `preset install` 等子命令。
报错说明 Node 版本不够或目录不对 —— 回到第 0 步。

---

## 2. 选 profile（最容易错的一步，不要猜）

```bash
ls ~/.dsh/profiles/
```

期望：列出若干目录，例如 `tauri` / `desktop` / `web`。

- **只有一个** → 用它。
- **有多个** → 用**当前正在跑的那个**。判断方法：看 dsh 进程的命令行里 `--profile` 参数，或看 GUI 设置页里显示的数据目录。**不要默认选第一个**。
- 拿不准 → 停下来问人。选错 profile = 装到另一个 dsh 实例上，现象是「装完了但没生效」。

后面的命令都带 `--profile <名字>`，下文的 `<P>` 就是它。

> 本包 CLI 的 `--profile` **默认值是 `tauri`**。机器上没有 tauri profile 时，不带参数会报
> `profile "tauri" 不存在` —— 看到这句就是 profile 名字错了。

---

## 3. 装

```bash
node bin/dsh-team.mjs install --profile <P>
```

它做三件事：

1. 往 `<~/.dsh/profiles/<P>>/package.json` 写 `dependencies["dsh-team-workflow"] = "link:<本目录>"`；
2. 把 `dsh-team-workflow` 加进 `dsh.profile.bundles`；
3. 跑 `dsh plugin --profile <P> install`（本质是 pnpm install）。

**期望输出**（末尾两行）：

```
✓ 已装进 profile "<P>"（.../node_modules/dsh-team-workflow）
  重启 dsh 后生效；可用 /team-baseline 自检。
```

**失败时：**

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `profile "<P>" 不存在` | profile 名字错 | 回第 2 步 |
| `pnpm install 失败（退出码 N）` | 依赖装不上（网络 / 锁文件 / 磁盘） | 看它打印的 pnpm 原始错误。**最常见是网络**：先确认 registry 可达 |
| `profile "desktop" is managed exclusively by the Electron application` | 这个 profile 由 Electron 独占管理，CLI 不能碰 | 手工建链接：`New-Item -ItemType Junction -Path "<profile>/node_modules/dsh-team-workflow" -Target "<本目录>"`（**必须 Junction**；MSYS 的 `ln -s` 会建成目录） |
| 装完但 `node_modules/dsh-team-workflow` 不存在 | link 没解析 | 同上，手工建 Junction |

---

## 4. 生成团队预设

```bash
node bin/dsh-team.mjs preset install --profile <P> --default
```

`--default` 会把它设成新会话的默认预设。

**期望**：打印生成的 bundle 路径（`~/.dsh/team-workflow/preset-team` 之类），没有 error 行。

**已知不影响结果的失败**：最后一步 `dsh plugin --profile <P> install` 可能失败并报
`cannot resolve profile bundle "dsh-tauri"` 之类 —— 那是 **profile 自己的依赖缺失**，预设文件在这之前已经写好了。**判定标准是预设文件存在，不是退出码。**

```bash
ls ~/.dsh/team-workflow/      # 期望看到 preset-team
```

---

## 5. 写压缩阈值（可选，但推荐）

```bash
node bin/dsh-team.mjs thrift apply --profile <P>
```

要先做第 4 步（它写进的是第 4 步生成的预设）。失败就先跳过，不影响主体功能。

---

## 6. 重启 dsh

**必须重启。** 插件在会话创建时加载，热改不会生效。

不要用 `taskkill /IM node.exe /F` / `Stop-Process -Name node` —— dsh 自己就是 node，
按进程名杀会把宿主一起杀掉（无报错、无日志，现象是「dsh 突然没了」）。
用 dsh 自己的退出/重启，或按命令行特征过滤进程。

---

## 7. 验收（逐条跑，全过才算装好）

| # | 命令 | 期望 |
| --- | --- | --- |
| 1 | `node bin/dsh-team.mjs status --profile <P>` | `已装依赖` **不是** `否`；`注册为 bundle` 不是 `否`；`skills` 列出十几个（`ai-search` / `commit-convention` / `kb-*` / `workflow` …） |
| 2 | 重启后，在 dsh 会话里输入 `/team-baseline` | 打出本包版本与状态。**打不出来 = 插件没加载** |
| 3 | `node bin/dsh-team.mjs bill` | 打印当天 token 账单，或明说「没有审计日志」 |
| 4 | `node bin/dsh-team.mjs skills` | 列出技能清单，条数与第 1 步一致 |
| 5 | 会话里问「当前基线版本是多少」 | 答得出 `v<package.json 的 version>` |

第 2 条是**唯一能证明「真的装上了」的检查** —— 前面几步只是把文件放对位置，第 2 条证明宿主认了它。

---

## 8. 常见失败处置

| 症状 | 最可能的原因 | 处理 |
| --- | --- | --- |
| `/team-baseline` 无反应 | 没重启 / 装错 profile / bundle 没进 `dsh.profile.bundles` | 先重启；再 `status` 看「注册为 bundle」；再核对 profile 名字 |
| 重启后 dsh 起不来 | 预设非法（`agent-preset/invalid`） | 看启动日志里的具体键。**不要手改预设产物** —— 改 `team/agent-settings.json` 再 `preset install` |
| 技能一个都看不到 | 某个 `SKILL.md` 的 frontmatter 坏了 | 跑 `node scripts/selftest-skills.mjs`，它会把具体文件打出来 |
| 装完两个 profile 都变了 | 装到了错的 profile | 用 `uninstall --profile <错的那个>` 摘掉 |
| `dsh-team` 命令找不到 | 没加进 PATH | 一律用 `node bin/dsh-team.mjs ...`，不依赖全局命令 |

---

## 9. 回滚

```bash
node bin/dsh-team.mjs uninstall --profile <P>
```

它从 profile 的 `package.json` 里删掉依赖与 bundle 注册，然后重跑 `pnpm install`。**之后同样要重启。**

需要连预设一起撤：

```bash
rm -rf ~/.dsh/team-workflow/
```

> 撤之前确认没有别的东西在用这个目录（本机的 `preset-ralph` 之类也可能在里面）。

---

## 10. 禁区（装的时候最容易顺手犯的）

- **不要 `git add -A`**：仓库里有故意不提交的本机开关（`team/extensions/scheduler.json` 的 `enabled`）。
- **不要手改预设产物**：预设是 `preset install` 从 `team/agent-settings.json` 生成的，手改下次重生成就覆盖。
- **不要按进程名杀 node**（见第 6 步）。
- **不要把密钥写进仓库**：搜索服务令牌、GitHub token 一律走环境变量或 credential vault。
- **不要在没备份的情况下跑 `purge --apply`**：它改的是 dsh 的安装树。要跑先 `purge --status` 看清楚它要打哪些文件、有哪些会失配。

---

## 附：装完之后能干什么

| 想要 | 命令 / 做法 |
| --- | --- |
| 看团队规范现在写了什么 | 读 `team/RULES.md`（它每轮都在系统提示里） |
| 看某个技能怎么用 | `node bin/dsh-team.mjs skills` 找到名字，再读 `skills/<名字>/SKILL.md` |
| 看 token 花在哪 | `node bin/dsh-team.mjs bill --date <日期> --anatomy` |
| 跑自检 | `npm test`（全链，几十条；`EXIT=0` 才算过） |
| 查宿主补丁状态 | `node bin/dsh-team.mjs purge --status` |
