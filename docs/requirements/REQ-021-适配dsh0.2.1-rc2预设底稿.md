# REQ-021 · 适配 dsh 0.2.1-rc.2：让插件找得到 standard 预设底稿

> 状态：进行中 · 提出：2026-10-18（dsh 升到 0.2.1-rc.2 之后，`preset install` 报「找不到 standard 预设」）

- **状态**：进行中
- **对应版本**：`2.6.1 → 2.6.2`（只修 bug → patch）
- **提出**：用户 2026-10-18 原话「适配一下0.2.1-rc2」

---

## 1. 要做什么

让插件在 dsh **0.2.1-rc.2** 上照常能用。用户视角的诉求就是这一句「适配一下」，但实测下来
真正坏掉的只有一处：**`dsh-team preset install` 找不到 standard 预设底稿**，于是团队预设
既装不了、也重新生成不了。

要的结果：`preset install` 重新可用，而且用的是**当前这台机器上装着的那份 dsh** 的
standard 底稿 —— 不是任何陈旧副本。

## 2. 为什么（不做的后果）

- 直接后果：`dsh-team preset install` / `thrift apply` 报
  `✗ 找不到 standard 预设（新旧两种布局都没找到）`，团队预设无法再生成（改阈值、换压缩后端
  都跟着失效）。
- 更坏的后果（这次差点踩上）：本机 `.dshbin` 那个历史 junction 指向 **0.2.0-rc.2** 的 tauri 树，
  底稿还是旧的（146 行）。如果只是「让它找到点什么」就算完事，会**静默**生成一份缺三条新行
  的预设 —— 丢掉 `time-context` / `tool-schedule` / `tool-plugin-market` 的出厂状态，而且
  没有任何报错。所以这次必须优先拿**真实安装**里的那份。

## 3. 不做什么

- **不改预设生成的锚点逻辑**：`RC2_*` 那组常量对 0.2.1-rc.2 的底稿**仍然全中**（实测
  `generateRc2TeamPreset` 成功、`changed=5`），改了纯属多余。
- **不删 legacy 的 `generateTeamPreset`**（0.1.x 布局仍在支持面内）。
- **不自动清理 `.dshbin` 那类历史脚手架** —— 只在选择时**优先真实安装**并把来源打印出来。
- **不做「任意 dsh 版本都兼容」的抽象**：只按实测的两种安装形状（真实目录 / Electron asar）处理。

## 4. 验收标准

- [ ] `node bin/dsh-team.mjs preset install --profile desktop` 本机 `EXIT=0`，且打印的「底稿」
      来自**当前安装**（asar 内或解包目录），**不是** `.dshbin` 的 junction
- [ ] 生成出的 `preset-team/cordis.patch.yml` 含 0.2.1-rc.2 的三条新行
      （`time-context` / `tool-schedule` / `tool-plugin-market`），且**不含**已删除的
      （`tool-subagent-codex` / `tool-subagent-claude-code` / `tool-ralph`）
- [ ] 新增自检：拿**真实安装**的 standard 跑一遍生成，断言 `changed` 与上面三条新行；
      无安装树时**明确打印跳过**（不许静默变绿）
- [ ] 反向验证：把 asar 读取那段去掉，新自检必须变红
- [ ] 全仓自检失败数不超过升级前那 4 条（`selftest-bash-linux` 环境 + `selftest-scheduler` /
      `selftest-squad` / `selftest-cli` 本机既有）
- [ ] `package.json` 版本 = `CHANGELOG.md` 首个标题

## 5. 已知约束（查实的硬事实）

