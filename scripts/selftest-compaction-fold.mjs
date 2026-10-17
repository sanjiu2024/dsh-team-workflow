#!/usr/bin/env node
/**
 * 自检：确定性折叠后端（REQ-018 的 ①）。
 *
 * 四段：
 *   1. 装配：`apply` 异步取到基类、派生、用同一份 config 注册服务（服务名由基类决定）
 *   2. **不调模型**：`summarize` 返回折叠产物，假基类的 LLM 路径**一次都没被调**（这条是灵魂）
 *   3. 返回值形状：走 `SummaryResult` 的**未标记**那一支（没有 `llmStreamCall` / `rawOutput`）
 *   4. 尺寸与退路：用宿主的计量器核对「确实更小」；折不动时**退回超类**去调 LLM，而不是让压缩失败
 *
 * 假基类照真实接口造：`constructor(ctx, config)`（真基类在里面 `super(ctx, "compaction")` 注册服务）、
 * `summarize(input, agent, signal)`（真实现调 LLM）。别按想象造 —— 这个仓库已经栽过三次。
 *
 *   node scripts/selftest-compaction-fold.mjs
 */
import * as assert from "node:assert/strict";
import { SAFE_RATIO, apply, estimateMessages, foldForBudget } from "../lib/compaction-fold.js";
import { contentText } from "../lib/fold-core.js";

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

const msg = (role, text) => ({ role, content: [{ type: "text", text }] });
const long = (n, ch = "x") => ch.repeat(n);

/** 假基类：记录构造参数与「LLM 路径」被调了几次。 */
function makeFakeBase() {
	const seen = { constructed: [], instances: [], llmCalls: 0 };
	class FakeBase {
		constructor(ctx, config) {
			this.ctx = ctx;
			this.config = config;
			seen.constructed.push({ ctx, config });
			seen.instances.push(this);
		}
		async summarize() {
			seen.llmCalls += 1;
			return { summary: [{ type: "text", text: "LLM 写的摘要" }], provider: "p", model: "m", llmStreamCall: true };
		}
	}
	return { FakeBase, seen };
}

/** 假 ctx：loader.import 供 makeHostLoader 用；tokenMeter 照真实形状（estimateMessage）。 */
function makeCtx({ base = makeFakeBase().FakeBase, withMeter = true } = {}) {
	const ctx = {
		logger: { info: () => {} },
		loader: { import: async () => ({ BasicCompactionEngine: base }) },
		...(withMeter ? { tokenMeter: { estimateMessage: (m) => Math.ceil(contentText(m).length / 4) } } : {}),
	};
	return ctx;
}

const foldable = () => [
	msg("user", "请修 A、B、C 三处"),
	msg("tool", long(8000, "t")),
	msg("assistant", `结论 ${long(4000, "a")}`),
	msg("tool", long(8000, "u")),
];

// ── 1. 装配 ─────────────────────────────────────────────────────────────────

await checkAsync("装配：异步取基类、派生、用同一份 config 注册（config 要能到达引擎）", async () => {
	const { FakeBase, seen } = makeFakeBase();
	const config = { thresholdRatio: 0.25, headroomTokens: 65536 };
	const ctx = makeCtx({ base: FakeBase });
	await apply(ctx, config);
	assert.equal(seen.constructed.length, 1, "该注册恰好一个引擎");
	assert.equal(seen.constructed[0].config, config, "预设里那一行的 config 要原样传进去");
	assert.equal(seen.constructed[0].ctx, ctx);
});

await checkAsync("装配：基类没导出 → 明确抛错（不静默失效）", async () => {
	const ctx = makeCtx({ base: null }); // null 而不是 undefined：undefined 会走默认参数
	await assert.rejects(() => apply(ctx, {}), /没导出 BasicCompactionEngine/);
});

// ── 2. 不调模型 ─────────────────────────────────────────────────────────────

await checkAsync("不调模型：summarize 返回折叠产物，假基类的 LLM 路径一次都没被调", async () => {
	const { FakeBase, seen } = makeFakeBase();
	const ctx = makeCtx({ base: FakeBase });
	await apply(ctx, {});
	// apply 不返回实例，所以从假基类的构造记录里取刚造的那个
	const instance = seen.instances[0];
	assert.ok(instance, "要能拿到引擎实例");
	const result = await instance.summarize({ messages: foldable() }, { id: "agent" }, undefined);
	assert.equal(seen.llmCalls, 0, "折叠后端**一次都不该调 LLM**");
	assert.match(result.summary[0].text, /确定性折叠/, "产物要带折叠说明");
	assert.match(result.summary[0].text, /用户原话/, "产物要有结构");
});

