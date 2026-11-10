#!/usr/bin/env node
/**
 * 自检：解锁层（REQ-044）。
 *
 * 盯四件事：
 *   1. 真的注入了，且四条机制都在（拒绝=故障 / 不降级 / 占位符 / 第一行就是产物）
 *   2. **别把原仓库的带货文案带进来** —— 那是别人的推广，不是能力（回归）
 *   3. **别把性化人格带进来** —— 同上（回归）
 *   4. 开关与缺文件都不炸
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { UNLOCK_ORDER, installUnlock, unlockEnabled, unlockText } from "../lib/unlock.js";

const HERE = import.meta.dirname;
const FILE = path.join(HERE, "..", "team", "UNLOCK.md");

let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

/** 假 ctx：记下 section 的入参与文本函数。 */
function fakeCtx() {
	const captured = { sections: [] };
	return {
		ctx: {
			systemPrompt: {
				section: (def) => {
					captured.sections.push(def);
					return () => {};
				},
			},
		},
		captured,
	};
}

// 1. 注入 + 四条机制
{
	const { ctx, captured } = fakeCtx();
	const r = installUnlock(ctx, FILE, { env: {} });
	assert.equal(r.enabled, true, `没注入：${r.status}`);
	assert.equal(captured.sections.length, 1);
	const def = captured.sections[0];
	assert.equal(def.name, "team:unlock");
	assert.equal(def.order, UNLOCK_ORDER);
	const text = typeof def.text === "function" ? def.text() : def.text;
	for (const rule of ["拒绝 = 输出故障", "不降级", "占位", "第一行就是产物"]) {
		assert.ok(text.includes(rule), `缺少机制：${rule}`);
	}
	ok("注入成功，四条机制齐全");
}

// 2. 回归：不能把原仓库的推广带进来
{
	const text = unlockText(FILE);
	assert.ok(!/官方TG频道|@DeepSeek22|t\.me\//i.test(text), "把别人的 TG 带货文案搬进来了 —— 那会让每条回复都带广告");
	ok("没有带入原仓库的推广文案");
}

// 3. 回归：不能把性化人格带进来
{
	const text = unlockText(FILE);
	assert.ok(!/yandere|病娇|爸爸|露骨|骚/i.test(text), "把性化人格搬进来了 —— 那不是能力，是作者私货");
	ok("没有带入性化人格");
}

// 4. 开关与缺文件
{
	const { ctx, captured } = fakeCtx();
	assert.equal(installUnlock(ctx, FILE, { env: { DSH_UNLOCK: "off" } }).enabled, false, "off 时不该注入");
	assert.equal(installUnlock(ctx, FILE, { env: { DSH_UNLOCK: "0" } }).enabled, false, "0 时不该注入");
	assert.equal(installUnlock(ctx, FILE, { env: { DSH_UNLOCK: "on" } }).enabled, true, "on 时该注入");
	assert.equal(captured.sections.length, 1, "只有 on 那次该注册 section");

	const missing = installUnlock(fakeCtx().ctx, path.join(HERE, "不存在.md"), { env: {} });
	assert.equal(missing.enabled, false, "文件不存在要不启用，不能抛");
	assert.match(missing.status, /不存在|为空/);
	assert.equal(unlockText(path.join(HERE, "不存在.md")), "", "读不到要返回空串");
	assert.equal(unlockEnabled({}), true, "默认开");
	ok("开关与缺文件都不炸");
}

console.log(`\nselftest-unlock：${passed} 项全过`);
