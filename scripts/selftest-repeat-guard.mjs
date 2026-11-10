import assert from "node:assert/strict";

import { repeatPeriod, REPEAT_WINDOW } from "../lib/repeat-guard-core.js";
import { guardStream, installRepeatGuard, REPEAT_GUARD_DEFAULTS } from "../lib/repeat-guard.js";

const repeated = (text, count = 4) => Array.from({ length: count }, () => text).join("");
const chars = (text) => text.split("");

assert.equal(repeatPeriod(chars(repeated("abcdefghijklmnop"))), 16, "16 字符片段连续 4 次应命中");
assert.equal(repeatPeriod(chars(repeated("abcdefghijklmnop", 3))), 0, "连续 3 次不应命中");
assert.equal(repeatPeriod(chars(repeated("abcdefghijklmno"))), 0, "15 字符周期不应命中");
const tooLongPeriod = Array.from({ length: 129 }, (_, index) => String.fromCharCode(0x1000 + index)).join("");
assert.equal(repeatPeriod(chars(repeated(tooLongPeriod))), 0, "超过最大周期不应命中");
assert.equal(repeatPeriod(chars(repeated(Array.from({ length: 128 }, (_, index) => String.fromCharCode(0x1000 + index)).join("")))), 128, "128 字符周期是上限且应命中");
assert.equal(repeatPeriod(chars("a".repeat(REPEAT_WINDOW + 10))), 16, "长输入只需保留有界尾窗（最短周期 16）");

const stream = async function* (chunks) {
	for (const chunk of chunks) yield chunk;
};
const block = (index, blockType, type, text) => [
	{ type: "block-start", index, blockType },
	{ type, index, text },
];
const cancelled = [];
const passed = [];
const logs = [];
const chunks = [
	...block(0, "reasoning", "reasoning-delta", repeated("思考片段文字重复思考片段文字重复")),
	{ type: "tool-call-delta", index: 1, id: "call-1", argumentsDelta: "{}" },
	...block(2, "text", "text-delta", "普通正文"),
];
for await (const chunk of guardStream(stream(chunks), {
	agentForSession: () => ({ cancel: (cause) => cancelled.push(cause) }),
	log: (message) => logs.push(message),
})) passed.push(chunk);
assert.equal(cancelled.length, 1, "命中后只取消一次");
assert.deepEqual(cancelled[0], {
	kind: "hook",
	reason: "思考连续重复输出（周期 16 字符，连续 4 次）",
});
assert.equal(passed.some((chunk) => chunk.type === "reasoning-delta"), false, "命中的 delta 不得送入 agent loop");
assert.equal(passed.some((chunk) => chunk.type === "tool-call-delta"), false, "命中后不再转发后续 chunk");
assert.equal(logs.length, 1, "命中时应记录一次提示");

const chunksSplit = [
	{ type: "block-start", index: 0, blockType: "text" },
	{ type: "text-delta", index: 0, text: "abcdefghijklmnopabcdefghijklmnop" },
	{ type: "text-delta", index: 0, text: "abcdefghijklmnopabcdefghijklmnop" },
];
const splitCancel = [];
const splitPassed = [];
for await (const chunk of guardStream(stream(chunksSplit), {
	agentForSession: () => ({ cancel: (cause) => splitCancel.push(cause) }),
})) splitPassed.push(chunk);
assert.equal(splitCancel.length, 1, "跨多个 delta 的连续重复也要命中");
assert.equal(splitPassed.filter((chunk) => chunk.type === "text-delta").length, 1, "只转发命中前的 delta");

const safeChunks = [
	...block(0, "text", "text-delta", "abcdefghijklmnopabcdefghijklmnopabcdefghijklmnop"),
	...block(1, "reasoning", "reasoning-delta", "abcdefghijklmnopabcdefghijklmnopabcdefghijklmnop"),
	{ type: "tool-call-delta", index: 2, id: "call-2", argumentsDelta: "{}" },
];
const safePassed = [];
for await (const chunk of guardStream(stream(safeChunks), { agentForSession: () => undefined })) safePassed.push(chunk);
assert.deepEqual(safePassed, safeChunks, "不足 4 次或无活 Agent 时应原样、同序透传");

