# REQ-005：思考链/工具行默认展开（适配 dsh 0.2.0-rc.x）

状态：已完成 · 2026-10-04

## 1. 要做什么

让 `dsh-team patch` 在 dsh 0.2.0-rc.x 上可用：**思考链和工具行默认展开**。
用户的原话：「我的工具和思考怎么不会自动展开了」。

## 2. 不做什么

- **不展开其它可折叠行**（用户 2026-10-04 选定方案 A）。压缩条目、系统提示、
  文件行、`ChatGroupSeat`、`QuestionToolRow` 这些同样调 `useDisclosure()` 的行
  一律不动 —— 这是这个补丁从第一天起的克制，rc.x 重构后依然守住。
- 不改 dsh、不给它提 PR（改的是安装树，属于本地补丁）。
- 不做持久化保护：npx 缓存被清或 dsh 升级后补丁会失效，重跑 `dsh-team patch` 即可。

## 3. 验收标准（可执行）

1. `dsh-team patch --status` 能列出两个 client.js 与四行状态（思考链 /
   展开默认值 / 工具行通用 / 工具行终端），且**未打补丁时不能报成已打**。
2. `dsh-team patch` 之后上面前四行为 `✓ 已打补丁`；`--status` 复检一致。
3. 落盘可验证：chat bundle 里能 grep 到
   `function useDisclosure(version = 0, defaultOpen = false)` 与
   `useState)(defaultOpen ? version : null)`；两个 bundle 里各有
   `useDisclosure(0, true)` 的调用点（chat 1 处、tool 2 处）。
4. 页面刷新后：思考链与工具行默认展开，点一下能收起；压缩条目等其它行**不受影响**。
5. `node scripts/selftest-patch.mjs` 全绿（含 rc.x 一节：memo 包装 + 共享 hook +
   分发器改名 + 「不碰别的组件」+「老形态仍然认」）。
6. `dsh-team patch --restore` 能把两个文件还原成打补丁前的字节（原有能力不许回归）。

## 5. 已知约束（实测）

1. 这两个展开态在 dsh 里**没有任何配置入口**，组件也没导出，所以只能改
   `@deepseek-ai/dsh-client-ui-{chat,tool}/lib/client.js`。
2. rc.x 的组件形态：`const X = (0, react.memo)(function X(` —— `function` 不在行首，
   老锚点 `\n\t*function X(` 失效；组件窗口的结束点也得把 `const` 声明算上，
   否则窗口会跨过后面同样是 memo 包装的组件。
3. rc.x 的折叠状态在共享 hook `useDisclosure(version = 0)` 里（定义在 **chat**
   bundle，以 **prop** 传给 tool bundle 的 ToolRow/BashRow）：
   `expanded = (expandedVersion === version)`，初始 `expandedVersion = null`。
4. rc.x 的终端行组件叫 `StartedBashRow`；`BashRow` 还在，但只剩分发器 ——
   只按名字找会挑中一个没有展开态的窗口。
5. web profile 的 `@deepseek-ai/*` 从**安装树**（npx 目录）解析，不在 profile 的
   node_modules 里；发现逻辑必须带上安装树，否则连文件都找不到。

## 6. 方案

- `discoverBundles(profilesRoot, installRoots)`：安装树从 PATH 上的 `dsh` 反推。
- `patchBundle` 认两种形态：老形态改 `useState(false)`；rc.x 形态改
  `useDisclosure()` 调用点 → `useDisclosure(0, true)`。
- `patchDisclosureHook(text)`：给 hook 加 `defaultOpen` 形参，初始值取
  `defaultOpen ? version : null`（toggle 逻辑不用动）。只在 chat bundle 跑一次，
  旧形态下报 `missing` 但不打扰用户。
- `disclosureHookStatus(text)`：**现状查询**，与 apply 分开 —— 混用会把没打的
  报成「已打补丁」。
- TARGETS 支持 `altName`，并在两个名字都命中时挑「窗口里真有展开态」的那个。

## 7. 用户要做的

刷新页面（客户端 HMR 通常 0.5 秒内自更新，不刷新也行）。
dsh 升级或 npx 缓存被清之后重跑一次 `dsh-team patch`。

## 8. 验收记录

| 验收标准 | 实际命令 / 输出 |
| --- | --- |
| 1 | `dsh-team patch --status` → 四行全「未打补丁」（修正前误报「已打补丁」） |
| 2 | `dsh-team patch` → 四行 `✓ 已打补丁`；`--status` 复检一致 |
| 3 | `grep` → `function useDisclosure(version = 0, defaultOpen = false)`、`useState)(defaultOpen ? version : null)`；`useDisclosure(0, true)` 在 chat 1 处、tool 2 处 |
| 4 | 待用户刷新页面确认（本机无法自动断言渲染结果） |
| 5 | `node scripts/selftest-patch.mjs` → `✓ 思考链/工具行展开补丁自检通过`，退出码 0 |
| 6 | 自检里的 apply → status → restore 全流程已覆盖并通过 |
