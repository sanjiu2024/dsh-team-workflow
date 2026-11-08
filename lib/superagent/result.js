/**
 * 从会话里取出 agent 的**最终输出文本**。
 *
 * ## 为什么单独一层（计划审查点名的隐藏风险）
 *
 * 原计划想当然地以为「跑完 agent 就能拿到结果」。实际上 `agents.create()` 只给你一个
 * handle，落盘的是**事件流**（`assistant/message` / `tool/call` / `tool/result` / …），
 * 不是一段文本。拿不到最终输出，「回评论」这一步就得去改调度层的返回面 —— 那会牵连
 * 整套 agent 生命周期，是计划里最容易返工的一处。
 *
 * 所以这里把它拆成两层：
 * - {@link lastAssistantText} 是**纯函数**（事件数组 → 文本），能单测、能回放；
 * - {@link readFinalOutput} 只管「打开会话、分页读、喂给上面那个」，不关心 content 结构。
 *
 * ## 只读，不 flush
 *
 * 上游的 `delivery.ts` 在读之前调 `sessionPersistence.flush()`，因为它要判断「这条消息
 * 投过没有」，必须看到最新落盘。这里**不调**：我们读的是**已经结束**的会话，
 * 而 flush 会影响正在跑的其他会话。要读活会话的结果时，调用方自己先 flush。
 *
 * @module dsh-team-workflow/superagent/result
 */

/**
 * 把一条消息的 `content` 拍平成文本块。
 *
 * `content` 是块数组（`{type:"text",text}` / `{type:"image",…}` / 工具块…）。
 * 只取 `text` 块 —— 图片与工具块对「回评论」没用，而且它们的体积可能很大。
 *
 * @param {unknown} content
 * @returns {string}
 */
export function extractText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		if (block.type !== "text") continue;
		if (typeof block.text === "string" && block.text !== "") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/**
 * 一条会话事件里携带的消息内容。
 *
 * 兼容两种载荷形态：`event.data.content`（消息本体直接挂 data 上）与
 * `event.data.message.content`（包了一层）。宿主的 `assistant/message` 用的是前者，
 * 后者是给「未来换了包装」留的余地 —— 两种都取不到就返回空数组，不抛。
 *
 * @param {unknown} data
 * @returns {Array<unknown>}
 */
function messageContent(data) {
	if (data === null || typeof data !== "object") return [];
	if (Array.isArray(data.content)) return data.content;
	if (data.message !== null && typeof data.message === "object" && Array.isArray(data.message.content)) {
		return data.message.content;
	}
	return [];
}

/**
 * 事件流里**最后一条非空**的助手文本。
 *
 * 为什么是「最后一条非空」而不是「最后一条」：agent 可能在末尾追加一轮只有工具调用的
 * 消息（`content` 里没有文本块）。那种轮次不该把前面真正的结论覆盖成空串 ——
 * 否则「回评论」会发一条空评论出去。
 *
 * 畸形事件（`null`、缺 `type`、`data` 不是对象）一律跳过，不让一条坏记录毁掉整次读取。
 *
 * @param {Array<unknown>} events
 * @returns {string} 没有助手文本时返回空串
 */
export function lastAssistantText(events) {
	if (!Array.isArray(events)) return "";
	let last = "";
	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		if (event.type !== "assistant/message") continue;
		const text = extractText(messageContent(event.data));
		if (text !== "") last = text;
	}
	return last;
}

/**
 * 打开一个已落盘的会话，分页读出事件，返回最后一条助手文本。
 *
 * 内存是 O(每页)：边读边更新「最后一条」，不把整条事件流攒在数组里 ——
 * 长会话的事件流可以是几万条，全留会白占几十 MB。
 *
 * @param {object} ctx 插件上下文（要 `sessionPersistence` 服务）
 * @param {string} sessionId
 * @param {{ pageSize?: number, maxPages?: number }} [options]
 *   `maxPages` 是**止损**：会话异常膨胀时宁可返回已知的最后一条，也不要无限读。
 * @returns {Promise<string>}
 */
export async function readFinalOutput(ctx, sessionId, { pageSize = 512, maxPages = 4096 } = {}) {
	if (typeof sessionId !== "string" || sessionId === "") {
		throw new Error("readFinalOutput: 需要 sessionId");
	}
	// 用 ctx.get 而不是静态 inject：本模块可能被单独 import 做自检，那时没有完整 ctx。
	const persistence = ctx?.get?.("sessionPersistence") ?? ctx?.sessionPersistence;
	if (!persistence || typeof persistence.open !== "function") {
		throw new Error("readFinalOutput: 宿主没有 sessionPersistence 服务");
	}

	const handle = await persistence.open(sessionId, "read");
	try {
		if (typeof handle?.read !== "function") {
			throw new Error("readFinalOutput: 会话句柄没有 read()");
		}
		let last = "";
		let offset = 0;
		for (let page = 0; page < maxPages; page += 1) {
			const result = await handle.read(offset, pageSize);
			const chunk = Array.isArray(result?.events) ? result.events : [];
			if (chunk.length === 0) break;
			const text = lastAssistantText(chunk);
			if (text !== "") last = text;
			offset += chunk.length;
		}
		return last;
	} finally {
		// handle 带 Symbol.asyncDispose（上游用 `await using`），但这里显式 close：
		// 老宿主可能只有 close()，两种都兜住。
		if (typeof handle?.close === "function") await handle.close();
		else if (typeof handle?.[Symbol.asyncDispose] === "function") await handle[Symbol.asyncDispose]();
	}
}
