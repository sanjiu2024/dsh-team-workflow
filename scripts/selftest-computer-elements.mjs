#!/usr/bin/env node
/**
 * 自检：观测编号表（REQ-024 步骤 6）。
 *
 * 这张表唯一的作用是**拦住过期编号**。它的性质是纯的，所以全部用假数据测，
 * 不需要开关窗口 —— 真正容易错的部分（UIA 三重校验）在 daemon 侧，
 * 由 `invoke` 的集成实测覆盖（见 REQ-024 §8 记录的五条路径）。
 *
 * 反向验证（改坏必须红）：
 *   · 把 `Number(expectVersion) !== version` 改成 `!== version + 1` → 「过期编号」那条红；
 *   · 把 `elements[idx - 1]` 改成 `elements[idx]` → 「1-based 寻址」那条红。
 *
 *   node scripts/selftest-computer-elements.mjs
 */
import * as assert from "node:assert/strict";

import { createElementTable } from "../lib/computer/core/elements.js";

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures += 1;
		console.error(`  ✗ ${name}\n      ${err?.message ?? err}`);
	}
};

const fake = (name) => ({ role: "Button", name, x: 10, y: 20, w: 100, h: 30, patterns: ["invoke"] });

check("空表：resolve 必须拒绝，并指路让人去观测", () => {
	const t = createElementTable();
	const r = t.resolve(1);
	assert.ok(r.error, "空表不该返回元素");
	assert.match(r.error, /observe_screen/, "错误里要告诉模型下一步该干什么");
	assert.equal(t.size, 0);
});

check("load 每次递增版本号，并记住窗口句柄", () => {
	const t = createElementTable();
	assert.equal(t.load(111, [fake("a")]), 1);
	assert.equal(t.load(222, [fake("b"), fake("c")]), 2);
	assert.equal(t.version, 2);
	assert.equal(t.size, 2);
	const r = t.resolve(1, 2);
	assert.equal(r.hwnd, 222, "句柄应来自最近一次观测");
	assert.equal(r.el.name, "b");
});

check("1-based 寻址：编号 1 是第一个元素", () => {
	const t = createElementTable();
	t.load(1, [fake("first"), fake("second")]);
	assert.equal(t.resolve(1).el.name, "first");
	assert.equal(t.resolve(2).el.name, "second");
});

check("越界编号：报错并带上当前总数", () => {
	const t = createElementTable();
	t.load(1, [fake("only")]);
	const r = t.resolve(3);
	assert.ok(r.error);
	assert.match(r.error, /没有第 3 号/);
	assert.match(r.error, /共 1 个/);
});

check("非正整数编号：直接拒绝（不让 NaN 变成第 0 个）", () => {
	const t = createElementTable();
	t.load(1, [fake("x")]);
	for (const bad of [0, -1, 1.5, "abc", null, undefined]) {
		assert.ok(t.resolve(bad).error, `${bad} 应该被拒绝`);
	}
});

check("**过期版本号必须拒绝**（这是整张表存在的理由）", () => {
	const t = createElementTable();
	t.load(1, [fake("old")]);
	t.load(2, [fake("new")]);
	const r = t.resolve(1, 1);
	assert.ok(r.error, "用第 1 次的编号在第 2 次之后点击必须被拒");
	assert.match(r.error, /已过期/);
	assert.match(r.error, /第 1 次/);
	assert.match(r.error, /第 2 次/);
});

check("版本号一致时放行", () => {
	const t = createElementTable();
	t.load(1, [fake("ok")]);
	const r = t.resolve(1, 1);
	assert.equal(r.el.name, "ok");
	assert.equal(r.version, 1);
});

check("不给版本号时不校验版本（仍受编号范围约束）", () => {
	const t = createElementTable();
	t.load(1, [fake("a")]);
	t.load(2, [fake("b")]);
	assert.equal(t.resolve(1).el.name, "b", "不给版本号就用当前表");
	assert.ok(t.resolve(9).error, "但越界仍然要拒");
});

check("clear 之后回到「还没观测过」", () => {
	const t = createElementTable();
	t.load(1, [fake("a")]);
	t.clear();
	assert.equal(t.size, 0);
	assert.match(t.resolve(1).error, /observe_screen/);
});

if (failures > 0) {
	console.error(`\n✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("\n✓ 自检通过：1-based 寻址 / 版本过期拒绝 / 越界与非整数拒绝 / clear 归零");
}
