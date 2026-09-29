# REQ-002 · dsh 版「操控电脑」（computer use）

> 状态：已完成
> 对应版本：`1.5.0 → 1.7.0`（加能力 minor；1.7.0 起默认启用）
> 提出：用户，2026-09-27。「帮我参考Codex的操控电脑的插件的实现方式，在dsh实现一下」+「并且在ai操控的时候自动锁定鼠标，以防不小心动」

---

## 1. 要做什么

- 在 dsh 里让 AI 能**直接操作 Windows 电脑**：看屏幕（截屏给模型看）、动鼠标（移动/点击/滚动）、敲键盘（打字/按键）。
- 动作集参考 **Anthropic computer use**（用户选定；调研发现 Codex 根本没有此类插件，最接近的就是 Anthropic computer use 与 OpenAI computer-use-preview，用户选前者）：
  `screenshot`、`mouse_move`、`mouse_click`（左/右/双击）、`scroll`、`type_text`、`key_press`、`cursor_position`。
- **AI 操控期间自动锁定鼠标，防人误碰**（用户选定「注入标记钩子」方案）：常驻 WH_MOUSE_LL 钩子，AI 注入的事件带标记放行、人的真实事件拦截——人完全锁死、AI 完全不受影响。
- 审批：**会话内首次操作弹 dsh 确认，批准后本会话放行**（用户选定）；新会话重新确认。

## 2. 为什么（不做的后果）

AI 现在只能靠文件和命令间接干活，**碰到 GUI 就瞎了**：浏览器要手动点的弹窗、桌面软件里的表单、没有 CLI 的工具，全都做不了。截屏+输入注入是把它从「终端助手」变成「能替人操作电脑」的最小闭环。

## 3. 不做什么

- **不改 dsh 内核**：纯包外插件（只用 `ctx.tools` / `ctx.get` / spawn），与 worktree 同款边界。
- **不做 OCR**：读屏靠模型视觉（4 个 tier 都声明了 `image` 输入）。
- **不做窗口管理**（激活窗口、拖动窗口标题栏之外的窗口操作）——第一版动作集就上表 7 个。
- **不锁键盘**：需求原话是「锁定鼠标」；WH_KEYBOARD_LL 同款套路留作扩展。
- **不做录屏/连续视觉**：单次截屏，模型要连续看就连续调。
- **非 Windows 不注册工具**（本包本来就是 Windows 场景）。
- **不保证向管理员权限窗口注入**（UIPI 系统限制，见 §7）。
- 不做图像识别/坐标辅助换算——模型自己看图定位。

## 4. 验收标准

- [ ] `npm test` 全绿，新增 `scripts/selftest-computer.mjs` 并挂进测试链。
- [ ] **真跑截屏**：自检里真 spawn PowerShell 截主屏 → 产出 PNG（验 8 字节 magic `89 50 4E 47`）→ mock attachments 收到 bytes → `render` 返回含 `{type:"image", attachment}` 的 ContentBlock 数组。
- [ ] **真跑路由门禁**：模型 route 不声明 image 输入时，工具报错拒绝（照 `assertImageCapableRoute` 语义，反向验证可红）。
- [ ] **真跑输入链路**：自检里真注入 `cursor_position → mouse_move → cursor_position`，坐标真变了且恢复原位（脚本失败则该段红）。
- [ ] **钩子分类逻辑**：纯函数单测——带 magic 标记的事件放行、无标记拦截；反向验证（把分类条件反过来）必须红。
- [ ] **审批语义**：mock approval——首次调用问、`allowed-once` 后本会话不再问、denied 后拒绝执行；三条各自可红。
- [x] **默认启用**（1.7.0 起，用户要求）：不带覆盖注册 7 个；`enabled:false` 一个不注册（反向验证：默认改回 false → 红）。
- [ ] 锁生命周期：操控空闲 15 秒自动解锁；插件 dispose 时钩子进程必死（不留孤儿进程，用 `taskkill /T` 验证）。
- [ ] `package.json` 版本 = `CHANGELOG.md` 首节标题；README 工具表/扩展表同步。

