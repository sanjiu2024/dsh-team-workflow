# REQ-004：dsh 0.2.0-rc.x 的团队预设（声明行 + bundle 承载）

状态：已完成 · 2026-10-04

## 1. 要做什么

让 `dsh-team preset install` 在 dsh 0.2.0-rc.x 上真正产出可用的「团队模式」预设，
并且能被新会话选到、选上之后一切正常（工具、提示词都不缺）。

用户的原话是：「我团队模式的 agent 怎么没来」——他要的是**在预设列表里看得见、
选得上、行为对**的东西，不是一份写进磁盘没人读的文件。

## 2. 不做什么

- 不改 dsh（frozen 的载体是上游的事）。
- 不做 profile 之外的其它 profile 自动发现；`--profile` 仍然显式。
- 不把生成的预设提交进仓库：它是**照着当前出厂的 standard 现改**的产物，
  提交进仓库必然与 dsh 升级脱节。
- 不动默认权限/审批策略。

## 3. 验收标准（可执行）

1. `dsh-team preset install --profile <p> --dry-run` 能打印出「底稿路径 + bundle 落点 + 4 处改动」，
   且不写盘。
2. 真跑 `dsh-team preset install --profile <p>` 后：
   - `<DSH_HOME>/team-workflow/preset-team/cordis.patch.yml` 存在，含 `id: preset-team` /
     `config.id: team` / `thresholdRatio: <团队值>`；
   - `dsh --profile <p> --dump-config` 的预设清单里出现 `team`；
   - 重启后 `plugin_manager list_plugins` 里 `preset-team` 为 `enabled: true`、
     `fiberPhase: active`。
3. `dsh-team preset install --default` 后 `--dump-config` 里 `agent-preset-registry.config.default == team`。
4. `node scripts/selftest-preset-gen.mjs` 全绿；给 `DSH_MODULES` 指到安装树时，
   「对出厂原文件也成立」那一步必须跑到并通过。
5. `dsh-team thrift apply` 后 bundle 里的阈值随之改变，且 `/thrift` 读回的值与新阈值一致。

## 4. 背景：为什么这件事一开始做不成

dsh 0.2.0-rc.x 起，预设不再是 `$DSH_HOME/.agent-presets/<id>/` 目录，而是 profile 树里的
一行 `@deepseek-ai/dsh-agent-preset` 声明。dsh 自带 skill `editing-cordis-compositions`
的原话：旧目录 *"Nothing reads that directory any more"*。

## 5. 已知约束（都是实测出来的）

1. **声明必须由 bundle patch 承载。** 放进 profile 的 `cordis.patch.yml` 时：
   - 行会出现在组合树里，`--dump-config` 看得到；
   - 但**预设不会被注册**（roster 里没有 `preset-<id>`）；
   - `default: <那个 id>` 指向不存在的预设 → 会话退化成「无预设」：
     persona / plan-mode 等预设文本全丢（系统提示 20911 → 18070 字），
     且 host 层被 `dsh-web-app` `disabled: true`、只由预设提供的
     `tool-fs`（read/write/edit）、`present`、`ask_user_question` 一起消失。
   - 判据：`plugin_manager` `list_plugins` 里的 `fiberPhase`。
2. **默认预设是设置字段**（客户端 `AGENT_PRESET_SETTINGS_NS = "agent-preset-registry"`），
   回落值才是 `config.default`；所以写 patch 等价于在界面设默认，但需要重启。
3. **自定义预设 id 没有后端 locale**：出厂那几个（standard/ptc/minimal/cordis）的显示名走
   客户端 locale，所以声明里不带 `name`。自定义 id 必须自己带 `name`/`description`，
   否则列表里只剩 id。
4. **出厂 patch 文件的位置**随安装方式变：`<install>/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。
   CLI 从 PATH 上的 `dsh` 反推安装树；profile 的 `node_modules` 里没有 `@deepseek-ai/*`。
5. `dsh --profile <p> --dump-config-schema` 对预设声明会报
   `unrecognized Loader tree carrier`（出厂那 4 个预设也报）——**是既有现象，不是故障判据**。

## 6. 方案

- `lib/preset-gen.js` 新增 `generateRc2TeamPreset(pristine, {settings, overlay})`：
  纯文本变换，只动四处（文件头注释 / 声明块 / persona 模式标识 / compaction 阈值），
  其余逐字照抄；并做「逐条 undo 回去必须逐字节等于出厂文件」的自检。
- `bin/dsh-team.mjs`：
  - `preset install` 先找 rc.x 的出厂 patch；找到走 bundle 路径，找不到回落旧目录路径。
  - bundle 落在 `<DSH_HOME>/team-workflow/preset-team/`，再写 profile 的
    `dependencies` + `dsh.profile.bundles` 并跑 `dsh plugin --profile <p> install`。
  - `--default` 往 profile patch 追加 `agent-preset-registry.config.default`（带 `.bak`、幂等）。
  - `thrift apply` 在 rc.x 下重生成整份 bundle。
- 自检：`scripts/selftest-preset-gen.mjs` 新增一节（纯函数 + 出厂原文件两条路）。

## 7. 用户要做的

重启 dsh（预设是加载期挂载的），然后开一个**新会话**：会话创建时预设就固定了，
已存在的会话不会中途切换 —— 这正是「看不见团队模式」的最后一个原因。