// ── 3. 返回值形状 ───────────────────────────────────────────────────────────

await checkAsync("形状：走 SummaryResult 的未标记那一支（没有 llmStreamCall / rawOutput）", async () => {
	const { FakeBase, seen } = makeFakeBase();
	await apply(makeCtx({ base: FakeBase }), {});
	const result = await seen.instances[0].summarize({ messages: foldable() });
	assert.ok(Array.isArray(result.summary), "summary 必须是块数组");
	assert.equal(result.summary[0].type, "text");
	assert.equal(result.provider, "", "没调模型 → provider 空串（宿主允许成对空）");
	assert.equal(result.model, "");
	assert.equal(result.llmStreamCall, undefined, "没走 llm.stream()，不许打这个标记");
	assert.equal(result.rawOutput, undefined);
});

// ── 4. 尺寸与退路 ───────────────────────────────────────────────────────────

check("计量：estimateMessages 用宿主那把尺；没有计量器就返回 undefined（不猜）", () => {
	const meter = { estimateMessage: (m) => contentText(m).length };
	assert.equal(estimateMessages(meter, [msg("user", "12345")]), 5);
	assert.equal(estimateMessages(undefined, [msg("user", "12345")]), undefined);
	assert.equal(estimateMessages({}, [msg("user", "12345")]), undefined);
});

check("尺寸：可折的区间，产物要明显小于输入（basic 那道闸是 throw）", () => {
	const meter = { estimateMessage: (m) => Math.ceil(contentText(m).length / 4) };
	const out = foldForBudget(foldable(), meter);
	assert.ok(out.text, "该折出东西");
	assert.ok(out.ratio < SAFE_RATIO, `要比输入小到 ${SAFE_RATIO} 以下，实际 ${out.ratio}`);
	assert.ok(out.inputTokens > 0 && out.summaryTokens > 0);
});

check("重折：第一遍只能到硬截断线（≈0.9）时，必须按更狠的比例再折一次", () => {
	// 需要重折的形状：**消息极多**时每条 40 字符的地板之和超过输入 → 折叠侧只能硬截断到 90%
	// → 0.9 ≥ SAFE_RATIO → 必须按更狠的比例再折。其它形状第一遍就达标（折叠侧目标本来就是 35%），
	// 所以没有这条用例的话，「重折循环」删掉套件也全绿。
	const meter = { estimateMessage: (m) => contentText(m).length };
	const many = [];
	for (let i = 0; i < 100; i += 1) many.push(msg("tool", long(50, "t")));
	const out = foldForBudget(many, meter);
	assert.ok(out.attempts >= 1, `该重折，实际 attempts=${out.attempts}`);
	assert.ok(out.ratio < SAFE_RATIO, `重折后要达标，实际 ${out.ratio}`);
});

check("退路：折不动（区间里全是必须逐字留的用户原话）→ 标记 fellBack，交给超类去调 LLM", () => {
	// 什么时候真的折不动：**极小区间**。折叠侧对 <200 字符的区间不启用硬截断（那种区间压根不该被压），
	// 而说明文字本身就有近百字符 → token 比 > 1。大区间折不动是不可能的：硬截断保证 ≤0.9。
	const meter = { estimateMessage: (m) => contentText(m).length };
	const out = foldForBudget([msg("user", "短需求")], meter);
	assert.ok(out.ratio > 1, `极小区间该折不动，实际 ratio=${out.ratio}`);
	assert.equal(out.fellBack, true, "折不动要明确标记，不能硬塞给 basic 让它 throw");
	assert.equal(out.text, undefined);
});

await checkAsync("退路接线：fellBack 时真的调回超类（而不是返回空摘要）", async () => {
	const { FakeBase, seen } = makeFakeBase();
	await apply(makeCtx({ base: FakeBase }), {});
	const result = await seen.instances[0].summarize({ messages: [msg("user", "短需求")] });
	assert.equal(seen.llmCalls, 1, "折不动时该退回超类");
	assert.equal(result.provider, "p", "退回后拿到的是超类的结果");
});

await checkAsync("没有计量器时：不猜尺寸，照常折（折叠侧已按字符保证比输入小）", async () => {
	const { FakeBase, seen } = makeFakeBase();
	await apply(makeCtx({ base: FakeBase, withMeter: false }), {});
	const result = await seen.instances[0].summarize({ messages: foldable() });
	assert.match(result.summary[0].text, /确定性折叠/);
	assert.equal(seen.llmCalls, 0);
});

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：确定性折叠后端（装配 / 不调模型 / 返回值形状 / 尺寸与退路）");
}
