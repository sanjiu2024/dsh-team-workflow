#!/usr/bin/env node
/**
 * 确定性折叠（REQ-018 的 ①）：**不调 LLM** 的压缩 —— 逐字**选择**保留什么、丢掉什么，
 * 不重写、不摘要。本文件是**纯函数**部分（同输入必同输出），引擎那半在 `compaction-fold.js`。
 *
 * ## 为什么是「选择」而不是「摘要」
 *
 * - 「确定性 + 逐字 + 显式丢失标记」是压缩方案里唯一**不需要信任模型**的一类（arXiv 2610.20116）；
 * - 唯一一次同条件头对头（pi-fold，Zenodo 22142456，2026-08-28）：给了窗口外存储 + 取回通道之后，
 *   折叠与原生压缩**打平**，成本只有一半；
 * - 另一条实测（arXiv 2608.16370）：**改压缩强度不影响完成率**，随机选条目 ≈ 离线最优 ——
 *   所以「选得聪明」边际收益很小，**「别丢原文、丢了要说清」**才是重点。
 *
 * 结论：不猜模型想要什么，只按**类型**决定保什么，并且**明说丢了什么**。
 *
 * ## 保什么（确定性规则，没有例外）
 *
 * | 类型 | 处理 | 理由 |
 * | --- | --- | --- |
 * | `user` | **逐字全留**（超长粘贴裁首尾） | 那是需求本身，压掉它等于改需求 |
 * | `user`（**更早的 checkpoint**） | 只留首尾 | 它已经是摘要了；逐字留会让「折叠加折叠」，实测留存率 83% |
 * | `tool` | 首尾 + 中段标记 | 工具输出是环境事实，中段最可丢（与 `tool-result-pruner` 同策） |
 * | `assistant` | 首尾 + 中段标记 | 助手的长推理可丢，结论通常在两端 |
 *
 * 输出是 **markdown 结构**（`##` 标题 + `-` 条目）—— 这不是装饰：② 的出处过滤按这个结构
 * 逐条判出处，而这里留下的都是**逐字原文**，所以天然「有环境支撑」。
 *
 * ## 丢东西必须说清
 *
 * 产物末尾固定带一行「确定性折叠」说明：多少条消息、保了多少字符、丢了多少字符、原文去哪取。
 * 静默丢内容比不压缩更危险 —— 模型会以为自己看到了全部。
 */

/** 出厂裁剪预算（字符）。工具输出最值得多留，助手推理最少。 */
export const FOLD_DEFAULTS = {
	toolHead: 1200,
	toolTail: 400,
	assistantHead: 400,
	assistantTail: 200,
	// 用户消息：常规长度**逐字全留**（那是需求本身）；只有超长粘贴才裁首尾。
	// 上限定得比别处宽 —— 需求被裁掉比工具输出被裁掉严重得多。
	userHead: 4000,
	userTail: 500,
};

/** 目标留存率：折叠产物最多占被压内容的这个比例（宿主还有一道「摘要必须更小」的闸）。 */
export const FOLD_TARGET_RATIO = 0.35;

/** 中段被裁时的标记（沿用 tool-result-pruner 的措辞，读日志的人一眼认得出）。 */
export const FOLD_MARKER = " [… 中段已折叠 …] ";

/** 从消息的 content 里取纯文本（块数组拼 text 块；字符串直接用）。 */
export function contentText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
	}
	return "";
}

