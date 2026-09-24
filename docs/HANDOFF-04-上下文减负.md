# HANDOFF-04 — 上下文减负：A + B + C

> 承接 HANDOFF-03。这一阶段解决一个具体问题：**主会话上下文太长**。
> 上一阶段的结论是「magic-context 的 `context` 处理器在 dsh 上落不了地」，
> 但那个结论只覆盖了「消息数组重排」这一条路。本阶段把真正能落地的三条
> 全部接通，并且证明 historian 不是架构不可能，只是**没配 model**。

## 0. 结论速览

| 项 | 状态 | 证据 |
|---|---|---|
| A. rtk 压缩覆盖到搜索类工具 | ✅ | `lib/rtk.js` 的 `compactTools` 数组化；selftest 第 7 节 |
| B. 规范里写清「委托是为了省上下文」 | ✅ | `team/RULES.md`；两次 headless 语义验证 |
| C. historian 真跑起来 | ✅ | `PiSubagentRunner` 直连返回 `{ok:true, assistantText:…}` |
| C2. compartment 注入系统提示 | ✅ | `readCompartments()` + SQL 契约测试 |
| C3. 压缩阀提前到 0.65 | ✅ | 生成的预设 `thresholdRatio: 0.65 / retainRatio: 0.2` |

**上一阶段的错误结论已纠正**：日志里 41 行 `registered historian trigger: DISABLED`
不是「dsh 不支持 historian」，是**配置里没写 historian model**。写一行配置就活了。

## 1. A —— rtk 压缩范围

### 问题
`lib/rtk.js` 原来只对 `bash|pwsh|shell|run_code` 做 head/tail 截断。
但真正撑爆上下文的是**搜索类工具**：`grep` 最坏 250 命中 × 2KB/行 = 500KB。

### 改法
`RTK_DEFAULTS.compactTools: ["bash","pwsh","shell","run_code","grep","glob"]`，
把原来写死的正则换成数组匹配；`RTK_FIELDS.compactTools` 加校验。

### 为什么 `read` 不在里面
`read` 有自己的 50KB / 2000 行上限，而且**它的输出带行号**。
head/tail 截断会把行号切断 → 后续 `edit` 定位全错。
这是刻意的排除，不是遗漏。

## 2. B —— 规范里的委托纪律

`team/RULES.md` 新增两节：

- 「先搞清楚：委托是为了省主会话上下文」—— 产出是文本的活派出去，产出是仓库变更的活谨慎派；探索类必须派。
- 「子代理回报必须短」—— `文件:行号` + 一句话，禁止贴代码全文。

效果是**主会话不用把探索过程读进自己的上下文**，这才是真正省 token 的地方。

## 3. C —— historian 为什么之前是 DISABLED

### 根因（不是架构问题）
bundle 启动时：
```text
registered historian trigger: DISABLED (configure the active harness's historian model in magic-context.jsonc)
```
这行的判断在 `dist/index.js:35899`：`bootProjectDeps.historianConfig ? 启用 : DISABLED`。
而 `historianConfig` 来自 `resolveHistorianModel(config, harness)` → 读
`config.historian[<harness>].model`。

**`~/.config/cortexkit/magic-context.jsonc` 这个文件在 pi 和 dsh 上都不存在** →
两边都用 schema 默认值 → 默认值里没有 historian model → DISABLED。

也就是说：pi 上 historian 也从来没跑过。这不是移植带来的损失。

### 配置形状
```text
{
  "historian": {
    "pi": { "model": "new-api/tier-std" }
  }
}
```

三个要点：
1. **块名是 `pi`**，不是 `dsh`。bundle 里 `setHarness(PI_HARNESS_KIND)` 写死；
   `resolveHarnessBlock(container, harness)` 的取值就是 `container[harness]`。
   dsh 没有自己的块名。
2. **model 必须是 `provider/model`**（bundle 的 `isValidModelReference` 要求含斜杠）。
3. **`enabled` 已废弃**，现在用 `disable`（`migrateLegacyAgentEnabledInMemory` 会警告并迁移）。

验证（`tools/mc-probe.mjs` 的新鲜日志）：
```text
config loaded from: ~\.config\cortexkit\magic-context.jsonc
registered historian trigger (model=new-api/tier-std, executeThreshold=65%)
historian trigger eval: usage=0.0% (0 tokens) [piUsage fallback], checking trigger...
historian trigger eval: shouldFire=false (no trigger condition met)
```
从「never evaluates」变成「**每轮评估，只是没到阈值**」。

## 4. C（硬的那半）—— pi 伪 CLI

### 问题
historian 要真的生成摘要，得 spawn 一个子进程。bundle 里
`resolveHistorianFromConfig` @35441 **写死 `runner: new PiSubagentRunner`**
（35453），没有注入点；`piSubagentRunnerFactory`（15211）是模块级 `var`，
**不导出**。从 pi 桩上桥接不了。

### 唯一可拦截的点
`resolvePiInvocation` @13823 在 Windows 上走到
`resolveWindowsPiCommand(env)`（13782）—— **扫 `process.env.PATH` 找 `pi.cmd`**。
这就能拦。

### 两个 Windows 硬约束（都是实测撞出来的）

**① 路径不能含空格。**
bundle 的调用形态是 `cmd.exe /d /s /c <未加引号的路径> <args>`。
包目录 `…/Desktop/deepseek harness cj/` 含空格 → 断在 `deepseek` 处：
```text
'C:\Users\Administrator\Desktop\deepseek' 不是内部或外部命令
```
→ 伪 CLI 落在 `~/.dsh/team-workflow/pi-shim/`（无空格）。

