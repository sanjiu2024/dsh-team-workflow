#!/usr/bin/env node
/**
 * 用量日报自检：aggregateEvents + renderMarkdown 的关键口径。
 *
 * 为什么单独一个文件：这个脚本产出的数字是定时任务改代码的依据，
 * 数字错了比崩了更危险 —— 崩了看得见，「推理 reasoning 恒为 0」这种
 * 是悄悄误导人。零依赖，断言失败直接抛。
 *
 * 重点是那条 67 字节 bug 的同类：**没数据 ≠ 值是 0**。网关不回
 * `reasoning_tokens` 时，日报曾经印一个好看的 0，读的人以为
 * 「模型没推理」，实际是「没这个数据」。
 */

import assert from "node:assert/strict";

import { aggregateEvents, buildReport, renderMarkdown, estTokens } from "./usage-report.mjs";

// —— 造事件：一条会话、两步 ——
const use = (over) => ({
	event: "assistant_usage",
	sessionId: "s1",
	turn: 1,
	ts: "2026-01-01T00:00:00.000+08:00",
	usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, total: 1050, reasoning: null },
	thinkingChars: 0,
	...over,
});

const meta = { date: "2026-01-01", source: "selftest", lines: 0, badLines: 0 };

// ── 1. 网关不回 reasoning_tokens：应当说「无此数据」，不能印 0 ──────────
{
	const events = [
		use({ thinkingChars: 268, usage: { input: 253, cacheRead: 8576, cacheWrite: 0, output: 217, total: 9046, reasoning: null } }),
		use({ thinkingChars: 0, usage: { input: 1, cacheRead: 2, cacheWrite: 0, output: 3, total: 6, reasoning: null } }),
	];
	const agg = aggregateEvents(events);
	assert.equal(agg.tokens.reasoningReported, 0, "网关没回 reasoning 时 reasoningReported 应为 0");
	assert.equal(agg.tokens.reasoning, 0, "没有 reasoning 数据时求和仍是 0");
	assert.equal(agg.tokens.thinkingChars, 268, "thinkingChars 应累计");
	assert.equal(agg.tokens.thinkingSteps, 1, "只有 thinkingChars>0 的步算「有思考」");

	const md = renderMarkdown(buildReport(agg), meta);
	assert.match(md, /推理 reasoning \| 无此数据/, `缺数据时必须明说，实际：${md.match(/推理 reasoning.*/)}`);
	assert.doesNotMatch(md, /推理 reasoning \| 0 \|/, "绝不能印一个假的 0");
	assert.match(md, /思维字符数 thinkingChars \| 268（1 步有思考）/, "真实量到的思维字符数要顶上");
	assert.ok(md.includes("thinkingChars"), "字面量要能被 grep 到");
	// 计数行也要对
	assert.match(md, /模型请求 \| 2 \|/, "两条 usage = 2 次请求");
}

// ── 2. 网关回了 reasoning_tokens：照常印数字，不要退化成「无此数据」 ────
{
	const events = [
		use({ usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 20, total: 30, reasoning: 7 } }),
		use({ usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2, total: 3, reasoning: 3 } }),
	];
	const agg = aggregateEvents(events);
	assert.equal(agg.tokens.reasoningReported, 2, "两条都回了 reasoning");
	assert.equal(agg.tokens.reasoning, 10, "reasoning 应累加 7+3");

	const md = renderMarkdown(buildReport(agg), meta);
	assert.match(md, /推理 reasoning \| 10 \|/, `有数据时照常印数字，实际：${md.match(/推理 reasoning.*/)}`);
	assert.doesNotMatch(md, /无此数据/, "有数据时不该说「无此数据」");
}

// ── 3. reasoning 为 null 与缺字段都不算「回了」 ──────────────────────────
{
	const a = aggregateEvents([use({ usage: { input: 1, output: 1, total: 2 } })]);
	assert.equal(a.tokens.reasoningReported, 0, "usage 里没有 reasoning 字段时不算回了");
	const b = aggregateEvents([use({ usage: { input: 1, output: 1, total: 2, reasoning: null } })]);
	assert.equal(b.tokens.reasoningReported, 0, "reasoning: null 不算回了");
	const c = aggregateEvents([use({ usage: { input: 1, output: 1, total: 2, reasoning: 0 } })]);
	assert.equal(c.tokens.reasoningReported, 1, "reasoning: 0 是真实的 0，要算「回了」");
}

// ── 4. 计费输入口径没被改动：input + cacheRead + cacheWrite ──────────────
{
	const agg = aggregateEvents([use({ usage: { input: 100, cacheRead: 900, cacheWrite: 5, output: 50, total: 1055, reasoning: null } })]);
	const r = buildReport(agg);
	assert.equal(r.tokens.billing, 1005, "计费输入 = 100 + 900 + 5");
	assert.equal(r.tokens.cacheHitRate, Number((900 / 1005).toFixed(4)), "命中率 = cacheRead / billing（保留 4 位）");
}

// ── 5. estTokens 口径：字符 → token 的粗估没被顺手改 ────────────────────
// 边界：chars 来自审计日志的 resultChars，恒非负；这里只钉住正数口径，
// 不为「负数该返回啥」加代码 —— 没有调用方能传负数，加了就是没人用的分支。
{
	assert.equal(estTokens(3500), 1000, "默认 3.5 字符/token");
	assert.equal(estTokens(0), 0);
	assert.equal(estTokens(1), 0, "不足一个 token 四舍五入到 0");
}

console.log("✓ 用量日报自检通过");