/** 首尾裁剪：短于预算就原样返回；否则 head + 标记 + tail。`head=0 && tail=0` 表示不裁。 */
export function headTail(text, head, tail) {
	if (head === 0 && tail === 0) return text;
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}${FOLD_MARKER}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** 一行里有没有「值得整行留下」的东西（命令 / 路径 / 错误）—— 用于助手文本挑结论行。 */
export function looksImportant(line) {
	return /(\b(error|failed|失败|报错|exception|traceback)\b|[\w./-]+\.(js|mjs|cjs|ts|json|md|py|sh)\b|`[^`]+`|\$\s|\bgit\s|\bnpm\s|\bnode\s)/i.test(
		line,
	);
}

/**
 * 折叠一串模型侧消息，产出 checkpoint 正文。
 *
 * @param {Array<{role?: string, content?: unknown}>} messages 待压缩区间的模型侧消息（按时间序）
 * @param {Partial<typeof FOLD_DEFAULTS>} [opts] 裁剪预算
 * @returns {{text: string, stats: {messages: number, keptChars: number, droppedChars: number, truncated: number}}}
 */
export function foldMessages(messages, opts = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const targetRatio = typeof opts.targetRatio === "number" ? opts.targetRatio : FOLD_TARGET_RATIO;
	const inputChars = list.reduce((n, m) => n + contentText(m).length, 0);

	// 逐条预算是**不够**的：真实会话里 20 条工具结果 × 每条 1600 字符 = 3 万字符，留存率 83%
	// （拿真实日志跑出来的）。所以外面再套一层**全局**预算：超了就整体减半重折，直到装下。
	// 全程确定性（减半是确定的，没有随机、没有时间），且用户原话最后才动。
	let last = null;
	let usedScale = 1;
	for (let round = 0; round < 12; round += 1) {
		const shrinkUsers = round >= 4; // 前 4 轮护住用户原话，之后才动它
		const factor = round < 4 ? 2 ** round : 2 ** (round - 3);
		usedScale = 1 / factor;
		last = foldOnce(list, { ...opts, scale: usedScale, shrinkUsers });
		if (inputChars === 0 || last.text.length <= inputChars * targetRatio) break;
	}
	// 最后一道硬保证：**产物必须小于被压内容**。区间里全是短消息时，逐条预算根本咬不住
	// （每条都没超预算 → 一个字符都裁不掉），留存率就是 100% —— 而 basic 有一道
	// 「摘要不比被压内容小就 throw」的闸，那会让压缩**直接失败**。所以装不下就硬截断，
	// 并且在说明里写明「连折叠产物本身也被截断了」：静默截断是最坏的一种。
	// 注意这里**不是** targetRatio：35% 是目标，不是不变量。真正的不变量是「比被压内容小」
	// （basic 那道闸比的是 framed token vs 路由价）。所以安全线取 90% —— 一条 3000 字符的
	// 用户原话本来就没得压，硬按 35% 砍它等于改需求。极小区间（<200 字符）不启用：
	// 那种区间压根不该被压，引擎会自己拒绝。
	const hardLimit = Math.floor(inputChars * 0.9);
	if (inputChars >= 200 && last.text.length > hardLimit) {
		const noteAt = last.text.lastIndexOf("\n\n（确定性折叠：");
		const body = noteAt > 0 ? last.text.slice(0, noteAt) : last.text;
		const note = noteAt > 0 ? last.text.slice(noteAt) : "";
		const room = Math.max(0, hardLimit - note.length - 40);
		last = {
			text: `${body.slice(0, room)} [… 折叠产物本身也被截断 …]${note}`,
			stats: { ...last.stats, hardTruncated: true },
		};
	}
	return { ...last, stats: { ...last.stats, inputChars, targetRatio, scale: usedScale } };
}

/** 折一遍（固定预算）。`shrinkUsers=false` 时用户原话不受 `scale` 影响。 */
function foldOnce(list, opts) {
	const scale = typeof opts.scale === "number" ? opts.scale : 1;
	const base = { ...FOLD_DEFAULTS, ...opts };
	const cut = (n) => (n === 0 ? 0 : Math.max(40, Math.round(n * scale)));
	const budget = {
		toolHead: cut(base.toolHead),
		toolTail: cut(base.toolTail),
		assistantHead: cut(base.assistantHead),
		assistantTail: cut(base.assistantTail),
		userHead: opts.shrinkUsers ? cut(base.userHead) : base.userHead,
		userTail: opts.shrinkUsers ? cut(base.userTail) : base.userTail,
	};
	const users = [];
	const priors = [];
	const tools = [];
	const assistants = [];
	let keptChars = 0;
	let droppedChars = 0;
	let truncated = 0;
	let priorCheckpoints = 0;

	const take = (text, head, tail) => {
		const folded = headTail(text, head, tail);
		keptChars += folded.length;
		droppedChars += Math.max(0, text.length - folded.length);
		if (folded.length !== text.length) truncated += 1;
		return folded;
	};

	for (const message of list) {
		const role = message?.role;
		const text = contentText(message).trim();
		if (text === "") continue;
		if (role === "user") {
			// **上一轮的 checkpoint 也是一条 `user/message`**：它已经是摘要了，逐字留等于
			// 「折叠加折叠」，实测留存率会飙到 83%（拿真实会话跑出来的）。所以它按助手那样
			// 只留首尾，并在标题上说明这是旧 checkpoint。
			if (text.includes("<compacted-summary>")) {
				priorCheckpoints += 1;
				priors.push(take(text, budget.assistantHead, budget.assistantTail));
			} else {
				users.push(take(text, budget.userHead, budget.userTail));
			}
		} else if (role === "tool") tools.push(take(text, budget.toolHead, budget.toolTail));
		else if (role === "assistant") {
			// 助手消息：先挑「重要行」（命令 / 路径 / 错误），再对整段做首尾裁剪。
			// 两步都确定性，且都不重写内容。
			const important = text
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && looksImportant(line))
				.slice(0, 5);
			const picked = important.length > 0 ? `${important.join("\n")}\n---\n${text}` : text;
			assistants.push(take(picked, budget.assistantHead, budget.assistantTail));
		}
		// 其它 role（system/developer）不进折叠产物：它们不是这段对话的内容
	}

	const sections = [];
	if (users.length > 0) sections.push(`## 用户原话（逐字）\n${users.map((t) => `- ${indent(t)}`).join("\n")}`);
	if (priors.length > 0) {
		sections.push(`## 更早的 checkpoint（首尾；内容已被上游摘要过）\n${priors.map((t) => `- ${indent(t)}`).join("\n")}`);
	}
	if (tools.length > 0) sections.push(`## 工具结果（首尾）\n${tools.map((t) => `- ${indent(t)}`).join("\n")}`);
	if (assistants.length > 0) {
		sections.push(`## 助手结论（首尾）\n${assistants.map((t) => `- ${indent(t)}`).join("\n")}`);
	}
	const note = `（确定性折叠：共 ${list.length} 条消息，逐字保留 ${keptChars} 字符、丢弃 ${droppedChars} 字符${
		truncated > 0 ? `、${truncated} 处做了首尾裁剪` : ""
	}${priorCheckpoints > 0 ? `；其中 ${priorCheckpoints} 条是更早的 checkpoint，只留了首尾` : ""}。原文都在会话日志里，可用 \`session_recall\` 取回。）`;
	const text = `${sections.join("\n\n")}\n\n${note}`;
	return { text, stats: { messages: list.length, keptChars, droppedChars, truncated, priorCheckpoints } };
}

/** 多行文本塞进一个 `- ` 条目时缩进后续行，免得破坏 markdown 结构（② 靠这个结构解析）。 */
function indent(text) {
	return text.replace(/\n/g, "\n  ");
}