## 5. 已知约束（侦察出来的硬事实）

| 约束 | 证据 | 影响 |
| --- | --- | --- |
| Codex 没有操控电脑插件（前提修正） | researcher brief（降级声明：内部知识，未联网核对） | 参考对象改为 Anthropic computer use |
| 4 个 tier 全部声明 `input: [text, image]` | `~/.dsh/settings.yaml:10-50` | 截图可直接回传模型 |
| 工具回图机制 = `output.render` 返回 ContentBlock 数组 | `dsh-tools/lib/index.js:3422`；`dsh-tool-fs/lib/index.js:1022-1029` | 照抄 `imageReadContent` 形状 |
| 图片持久化 = `ctx.get('attachments').saveImage({data,mediaType,name})` | `dsh-tool-fs/lib/index.js:1089` | 截图字节入库拿 attachmentId |
| 模型无 image 能力时必须拒绝 | `dsh-tool-fs/lib/index.js:965-973`（`resolveModelInfo().inputModalities.includes("image")`） | 工具 execute 里做同款门禁 |
| `ctx.tools.register()` 要求 `output.schema` 是**编译好的 JSON Schema** | `dsh-tools/lib/index.js:2776`；本包 1.1.1 教训 | 参数表必须过 `toParameterSchema()` |
| 零依赖：不能 ESM import `@deepseek-ai/*` | STABILITY.md 信任假设 / 历史 ERR_MODULE_NOT_FOUND | 只走 `ctx.tools` + spawn 子进程 |
| 高 DPI 不先 `SetProcessDPIAware` 则坐标/分辨率错位 | researcher brief | 截图与注入脚本开头必须声明 DPI aware |
| UIPI：非提权进程无法向管理员窗口注入（静默无效） | researcher brief（Microsoft SendInput 文档，未核对） | §7 天花板；工具结果里如实回报 |
| 注入标记方案：SendInput 的 `dwExtraInfo` 可携带 magic，WH_MOUSE_LL 钩子读同字段分类 | researcher brief | 锁与注入共用同一标记常量 |
| 审批 seam：`ApprovalService.request()` → 结果为 `allowed-once` / `rejected` / `cancelled` / `unavailable` | `dsh-user-approval/lib/types/index.d.ts:97,26`；`ToolDefinition` 无审批字段（`dsh-tools/lib/types/index.d.ts:106`）；请求形状 `{agent, toolName, callId?, reason?}`（`types.d.ts:55-66`） | execute 内主动 request + 会话级 confirmed 集合；`unavailable`/`cancelled` 一律拒绝（fail-safe） |
| 常驻子进程先例：`ctx.effect()` 整体清理（abort + kill 全部活进程） | `dsh-tool-bash-persistent/lib/index.js:187`；本包 `lib/bash-linux.js:551,597,622` | 钩子进程挂 effect：stdin quit + `taskkill /T` 兜底 |
| 子进程生命周期清理惯例 `ctx.effect(() => dispose, label)` | 本包 `lib/index.js` 各挂载点 | 钩子进程必须挂 effect 清理 |

## 6. 方案

### 新增文件
- `lib/computer.js`（或拆 `lib/computer/` 下 tools+hook+ps 脚本内联）：注册 7 个工具 + 钩子进程管理 + 审批。
- `team/extensions/computer.json`：`enabled: true`（**1.7.0 起默认启用**，用户 2026-09-27 要求；`enabled:false` 可关；非 Windows 恒不注册）。
- `scripts/selftest-computer.mjs`：挂进 `npm test`。
- 改：`lib/index.js`（挂载点 + 注册表）、README、CHANGELOG、`package.json`（1.6.0）。