const independent = [
	{ type: "block-start", index: 0, blockType: "text" },
	{ type: "text-delta", index: 0, text: "abcdefghijklmnopabcdefghijklmnop" },
	{ type: "block-start", index: 1, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 1, text: "abcdefghijklmnopabcdefghijklmnop" },
];
const independentCancel = [];
for await (const _chunk of guardStream(stream(independent), {
	agentForSession: () => ({ cancel: (cause) => independentCancel.push(cause) }),
})) { /* consume */ }
assert.equal(independentCancel.length, 0, "text 与 reasoning、不同 block 不得合并计算");

const toolOnly = Array.from({ length: 4 }, (_, index) => ({
	type: "tool-call-delta", index: 0, id: "call-tool", name: "lookup", argumentsDelta: "abcdefgh",
}));
const toolOnlyPassed = [];
for await (const chunk of guardStream(stream(toolOnly), {
	agentForSession: () => ({ cancel: () => assert.fail("tool-call 不得触发重复输出中断") }),
})) toolOnlyPassed.push(chunk);
assert.deepEqual(toolOnlyPassed, toolOnly, "重复工具参数应原样透传、不触发取消");

let streamListener;
const signal = new AbortController();
const sameSessionAgent = {
	cancel: (cause, options) => {
		assert.equal(options.keepInbox, true, "取消重复输出时不应清掉排队的用户输入");
		signal.abort(cause);
	},
};
const disposed = [];
const installed = installRepeatGuard({
	inject: (deps, callback) => {
		assert.deepEqual(deps, ["agents"]);
		callback({
			agents: { get: (id) => id === "session-a" ? sameSessionAgent : undefined },
			on: (name, listener, options) => {
				assert.equal(name, "llm/stream");
				assert.equal(options.global, true);
				streamListener = listener;
				return () => disposed.push("listener");
			},
			logger: { warn() {} },
		});
		return { dispose: async () => disposed.push("scope") };
	},
});
const liveChunks = [
	{ type: "block-start", index: 0, blockType: "text" },
	{ type: "text-delta", index: 0, text: "abcdefghijklmnopabcdefghijklmnopabcdefghijklmnopabcdefghijklmnop" },
];
const livePassed = [];
for await (const chunk of streamListener({ sessionId: "session-a" }, () => stream(liveChunks))) {
	signal.signal.throwIfAborted?.();
	livePassed.push(chunk);
}
assert.equal(signal.signal.aborted, true, "中间件命中后应触发 Agent 的 AbortSignal");
assert.deepEqual(signal.signal.reason, { kind: "hook", reason: "正文连续重复输出（周期 16 字符，连续 4 次）" });
assert.deepEqual(livePassed, [{ type: "block-start", index: 0, blockType: "text" }], "命中的 delta 不得传到 AgentLoop");
await installed.dispose();
assert.deepEqual(disposed, ["scope"], "卸载时释放 inject scope");

	// 思考体量护栏（REQ-014 C）已于 2026-11-10 按用户要求移除，那一段的用例一并删掉。
	// 删掉功能时不删用例，等于留一组永远绿的死断言 —— 它们测的东西已经不存在了。

// ── 思考体量护栏（REQ-014 C）已于 2026-11-10 按用户要求移除 ────────────────
//
// 删掉功能时用例也一起删 —— 留着就是一组永远绿的死断言，它们测的东西已经不存在了。
//  留着：D 段还要用它造「够长但不成周期」的数据。
const noisy = (length) => Array.from({ length }, (_, index) => String.fromCharCode(0x4e00 + (index % 997))).join("");

// ── D · 中断后自动提示（REQ-014）─────────────────────────────────────────────
//
// 这一段**必须打在生产闭包上**（installRepeatGuard + 假 ctx.loader），不能用本地复刻件：
// 我第一版就是在测试里自己写了一遍预算逻辑，结果 `maxNudgesPerSession` 在测试里零引用 ——
// 把默认 3 改成 99 测试照样全绿（std 测 2026-10-09 逮到的）。
const tick = () => new Promise((resolve) => setImmediate(resolve));

