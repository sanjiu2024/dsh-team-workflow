/**
 * 模型价目表 —— 让主 agent **在选模型之前**就知道每个模型多少钱。
 *
 * 为什么要有它（2026-10-31 用户要求）：
 *   `squad_spawn` 早就能传 `model` / `provider`，但模型此前只能按「档位」选 —— 而档位是别名，
 *   **看不到钱**。用户的原话是「选择前必须要知道每款模型的定价，再进行选择，并且要为用户考虑
 *   token 费用」。所以这里补的是**决策依据**，不是新的调度能力：
 *     主 agent → `model_price`（本模块）→ 拿到单价与「一次典型任务的估算花费」→ 再决定派谁。
 *
 * 三条设计约束：
 *   ① **不猜价**。表里没有的模型一律显示「价格未知」，绝不用别的模型的价代替 ——
 *      拿错价做便宜选择，比不做选择更糟。
 *   ② 单价和**估算**分开给。单价是每 100 万 token 的美元价；估算用一组可配的
 *      「典型输入/输出 token 数」把单价翻译成「这一趟大概多少钱」，否则 0.15 vs 0.66 很难比。
 *   ③ 单位统一为 **USD / 1M tokens**，字段名就叫 `input` / `output` / `cacheRead`，
 *      不搞 per-1K 与 per-1M 混用 —— 这是价目表最容易出错的地方。
 */
import { toParameterSchema } from "./util.js";

/** 段名与段序：紧挨 `team:baseline`(600) 之前，排在个人指令(650)之后。 */
export const PRICING_SECTION = "team:pricing";
export const PRICING_ORDER = 640;

export const PRICING_DEFAULTS = {
	enabled: true,
	/** 价目表货币。现在只有 USD；写别的也不会自动换算，只用于显示。 */
	currency: "USD",
	/**
	 * 「一次典型子代理任务」的 token 量，用来把单价换算成可比较的花费。
	 * 改这两个数不影响单价，只影响估算列。
	 */
	sampleInputTokens: 60000,
	sampleOutputTokens: 6000,
	/** 见 team/extensions/pricing.json 的 models 数组；每项一条模型。 */
	models: [],
};

export const PRICING_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	currency: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	sampleInputTokens: (v) => (Number.isFinite(v) && v >= 0 ? v : undefined),
	sampleOutputTokens: (v) => (Number.isFinite(v) && v >= 0 ? v : undefined),
	models: (v) => (Array.isArray(v) ? v : undefined),
};

/** 单价有效判据：有限非负数才算"知道价格"，其余一律当未知（不拿 0 冒充免费）。 */
const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 按 id 找模型条目；大小写敏感（模型 id 本来就区分大小写）。 */
export function findModel(models, id) {
	const want = String(id ?? "").trim();
	if (want === "") return undefined;
	return (models ?? []).find((entry) => String(entry?.id ?? "").trim() === want);
}

/** 这个条目是不是有可用价格（input / output 都要有）。 */
export function hasPrice(entry) {
	return Boolean(entry) && isPrice(entry.input) && isPrice(entry.output);
}

/**
 * 估算一次调用的花费（USD）。
 *
 * @returns {{ ok: boolean, usd?: number, why?: string }}
 *   `ok:false` 时 `why` 说清缺什么 —— 调用方要把这句话原样给模型看，
 *   而不是回一个 0（0 会被读成"免费"）。
 */
export function estimateCost(entry, { input = 0, output = 0, cacheRead = 0 } = {}) {
	if (!entry) return { ok: false, why: "价目表里没有这个模型" };
	if (!isPrice(entry.input) || !isPrice(entry.output)) return { ok: false, why: "这个模型的价格未知" };
	const perM = 1e6;
	let usd = (input / perM) * entry.input + (output / perM) * entry.output;
	if (isPrice(entry.cacheRead)) usd += (cacheRead / perM) * entry.cacheRead;
	return { ok: true, usd };
}

