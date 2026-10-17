#!/usr/bin/env node
/**
 * 自检：出处过滤（REQ-018 的 ②）。
 *
 * 三段（**只测纯函数与过滤本身** —— 接线还没写，而且第一版接线是错的，见 lib/context-filter.js 头注释）：
 *   1. 纯函数：`distinctiveTokens`（挑可查标识，纯数字不算）/ `parseCheckpoint`（条目 vs 结构）
 *   2. 过滤本身：删无出处的、留有出处的、写清删了几条
 *   3. **安全闸**：查不了就留、删太多就整段放弃（混合场景只删该删的那条）
 *
 * 为什么这几条必须钉住：这个功能的破坏面是**上下文本身** —— 删错一条，模型就永远看不到它了。
 * 所以「宁可不删」的三条约束（只碰 checkpoint / 查不了就留 / 删太多放弃）都要有断言守着。
 *
 *   node scripts/selftest-context-filter.mjs
 */
import * as assert from "node:assert/strict";
import { distinctiveTokens, filterCheckpointText, parseCheckpoint, SUPPORT_TOKENS_PER_ENTRY } from "../lib/context-filter.js";

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures += 1;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
	} catch (error) {
		failures += 1;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

const ckpt = (body) =>
	`This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n<compacted-summary>${body}</compacted-summary>\n\n继续干活。`;

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

check("distinctiveTokens：挑标识符/路径，纯数字不算，去重且限量", () => {
	// 候选要**给够**（超过 SUPPORT_TOKENS_PER_ENTRY）—— 否则「限量」那句断言是空的（变异测不出来）
	const t = distinctiveTokens(
		"- 改了 lib/squad-round.js，把 startMember 和 appendBoard 与 roleToolsFor 都动了，还有 lib/util.js 和 scripts/selftest-squad.mjs（见 REQ-017）",
	);
	assert.ok(t.includes("scripts/selftest-squad.mjs"), `要挑出路径，实际 ${JSON.stringify(t)}`);
	assert.ok(t.includes("lib/squad-round.js"), "要挑出路径");
	assert.ok(!t.includes("1234567"), "纯数字不当证据");
	// 限量的守门员：候选给够时，返回的条数必须**正好**是上限（变异：去掉 slice → 变红）
	assert.equal(t.length, SUPPORT_TOKENS_PER_ENTRY, `要限量，实际 ${JSON.stringify(t)}`);
	assert.ok(t.every((x) => x.length >= 6), "太短的不要");
	assert.deepEqual(distinctiveTokens("- 都是短词 a b c"), [], "太短的不算");
	assert.deepEqual(distinctiveTokens(""), []);
});

check("parseCheckpoint：不是 checkpoint 就返回 null；条目含续行，标题算结构", () => {
	assert.equal(parseCheckpoint("普通用户消息"), null);
	assert.equal(parseCheckpoint("<compacted-summary>没有闭合"), null);
	const p = parseCheckpoint(ckpt("\n## 标题\n- 第一条\n  续行还在第一条里\n- 第二条\n\n散文\n"));
	assert.ok(p, "要能解析");
	const kinds = p.blocks.map((b) => b.kind);
	// 结尾的空行也算一块（它照样原样保留）—— 所以是 7 块不是 6 块
	assert.deepEqual(kinds, ["other", "other", "entry", "entry", "other", "other", "other"], `实际 ${JSON.stringify(kinds)}`);
	assert.match(p.blocks[2].text, /续行还在第一条里/, "续行要归到同一条");
});

// ── 2. 过滤本身 ─────────────────────────────────────────────────────────────

await checkAsync("过滤：删掉无出处的条目、留有出处的、并写清删了几条", async () => {
	const text = ckpt("\n- 有出处的条目 lib/util.js\n- 没出处的条目 幻觉模块/xyz.js\n- 另一条有出处的 lib/index.js\n");
	const out = await filterCheckpointText(text, async (entry) => !entry.includes("幻觉"));
	assert.match(out.text, /lib\/util\.js/, "有出处的要留");
	assert.match(out.text, /lib\/index\.js/, "有出处的要留");
	assert.doesNotMatch(out.text, /幻觉模块/, "无出处的要删");
	assert.match(out.text, /删掉了 1 条/, "要写清删了几条（显式丢失标记）");
	assert.match(out.text, /session_recall/, "要告诉模型原文去哪取");
	assert.equal(out.dropped, 1);
	assert.equal(out.checked, 3);
	assert.match(out.text, /<\/compacted-summary>/, "闭合标签要留着");
});

await checkAsync("过滤：全都有出处 → 一个字节都不动（连标记都不加）", async () => {
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 lib/b.js\n");
	const out = await filterCheckpointText(text, async () => true);
	assert.equal(out.text, text);
	assert.equal(out.dropped, 0);
});

await checkAsync("过滤：没有条目（只有散文）→ 原样返回", async () => {
	const text = ckpt("\n这是一段没有条目的散文。\n");
	const out = await filterCheckpointText(text, async () => false);
	assert.equal(out.text, text);
	assert.equal(out.checked, 0);
});

// ── 3. 安全闸 ───────────────────────────────────────────────────────────────

await checkAsync("安全闸：查不了（isSupported 抛错）→ 留，不当成无出处", async () => {
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 lib/b.js\n");
	const out = await filterCheckpointText(text, async () => {
		throw new Error("检索挂了");
	});
	assert.equal(out.text, text, "查不了就不许删");
	assert.equal(out.dropped, 0);
});

await checkAsync("安全闸：要删的超过一半 → 整段放弃过滤并标记 aborted", async () => {
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 lib/b.js\n- 丙 lib/c.js\n- 丁 lib/d.js\n");
	const out = await filterCheckpointText(text, async () => false);
	assert.equal(out.text, text, "删太多就整段别删");
	assert.equal(out.dropped, 0);
	assert.equal(out.aborted, true, "要标记放弃过（好记一笔）");
});

await checkAsync("安全闸：混合场景（有的无出处、有的查不了）→ 只删无出处的那条，不是整段放弃", async () => {
	// 这条是 catch 里 `ok = true` 的守门员：改成 false 就会多删一条（dropped 从 1 变 2）。
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 hallucinated/x.js\n- 丙 boom/throw.js\n- 丁 lib/d.js\n");
	const out = await filterCheckpointText(text, async (entry) => {
		if (entry.includes("boom")) throw new Error("这条查不了");
		return !entry.includes("hallucinated");
	});
	assert.equal(out.dropped, 1, `只该删无出处那条，实际删了 ${out.dropped}`);
	assert.doesNotMatch(out.text, /hallucinated/);
	assert.match(out.text, /boom\/throw\.js/, "查不了的要留");
	assert.equal(out.aborted, undefined, "没超过一半就不该放弃");
});

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：出处过滤（纯函数 / 过滤与标记 / 安全闸）—— 注意：接线未写，见 lib/context-filter.js 头注释");
}
