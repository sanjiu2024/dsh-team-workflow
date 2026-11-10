#!/usr/bin/env node
/**
 * 自检：小队失败分类与定向修复（REQ-042）。
 *
 * 盯三件事：
 *   1. 分类要对得上真实失败文本（测试红、缺文件、权限、超时、编译、网络）
 *   2. **认不出来就说认不出来** —— 硬套一个类别比不分类更坏（会把人引向错方向）
 *   3. 建议必须指向**动作**，不是「再试一次」这种废话
 */

import assert from "node:assert/strict";

import { classifyFailure, repairDirective } from "../lib/squad-repair.js";

let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

// 1. 真实失败文本 → 正确分类
{
	const cases = [
		["npm test 失败：3 failing", "test-failed"],
		["AssertionError: expected 2 to equal 3", "test-failed"],
		["ENOENT: no such file or directory, open 'src/a.js'", "missing-file"],
		["EACCES: permission denied, open '/etc/hosts'", "permission"],
		["Command timed out after 120000ms", "timeout"],
		["SyntaxError: Unexpected token ')'", "compile"],
		["ECONNREFUSED 127.0.0.1:7897", "network"],
		["步数用尽（上限 80）", "steps-exhausted"],
	];
	for (const [text, kind] of cases) {
		assert.equal(classifyFailure(text).kind, kind, `「${text}」应判为 ${kind}`);
	}
	ok(`8 类失败文本都能分类（${cases.length} 条）`);
}

// 2. 认不出来不硬套
{
	const r = classifyFailure("模型自己决定停下来想想");
	assert.equal(r.kind, "unknown");
	assert.equal(r.hint, null, "认不出来就不能给建议");
	assert.equal(repairDirective("模型自己决定停下来想想"), "", "认不出来要返回空串，让调用方原样重派");
	ok("认不出来不硬套、也不塞废话");
}

// 3. 建议指向动作
{
	const hint = repairDirective("ECONNREFUSED 127.0.0.1:7897");
	assert.match(hint, /ECONNREFUSED|network/, "建议里要带类别");
	assert.match(hint, /curl|直连|端点/, "要给出具体动作，不是「再试一次」");
	assert.ok(!/再试一次|重试即可/.test(hint.replace(/别在同一地址上重试/, "")), "不能是空话");
	ok("建议指向具体动作");
}

// 4. 空输入
{
	assert.equal(classifyFailure("").kind, "unknown");
	assert.equal(classifyFailure(undefined).kind, "unknown", "非字符串不能抛");
	ok("空/非字符串输入不抛");
}

console.log(`\nselftest-squad-repair：${passed} 项全过`);