### 执行链（零依赖）
1. **截屏**：spawn `powershell -NoProfile`，内联 C#：`SetProcessDPIAware` → `Graphics.CopyFromScreen(全屏矩形)` → PNG 字节（stdout 或临时文件，注意 PNG 二进制走 base64/文件避免管道损坏）→ `attachments.saveImage` → 返回 `{image:{attachmentId,...}}`，`render` 出 `[text, image]`。
2. **输入注入**：同款内联 C# `SendInput`（MOUSEINPUT/KEYBDINPUT），**`dwExtraInfo = COMPUTER_MAGIC`**（与钩子共享常量）；光标绝对坐标用 0–65535 归一。
3. **鼠标锁**：spawn 常驻 `powershell` 钩子进程（WH_MOUSE_LL + 消息循环）：
   - `dwExtraInfo == COMPUTER_MAGIC` → 放行（AI）；否则 `return 1` 拦截（人）。
   - 父进程经 stdin 写 `arm`/`disarm`/`quit` 控制；stdout 读心跳/事件计数。
   - **fail-open**：钩子进程崩溃/断连 → 立即视为解锁，自动重启失败则报工具错误并保持解锁（宁可人能动，不能锁死用户电脑）。
   - **紧急逃生**：钩子内检测 `Ctrl+Alt+L` → 永久 disarm（本进程生命周期内不再拦截）。
   - 生命周期：会话**首次操控动作获批 → arm**；每次操控动作刷新空闲计时；**空闲 15s → disarm**（AI 停手就把鼠标还给人）；插件 dispose → stdin `quit` + `taskkill /T` 兜底。
4. **审批**：`ctx.get('approval')` 走 `ask → allowed-once`（细节按 scout 回报落）；插件内维护会话级 `confirmed` 集合实现「首次问、本会话放行」；screenshot **也要过审批**（截屏=看见整个屏幕，与操作同级）——若 scout 发现 dsh 有工具级免审声明，再降级为只拦操作类（在 §8 记录）。

### 为什么不选别的路
- 不用 `BlockInput`（用户已否）：要管理员、连 AI 自己一起拦、进程异常有键鼠锁死风险。
- 不用 `ClipCursor` 困角落（用户已否）：AI 动作瞬间要放开，留干扰窗口。
- 不改 dsh 内核装钩子：Node 装 Windows 钩子要原生模块，违反零依赖。

## 7. 天花板（做完之后仍不支持的）

- **向管理员权限窗口注入静默无效**（UIPI）——AI 点不到 UAC/管理员软件的按钮，工具结果只能如实说没生效。
- **多显示器 + 缩放未实测**：DPI aware 声明了，但跨屏坐标归一化要真机验证（§8 记录）；第一版目标主屏。
- **模型看图定位精度依赖 tier 模型**（deepseek flash 看截图点准不准未验证——真机验收 §8）。
- **真实物理鼠标未验证**（2026-09-28 诚实标注）：全部拦截测试用的都是**注入事件**
  （`mouse_event` / `SendInput`）。若真实鼠标或触控板走 Raw Input、或厂商驱动**直接**移动光标，
  `WH_MOUSE_LL` 可能拦不住 —— 这是「锁不住」的另一候选原因，需真机手动确认。
- **锁的窗口是「空闲 2 分钟」**：模型两次操作之间若思考超过 2 分钟，锁会自动松开。
  这是有意为之（否则 AI 跑神后用户会长时间失去鼠标）；但窗口太短时用户感受不到锁生效。
  立即取回鼠标：`Ctrl+Alt+L`。
- **锁不了键盘**（§3）；人仍可按 `Ctrl+Alt+L` 或拔键盘（预期行为）。
- **钩子进程是外部 PowerShell**：懒启动 —— 首次实操才冷启动（~1s，期间人事件不拦）；
  之后常驻到 dispose。装完不操作 = 零进程、零开销。
