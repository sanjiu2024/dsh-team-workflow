/**
 * 子代理的模型价目表 + 按难度选择的规则（REQ-036 第二半）。
 *
 * ## 为什么要在系统提示里常驻一张价目表
 *
 * 三档工具行开了 `modelSelectionSettings` 之后，模型**能**传 `provider` / `model` ——
 * 但「能传」不等于「会传对」。2026-11-10 用户的原话是「让主 agent 在调用子 agent 的时候
 * 先看一眼每个模型的价目表，再依照任务难度来选择」。
 *
 * 不给它价格，它会做两件蠢事：① 一律用默认档（贵活便宜活一个价，要么浪费要么返工）；
 * ② 偶尔挑个最贵的去做琐事（`kimi-k3` 输出 $85.5/M，一次长回答能顶几十次 flash）。
 *
 * 所以这张表里除了价格，还有**延迟**和**适合什么**——只有价格没有用途，模型还是不会选。
 *
 * ## 为什么常驻而不是做成工具
 *
 * 做成工具（`model_price`）需要模型**主动想起来调用**，而「想起来」正是最不可靠的一环。
 * 它每轮都在，成本约 1.2k token；按 0.7 的压缩阈值算，相对每次派活省下的钱可以忽略。
 * 真要省，改 `team/agent-settings.json` 里 `modelSelection.menuInPrompt: false` 关掉。
 *
 * ## 价格是外部事实，会过期
 *
 * 表里的单价来自 2026-11-10 用户中转站 `zzcraft.cn` 的价格页（截图逐条核对）。
 * 它不是代码算出来的，改价时改这个文件即可 —— 所以放在 `MENU` 常量里，一眼能看全。
 *
 * @module dsh-team-workflow/model-menu
 */

/** 注入顺序：在团队基线（order 见 baseline.js）之后，红队指挥稿附近。 */
export const MODEL_MENU_ORDER = 645;

/**
 * 一个模型一行。字段顺序就是表里的列顺序。
 *
 * `latency` 是中转站实测的首 token 时间（截图上标的「延迟」），为空表示站上没数据。
 * `use` 是**什么时候该用它**——这一列比价格更重要，模型是按任务描述去匹配的。
 */
const MENU = [
	// —— 便宜档：日常活先用这层 ——
	{
		model: "deepseek-v4.1-flash",
		in: "0.105",
		out: "0.42",
		cache: "0.0021",
		latency: "15.3s",
		use: "**默认**。读代码、改几行、跑测试、写文档 —— 八成的活它够用",
	},
	{
		model: "glm-5.3-flash",
		in: "0.48",
		out: "1.61",
		cache: "0.096",
		latency: "1.2s",
		use: "**最快**（1.2s）。一次扇出多个子代理、或要反复来回问的活，总耗时最短",
	},
	{
		model: "claude-haiku-5-5",
		in: "0.57",
		out: "2.85",
		cache: "0.057",
		latency: "7.4s",
		use: "**审查/判断**类（power 档默认）—— 只凭材料出意见、不探索仓库",
	},
	{
		model: "qwen3.8-flash",
		in: "0.73",
		out: "2.29",
		cache: "0.078",
		latency: "12.5s",
		use: "中文理解、中文文档/注释的活",
	},
	{
		model: "deepseek-v4-pro",
		in: "0.462",
		out: "1.386",
		cache: "0.0154",
		latency: "",
		use: "中等复杂实现：要多步规划、要改多个文件，但不需要架构决策",
	},
	{
		model: "minimax-m3",
		in: "0.96",
		out: "3.85",
		cache: "0.19",
		latency: "",
		use: "长文档、多模态输入的活",
	},
	{
		model: "nvidia/nemotron-3-ultra-550b-a55b:free",
		in: "0/次",
		out: "",
		cache: "",
		latency: "",
		use: "免费但按次计费、稳定性没保障。只做**可以重试**的粗活（初步筛一遍、粗分类）",
	},

	// —— 中档：上面那层做不动才上 ——
	{
		model: "kimi-k2.7-code",
		in: "3.05",
		out: "12.85",
		cache: "0.61",
		latency: "",
		use: "代码专项：大重构、跨文件一致性改造",
	},
	{
		model: "glm-5.3",
		in: "7.98",
		out: "25.08",
		cache: "1.48",
		latency: "",
		use: "复杂推理、架构决策、方案取舍",
	},
	{
		model: "glm-5.2",
		in: "4.50",
		out: "14.13",
		cache: "",
		latency: "",
		use: "已被 5.3 取代，**尽量不用**（留着只是为了让白名单完整）",
	},

	// —— 贵档：明确说得出理由再用 ——
	{
		model: "gemini-4-argon",
		in: "9.74",
		out: "48.71",
		cache: "1.06",
		latency: "",
		use: "需要超大上下文（1M）一次吞下整份材料",
	},
	{
		model: "qwen3.8-max",
		in: "11.4",
		out: "34.2",
		cache: "1.43",
		latency: "",
		use: "中文极难任务（flash 反复做不对时）",
	},
	{
		model: "grok-4.7",
		in: "11.4",
		out: "34.2",
		cache: "2.85",
		latency: "",
		use: "上面都试过仍不行时的备选",
	},
	{
		model: "kimi-k3",
		in: "17.1",
		out: "85.5",
		cache: "1.71",
		latency: "1.1s",
		use: "**最贵**（输出 $85.5/M）。只在便宜档与中档都失败、且这活确实值这个钱时才用",
	},
];

