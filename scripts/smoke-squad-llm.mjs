#!/usr/bin/env node
/**
 * 冒烟：拿**真的** `@deepseek-ai/dsh-llm` 把成员循环（`lib/squad-loop.js`）走一遍。
 *
 * ── 为什么要有这个脚本，而且它**不进 `npm test`** ────────────────────────────
 * `scripts/selftest-squad.mjs` 里的 `BlockAssembler` / `createToolResultMessage` 是**替身**：
 * 本仓库零依赖，自检不能引 dsh-llm。替身一旦和真件分叉，自检会照样全绿 ——
 * 而线上第一次 `squad_spawn` 就会炸（循环拿到的块形状不对、消息构造器签名不对）。
 * 这个脚本用真件跑同一条路径，把分叉按在这里。
 *
 * 它**不连 provider**：模型流是脚本化的假流（真流要 key、要网络，不能进自检）。
 * 所以它验的是「我们的循环 ↔ 真件」这一层，不验 provider。
 *
 *   node scripts/smoke-squad-llm.mjs
 *   DSH_MODULES=/path/to/@deepseek-ai node scripts/smoke-squad-llm.mjs
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { findDshModules, skipWithoutDshModules } from "./dsh-modules.mjs";
import { LOOP_DEFAULTS, runMemberLoop } from "../lib/squad-loop.js";

const DSH = findDshModules();
if (DSH === null) {
	skipWithoutDshModules("冒烟：成员循环 × 真 dsh-llm", "循环与真 BlockAssembler / createToolResultMessage 是否对得上");
}

const mod = await import(pathToFileURL(path.join(DSH, "dsh-llm", "lib", "index.js")).href);
// dsh 自己的 loader 会把 CJS 包装拆开（`unwrapExports`），直接 import 时要自己拆一层。
const llm = mod?.default && typeof mod.default === "object" && mod.default.BlockAssembler ? mod.default : mod;
const kit = { BlockAssembler: llm.BlockAssembler, createToolResultMessage: llm.createToolResultMessage };
assert.equal(typeof kit.BlockAssembler, "function", "真 dsh-llm 没导出 BlockAssembler");
assert.equal(typeof kit.createToolResultMessage, "function", "真 dsh-llm 没导出 createToolResultMessage");
console.log(`✓ 拿到真件：${path.join(DSH, "dsh-llm")}`);

/** 脚本化的假流：一轮一项，chunk 形状照 `StreamChunk`（真件就是这么读的）。 */
function scriptedStream(script, seen = []) {
	let round = 0;
	return (options) => {
		seen.push(options);
		const step = script[Math.min(round, script.length - 1)] ?? { text: "", calls: [], finish: "stop" };
		round += 1;
		const calls = step.calls ?? [];
		return (async function* chunks() {
			let index = 0;
			yield { type: "usage", usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
			if (step.text) {
				yield { type: "block-start", index, blockType: "text" };
				yield { type: "text-delta", index, text: step.text };
				index += 1;
			}
			for (const call of calls) {
				yield { type: "block-start", index, blockType: "tool-call" };
				yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: call.arguments };
				index += 1;
			}
			yield { type: "finish", reason: { kind: step.finish ?? (calls.length > 0 ? "tool-calls" : "stop") } };
		})();
	};
}

const run = (overrides) =>
	runMemberLoop({
		kit,
		provider: "smoke",
		model: "smoke",
		system: "你是成员",
		task: "读 a.txt",
		tools: [],
		executeTool: async () => ({ text: "ok" }),
		limits: LOOP_DEFAULTS,
		...overrides,
	});

// ── 1. 纯文本一轮：真件的 blocks()/usage/finish/message() 都要被我们正确读出来 ──
{
	const seen = [];
	const result = await run({ stream: scriptedStream([{ text: "干完了" }], seen) });
	assert.equal(result.status, "完成", result.reason);
	assert.equal(result.steps, 1);
	assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, "真件的 usage 要能读出来");
	assert.equal(result.transcript[0].text, "干完了");
	assert.equal(seen[0].system, "你是成员");
	console.log("✓ 纯文本一轮：blocks()/usage/finish/message() 读得对，收工判对");
}

// ── 2. 工具一轮 + 下一轮收工：真件组出来的 tool-call 块要能被执行，结果消息要合法 ──
{
	const seen = [];
	const executed = [];
	const stream = scriptedStream(
		[
			{ text: "先看一眼", calls: [{ id: "call-1", name: "read", arguments: '{"path":"a.txt"}' }] },
			{ text: "收工" },
		],
		seen,
	);
	const result = await run({
		stream,
		executeTool: async (call) => {
			executed.push(call);
			return { text: "文件内容" };
		},
	});
	assert.equal(result.status, "完成", result.reason);
	assert.equal(result.steps, 2);
	assert.deepEqual(executed, [{ id: "call-1", name: "read", arguments: { path: "a.txt" } }], "真件的块要能被执行（id/name/arguments 都对）");

	const messages = seen[1].messages;
	assert.equal(messages[0].role, "user");
	assert.equal(messages[1].role, "assistant", "真件 message() 造出来的是 assistant");
	assert.equal(messages[1].source.kind, "model");
	assert.equal(messages[1].content[0].type, "text");
	assert.equal(messages[2].role, "tool", "真件 createToolResultMessage 造出来的是 tool");
	assert.equal(messages[2].toolCallId, "call-1", "结果要对着 callId");
	assert.equal(messages[2].isError, false);
	assert.equal(messages[2].source.kind, "tool");
	assert.equal(messages.filter((m) => m.role === "tool").length, 1, "每个 call 恰好一条结果");
	assert.notEqual(messages[0].role, "tool", "窗口不能以 tool 结果开头");
	console.log("✓ 工具一轮：真件组的块能执行、结果消息带对 callId、协议两条约束都成立");
}

// ── 3. max-tokens 且带工具调用：真件会**丢掉**这个 tool-call（不能安全执行），
//      我们据此判「卡住」—— 这条分支依赖真件的那个决定，所以要真跑一遍 ──
{
	const result = await run({
		stream: scriptedStream([{ text: "说到一半", calls: [{ id: "call-9", name: "read", arguments: "{}" }], finish: "max-tokens" }]),
		executeTool: async () => {
			throw new Error("被截断的 tool-call 不该被执行");
		},
	});
	assert.equal(result.status, "卡住");
	assert.match(result.reason, /max-tokens/);
	console.log("✓ max-tokens：真件丢掉截断的 tool-call，我们判「卡住」而不是假装收工");
}

// ── 4. 真件的 finish 兜底：没有 finish chunk 时它给 {kind:'stop'}，我们照它收工 ──
{
	const result = await run({
		stream: () =>
			(async function* chunks() {
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "text-delta", index: 0, text: "没有 finish chunk" };
			})(),
	});
	assert.equal(result.status, "完成", result.reason);
	assert.equal(result.transcript[0].text, "没有 finish chunk");
	console.log("✓ 没有 finish chunk：真件兜底 {kind:'stop'}，我们照它收工");
}

console.log("\n全部通过 ✓（成员循环 × 真 dsh-llm）");
