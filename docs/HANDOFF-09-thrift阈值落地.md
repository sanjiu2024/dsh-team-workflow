# HANDOFF-09 · `/thrift` 的阈值终于写到真地方了

承接 `HANDOFF-08`。那一轮把「默认展开」做完了（0.4.0），顺手留了一条待办没动。
这一轮修的是**上下文节流那条命令的静默失效** —— 它属于 HANDOFF-08 §6.2 里日报点出的
「值得加的功能」那一类，也是 0.4.0 之前就存在的老问题。

对应版本：`0.4.0 → 0.4.1`（patch：只修 bug，没加能力）。

---

## 1. 症状：一条「看着成功」的命令

用户在会话里敲 `/thrift prune 40000`，命令回一段带「生效配置」的表；再
`dsh-team thrift apply`，打印「已写入」。重启 dsh，**什么都没变**。

不只没变，是**看着像变了**：`/thrift show` 里那三行数字是 40000，而真在跑的还是 8192。

这类 bug 的性质和 `HANDOFF-07` 那轮（折叠没落地）是同一个：命令有输出、日志没报错、
数字看着合理 —— 唯一不对的是它没有效果。

## 2. 根因：三个错叠在一起

| # | 错 | 后果 |
|---|---|---|
| 1 | **写错了文件**。阈值写进 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/tauri/`） | 预设是**整份 entry list、没有 patch 层**，profile patch 够不到它 |
| 2 | **键名不对**。写的是 overlay 那套 `pruneThresholdChars` 等 | 插件只认 `thresholdChars` / `headChars` / `tailChars`，**未知键直接 throw** |
| 3 | **显示的是自己的 overlay** | 写完即看着「已生效」，把 1、2 一起藏住 |

### 2.1 真在跑的那两行在哪

穷举过 `@deepseek-ai/dsh-*` 三处加载面之后确认：压缩/裁剪的**生效实例**在 agent 预设的
`compaction` group 里：

```yaml
# ~/.dsh/.agent-presets/team/agent.cordis.yml
- id: compaction
  name: cordis:group
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        thresholdRatio: 0.9
        retainRatio: 0.2
        auto: true
```

host 层（`dsh-web-app`）把 `compaction-basic` / `command-compact` / `tool-result-pruner`
三行都 `disabled: true` 了（见 `CHANGELOG 0.2.0`），所以**只有预设里这两行算数**。

### 2.2 校验公式来自插件源码，不是猜的

`@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js`：

```js
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const emittedChars = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars;
if (emittedChars > resolved.thresholdChars) throw new Error(...)
```

`codePointLength` 是 `Array.from(text).length`（**不是** `.length`，虽然这个 marker 恰好
两者都是 39）。`@deepseek-ai/dsh-compaction-basic` 那边对应的是
`retainRatio >= thresholdRatio` ⇒ throw。两条都实测核对过。

## 3. 修法

新增 `lib/preset-gen.js`，**纯文本进、纯文本出**：

- `resolveThriftConfig(settings, overlay)` —— 换算 + 按插件真实约束校验，非法就抛
- `generateTeamPreset(pristine, {settings, overlay})` —— 产出新预设 + `changed` 条数，
  内部把每条改动**逐条撤回去**、断言逐字节等于 standard
- `readEffectiveThrift(text)` —— 从生成好的预设里回读真值（`/thrift show` 用）

`thrift apply` 与 `preset install` 走同一条生成/校验路径，不另开一套。
`/thrift show` 分开报「生效中（预设里读到的）」与「待应用 overlay（还没写进预设的）」；
没有 overlay 文件就说没有，不拿内部默认值冒充用户意图。

### 为什么不是「给预设加一层 patch」

dsh 的 loader patch 是 **profile 层**的机制（`cordis.patch.yml` 是顶层数组、
按 bundle 顺序叠，见 `cordis.patch.yml` 头部注释）。预设自己就是 entry list，
没有再接 patch 的口子。检查过 `dsh-agent-presets` 的实现，没找到对预设的 patch 支持。
所以只能重生成 —— 和 `preset install` 本来就是同一件事。

## 4. 已知天花板

- **重生成会覆盖用户在 team 预设里的手改。** 这和 0.4.0 之前的行为一致（那时也是整份
  重写），不是这轮引入的；但值得记一笔：预设是**本包的产物**，用户要改应该改
  `team/agent-settings.json` 或走 `/thrift`，不该手改 `~/.dsh/.agent-presets/team/`。
- **`/thrift compact <ratio>` 的合法性是写盘时才校验的**，不是敲命令时。命令只写 overlay，
  真正拦住非法值的是生成阶段。所以非法值会留在 overlay 文件里、`/thrift show` 会把它列成
  「待应用」，直到有人去 `apply`。没有做成「敲命令就校验」是因为校验要读 standard 预设
  （命令跑在插件里、不保证能定位到安装树）—— 宁可晚一步拦，不要拦不住。
- **回读是手写 YAML 子集解析**。它只认「`- id: <row>` 行 → 自己那层 `config:` →
  缩进正好深 2 的直接子键」这个形状，够用且抗嵌套同名诱饵（自检里有守门用例）。
  预设格式若大改（比如换成 JSON），`readEffectiveThrift` 会返回 `undefined` ——
  **明说读不到，不瞎给值**。

## 5. 证据

```bash
node scripts/selftest-preset-gen.mjs     # 12 节，含「生成阶段拦住会让 dsh 起不来的 overlay」
npm test                                 # 全部 9 个自检
```

自检里这几条是真的会失败的（不是摆设）：把 `THRIFT_KEYS` 改回 overlay 键名、
把 `retainRatio < thresholdRatio` 的判断去掉、把 `thresholdRatio ∈ (0,1]` 的范围检查去掉、
把 `readEffectiveThrift` 的「直接子键」那层判断去掉（嵌套诱饵会盖掉真值），
这四种都实测能红。

找不到 dsh 安装树时，第 3 节会**跳过并明说跳过了什么**（只通过第 1~2 节），
不会只印一句「全部通过」把没验的东西说成验过了。

## 6. 交接清单

- **改动文件**：`lib/preset-gen.js`（新）、`scripts/selftest-preset-gen.mjs`（新）、
  `lib/thrift.js`、`bin/dsh-team.mjs`、`README.md`、`package.json`、`CHANGELOG.md`、本文件。
- **`bin/dsh-team.mjs` 顺带删掉的**：`toYaml()`（只给旧 patch 写法用的）、
  `patchCompactionRow()`、`patchPersonaRow()` —— 生成逻辑搬进 `lib/preset-gen.js` 后
  这三个都没有调用方了。`ROW_ID` 仍被 `status` 用，保留。
- **待办**（HANDOFF-08 §6.4 那三条，都还没动）：
  - `ctx_*` 工具的高错误率根因（需先复现拿错误正文，审计日志不记错误正文）
  - read 会话内重复读取的抑制（注意这是**改工具的共享行为**，先 grep 全部调用方）
  - ~~搜索查询缓存~~ 已在 `cb5bce6` 做掉
