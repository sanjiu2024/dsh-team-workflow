#!/usr/bin/env node
/**
 * 工具结果的**字符预算**（REQ-040）。
 *
 * 为什么要有：外部工具（MCP / magic-context 那批 `ctx_*`）的结果是**原样**进上下文的。
 * 一次 `ctx_expand` 能吐几万字符，`ctx_search` 十条命中叠起来也一样 —— 而上下文地板是
 * 每次调用都要重发一遍的（cacheRead 占总量 98%），**一条大结果会跟着你走到会话结束**。
 *
 * 依据：arXiv 2611.12068（MIRIX-2.0）—— 检索/取回要跑在**显式预算**下，证据量不随历史增长。
 * 同一条原则我们已经在 `lib/session-recall.js` 的 `RECALL_MAX_CHARS` 上用过一次。
 *
 * 三个设计取舍：
 * 1. **保头留尾**，不是只砍尾巴：工具的结论常在末尾（错误、汇总、退出码）。
 * 2. **截断必留标记**，并且告诉模型**下一步该怎么做**（缩小参数），而不是只说「截断了」——
 *    静默截断是最坏的一种，说清但不说怎么办是第二坏的。
 * 3. **不上 LLM 摘要**：这条路径在工具结果回来的地方，没有模型可调，也不该有。
 */

/** 默认预算：3 万字符 ≈ 8–10K token。可按工具覆盖。 */
export const TOOL_BUDGET_DEFAULTS = {
	maxChars: 30000,
	/** 头部占比。尾部留 30% 给结论/报错。 */
	headRatio: 0.7,
	/** 低于这个长度不做任何事 —— 省掉无谓的字符串操作。 */
	minChars: 2000,
};

/**
 * 按预算裁剪一段工具结果。
 *
 * @param {unknown} text 工具返回的文本（非字符串一律当空串，绝不抛 —— 这是在工具返回路径上）
 * @param {{maxChars?: number, headRatio?: number, toolName?: string}} [opts]
 * @returns {string}
 */
export function capToolText(text, opts = {}) {
	const s = typeof text === "string" ? text : "";
	const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : TOOL_BUDGET_DEFAULTS.maxChars;
	const headRatio =
		typeof opts.headRatio === "number" && opts.headRatio > 0 && opts.headRatio < 1
			? opts.headRatio
			: TOOL_BUDGET_DEFAULTS.headRatio;
	const toolName = typeof opts.toolName === "string" ? opts.toolName : "";

	if (s.length <= Math.max(maxChars, TOOL_BUDGET_DEFAULTS.minChars)) return s;

	const head = Math.floor(maxChars * headRatio);
	const tail = Math.max(0, maxChars - head);
	const name = toolName ? `「${toolName}」` : "";
	const marker = `\n[… ${name}结果 ${s.length} 字符，超出 ${maxChars} 预算；中间 ${s.length - head - tail} 字符已省略。要看全量请缩小参数（分页 / 加过滤 / 限定路径 / 更小的 limit），不要原样重试 …]\n`;
	return `${s.slice(0, head)}${marker}${tail > 0 ? s.slice(-tail) : ""}`;
}
