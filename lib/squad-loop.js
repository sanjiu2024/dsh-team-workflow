/**
 * 小队成员的 agent loop —— **小队自己驱动**（REQ-011 §6.2）。
 *
 * ── 这条路为什么长这样 ────────────────────────────────────────────────────
 * dsh 全树没有任何插件自己驱动过 loop，`ctx.tools.execute` 的唯一驱动路径是 agent-loop
 * 内部的符号键 scheduler（源码标注 `@internal`、「不是插件扩展点」）。用户明确选了
 * 「成员完全独立于 subagent」，所以这个循环由我们自己写：自己发 `ctx.llm.stream`、
 * 自己执行工具（`squad-tools.js`）、自己维护转录。
 *
 * ── 依赖全部注入（这是刻意的） ─────────────────────────────────────────────
 * 这个文件**不认识 ctx**：模型流、消息构造器、工具执行器都由调用方给。好处是自检可以
 * 用假的异步流把它整条路径跑一遍（`scripts/selftest-squad.mjs` 就是这么做的），
 * 不必起真的 provider。
 *
 * ── 两条协议约束（写错就会让下一次请求被 provider 拒） ──────────────────────
 *  1. **每个 tool call 必须有且只有一个 tool 结果**：参数解析失败、超出单步上限、
 *     工具自己报错，都要回一条 `isError` 的结果，不能"跳过"。
 *  2. **窗口不能以 tool 结果开头**：裁剪历史时只从非 tool 消息处切，否则请求非法。
 */

/** 循环护栏。成员在后台跑，没有这些就是无界循环。 */
export const LOOP_DEFAULTS = {
	/** 最多几轮「模型 → 工具」；到了还没收工就判卡住。 */
	maxSteps: 30,
	/** 单步最多执行几个工具调用（多出来的回一条错误结果，不静默丢）。 */
	maxToolCallsPerStep: 8,
	/** 单条工具结果进上下文前截到多少字符。 */
	maxToolResultChars: 6000,
	/** 历史保留多少条消息（超了从最旧的整段丢）。 */
	keepMessages: 40,
};

/** 把模型给的 arguments（原始 JSON 字符串）解析成对象。 */
export function parseToolArguments(raw) {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (text === "") return { ok: true, value: {} };
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, detail: "arguments 必须是一个 JSON 对象" };
		}
		return { ok: true, value };
	} catch (err) {
		return { ok: false, detail: `arguments 不是合法 JSON：${err?.message ?? String(err)}` };
	}
}

/** 裁剪历史：保留第一条（任务）+ 尾部窗口，且窗口不能以 tool 结果开头。 */
export function trimMessages(messages, keep = LOOP_DEFAULTS.keepMessages) {
	if (messages.length <= keep) return messages;
	const head = messages[0];
	let start = messages.length - keep;
	while (start < messages.length && messages[start]?.role === "tool") start += 1;
	if (start >= messages.length) return [head];
	return [head, ...messages.slice(start)];
}

/**
 * 续聊用的种子历史（REQ-015 §6.3）：拿上一次的消息数组接着往下走。
 *
 * 两条协议约束在这里也必须成立，所以只做两件事：
 *  1. **去掉开头的 tool 消息** —— 窗口不能以 tool 结果开头（§15 的约束 2）。
 *     注意只去**开头**：中间的 tool 消息是它前面那条 assistant 的工具结果，删了
 *     就等于「有 tool call 没结果」，那是另一种非法（约束 1）。
 *  2. 把新任务作为最后一条 user 消息追加。
 */
export function seedMessages(seed, task) {
	const out = Array.isArray(seed) ? seed.filter((m) => m !== null && typeof m === "object").slice() : [];
	while (out.length > 0 && out[0]?.role === "tool") out.shift();
	if (typeof task === "string" && task !== "") out.push({ role: "user", content: [{ type: "text", text: task }] });
	return out;
}

