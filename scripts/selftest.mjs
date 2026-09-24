#!/usr/bin/env node
/**
 * 自检：用假的 cordis ctx 把插件跑一遍，检查真正重要的行为。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 和 lib/util.js 的 sha256 保持一致，用途：断言哈希算的是哪个字符串 */
const sha256Ref = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// 审计日志、节流 overlay 写到临时目录，别碰真环境
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-selftest-"));
process.env.DSH_HOME = tempHome;

const { apply } = await import(new URL("../lib/index.js", import.meta.url).href);

/** 最小可用的 cordis ctx */
function makeCtx(baseUrl) {
	const handlers = new Map();
	const sections = [];
	const commands = [];
	const tools = [];
	const effects = [];
	const logs = [];
	return {
		baseUrl,
		logger: {
			info: (m) => logs.push(["info", m]),
			warn: (m) => logs.push(["warn", m]),
			error: (m) => logs.push(["error", m]),
		},
		systemPrompt: {
			section(section) {
				if (sections.some((s) => s.name === section.name)) {
					throw new Error(`duplicate prompt section ${section.name}`);
				}
				sections.push(section);
				return () => {
					const at = sections.indexOf(section);
					if (at >= 0) sections.splice(at, 1);
				};
			},
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {
				const list = handlers.get(event);
				const at = list.indexOf(handler);
				if (at >= 0) list.splice(at, 1);
			};
		},
		commands: {
			register(definition) {
				commands.push(definition);
				return () => {};
			},
		},
		tools: {
			register(definition) {
				tools.push(definition);
				return () => {};
			},
		},
		effect(fn, label) {
			effects.push(label ?? "effect");
			const dispose = fn();
			return () => dispose?.();
		},
		// 探针：这些服务"存在"
		get: () => undefined,
		_handlers: handlers,
		_sections: sections,
		_commands: commands,
		_tools: tools,
		_effects: effects,
		_logs: logs,
	};
}

const ctx = makeCtx(new URL("../", import.meta.url).href);
apply(ctx, {});

// —— 1. 系统提示段 ——

const baseline = ctx._sections.find((s) => s.name === "team:baseline");
assert.ok(baseline, "缺少 team:baseline 系统提示段");
assert.equal(baseline.order, 600, "team:baseline 的 order 必须是 600（TEAM_POLICY）");
const baselineText = typeof baseline.text === "function" ? baseline.text(ctx) : baseline.text;
assert.ok(baselineText.includes("团队基线规范"), "团队规范没读进来");
assert.ok(baselineText.length > 500, "团队规范内容过短，可能没读到 team/RULES.md");

// —— 2. 命令 ——

const names = ctx._commands.map((c) => c.name).sort();
assert.deepEqual(names, ["audit-log", "team-baseline", "thrift"], `命令不对：${names}`);

// —— 3. 审计日志：真喂事件 ——

const sessionEvents = ctx._handlers.get("session/event") ?? [];
assert.ok(sessionEvents.length >= 1, "没订阅 session/event");

const session = { id: "selftest-session", header: { version: 1, id: "selftest-session", createdAt: 1_700_000_000_000, cwd: "C:\\tmp", isSeeded: false } };
function feed(event) {
	for (const handler of sessionEvents) handler(session, event);
}
// dsh 的真实事件形状：payload 全在 `data` 下，且 tool/call.arguments 是
// 模型产出的**原始 JSON 字符串**。别改成扁平形状 —— 那样测不出这个 bug。
feed({ type: "turn/start", seq: 1, time: 0, data: { turn: 1 } });
feed({
	type: "user/message",
	seq: 2,
	time: 0,
	data: {
		role: "user",
		source: { kind: "user" },
		content: [{ type: "text", text: "你好" }],
	},
});
feed({
	type: "tool/call",
	seq: 3,
	time: 0,
	data: {
		turn: 1,
		step: 1,
		callId: "call-1",
		name: "bash",
		arguments: JSON.stringify({ command: "echo hi", apiKey: "sk-abcdefgh12345678" }),
	},
});
feed({
	type: "tool/result",
	seq: 4,
	time: 0,
	data: {
		turn: 1,
		step: 1,
		message: {
			role: "user",
			source: { kind: "tool", callId: "call-1" },
			content: [
				{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "hi" }] },
			],
		},
	},
});
feed({
	type: "assistant/message",
	seq: 5,
	time: 0,
	data: {
		turn: 1,
		step: 1,
		message: {
			role: "assistant",
			source: {
				kind: "model",
				provider: "new-api",
				model: "tier-std",
				replayState: { response: { stopReason: "stop" } },
			},
			content: [
				{ type: "text", text: "done" },
				{ type: "reasoning", text: "想一下" },
			],
		},
		usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 100 },
		stream: [],
	},
});
feed({ type: "compaction/prune", seq: 6, time: 0, data: { shadowedSeqs: [1, 2], shadowedTokenCount: 400 } });
feed({ type: "turn/end", seq: 7, time: 0, data: { turn: 1, reason: { kind: "completed" } } });

const auditDir = path.join(tempHome, "storages", "audit-log");
assert.ok(fs.existsSync(auditDir), `审计目录没建：${auditDir}`);
const files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
assert.equal(files.length, 1, `期望 1 个审计文件，实际 ${files.length}`);

