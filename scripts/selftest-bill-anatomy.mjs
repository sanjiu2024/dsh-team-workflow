#!/usr/bin/env node
/**
 * 自检：成本拆账（REQ-041）。
 *
 * 盯三件事：
 *   1. 汇总口径：真实 token 只认 `assistant_usage`，字符只认三类正文事件。
 *   2. **估算不能放大 100 倍** —— 这里真踩过：拿百分比去乘 token 总量，结果 92M 变成 5.1G。
 *   3. 没数据就明说，不编数字（审计可以关，关了就是没有）。
 */

import assert from "node:assert/strict";

import { anatomyFromRecords, formatAnatomy } from "../lib/bill-anatomy.js";

let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

const rec = (event, fields = {}) => ({ event, ...fields });

// 1. 空输入
{
	const a = anatomyFromRecords([]);
	assert.equal(a.calls, 0);
	assert.equal(a.bodyChars, 0);
	assert.match(formatAnatomy(a, { date: "2026-11-11" }), /没有可拆的记录/, "空数据要说明，不要印一堆 0");
	ok("空记录不炸、且不编数字");
}

// 2. 汇总口径
{
	const records = [
		rec("assistant_usage", { turn: 1, usage: { input: 1000, cacheRead: 9000, output: 100 } }),
		rec("assistant_usage", { turn: 1, usage: { input: 2000, cacheRead: 8000, output: 200 } }),
		rec("system_message", { turn: 1, chars: 6000 }),
		rec("user_message", { turn: 1, chars: 2000 }),
		rec("tool_result", { turn: 1, toolName: "bash", resultChars: 1000, isError: false }),
		rec("tool_result", { turn: 1, toolName: "bash", resultChars: 500, isError: true }),
		rec("tool_result", { turn: 1, toolName: "read", resultChars: 500, isError: false }),
		rec("compaction_summary", { turn: 1 }),
		{ event: "broken" },
	];
	const a = anatomyFromRecords(records);
	assert.equal(a.calls, 2);
	assert.equal(a.input, 3000);
	assert.equal(a.cacheRead, 17000);
	assert.equal(a.bodyChars, 10000, "正文 = system 6000 + user 2000 + tool 2000");
	assert.equal(a.bySource.tool, 2000);
	assert.equal(a.byTool[0].name, "bash", "按字符降序，bash 在前");
	assert.equal(a.byTool[0].calls, 2);
	assert.equal(a.byTool[0].errors, 1);
	assert.equal(a.toolErrors, 1);
	assert.equal(a.compactions, 1);
	ok("汇总口径正确（token 只认 usage、字符按三类、工具按名字聚合并排序）");
}

// 3. 按调用归属：token 的分母是「调用当时的上下文」，不是最终总量
{
	// 顺序照真实日志：先有消息，再有那条 assistant_usage
	const records = [
		rec("system_message", { turn: 1, chars: 5000 }),
		rec("tool_result", { turn: 1, toolName: "bash", resultChars: 5000 }),
		rec("assistant_usage", { turn: 1, usage: { input: 0, cacheRead: 100000, output: 0 } }),
	];
	const a = anatomyFromRecords(records);
	const text = formatAnatomy(a, { date: "2026-11-11" });
	assert.match(text, /50\.0%/, "两类各占一半，要显示 50.0%");
	// 50% × 100,000 = 50,000 → 显示成 50.0K；错的话会是 5.0M（×100）
	assert.match(text, /50\.0K token/, `估算被放大了：${text.split("\n")[3]}`);
	assert.ok(!/5\.0M token/.test(text), "估算放大了 100 倍 —— pct 又被当比例乘了一次");
	assert.equal(Math.round(a.bySourceTokens.system), 50000, "system 应分到 5 万 token");
	ok("按调用当时构成归属（各半 → 各 50.0K）");
}

// 3b. 回归：多条 system_message 不能累加（第一版把它算成了 5 份基线，24.4% 报成 50.9%）
{
	const records = [
		rec("system_message", { turn: 1, chars: 40000 }),
		rec("user_message", { turn: 1, chars: 40000 }),
		rec("assistant_usage", { turn: 1, usage: { input: 0, cacheRead: 80000, output: 0 } }),
		rec("system_message", { turn: 2, chars: 40000 }),
		rec("user_message", { turn: 2, chars: 40000 }),
		rec("assistant_usage", { turn: 2, usage: { input: 0, cacheRead: 80000, output: 0 } }),
	];
	const a = anatomyFromRecords(records);
	// 两条 system_message 是同一条基线重发，上下文里只有一个：40K，不是 80K
	assert.equal(a.bySource.system, 40000, "system 字符被累加了 —— 上下文里只有一个基线");
	// 若把两条 system_message 累加，system 会是 80K 并压过用户；正确的账里用户更贵
	assert.ok(
		a.bySourceTokens.user > a.bySourceTokens.system,
		`用户累计 80K 应比固定基线更贵，实际 system ${Math.round(a.bySourceTokens.system)} / user ${Math.round(a.bySourceTokens.user)}`,
	);
	ok("多条 system_message 不累加（回归：曾把 24.4% 报成 50.9%）");
}

// 4. 有正文但零 token（审计只记了消息、没记用量）
{
	const records = [rec("system_message", { chars: 100 }), rec("user_message", { chars: 100 })];
	const text = formatAnatomy(anatomyFromRecords(records), { date: "2026-11-11" });
	assert.match(text, /上下文构成/, "有正文就该出构成表");
	assert.match(text, /0 次调用/, "调用为 0 要如实写");
	ok("只有正文没有用量时也能渲染");
}

console.log(`\nselftest-bill-anatomy：${passed} 项全过`);