| 约束 | 证据 | 影响 |
| --- | --- | --- |
| 0.2.1-rc.2 的 standard 预设仍在 asar 内同一路径 | 自写 asar 头解析提取成功：`dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`，128 行 | 只要读得到 asar 就能拿到正确底稿 |
| 生成逻辑对新底稿仍然成立 | `generateRc2TeamPreset(新底稿, {settings,overlay:{}})` → `changed=5`、170 行、无抛错 | 这次不碰生成逻辑 |
| 现有查找依赖 PATH 上的 dsh 反推 + 真实文件系统 | `bin/dsh-team.mjs:633`（walk 8 层找 `<dir>/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）、`:652`（`whichDsh()` 只认 `dsh.cmd`/`dsh.exe`/`dsh`） | 新版 PATH 第一个是启动器目录 `AppData\Local\deepseek-harness\bin\dsh.cmd`，祖先里没有那些包 → 全空 |
| Electron 的包在 `app.asar` 里，普通 Node 进程看不见 | `resources\app.asar` 是文件（116MB）；`app.asar.unpacked` 只解了 `dsh/node_modules/@deepseek-ai`，**不含** `dsh-web-app/presets` | 必须自己解析 asar 头部 |
| 本机 `.dshbin` 的 junction 指向 **0.2.0-rc.2** | `C:\Users\Administrator\.dsh\plugins\.dshbin\node_modules\@deepseek-ai\dsh-web-app` → tauri 树；其 standard 146 行，与新底稿差 34 处 | 拿它当底稿会**静默**生成过时预设 |
| 宿主给子进程的环境变量里没有安装路径 | 实测只有 `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_SHELL` / `DSH_WEB_URL` | 只能自己找 |
| 两条可行的发现路径都实测过 | ① `%LOCALAPPDATA%\Programs\*\resources\app.asar` 唯一命中当前安装；② 宿主 `process.execPath` = `...\Programs\DeepSeek Harness\DeepSeek Harness.exe` | ① 是主路径（CLI 下 ② 会退化成 node.exe，只能当补充） |

## 6. 方案

1. **`bin/dsh-team.mjs` 新增纯 Node 的 asar 读取**：读 16 字节头 → `headerSize`（偏移 4）、
   `jsonLen`（偏移 12）→ 解析 JSON 目录树 → 数据区在 `8 + headerSize + offset`。
   提供 `asarEntry(asarPath, innerPath)`：目录返回子项名，文件返回 utf8 文本。
2. **`findRc2StandardPatch()` 候选顺序改为**（命中即返回，并带出来源类型）：
   ① `process.execPath` 是 Electron 时 → `<dir>/resources/app.asar`；
   ② 扫 `%LOCALAPPDATA%\Programs\*\resources\app.asar` 与 `%PROGRAMFILES%\*\resources\app.asar`
   （取**含该条目**的那份）；
   ③ 现有 PATH 反推 walk（真实目录）；
   ④ profile 的 `node_modules`。
3. **来源可见**：`preset install` 打印「底稿」时一并报出来源（asar 内路径 / 真实路径），
   能取到就报该安装的 `desktopVersion` —— 陈旧底稿一眼可见。
4. **自检补一段**：`scripts/selftest-preset-gen.mjs` 增加「用真实安装的 standard 生成」，
   断言 `changed` 与三条新行；无安装树时打印跳过（沿用现有措辞）。

## 7. 天花板（做完之后仍不支持）

- 只能读**未加密的普通 asar**（当前 dsh 是）。将来若换格式或把 presets 移出 asar，这段会失效 ——
  那时真实目录查找会接手。
- **不做**「底稿版本 ≠ 运行版本就拒绝」的强校验，只打印来源与版本号，由人判断。

## 8. 验收记录

- [x] `node bin/dsh-team.mjs preset install --profile desktop` → `EXIT=0`；底稿行 =
      `...\resources\app.asar → dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml（dsh 0.2.1-rc.2）`
      —— 来自当前安装，**不是** `.dshbin`
- [x] 生成出的预设：`time-context` / `tool-schedule` / `tool-plugin-market` 各 1 处；
      `tool-subagent-codex` / `tool-subagent-claude-code` / `tool-ralph` 各 0 处；
      `compaction-fold` 2 处、`subagent_std`/`subagent_power`/`subagent_max` 各 1 处、
      `当前模式：团队模式` 1 处（共 163 行）
- [x] `node scripts/selftest-preset-gen.mjs` → `✓ 真底稿生成：新出厂行继承、已删行清掉、团队行保留`，`EXIT=0`
- [x] 反向验证 → 在 `standardFromInstall()` 顶部插 `return undefined;`（模拟「不会读 asar」）→
      `EXIT=1`，报 `本机装了 dsh（C:\...\DeepSeek Harness）却读不到它的 standard 预设 —— 查找链坏了`；
      逐字节还原后哈希一致、`EXIT=0`
- [x] `preset install --dry-run` → `EXIT=0`，且预设文件哈希不变（dry-run 真的不写）
- [x] 全仓自检 27 条 → 失败 4 条，与升级前**同一组**（`selftest-bash-linux` 环境无 bash +
      `selftest-scheduler` ×2 / `selftest-squad` ×2 / `selftest-cli` ×1 本机既有）
- [x] `package.json` = `2.6.2` = `CHANGELOG.md` 首个标题 `## [2.6.2]`

### 过程中纠正的两处自己的判断（记下来免得下次重踩）

1. 我先用 `generateTeamPreset`（**legacy**，给 0.1.x 布局用的）测新底稿，它报「没找到 compaction-basic 行」
   —— 那是**正常**的（现代预设不该喂给 legacy 函数）。真正该测的是 `generateRc2TeamPreset`，它一次通过
   （`changed=5`）。差点据此去改一堆没坏的锚点。
2. `preset install` 的 `EXIT=-1` 是我自己用 `Select-Object -First N` 截断管道造成的假象；
   不截管道重测是 `EXIT=0`。

### 独立审查（测试型，只读，未改文件）报了 6 条

**已修 4 条**：`wired` 只验 `existsSync` 不验**指向**（node_modules 里是实目录或链到别处时会跳过
pnpm、新 patch 静默不生效 → 改成比 realpath）；asar 头部不设上限（拿 `package.json` 当 asar 实测
算出 1671MB、最坏 ~4GB，`Buffer.alloc` 先分配后失败、OOM 不可捕获 → 加 64MB 上限）；按文件名
`/harness|electron/` 认 Electron（改名/便携版认不出 → 改成看 exe 旁边有没有 `resources/app.asar`）；
`scripts/dsh-modules.mjs` 的注释说「与 CLI 一致」但没跟进 asar（→ 注释写明它**不**跟进）。

**驳回 1 条**：审查说自检里三条 `doesNotMatch`（`tool-subagent-codex` / `claude-code` / `tool-ralph`）
是空断言 —— 它们在当前底稿上确实恒真，但**咬合对象就是陈旧底稿**（0.2.0-rc.2 有这三行，审查自己
的实验 4 拿旧底稿跑就红了）。已在代码里加注释说明，避免下一个人当空断言删掉。

**另记 1 条既有问题**：`dsh-team patch --status` 在 0.2.1 上失败，与本节同源（且要 patch 的客户端
文件也在 asar 内，只换查找不够）→ 已写进 `docs/状态.md` §5 第 6 条，单独做。
