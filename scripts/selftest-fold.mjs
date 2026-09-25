#!/usr/bin/env node
/**
 * 折叠落地自检：证明 magic-context 的折叠**真的把 dsh surface 缩短了**，
 * 且工具配对（assistant tool-call / tool-result）永远完整。
 *
 * 旧版 landOnSurface 跳过所有非 append 变化，折叠只进系统提示、消息历史
 * 永不收缩 —— dsh 自带压缩照常触发。这是本次修复的核心断言。
 *
 * 两个场景，缺一不可：
 *   A. 折叠边界**恰好落在**配对边界 → 干净收缩
 *   B. 折叠边界**落在配对中间** → 必须自动内缩到最近平衡切口，绝不切出孤儿
 *
 *   node scripts/selftest-fold.mjs
 */
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DSH = process.env.DSH_MODULES ?? "C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/";
const { Session } = await import(pathToFileURL(path.join(DSH, "dsh-session/lib/index.js")).href);
const { landOnSurface } = await import(pathToFileURL(path.join(root, "lib", "mc.js")).href);
const { alignSurface } = await import(pathToFileURL(path.join(root, "lib", "mc-adapter.js")).href);

const src = { kind: "plugin", plugin: "probe" };
const block = (text) => ({ type: "text", text });

/** 建一个含两组工具配对的 7 条历史会话。 */
function buildSession(name) {
	const s = Session.create(name);
	s.append("user/message", { id: "u0", role: "user", content: [block("记忆一：一律用中文回答")], source: src }, { surfaceOp: "append" });
	s.append("assistant/message", {
		turn: 0, step: 0, stream: [],
		message: { id: "a1", role: "assistant", content: [block("好"), { type: "tool-call", id: "c1", name: "read", arguments: "{}" }], source: src },
	}, { surfaceOp: "append" });
	s.append("tool/result", {
		turn: 0, step: 0,
		message: { id: "r1", role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [block("文件内容".repeat(200))] }], source: src },
	}, { surfaceOp: "append" });
	s.append("user/message", { id: "u2", role: "user", content: [block("记忆二：不要按进程名杀 node")], source: src }, { surfaceOp: "append" });
	s.append("assistant/message", {
		turn: 1, step: 0, stream: [],
		message: { id: "a3", role: "assistant", content: [block("查一下"), { type: "tool-call", id: "c2", name: "grep", arguments: "{}" }], source: src },
	}, { surfaceOp: "append" });
	s.append("tool/result", {
		turn: 1, step: 0,
		message: { id: "r3", role: "user", content: [{ type: "tool-result", toolCallId: "c2", content: [block("命中很多".repeat(200))] }], source: src },
	}, { surfaceOp: "append" });
	s.append("user/message", { id: "u4", role: "user", content: [block("随便一问")], source: src }, { surfaceOp: "append" });
	return s;
}

/** 配对完整性 + 相邻性检查（供应商 400 的两个来源）。 */
function checkPairing(messages) {
	const calls = new Set();
	const results = new Set();
	for (const m of messages) {
		for (const b of m.content ?? []) {
			if (b?.type === "tool-call") calls.add(b.id);
			if (b?.type === "tool-result") results.add(b.toolCallId);
		}
	}
	const orphanCalls = [...calls].filter((id) => !results.has(id));
	const orphanResults = [...results].filter((id) => !calls.has(id));
	let orderOk = true;
	for (let i = 0; i < messages.length; i += 1) {
		const hasCall = (messages[i].content ?? []).some((b) => b?.type === "tool-call");
		if (hasCall && !(messages[i + 1]?.content ?? []).some((b) => b?.type === "tool-result")) orderOk = false;
	}
	return { paired: orphanCalls.length === 0 && orphanResults.length === 0, orphanCalls, orphanResults, orderOk };
}

let failed = 0;