/** 钱太小的时候别显示成 0.00，否则看起来像免费。 */
export function formatUsd(usd) {
	if (!Number.isFinite(usd)) return "—";
	if (usd === 0) return "$0";
	if (usd < 0.0001) return "<$0.0001";
	if (usd < 1) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

/**
 * 把价目表渲染成给模型看的一段文本。
 *
 * 按**估算价从便宜到贵**排序 —— 主 agent 要的正是这个顺序，别让它自己再排一遍。
 */
export function formatCatalog(config) {
	const models = Array.isArray(config?.models) ? config.models : [];
	const cur = config?.currency ?? "USD";
	const inTok = config?.sampleInputTokens ?? PRICING_DEFAULTS.sampleInputTokens;
	const outTok = config?.sampleOutputTokens ?? PRICING_DEFAULTS.sampleOutputTokens;
	const lines = [];
	lines.push(
		`模型价目（${cur} / 每 100 万 token；估算按一次任务 输入 ${inTok.toLocaleString()} + 输出 ${outTok.toLocaleString()}）`,
	);
	lines.push("");
	if (models.length === 0) {
		lines.push("（价目表是空的 —— 在 team/extensions/pricing.json 的 models 里加条目）");
		return lines.join("\n");
	}
	const rows = models.map((entry) => {
		const name = String(entry?.label ?? entry?.id ?? "(无 id)");
		const id = String(entry?.id ?? "");
		const provider = String(entry?.provider ?? "—");
		const flags =
			(entry?.verified === true ? "" : "*") + (entry?.idGuess === true ? "†" : "") || " ";
		if (!hasPrice(entry)) {
			return { name, id, provider, price: "价格未知", est: Number.POSITIVE_INFINITY, estText: "不能拿它当便宜方案", flags: "?" };
		}
		const est = estimateCost(entry, { input: inTok, output: outTok });
		const cache = isPrice(entry.cacheRead) ? ` · cache ${entry.cacheRead}` : "";
		const limit = Number.isFinite(entry.monthlyLimitUsd) ? ` · 月额度 $${entry.monthlyLimitUsd}` : "";
		return {
			name,
			id,
			provider,
			price: `in ${entry.input} · out ${entry.output}${cache}${limit}`,
			est: est.ok ? est.usd : Number.POSITIVE_INFINITY,
			estText: est.ok ? `${formatUsd(est.usd)} / 次` : "价格未知",
			flags,
		};
	});
	rows.sort((a, b) => a.est - b.est);
	for (const row of rows) {
		lines.push(`${row.flags.padEnd(2)} ${row.name}  (${row.provider})`);
		lines.push(`     ${row.price}  → ${row.estText}`);
		if (row.id !== "" && row.id !== row.name) lines.push(`     id: ${row.id}`);
	}
	lines.push("");
	if (rows.some((r) => r.flags.includes("*"))) lines.push("`*` = 价格没跟真实账单核对过。");
	if (rows.some((r) => r.flags.includes("†"))) lines.push("`†` = 模型 id 是按文档名推的，**没跟 /models 核对过**，真派活前先确认一次。");
	if (rows.some((r) => r.flags.includes("?"))) lines.push("`?` = 价格未知：**别**拿它跟别的模型比谁便宜，那是猜的。");
	lines.push("选模型：先看这活值不值得用贵的 → 再看估算价差 → 最后才看能力。");
	return lines.join("\n");
}

/**
 * 挂上系统提示段 + `model_price` 工具。
 *
 * 提示段很短（两行），因为它的作用是**提醒去查**，不是把价目表塞进每一步的地板 ——
 * 价目表本身走工具按需取。
 */
export function installPricing(ctx, config) {
	const cfg = { ...PRICING_DEFAULTS, ...(config ?? {}) };
	const disposers = [];
	if (cfg.enabled === false) return { dispose: () => {} };

	if (Array.isArray(cfg.models) && cfg.models.length > 0) {
		disposers.push(
			ctx.systemPrompt.section({
				name: PRICING_SECTION,
				order: PRICING_ORDER,
				text:
					"派子代理 / 子任务前先调 `model_price` 看每个模型的价格与「一次任务估算价」——" +
					"用户在为 token 付费：能用便宜的别用贵的，贵模型留给真的需要它的活。价格未知的模型不要拿来当便宜方案。",
			}),
		);
	}

	const text = () => ({
		schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
		render: (_args, value) => [{ type: "text", text: value.text }],
	});

	disposers.push(
		ctx.tools.register({
			name: "model_price",
			description:
				"列出可派给子代理的模型及其**价格**（每 100 万 token）与「一次典型任务估算花费」，按估算价从便宜到贵排序。" +
				"**在 `squad_spawn` / 子任务里选 `model` 之前先调它** —— 用户在为 token 付费，先看价再选。" +
				"标 `?` 的模型价格未知：不要拿它跟别的模型比便宜。",
			parameters: toParameterSchema({}),
			output: text(),
			async execute() {
				return { text: formatCatalog(cfg) };
			},
		}),
	);

	return {
		dispose: () => {
			for (const d of disposers) {
				try {
					if (typeof d === "function") d();
				} catch {
					/* 宿主这一版可能不返回 disposer */
				}
			}
		},
	};
}