- **紧急解锁靠轮询探测**：改用 `ensureArmed()` 的 `status` 查询（`fs.watch` 会拴死
  宿主事件循环，Windows 上 unref 无效）；即「下一次操控动作时才发现已解锁」。
- **spool 目录可被 bash 直写**（第 3 层 P2）：模型若用 bash 往 `in/*.cmd` 写命令可绕过审批弹窗；但 dsh 的 bash 本就等价任意命令，这属既有信任边界、未新增能力 —— 不修，此处明记。
- 不做窗口管理/录屏/OCR/坐标辅助。

## 8. 验收记录

**2026-09-28 锁鼠标排查（用户反馈「锁不了鼠标，顶多让鼠标慢一点」）：**

- [x] 拦截机制有效性：外部进程高频注入 400 个非标记事件 → blocked +400（**全拦**）、光标不移
      → 结论：**不是拦不住**。
- [x] 无钩子基线 vs 过钩子耗时：2185ms vs 2132ms（各 500 事件）→ 钩子**零额外开销**。
- [x] 钩子响应性：把 `Sleep(15)` 加回钩子消息循环，比值仍 0.85
      → LL 钩子回调由系统**直接**调用、不受消息循环 sleep 影响
      → **耗时类断言无法区分好坏，已放弃**（硬写阈值只会变成 flaky）。
      钩子仍改为独立线程 + 紧消息循环（结构正确性）。
- [x] 定位真因：锁只在工具调用瞬间生效 + 15 秒空闲窗口 ≪ 模型思考间隔
      → 用户碰鼠标时锁几乎总是松的。默认窗口 15s → **2 分钟**。
- [x] 新增断言「锁定窗口必须盖得住模型思考时间（≥60s）」；反向验证（改回 15s）→ **红**。
- [x] 光标落点类断言全部改为守护进程自报计数（这台机器实测有 ~34 个合成鼠标事件/秒的噪声，
      位置断言必然假红）；修后 computer 自检全绿。
- [ ] **待真机确认**：用真实鼠标在锁定期内拖动，光标是否纹丝不动（见 §7 未验证项）。
**1.7.0（默认启用 + 两个真 bug 修复）实测：**

- [x] 默认启用：`COMPUTER_DEFAULTS.enabled = true`，无覆盖时 7 工具全注册。
      反向验证：默认改回 `false` → 「默认启用」自检红 → 恢复绿。
- [x] 显式关：`enabled:false` 一个工具都不注册（自检锚点）。
- [x] **`fs.watch` 拴死事件循环**（默认启用暴露）：实测 `selftest.mjs` EXIT=124 卡死 →
      注释掉 `fs.watch` 那行 → EXIT=0；改 `status` 轮询后 → EXIT=0 且连跑 2 次全量绿。
      期间用 `process.getActiveResourcesInfo()` 定位到 ref 着的 `PipeWrap`（非 unref 的假象：
      `_getActiveHandles()` 会把已 unref 的句柄也列出来，看它会被带偏）。
- [x] **自检互相污染**：`selftest-mc`/`selftest-context7` 未 dispose 留下守护进程 →
      computer 自检被别的实例钩子拦住（3 项红）→ 两处显式 `computer:{enabled:false}` → 全绿。
- [x] 全量 16 段连跑 2 次 EXIT=0、`✗` 计数 0、无残留守护进程。
- [x] 孤儿兜底：手动起守护进程后强杀宿主 → 守护进程随之消失（实测 pid 19716 GONE）。
      诚实说明：普通 `spawn` 下无法区分「父死自退检查」与「stdio 管道关闭」哪个生效，
      故不写自检断言（曾写一版「因错而对」的测试，反向验证不红，已删）。


（2026-09-27 实测；全部真实运行，无一条推断。）

- [x] `npm test` 全绿，新增 `scripts/selftest-computer.mjs`（第 16 段）
      → `npm test` → `EXIT=0`，无 ✗，16 段全过
