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

// ── 6. 跨会话的同参数调用不算重复 ─────────────────────────────────────────
// 曾经的聚合键是 `${tool}|${argsSha}`，没带 sessionId —— 同一个 read 参数
// 出现在 9 次调用里就报「同参数调了 9 次」，实际那是跨 3 个会话各读几次。
// 两个会话不共享上下文，各自读一次谁都没付第二遍钱，不该计入浪费。
{
	const call = (sessionId, file, callId, off = undefined) => [
		{
			event: "tool_call",
			sessionId,
			toolName: "read",
			toolCallId: callId,
			argsSha256: `sha-${file}-${off}`,
			argsPreview: JSON.stringify({ file_path: file, ...(off === undefined ? {} : { offset: off, limit: 50 }) }),
		},
		{ event: "tool_result", sessionId, toolCallId: callId, resultChars: 4000, isError: false },
	];
	const flat = (arr) => arr.flat();

	// 同一文件、同一参数，但分属两个会话 → 不是浪费
	const cross = aggregateEvents(
		flat([call("sA", "/f.txt", "c1"), call("sB", "/f.txt", "c2")]),
	);
	const rc = buildReport(cross);
	assert.equal(rc.duplicates.length, 0, `跨会话同参数不得算重复，实际：${JSON.stringify(rc.duplicates)}`);
	assert.equal(rc.repeatedReads.length, 0, "跨会话读同一文件不得进「同会话内重复读取」");

	// 同一会话、同一参数两次 → 真的是重复
	const same = aggregateEvents(flat([call("sA", "/f.txt", "c1"), call("sA", "/f.txt", "c2")]));
	const rs = buildReport(same);
	assert.equal(rs.duplicates.length, 1, "同会话同参数两次应算一条重复");
	assert.equal(rs.duplicates[0].count, 2);
	assert.equal(rs.duplicates[0].wastedChars, 4000, "多读的那一次结果字符全浪费");
	assert.equal(rs.repeatedReads.length, 1);
	assert.equal(rs.repeatedReads[0].sameArgs, 2, "同 offset/limit 才算「同参数」");

	// 同一会话、同文件、不同区段（不同 offset）→ 是在翻文件，不是重复读
	const paged = aggregateEvents(
		flat([call("sA", "/f.txt", "c1", 0), call("sA", "/f.txt", "c2", 100)]),
	);
	const rp = buildReport(paged);
	assert.equal(rp.duplicates.length, 0, "不同 offset 不是同参数");
	assert.equal(rp.repeatedReads.length, 1, "同一文件读了两次要列出来");
	assert.equal(rp.repeatedReads[0].count, 2);
	assert.equal(rp.repeatedReads[0].sameArgs, 1, "两次区段不同 → 同参数计数为 1，用来说明不是浪费");
}

// ── 7. 搜索词重复：跨会话的次数要报出来（缓存是进程级，本该拦住）─────
// 网络时间跨会话也是真花的；但上下文只在同会话内重复付费，所以两个
// 数要分开给 —— 不弄清这件事就会把「4 个会话各搜一次」错当成 4 次浪费。
{
	const search = (sessionId, callId, queries) => [
		{
			event: "tool_call",
			sessionId,
			toolName: "web_search",
			toolCallId: callId,
			argsSha256: `sha-${callId}`,
			argsPreview: JSON.stringify({ queries }),
		},
		{ event: "tool_result", sessionId, toolName: "web_search", toolCallId: callId, resultChars: 500, isError: false },
	];
	const agg = aggregateEvents([
		...search("sA", "w1", ["vue3"]),
		...search("sB", "w2", ["vue3"]),
		...search("sC", "w3", [" vue3 "]), // 空白归一后是同一组词
	]);
	const w = buildReport(agg).web;
	assert.equal(w.repeated.length, 1, "同一组搜索词只该出现一行");
	assert.equal(w.repeated[0].count, 3, "次数跨会话累计");
	assert.equal(w.repeated[0].sessions, 3, "同时报出横跨几个会话，读者才能分清网络时间与上下文");

	// 单会话内搜两次也是重复（这次上下文也真付了两遍）
	const one = buildReport(aggregateEvents([...search("sA", "w1", ["vue3"]), ...search("sA", "w2", ["vue3"])])).web;
	assert.equal(one.repeated[0].count, 2);
	assert.equal(one.repeated[0].sessions, 1);
}

console.log("✓ 用量日报自检通过");
