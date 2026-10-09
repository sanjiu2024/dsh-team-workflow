import assert from "node:assert/strict";

import { repeatPeriod, REPEAT_WINDOW } from "../lib/repeat-guard-core.js";
import { guardStream, installRepeatGuard } from "../lib/repeat-guard.js";

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
	reason: "检测到思考连续重复输出（周期 16 字符，连续 4 次）",
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
assert.deepEqual(signal.signal.reason, { kind: "hook", reason: "检测到正文连续重复输出（周期 16 字符，连续 4 次）" });
assert.deepEqual(livePassed, [{ type: "block-start", index: 0, blockType: "text" }], "命中的 delta 不得传到 AgentLoop");
await installed.dispose();
assert.deepEqual(disposed, ["scope"], "卸载时释放 inject scope");

console.log("重复输出自动中断：周期阈值、跨 delta、类型隔离、无 Agent 透传、取消与后续截断 ✓");