const raw = fs.readFileSync(path.join(auditDir, files[0]), "utf8").trimEnd();
const lines = raw.split("\n");
assert.ok(lines.length >= 7, `审计条数太少：${lines.length}`);
for (const line of lines) {
	assert.ok(Buffer.byteLength(line, "utf8") <= 8192, "审计行超过 8192 字节上限");
	const rec = JSON.parse(line);
	assert.equal(rec.v, 1, "记录版本 v 不对");
	assert.ok(typeof rec.ts === "string" && rec.ts.length > 0, "缺 ts");
	assert.ok(typeof rec.event === "string", "缺 event");
}

const byEvent = new Map();
for (const line of lines) {
	const rec = JSON.parse(line);
	byEvent.set(rec.event, (byEvent.get(rec.event) ?? 0) + 1);
}
for (const expected of ["turn_start", "tool_call", "tool_result", "compaction_prune", "turn_end"]) {
	assert.ok(byEvent.has(expected), `审计里缺 ${expected}；实际有 ${[...byEvent.keys()].join(", ")}`);
}
assert.equal(byEvent.get("tool_call"), 1, "tool_call 条数不对");
assert.equal(byEvent.get("tool_result"), 1, "tool_result 条数不对");

// 凭证脱敏：明文 apiKey 绝不能出现在日志里
assert.ok(!raw.includes("sk-abcdefgh12345678"), "审计日志里出现了明文 API key");

// 哈希字段是 sha256 形状
// 字段没读歪：真机上这三个曾经全是 null（事件形状猜错了）
const recs = lines.map((l) => JSON.parse(l));
const callRec = recs.find((r) => r.event === "tool_call");
assert.ok(callRec, "没有 tool_call 记录");
assert.equal(callRec.toolName, "bash", "tool_call.toolName 读歪了");
assert.equal(callRec.toolCallId, "call-1", "tool_call.toolCallId 读歪了");
assert.ok(callRec.argsPreview.includes("echo hi"), "tool_call.argsPreview 没解析出参数");
assert.equal(callRec.argsSha256, sha256Ref(JSON.stringify({ command: "echo hi", apiKey: "sk-abcdefgh12345678" })), "argsSha256 不是原始 arguments 字符串的哈希");
const usageRec = recs.find((r) => r.event === "assistant_usage");
assert.ok(usageRec.usage.input === 1000, "assistant_usage.usage.input 读歪了");
assert.equal(usageRec.hasThinking, true, "assistant_usage.hasThinking 没认出 reasoning 块");
assert.equal(usageRec.blockTypes.reasoning, 1, "assistant_usage.blockTypes 统计不对");
const resultRec = recs.find((r) => r.event === "tool_result");
assert.equal(resultRec.toolCallId, "call-1", "tool_result.toolCallId 没从 block 里取到");
assert.equal(resultRec.resultChars, 2, "tool_result.resultChars 不对");
const endRec = recs.find((r) => r.event === "turn_end");
assert.equal(endRec.reason, "completed", "turn_end.reason 没从对象里取到 kind");

// —— 4. 节流统计用同一批事件累出来了 ——

const thriftCommand = ctx._commands.find((c) => c.name === "thrift");
const shown = thriftCommand.handler({ rawInput: "show" });
assert.equal(shown.kind, "success", `/thrift show 失败：${shown.text}`);
assert.ok(shown.text.includes("峰值 prompt：1600"), `/thrift show 没统计到峰值：\n${shown.text}`);
assert.ok(shown.text.includes("裁剪 1 次"), `/thrift show 没统计到裁剪：\n${shown.text}`);

// 参数校验
assert.equal(thriftCommand.handler({ rawInput: "compact abc" }).kind, "error", "/thrift 该拒绝非法参数");
assert.equal(thriftCommand.handler({ rawInput: "没见过的参数" }).kind, "error", "/thrift 该拒绝未知参数");

// —— 5. /team-baseline 能跑 ——

const baselineCommand = ctx._commands.find((c) => c.name === "team-baseline");
const info = baselineCommand.handler({});
assert.equal(info.kind, "success", `/team-baseline 失败：${info.text}`);
assert.ok(info.text.includes("dsh-team-workflow"), "/team-baseline 没打版本号");
assert.ok(info.text.includes("团队规范"), "/team-baseline 没打团队规范状态");

// —— 6. 异常隔离：坏事件不能把插件带崩 ——

for (const handler of sessionEvents) {
	handler(session, { type: "tool/call", seq: 1, time: 0, data: { arguments: null } });
	handler(session, { type: "tool/call", seq: 2, time: 0 });
	handler(session, { type: "tool/call", seq: 3, time: 0, data: { arguments: "不是 JSON" } });
	handler(session, { type: undefined });
	handler(session, { type: "turn/end" });
	handler(session, null);
}

// —— 7. tools/post-execute 挂上了 ——

assert.ok(ctx._handlers.has("tools/post-execute"), "没订阅 tools/post-execute");
assert.ok(ctx._tools.some((t) => t.name === "lens_check"), "缺少 lens_check 工具");

// —— 8. 清理 ——

fs.rmSync(tempHome, { recursive: true, force: true });

console.log("✓ 自检通过：系统提示段 / 命令 / 审计落盘与脱敏 / 节流统计 / 异常隔离");
