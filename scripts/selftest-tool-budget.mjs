#!/usr/bin/env node
/**
 * 自检：工具结果的字符预算（REQ-040）。
 *
 * 盯四件事：
 *   1. 小结果一个字都不动 —— 这条路径在每个工具返回上都跑，不能有副作用。
 *   2. 大结果**保头留尾**：结论/报错常在末尾，只砍尾巴会把它砍掉。
 *   3. 标记必须说清：多少字符、省了多少、**下一步怎么缩小**（只说「截断了」没用）。
 *   4. 非字符串不抛 —— 它跑在工具返回路径上，这里抛等于把工具弄挂。
 */

import assert from "node:assert/strict";

import { TOOL_BUDGET_DEFAULTS, capToolText } from "../lib/tool-budget.js";

let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

const big = (n) => `HEAD${"x".repeat(n)}TAIL`;

// 1. 小结果原样
{
	const small = "ok: 3 files";
	assert.equal(capToolText(small), small, "小结果被动了");
	ok("小结果原样返回");
}

// 2. 保头留尾
{
	const text = `${"A".repeat(50000)}${"B".repeat(1000)}END-MARK`;
	const out = capToolText(text, { maxChars: 30000, toolName: "ctx_expand" });
	assert.ok(out.startsWith("A"), "头部丢了");
	assert.ok(out.endsWith("END-MARK"), "尾部结论被砍掉了 —— 那正是最该留的部分");
	assert.ok(out.length < 30000 + 600, `产物 ${out.length} 超出预算太多（标记也算进去）`);
	ok(`大结果保头留尾（${text.length} → ${out.length} 字符）`);
}

// 3. 标记说清「怎么缩小」
{
	const input = big(90000);
	const out = capToolText(input, { maxChars: 20000, toolName: "ctx_search" });
	assert.match(out, /ctx_search/, "标记里要带工具名，模型才知道是哪个结果被截了");
	assert.ok(out.includes(String(input.length)), "要写原始长度");
	assert.match(out, /缩小参数|分页|limit/, "只说截断没用，要告诉模型下一步怎么缩小");
	ok("截断标记带工具名、原长度与缩小建议");
}

// 4. 边界与非字符串
{
	const exact = "z".repeat(TOOL_BUDGET_DEFAULTS.maxChars);
	assert.equal(capToolText(exact).length, exact.length, "正好等于预算时不该截");

	assert.equal(capToolText(undefined), "", "非字符串要退化成空串，不能抛");
	assert.equal(capToolText(null, { maxChars: 100 }), "", "null 同上");
	assert.equal(capToolText(12345), "", "数字同上");
	assert.equal(capToolText("short", { maxChars: 0 }), "short", "非法预算要退回默认，不能把内容截成空");
	ok("边界：正好等于预算不动、非字符串不抛、非法预算退回默认");
}

console.log(`\nselftest-tool-budget：${passed} 项全过`);