- [x] 真跑截屏：daemon 真产 PNG，8 字节文件头验证 + saveImage mock 收到 bytes
      → `node scripts/selftest-computer.mjs` → 「截屏：daemon 真产 PNG（文件头验证在 attachments mock 里）」通过；
      截图内容位图真实（后续真机截屏见锁测试同进程）
- [x] 真跑路由门禁：不支持 image 的模型 route → 拒绝
      → 自检「路由门禁：模型不支持 image 输入 → 截屏拒绝」通过，saveImageCalls=0
- [x] 真跑输入链路：cursor_position → mouse_move → cursor_position 坐标真变且复位
      → 自检锁测试：armed 下 move (x+40,y+40) 坐标精确等于目标；结束复位 `deepEqual(startPos)` 通过
- [x] 钩子分类端到端反向验证：C# 拦截条件翻转 → 自检红
      → 把 `if (m.dwExtraInfo != (IntPtr)MAGIC) return 1` 改成 `==` → 「锁」「空闲解锁」2 项失败；恢复 → 绿
- [x] 审批语义三条各自可红
      → 首次问/同会话不问/新会话重问 均真跑通过；反向 `allowsOutcome` 恒真 → 3 项红（纯函数 + 首次询问 + allowed-once）
- [x] 默认关反向验证
      → 把 `COMPUTER_DEFAULTS.enabled` 改 `true` → 「默认关：…一个工具都不注册」红；恢复 → 绿
- [x] 锁生命周期：空闲 15s 解锁（自检用 900ms 缩时）+ 钩子死 fail-open + dispose 杀进程不留孤儿
      → 自检「空闲自动解锁」（status 命令断言 armed 0）、「fail-open」（重启后 fakehuman 能动）、「dispose：进程死+目录清」全过
- [x] 紧急解锁闩：Ctrl+Alt+L → 操控类工具停用（截屏不受影响）
      → 自检：真注入 ctrl+alt+l → 钩子写事件 → mouse_move/mouse_click 返回 EMERGENCY_REFUSAL
- [x] 16 段自检稳定绿（修复竞态后连跑 3 次 + 全量 2 次 EXIT=0）
- [x] `package.json` 1.6.0 = `CHANGELOG.md` 首节；README 功能表/自检节、STABILITY 工具表（7 行）与配置文件数（12）已同步

**真机人工验收（自检不能覆盖，待用户过一遍）**：

- [ ] 把 `team/extensions/computer.json` 的 `enabled` 改 `true` + 重启 dsh，问模型「截个图」→
      看到审批弹窗（首次）→ 模型能描述屏幕内容；`/team-baseline` 显示「操控电脑：开」
- [ ] 让 AI 点一个真实按钮 + 打一行中文：确认注入有效（注意：向管理员窗口注入静默无效是 UIPI 预期）
- [ ] AI 连续操作期间碰鼠标：人不应能移动光标；停手 15s 后恢复；按 Ctrl+Alt+L 立即恢复并停用操控工具

**踩过的坑（已写进实现注释）**：

1. Windows PowerShell 5.1 用 `-File` 读**无 BOM 的 UTF-8 中文脚本按 GBK 解码** → 假报解析错；
   脚本必须带 `\uFEFF` BOM 写入（ParseInput 同内容零错、ParseFile 报错的对账定位）。
2. `param()` 必须是脚本第一条语句。
3. PowerShell 没有 `[ushort]` 类型加速器，要用 `[uint16]`。
4. kill 旧守护进程后其 `exit` 事件会迟到 —— handler 必须只清自己实例的句柄，
   否则误清新进程句柄 → 启动误报失败（间歇性，连跑 3 次才重现）。
5. KEYEVENTF_UNICODE 与 wVk 互斥：打字用 wScan+UNICODE、组合键用 wVk，不能混。
6. 系统指针加速会让 mouse_event 相对位移 ≠ 输入值，断言只能断方向。