function installGuard({ createUserMessage = (input) => input, isLoopRequest = (options) => options?.loop !== false } = {}) {
	const listeners = new Map();
	const warnings = [];
	const agents = new Map();
	const agent = {
		cancelled: [],
		followed: [],
		cancel(cause, options) { this.cancelled.push({ cause, options }); },
		followup(message) { this.followed.push(message); },
	};
	const ctx = {
		loader: {
			import: async () => ({
				__esModule: true,
				default: function dshLlmPlugin() {},
				isAgentLoopRequest: isLoopRequest,
				createUserMessage,
			}),
			unwrapExports: (e) => ((typeof e === "function" || (e = e.default ?? e, !e.__esModule)) ? e : e.default ?? e),
		},
		on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); },
		inject: (deps, callback) => {
			callback({
				agents: { get: (id) => agents.get(id) },
				on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); },
				logger: { warn: (message) => warnings.push(message) },
			});
			return { dispose: async () => {} };
		},
	};
	const guard = installRepeatGuard(ctx, { enabled: true, maxReasoningChars: 20000, nudge: true, maxNudgesPerSession: 3 });
	return { guard, listeners, warnings, agent, agents };
}

/**
 * 一个「一定命中」的流：16 字符周期 × 4（REQ-013 那条路）。
 *
 * 2026-11-10 之前这里造的是 20001 字符的**非周期**文本，走的是 REQ-014 C 的体量护栏。
 * 那条护栏删掉之后，非周期文本**不该**再触发任何中断 —— 所以这里换成周期数据。
 * 名字留着（`volumeStream`）是为了让下面几处调用点不用改，但它现在不测体量了。
 */
const volumeStream = () => stream([
	{ type: "block-start", index: 0, blockType: "reasoning" },
	{ type: "reasoning-delta", index: 0, text: "abcdefghijklmnop".repeat(4) },
]);

{
	const { guard, listeners, agent, agents } = installGuard();
	agents.set("session-real", agent);
	await tick();   // 等 isAgentLoopRequest 预加载完，门禁才生效

	// ① 辅助调用（压缩/会话标题）带同一 sessionId —— 必须原样旁路，绝不动真人 turn
	for (const purpose of ["compaction", "session-title"]) {
		const inner = stream([{ type: "block-start", index: 0, blockType: "reasoning" }, { type: "reasoning-delta", index: 0, text: noisy(30000) }]);
		const returned = listeners.get("llm/stream")({ sessionId: "session-real", purpose }, () => inner);
		assert.equal(returned, inner, `purpose=${purpose} 必须原样返回 next()，不包装`);
	}
	assert.equal(agent.cancelled.length, 0, "辅助调用不得取消真人 turn");

	// ② 非 AgentLoop 请求（isAgentLoopRequest 说不是）→ 旁路
	const foreign = stream([{ type: "block-start", index: 0, blockType: "reasoning" }, { type: "reasoning-delta", index: 0, text: noisy(30000) }]);
	assert.equal(listeners.get("llm/stream")({ sessionId: "session-real", loop: false }, () => foreign), foreign, "非 loop 请求要旁路");

	// ③ 真 loop 请求 + 命中字面重复 → 取消 + 真提示文案
	//
	// 2026-11-10：这里原来用「体量超限」触发，C 删掉后改成用 REQ-013 那条路（16 字符 × 4）。
	// 顺带把「体量再大也不掐」也测了 —— 那正是删它的理由。
	const periodic = (text) => stream([
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text },
	]);
	const repeatHit = () => periodic("abcdefghijklmnop".repeat(4));
	for await (const _chunk of listeners.get("llm/stream")({ sessionId: "session-real", loop: true }, repeatHit)) { /* consume */ }
	assert.equal(agent.cancelled.length, 1, "loop 请求命中字面重复要取消");
	assert.deepEqual(agent.cancelled[0], { cause: { kind: "hook", reason: "思考连续重复输出（周期 16 字符，连续 4 次）" }, options: { keepInbox: true } });
	assert.equal(agent.followed.length, 1, "取消后要投递提示");
	assert.match(agent.followed[0].content[0].text, /检测到你在思考里绕圈（思考连续重复输出/);
	assert.match(agent.followed[0].content[0].text, /直接给结论/);
	assert.deepEqual(agent.followed[0].source, { kind: "user" });

	// ④ 预算打在生产闭包上：默认 3，第 4 次只取消
	for (let round = 2; round <= 4; round += 1) {
		for await (const _chunk of listeners.get("llm/stream")({ sessionId: "session-real", loop: true }, repeatHit)) { /* consume */ }
	}
	assert.equal(agent.cancelled.length, 4, "每次都该取消");
	assert.equal(agent.followed.length, 3, "提示上限 3 次（第 4 次只取消）");
	assert.equal(guard.nudgeCount("session-real"), 3);
}