/** 从一条消息里取纯文本（直投注入时进转录用）。 */
export function messageText(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

function blocksText(blocks) {
	return blocks
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

function blocksCalls(blocks) {
	return blocks.filter((b) => b?.type === "tool-call");
}

/** 把一次调用的用量累加进总数（`squad.js` 也用它累计成员的总用量）。 */
export function addUsage(total, usage) {
	if (!usage || typeof usage !== "object") return total;
	const next = { ...total };
	for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
		const v = usage[key];
		if (typeof v === "number" && Number.isFinite(v)) next[key] = (next[key] ?? 0) + v;
	}
	return next;
}

function clipText(text, max) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}\n…（截断，原 ${s.length} 字符）` : s;
}

/**
 * 跑一个成员，直到它收工 / 卡住 / 被中止。
 *
 * @param {object} deps
 * @param {object} deps.kit `{BlockAssembler, createToolResultMessage}`（宿主 `@deepseek-ai/dsh-llm` 的导出）
 * @param {(options: object) => AsyncIterable<object>} deps.stream 模型流（生产环境 = `ctx.llm.stream`）
 * @param {string} deps.provider
 * @param {string} deps.model
 * @param {string} deps.system 系统提示（每一轮都带 —— 它是 provider 的 system 槽，不属于 messages）
 * @param {string} deps.task 任务正文
 * @param {readonly object[]} [deps.messages] 续聊的种子历史（REQ-015）；给了就接着它跑
 * @param {() => object[]} [deps.takeInbox] 取待投消息（REQ-015 直投）；每步边界调一次
 * @param {readonly object[]} deps.tools 工具表（`MEMBER_TOOLS`）
 * @param {(call: object) => Promise<{text: string, isError?: boolean}>} deps.executeTool
 * @param {(event: object) => void} [deps.onEvent] 转录 / 状态事件
 * @param {AbortSignal} [deps.signal]
 * @param {object} [deps.limits]
 * @returns {Promise<{status: "完成"|"卡住", kind: string, reason: string, steps: number, usage: object, transcript: object[], messages: object[]}>}
 *
 * `kind` 是给调用方做决策用的机器可读类别（REQ-015 的重试只认 `infra`）：
 * `done` / `infra`（模型流抛错、provider 报错、拿不到 BlockAssembler）/ `aborted` /
 * `max-steps` / `max-tokens`。
 */
export async function runMemberLoop(deps) {
	const {
		kit,
		stream,
		provider,
		model,
		system,
		task,
		messages: seed,
		takeInbox,
		tools,
		executeTool,
		budgetLeft,
		onEvent = () => {},
		signal,
		limits = LOOP_DEFAULTS,
	} = deps;

	const transcript = [];
	const emit = (event) => {
		transcript.push(event);
		try {
			onEvent(event);
		} catch {
			/* 观察者自己出错不能弄死成员的循环 */
		}
	};
	// `messages` 必须在 `finish` 之前声明：早退路径（拿不到 BlockAssembler）会在赋值之前就调它。
	let messages = [];
	const finish = (status, reason, steps, usage, kind) => ({ status, kind, reason, steps, usage, transcript, messages });

	if (typeof kit?.BlockAssembler !== "function") {
		return finish("卡住", "拿不到宿主的 BlockAssembler（ctx.loader 没给出 dsh-llm）", 0, {}, "infra");
	}

	// 续聊（`seed`）与首次跑走同一条路：首次就是「空种子 + 任务」。
	messages = seedMessages(seed, task);
	let usageTotal = {};
	let step = 0;

	for (step = 1; step <= limits.maxSteps; step += 1) {
		if (signal?.aborted) return finish("卡住", "被中止", step - 1, usageTotal, "aborted");

		// token 预算（REQ-016 A2）：在**步边界**判 —— 只在收工判的话，一步就能超出去一大截。
		// 调用方给的函数吃「这一轮已经烧掉的量」，所以队级与成员级的账都算得准。
		const left = typeof budgetLeft === "function" ? budgetLeft(usageTotal) : undefined;
		if (typeof left === "number" && Number.isFinite(left) && left <= 0) {
			return finish("卡住", "token 预算用尽（小队/成员上限）", step - 1, usageTotal, "max-tokens");
		}

		const assembler = new kit.BlockAssembler();
		try {
			for await (const chunk of stream({ provider, model, messages, tools, system, signal })) {
				assembler.push(chunk);
			}
		} catch (err) {
			// 中止也是从这里出去的（流多半会 reject）：那是我们主动掐的，别报成 provider 的错。
			if (signal?.aborted) return finish("卡住", "被中止", step, usageTotal, "aborted");
			return finish("卡住", `模型调用失败：${err?.message ?? String(err)}`, step, usageTotal, "infra");
		}

		const reason = assembler.finish ?? { kind: "stop" };
		usageTotal = addUsage(usageTotal, assembler.usage);
		const blocks = assembler.blocks();
		const text = blocksText(blocks);
		const calls = blocksCalls(blocks);

		messages.push(assembler.message({ provider, model }));
		emit({ role: "assistant", text, calls: calls.map((c) => ({ id: c.id, name: c.name })), step });

		// 这两条早退路上，assistant（可能带着 tool-call）**已经进 messages 了**。
		// 直接 return 会留下「有 tool call、没有结果」的悬挂态，而这个 messages 数组会被
		// 续聊/重试原样发回去 —— provider 会拒（协议约束 1）。所以补一条 isError 结果再走。
		// （2026-10-16 std 测实测到序列 user→assistant(call)→user。）
		if ((reason.kind === "aborted" || reason.kind === "error") && calls.length > 0) {
			const why = reason.kind === "aborted" ? "这一轮被中止" : "模型报错";
			for (const call of calls) {
				messages.push(
					kit.createToolResultMessage({
						callId: call.id,
						content: [{ type: "text", text: `[未执行] ${why}，这个工具没有运行。` }],
						isError: true,
					}),
				);
			}
		}
		if (reason.kind === "aborted") return finish("卡住", "被中止", step, usageTotal, "aborted");
		if (reason.kind === "error") return finish("卡住", `模型报错：${reason.failure?.message ?? "未知"}`, step, usageTotal, "infra");

		if (calls.length === 0) {
			if (reason.kind === "max-tokens") return finish("卡住", "输出被 max-tokens 截断，没给出结论", step, usageTotal, "max-tokens");
			return finish("完成", reason.kind === "stop" ? "收工" : `收工（${reason.kind}）`, step, usageTotal, "done");
		}

		let executed = 0;
		for (const call of calls) {
			let result;
			if (executed >= limits.maxToolCallsPerStep) {
				result = { text: `[失败] 单步工具调用上限是 ${limits.maxToolCallsPerStep}，这一个没执行`, isError: true };
			} else {
				executed += 1;
				const parsed = parseToolArguments(call.arguments);
				result = parsed.ok
					? await executeTool({ id: call.id, name: call.name, arguments: parsed.value })
					: { text: `[失败] ${parsed.detail}`, isError: true };
			}
			const shown = clipText(result?.text ?? "", limits.maxToolResultChars);
			messages.push(
				kit.createToolResultMessage({
					callId: call.id,
					content: [{ type: "text", text: shown }],
					isError: result?.isError === true,
				}),
			);
			emit({ role: "tool", name: call.name, callId: call.id, text: shown, isError: result?.isError === true, step });
		}

		// 直投（REQ-015）：**必须**在上一步的工具结果全部追加完之后取 —— 早一步注入就会
		// 让窗口里出现「有 tool call 没结果」的中间态，下一次请求会被 provider 拒。
		const injected = typeof takeInbox === "function" ? takeInbox() ?? [] : [];
		for (const message of injected) {
			messages.push(message);
			emit({ role: "user", text: messageText(message), injected: true, step });
		}

		messages = trimMessages(messages, limits.keepMessages);
	}

	return finish("卡住", `跑了 ${limits.maxSteps} 步还没收工`, limits.maxSteps, usageTotal, "max-steps");
}
