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
 * 一行里有没有「失败信号」—— 用于工具结果挑**决定性行**。
 *
 * 为什么不复用 `looksImportant`：那套是给助手文本设计的，`node` / `npm` / 文件路径都算重要，
 * 套到 20KB 构建日志上会把每行都捞出来，等于没筛。工具输出里真正「预测下一步」的只有失败：
 * 错误、非零退出码、异常、断言 —— 它决定接下来改哪里。
 *
 * 依据：arXiv 2611.12825（MaxIM）把「有界记忆该保留什么」定义为**预测未来任务目标的能力**，
 * 而不是叙述完整性。失败行正属此类：留着它，下一步不用重跑就能知道错在哪。
 */
export function looksCritical(line) {
	return /(\b(error|failed|failure|fatal|exception|traceback|panic|abort)\b|\b\w*(Error|Exception)\b|\bassert\w*(error|failed)\b|assertion|\bexit (code|status)[:\s]*[1-9]|\b[45]\d{2}\b.*\b(error|denied|forbidden)\b|失败|报错|错误|异常|不通过)/i.test(
		line,
	);
}

/**
 * 把**连续重复的行**压成 。
 *
 * 构建日志、下载进度条、重复的断言输出：同一行刷几百次，把首尾预算全吃掉，
 * 真正有信息的那几行反而被挤出去。压成 ×N 之后信息一点没少（次数还在），
 * 但长度从「几百行」变成「一行」。
 *
 * 三条边界：
 * - **只压连续相同的行**，不跨段合并 —— 跨段合并会改变结构，② 的出处过滤靠结构。
 * - 短行才压（默认 ≤200 字符）：一长段 HTML 里碰巧有重复行时，压掉反而难读。
 * - 少于 3 次不压：`×2` 比原样多占字符，还多一层解释成本。
 *
 * 依据：arXiv 2611.12068（MIRIX-2.0）—— 合并重复但**不重写任何记录**。
 */
export function collapseRepeats(text, { minRun = 3, maxLine = 200 } = {}) {
	if (typeof text !== "string" || text.length < 200) return text;
	const lines = text.split("\n");
	const out = [];
	let i = 0;
	let collapsed = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j += 1;
		const run = j - i;
		if (run >= minRun && lines[i].length > 0 && lines[i].length <= maxLine) {
			out.push(`${lines[i]}  ×${run}`);
			collapsed += run - 1;
			i = j;
		} else {
			out.push(lines[i]);
			i += 1;
		}
	}
	return collapsed === 0 ? text : out.join("\n");
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
	// 硬截断线由**目标**驱动，但留一倍余量：目标是 35% 时安全线取 70%，目标被引擎调狠到 17.5%
	// 时安全线跟着收到 35%。为什么必须跟目标联动：写死 90% 的话，引擎那层「折不动就再狠一点」
	// 完全推不动（第一遍已经贴到 90%），重折就是空转 —— 拿真数据试出来的。
	// 上限 90% 是「比被压内容小」这条不变量的兜底；极小区间（<200 字符）不启用：那种区间
	// 压根不该被压，引擎会自己拒绝。
	const hardLimit = Math.max(1, Math.floor(inputChars * Math.min(0.9, Math.max(0.1, targetRatio * 2))));
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
		} else if (role === "tool") {
			// 先压连续重复行：构建日志那种「同一行刷 800 次」会把首尾预算全吃掉。
			// 压完再看要不要裁 —— 很多情况下压完就不超预算了，一个字都不用丢。
			const squashed = collapseRepeats(text);
			// 工具结果默认只留首尾。但中段里的**失败行**必须在 —— 否则压完只剩「看起来成功了」，
			// 下一步会照着错的结论走。只在真会被裁的时候才捞：否则错误行会重复一遍，
			// 还把本来不需要裁的输出撑大。
			let picked = squashed;
			if (squashed.length > budget.toolHead + budget.toolTail) {
				const critical = squashed
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "" && looksCritical(line))
					.slice(0, 5);
				if (critical.length > 0) picked = `${critical.join("\n")}\n---\n${squashed}`;
			}
			tools.push(take(picked, budget.toolHead, budget.toolTail));
		} else if (role === "assistant") {
			// 助手消息：先压重复行，再挑「重要行」（命令 / 路径 / 错误），最后对整段做首尾裁剪。
			// 三步都确定性，且都不重写内容。
			const squashed = collapseRepeats(text);
			const important = squashed
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && looksImportant(line))
				.slice(0, 5);
			const picked = important.length > 0 ? `${important.join("\n")}\n---\n${squashed}` : squashed;
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