// —— 场景 A：边界正好落在配对边界（折头 6 条，留 1 条）——
{
	const log = (m) => console.log(m);
	console.log("=== 场景 A：干净边界 ===");
	const session = buildSession("fold-a");
	const before = session.deriveMessages();
	console.log(`折叠前: ${before.length} 条`);
	const after = [
		{ role: "user", content: [block("<session-history>摘要</session-history>")] },
		{ role: "user", content: [block("<session-history-since>(no new content)</session-history-since>")] },
		{ role: "user", content: [block("§1§ 随便一问")] },
	];
	const plan = alignSurface(before, after);
	for (const op of plan) console.log(op.kind === "append" ? `  append ${op.messages.length}` : `  ${op.kind} [${op.start}..${op.end}] ${op.note}`);
	const r = landOnSurface({ session, before: structuredClone(before), after, log });
	const final = session.deriveMessages();
	const p = checkPairing(final);
	const ok = final.length < before.length && r.folds === 1 && p.paired && p.orderOk;
	console.log(`落地 ${JSON.stringify(r)}`);
	console.log(`缩短 ${before.length}→${final.length}: ${final.length < before.length ? "✓" : "✗"} | folds=${r.folds} | 配对完整 ${p.paired ? "✓" : "✗"} | 相邻 ${p.orderOk ? "✓" : "✗"}`);
	console.log(`结果: ${ok ? "✓ PASS" : "✗ FAIL"}\n`);
	if (!ok) failed += 1;
}