/** 一行表格。空值显示成 `—`，避免表格错位。 */
function row(entry) {
	const cell = (value) => (value === "" ? "—" : value);
	const price = entry.out === "" ? `${entry.in}` : `$${entry.in} / $${entry.out}`;
	const cache = entry.cache === "" ? "" : ` / $${entry.cache}`;
	return `| \`${entry.model}\` | ${price}${cache} | ${cell(entry.latency)} | ${entry.use} |`;
}

/**
 * 生成注入文本。
 *
 * @param {{ provider?: string }} [options] 白名单里那些 route 的 provider（默认 tumianyue-api）
 * @returns {string}
 */
export function modelMenuText({ provider = "tumianyue-api" } = {}) {
	const lines = [
		"## 派子代理：先看价目再选模型",
		"",
		"三个档位工具都支持现场指定模型（`provider` / `model` / `reasoning_effort`）。",
		"**先按下面这张表估一下这一步值多少钱，再按任务难度挑** —— 不要一律用默认档（贵活便宜活一个价），",
		"也不要拿最贵的去做琐事。",
		"",
		`价格单位：美元 / 100 万 token（输入 / 输出 / 缓存读）。延迟是中转站实测的首 token 时间。全部走 \`${provider}\`。`,
		"",
		"| 模型 | 输入 / 输出 / 缓存读 | 延迟 | 什么时候用它 |",
		"| --- | --- | --- | --- |",
		...MENU.map(row),
		"",
		"### 怎么选",
		"",
		"1. **默认 `deepseek-v4.1-flash`**。改几行、读代码、跑测试、写文档 —— 先想它，够用就别升。",
		"2. **先估这一步值多少钱**：改一行却派 `kimi-k3`（输出 $85.5/M）是浪费；反过来用 flash 做架构决策会返工，那更贵。",
		"3. **审查/判断一律 `claude-haiku-5-5`**（power 档默认）：只凭材料出意见，快且便宜。",
		"4. **一次扇出 5 个以上子代理**用 `glm-5.3-flash`（延迟 1.2s）—— 便宜不是重点，总耗时短才是。",
		"5. **升档要能说出理由**。说不出「为什么 flash / v4-pro 做不了」，就别升。",
		"6. **用了中档以上在结论里写一句用了哪个模型**，便于事后核成本。",
		"",
		"不指定 `provider` / `model` 时用档位默认值：`subagent_std` = tumianyue-api/deepseek-v4.1-flash，",
		"`subagent_power` = tumianyue-api/claude-haiku-5-5，`subagent_fork` 继承父会话。",
	];
	return lines.join("\n");
}

/**
 * 装进系统提示。
 *
 * @param {object} ctx 插件上下文（需要 `systemPrompt`）
 * @param {{ enabled?: boolean, provider?: string }} [options]
 * @returns {(() => void) | undefined} disposer；没开时返回 undefined
 */
export function installModelMenu(ctx, { enabled = true, provider } = {}) {
	if (enabled !== true) return undefined;
	if (typeof ctx?.systemPrompt?.section !== "function") return undefined;
	return ctx.systemPrompt.section({
		name: "team:model-menu",
		order: MODEL_MENU_ORDER,
		text: modelMenuText({ ...(provider === undefined ? {} : { provider }) }),
	});
}