{
	// ⑤ 造不出提示：只取消 + warn，且**不白扣预算**（退回去）
	// 注意传 `null` 而不是 `undefined`：解构默认值只对 undefined 生效，传 undefined 等于用默认的
	// 恒等函数 —— 那样这条用例就测不到「宿主没导出」了（我第一次就踩了）
	const { guard, listeners, agent, agents } = installGuard({ createUserMessage: null });
	agents.set("session-broken", agent);
	await tick();
	for await (const _chunk of listeners.get("llm/stream")({ sessionId: "session-broken", loop: true }, volumeStream)) { /* consume */ }
	assert.equal(agent.cancelled.length, 1, "造不出提示也必须完成中断");
	assert.equal(agent.followed.length, 0, "没有提示就不该 followup");
	assert.equal(guard.nudgeCount("session-broken"), 0, "失败不该消耗预算（先占位、失败退回）");
}

{
	// ⑥ 并发：预算 1、两条流同时命中 —— 只该发 1 条提示（读-改-写跨 await 会丢更新）
	const listeners = new Map();
	const agent = { cancelled: [], followed: [], cancel(c) { this.cancelled.push(c); }, followup(m) { this.followed.push(m); } };
	const agents = new Map([["session-race", agent]]);
	let resolveMessage;
	const gate = new Promise((resolve) => { resolveMessage = resolve; });
	installRepeatGuard({
		loader: {
			import: async () => ({
				__esModule: true,
				default: function p() {},
				isAgentLoopRequest: () => true,
				createUserMessage: async (input) => { await gate; return input; },
			}),
			unwrapExports: (e) => e,
		},
		on: (name, listener) => { listeners.set(name, listener); return () => {}; },
		inject: (deps, callback) => {
			callback({
				agents: { get: (id) => agents.get(id) },
				on: (name, listener) => { listeners.set(name, listener); return () => {}; },
				logger: { warn: () => {} },
			});
			return { dispose: async () => {} };
		},
	}, { enabled: true, maxReasoningChars: 20000, nudge: true, maxNudgesPerSession: 1 });
	await tick();
	const listener = listeners.get("llm/stream");
	const consume = async () => {
		for await (const _chunk of listener({ sessionId: "session-race", loop: true }, volumeStream)) { /* consume */ }
	};
	const both = Promise.all([consume(), consume()]);
	await tick();
	resolveMessage();
	await both;
	assert.equal(agent.cancelled.length, 2, "两条流都该被取消");
	assert.equal(agent.followed.length, 1, "预算 1 时并发只能发 1 条提示（先占位再 await）");
}

console.log("重复输出自动中断：周期阈值、跨 delta、类型隔离、无 Agent 透传、取消与后续截断 ✓");

// —— 2026-11-10：思考体量护栏（REQ-014 C）已删除，得钉住「它真的不再掐」——
//
// 删掉一个「掐断」的能力，风险在于**没删干净**：某个角落还留着计数或阈值，
// 于是一次正常的长推理被无预警打断 —— 那比多烧几个 token 糟得多。
// 所以这条断言的正向作用是：30000 字符的**非周期**推理必须原样透传、不取消。
{
	const { guard, listeners, agent, agents } = installGuard();
	agents.set("session-long", agent);
	await tick();

	const longButClean = () => stream([
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: noisy(30000) },
		{ type: "block-start", index: 1, blockType: "text" },
		{ type: "text-delta", index: 1, text: "结论：可以" },
	]);
	let delivered = 0;
	for await (const _chunk of listeners.get("llm/stream")({ sessionId: "session-long", loop: true }, longButClean)) {
		delivered += 1;
	}
	assert.equal(agent.cancelled.length, 0, "30000 字符的非周期推理不该被掐（体量护栏已删）");
	assert.deepEqual(agent.followed, [], "没掐就不该发提示");
	assert.ok(delivered >= 3, `整条流要原样透传，实际只收到 ${delivered} 个 chunk`);

	// 反面对照：同样的长度，但**成周期** → 必须掐。不然这条断言可能只是「整层坏了」。
	const longButLoopy = () => stream([
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: ("alpha-beta-gamma-").repeat(2000) },
	]);
	for await (const _chunk of listeners.get("llm/stream")({ sessionId: "session-long", loop: true }, longButLoopy)) { /* consume */ }
	assert.equal(agent.cancelled.length, 1, "成周期的长推理仍然要掐 —— 删的是体量，不是重复检测");

	await installed?.dispose?.();
	guard?.dispose?.();
	console.log("✓ 体量护栏已删：长而干净的推理透传，长而成周期的仍然掐");
}