// —— 场景 B：折叠边界落在配对中间（折 2 条：user + assistant-with-toolcall）——
{
	const log = (m) => console.log(m);
	console.log("=== 场景 B：边界落在配对中间（必须内缩） ===");
	const session = buildSession("fold-b");
	const before = session.deriveMessages();
	console.log(`折叠前: ${before.length} 条`);
	// bundle 只保留尾部 5 条（§1§ 记忆二、§2§ 查一下、§3§ 随便一问 —— 折掉前 2 条）
	// 注意：折段 [0..1] = user + assistant(tool-call)，把 tool/result 留在外面 → 孤儿！
	const after = [
		{ role: "user", content: [block("<session-history>摘要</session-history>")] },
		{ role: "user", content: [block("§1§ 记忆二：不要按进程名杀 node")] },
		{ role: "assistant", content: [block("§2§ 查一下"), { type: "tool_use", id: "c2", name: "grep", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", toolCallId: "c2", content: [block("命中很多".repeat(200))] }] },
		{ role: "user", content: [block("§3§ 随便一问")] },
	];
	const plan = alignSurface(before, after);
	for (const op of plan) console.log(op.kind === "append" ? `  append ${op.messages.length}` : `  ${op.kind} [${op.start}..${op.end}] ${op.note}`);
	const r = landOnSurface({ session, before: structuredClone(before), after, log });
	const final = session.deriveMessages();
	const p = checkPairing(final);
	for (const m of final) console.log(`  ${String(m.role).padEnd(9)} ${JSON.stringify(String(m.content?.[0]?.text ?? m.content?.[0]?.type ?? "").slice(0, 50))}`);
	const ok = final.length < before.length && p.paired && p.orderOk;
	console.log(`落地 ${JSON.stringify(r)}`);
	console.log(`缩短 ${before.length}→${final.length}: ${final.length < before.length ? "✓" : "✗"} | 配对完整 ${p.paired ? "✓" : "✗"} (孤儿 ${p.orphanCalls.length}/${p.orphanResults.length}) | 相邻 ${p.orderOk ? "✓" : "✗"}`);
	console.log(`结果: ${ok ? "✓ PASS" : "✗ FAIL"}\n`);
	if (!ok) failed += 1;
}

// —— 场景 C：折段**尾部**落在配对中间（tool/result 被留下）——
// 场景 B 的两条边界恰好都是平衡的，没打到内缩保护。这里让 alignSurface 的
// end 指向 assistant-with-tool-call 本身（cuts[end+1] === false），必须内缩。
{
	const log = (m) => console.log(m);
	console.log("=== 场景 C：尾部边界在配对中间（必须内缩） ===");
	const session = buildSession("fold-c");
	const before = session.deriveMessages();
	console.log(`折叠前: ${before.length} 条`);
	// 保留尾部 5 条，但让「被折掉的最后一条」= a3(assistant+tool-call, index 4)
	// 折段 = [0..4]（user, a1, r1, user, a3）→ end 指向 a3，cuts[5] 为 false
	const after = [
		{ role: "user", content: [block("<session-history>摘要</session-history>")] },
		{ role: "user", content: [{ type: "tool_result", toolCallId: "c2", content: [block("命中很多".repeat(200))] }] },
		{ role: "user", content: [block("§1§ 随便一问")] },
	];
	const plan = alignSurface(before, after);
	for (const op of plan) console.log(op.kind === "append" ? `  append ${op.messages.length}` : `  ${op.kind} [${op.start}..${op.end}] ${op.note}`);
	// 确认这个场景真的把 end 落到了不平衡处（否则本场景没测到东西）
	const rep = plan.find((o) => o.kind === "replace");
	const cutsBefore = (() => {
		let open = 0; const c = [true];
		for (const seq of session.surface.nodes) {
			const e = session.eventAt(seq);
			if (e?.type === "assistant/message") open += (e.data?.message?.content ?? []).filter((b) => b?.type === "tool-call").length;
			else if (e?.type === "tool/result") open -= 1;
			c.push(open === 0);
		}
		return c;
	})();
	const endUnbalanced = rep && cutsBefore[rep.end + 1] === false;
	console.log(`  （前置条件：end=${rep?.end} 处切口不平衡 = ${endUnbalanced}）`);
	const r = landOnSurface({ session, before: structuredClone(before), after, log });
	const final = session.deriveMessages();
	const p = checkPairing(final);
	for (const m of final) console.log(`  ${String(m.role).padEnd(9)} ${JSON.stringify(String(m.content?.[0]?.text ?? m.content?.[0]?.type ?? "").slice(0, 50))}`);
	// 关键：内缩后 tool/result 仍与 a3 成对；不能出现孤儿 result
	const ok = endUnbalanced && final.length < before.length && p.paired && p.orderOk;
	console.log(`落地 ${JSON.stringify(r)}`);
	console.log(`前置条件成立 ${endUnbalanced ? "✓" : "✗"} | 缩短 ${before.length}→${final.length} | 配对完整 ${p.paired ? "✓" : "✗"} (孤儿 ${p.orphanCalls.length}/${p.orphanResults.length}) | 相邻 ${p.orderOk ? "✓" : "✗"}`);
	console.log(`结果: ${ok ? "✓ PASS" : "✗ FAIL"}\n`);
	if (!ok) failed += 1;
}

// —— 场景 D：carrier 必须剥掉 §N§（否则下一轮再叠一层 → 无界增生）——
{
	const log = (m) => console.log(m);
	console.log("=== 场景 D：carrier 不得带 §N§ ===");
	const session = buildSession("fold-d");
	const before = session.deriveMessages();
	// midB 恰好 1 条、role=user、无 tool block → 会走「直接用 bundle 那条当 carrier」分支。
	// 它带着 §9§：写进 surface 就成了真历史，下一轮 bundle 再打一层 → §10§ §9§ …
	const after = [
		{ role: "user", content: [block("<session-history>摘要</session-history>")] },
		{ role: "user", content: [block("§9§ 折叠后仅剩的这条")] },
	];
	const r = landOnSurface({ session, before: structuredClone(before), after, log });
	const final = session.deriveMessages();
	const allText = final.map((m) => String(m.content?.[0]?.text ?? "")).join("\n");
	const leaked = /§\d+§/.test(allText);
	const ok = r.folds === 1 && !leaked;
	console.log(`落地 ${JSON.stringify(r)}`);
	console.log(`未泄漏 §N§: ${leaked ? "✗" : "✓"} | 缩短 ${before.length}→${final.length}`);
	if (leaked) console.log(`  泄漏内容: ${allText.replace(/\n/g, " | ").slice(0, 200)}`);
	console.log(`结果: ${ok ? "✓ PASS" : "✗ FAIL"}\n`);
	if (!ok) failed += 1;
}

console.log(failed === 0 ? "全部通过 ✓" : `${failed} 个场景失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