**② `.cmd` 文件必须全 ASCII。**
`cmd.exe` 按 GBK 读批处理文件，UTF-8 中文注释会变成乱码并被当成命令执行：
```text
'…PiSubagentRunner' 不是内部或外部命令
```

### 注入方式
不写用户 profile、不碰全局 PATH —— 只在插件进程内改：
```text
process.env.PATH = [shimDir, ...现有项].join(sep);
```
`stagePiShim()` 每次启动重新拷一遍（所以是幂等的，也是自愈的）。

真 dsh 验证：往 `pi.cmd` 写个 `MARKER-BEFORE`，跑一次 headless，内容被还原成原文件。

### 协议
伪 CLI 只做一件最小的事：读 `--system-prompt` 指定的文件、从 **stdin** 读用户
消息（Windows 下 bundle **总是**走 stdin，`deliverViaStdin`）、POST 到 provider、
按 pi 的 NDJSON 协议吐一行：
```text
{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"…"}],"stopReason":"stop"}]}
```

**它不实现 pi**，只实现 bundle 消费的那一行。

### 凭据
`provider.apiKeyEnv` 是 `z.string().role("credential-ref")`，由 dsh 在进程内用
`ctx.credentials` 解析 —— **子进程看不到**。所以伪 CLI 直接读
`~/.dsh/.credentials.yaml` 的 `refs.<apiKeyEnv>`。
同一个引用名、同一个文件，不是绕过。

### 端到端证据
```text
$ node /tmp/histtest.mjs          # 走 bundle 的真 PiSubagentRunner
model  = new-api/tier-std
runner = PiSubagentRunner
run 返回 = {"ok":true,"assistantText":"团队规定用中文回答且不要按进程名杀 node。","toolCallCount":0,"durationMs":6290}
```
**spawn → 协议 → 结果解析，全链路通。**

## 5. C2 —— compartment 注入

### 为什么需要自己注入
historian 的产出（P1-P4 四级折叠摘要）写在 DB 的 `compartments` 表，
由 bundle 的 `context` 处理器负责送进模型。而那条路在 dsh 上落不了地
（见 HANDOFF-03：`assistant/message` 永不可替换）。所以直接读表、拼进系统提示。

### 改法
`readCompartments(sessionId)`：
- 只读打开 `~/.dsh/storages/memory/cortexkit/magic-context/context.db`
- `WHERE session_id = ? AND COALESCE(legacy,0) = 0 ORDER BY sequence DESC LIMIT 8`
- 倒回正序（老的在前），取 `p1` + `p2`（骨架 + 要点，不取 P3/P4 控制 token）
- 拼成 `## Magic Context —— 已折叠的历史` 块

挂在 `refreshBlock()` 里，和 `before_agent_start` 的输出拼一起，
走 `systemPrompt.section`（order 700，同步 `text: () => mcBlock`）。

### 容错
打不开 DB（表还没建 / 被锁 / 路径不对）→ 返回 `""`。
折叠是增强不是主路，不能把 agent 拖死。

### 验证
SQL 契约单独测过（`/tmp/cptest.mjs`）：`legacy=1` 的行排除、别的 session 排除、
`sequence` 倒序取再正序输出、空会话返回 0 行。

## 6. C3 —— 压缩阀值

`team/agent-settings.json`：
```text
reserveTokens:    32768 → 44800     (thresholdRatio 0.744 → 0.65)
keepRecentTokens: 20000 → 25600     (retainRatio    0.1563 → 0.2)
```
窗口 128000 → **触发 83,200 / 保留 25,600**（原 95,232 / 20,006）。

生成的 `~/.dsh/.agent-presets/team/agent.cordis.yml:148-150` 已确认。

## 7. 仍然存在的天花板（说清楚，不粉饰）

1. **`§N§` 序号前缀落不到模型眼里。** 它是 `context` 处理器的产物，落到 surface
   就被 dsh 的 provenance 校验挡下。但 `ctx_expand` 走的是 bundle 自带的
   raw-message provider，**不依赖 surface**，所以 `ctx_search → ctx_expand` 仍然可用。
2. **compartment 只注入 P1+P2。** P3/P4 留在 DB 里，要靠 `ctx_search` 取。
   这是 token 预算的取舍，不是缺陷。
3. **`ai-tokenizer` 不可用** → historian 的阈值判断用近似字符数估算，
   边界可能偏早或偏晚。这是运行环境缺依赖，不是移植问题。
4. **historian 是否真在生产会话里触发过，还没验过。** 需要一段足够长、
   超过 65% 窗口的对话。目前只验到「每轮都被评估」。

## 8. 本阶段新增/修改的文件

```text
新增  tools/pi-shim/pi.mjs          伪 CLI 主体（只用 node:*）
新增  tools/pi-shim/pi.cmd          cmd.exe 包装（全 ASCII）
改    lib/mc.js                     stagePiShim / piShimDir / readCompartments
改    lib/rtk.js                    compactTools 数组化
改    bin/dsh-team.mjs              mc install 时落位伪 CLI
改    team/RULES.md                 委托纪律两节
改    team/agent-settings.json      压缩阈值
改    scripts/selftest.mjs          compactTools 覆盖
```

## 9. 回归

```text
selftest          ✓
selftest-mc       ✓
selftest-surface  ✓
mc-probe          ✓
historian 直连    ✓
真 dsh e2e        ✓
```

## 10. 下一步

- 跑一段长对话，确认 historian 真的产出 compartment（`compartments` 计数 > 0）。
- Phase 2 共享库：关掉 PID 22736 / 42508 后跑 `npx @cortexkit/magic-context@latest doctor`，
  去掉 `MAGIC_CONTEXT_TEST_DATA_DIR`。
- 重启桌面 app，确认 `/team-baseline`、11 个 skill、`team` 预设、子代理自选档。
