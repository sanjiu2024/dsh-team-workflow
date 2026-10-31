#!/usr/bin/env node
/**
 * 自检：`lib/pricing.js`（模型价目表 + 选模型前的价格依据）。
 *
 * 每条断言都配一个能咬住它的变异：
 *   ① **不猜价**：价格未知的模型 `estimateCost` 必须 `ok:false`，且**排序排在最后**
 *      （变异：把未知价当 0 → 它会排到最便宜 → 红）
 *   ② 单位是 per-1M：60k×0.15/1M + 6k×0.6/1M = 0.009 + 0.0036 = 0.0126
 *      （变异：改成 per-1K → 结果大 1000 倍 → 红）
 *   ③ 缓存价只在其存在时计入（变异：无条件加 → ②的期望值对不上 → 红）
 *   ④ `formatUsd` 不能把很小的钱显示成 0.00（看起来像免费）
 *   ⑤ 排序：估算价从便宜到贵（变异：不排 → 按配置顺序 → 红）
 *   ⑥ `enabled:false` 一个都不挂；有模型时挂 1 段 + 1 工具
 *   ⑦ 空表不抛，给一句能照做的提示
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const m = await import("../lib/pricing.js");

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`✓ ${label}`);
};
const expect = (label, actual, want) => {
	assert.deepEqual(actual, want, label);
	ok(label);
};

const flash = {
	id: "deepseek-v4.1-flash",
	label: "DS Flash",
	provider: "p",
	input: 0.15,
	output: 0.6,
	cacheRead: 0.003,
	verified: true,
};
const pricey = { id: "kimi", label: "Kimi", provider: "p", input: 2, output: 10, verified: true };
const unknown = { id: "mystery", label: "Mystery", provider: "p", input: null, output: null, verified: false };

// ① 不猜价
{
	const r = m.estimateCost(unknown, { input: 1e6, output: 1e6 });
	expect("未知价格 → ok:false 且说清原因", [r.ok, r.why], [false, "这个模型的价格未知"]);
	const missing = m.estimateCost(m.findModel([flash], "nope"), {});
	expect("表里没有这个模型 → ok:false", missing.ok, false);
}

// ② 单位是每 100 万 token
{
	const r = m.estimateCost(flash, { input: 60000, output: 6000 });
	assert.equal(r.ok, true);
	// 0.009 + 0.0036 = 0.0126
	assert.ok(Math.abs(r.usd - 0.0126) < 1e-9, `期望 0.0126，实际 ${r.usd}`);
	ok("per-1M 单位：60k in + 6k out = $0.0126");
}

// ③ 缓存价只在存在时计入
{
	const noCache = { ...flash };
	delete noCache.cacheRead;
	const a = m.estimateCost(flash, { input: 60000, output: 6000, cacheRead: 1e6 });
	const b = m.estimateCost(noCache, { input: 60000, output: 6000, cacheRead: 1e6 });
	assert.ok(a.usd > b.usd, "有 cacheRead 价时应当更贵（1M cache 全按缓存价算）");
	ok("缓存价：只有写了 cacheRead 才计入");
}

// ④ 小钱不显示成 0.00
{
	expect("formatUsd(0)", m.formatUsd(0), "$0");
	expect("formatUsd(0.00001) 不能是 $0.0000", m.formatUsd(0.00001), "<$0.0001");
	expect("formatUsd(0.0126)", m.formatUsd(0.0126), "$0.0126");
	expect("formatUsd(1.5)", m.formatUsd(1.5), "$1.50");
	expect("formatUsd(NaN)", m.formatUsd(Number.NaN), "—");
}

// ⑤ 排序：便宜在前，未知价垫底
{
	const cfg = { ...m.PRICING_DEFAULTS, models: [pricey, unknown, flash] };
	const text = m.formatCatalog(cfg);
	const iFlash = text.indexOf("DS Flash");
	const iPricey = text.indexOf("Kimi");
	const iUnknown = text.indexOf("Mystery");
	assert.ok(iFlash >= 0 && iPricey >= 0 && iUnknown >= 0, "三个模型都该出现在表里");
	assert.ok(iFlash < iPricey, "便宜的（DS Flash）应排在贵的（Kimi）之前");
	assert.ok(iUnknown > iPricey, "价格未知的必须垫底 —— 不能因为「没价」被当成最便宜");
	ok("排序：估算价升序，未知价垫底");
}

// ⑥ enabled:false 不挂；有模型时挂 1 段 + 1 工具
{
	const makeCtx = () => {
		const sections = [];
		const tools = [];
		return {
			sections,
			tools,
			ctx: {
				systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
				tools: { register: (t) => { tools.push(t); return () => {}; } },
			},
		};
	};
	const off = makeCtx();
	m.installPricing(off.ctx, { enabled: false, models: [flash] });
	expect("enabled:false → 不挂段也不挂工具", [off.sections.length, off.tools.length], [0, 0]);

	const on = makeCtx();
	m.installPricing(on.ctx, { models: [flash] });
	expect("有模型 → 挂 1 段 + 1 工具", [on.sections.length, on.tools.length], [1, 1]);
	expect("工具名是 model_price", on.tools[0].name, "model_price");
	expect("段的 order 是 640", on.sections[0].order, 640);

	const empty = makeCtx();
	m.installPricing(empty.ctx, { models: [] });
	expect("空表 → 不挂提示段（没什么可提醒的）", empty.sections.length, 0);
}

// ⑦ 空表不抛，给一句能照做的提示
{
	const text = m.formatCatalog({ ...m.PRICING_DEFAULTS, models: [] });
	assert.ok(text.includes("价目表是空的"), "空表要明说，而不是给一张空表格");
	assert.ok(text.includes("pricing.json"), "要指出去哪填");
	ok("空表：不抛，并指出去哪加条目");
}

// ⑧ 出厂价目表本身要能过校验（文件与 schema 不许漂移）
{
	const file = path.join(ROOT, "team/extensions/pricing.json");
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	for (const [key, check] of Object.entries(m.PRICING_FIELDS)) {
		if (!Object.hasOwn(raw, key)) continue;
		assert.notEqual(check(raw[key]), undefined, `出厂 pricing.json 的 ${key} 过不了校验器`);
	}
	const ids = raw.models.map((e) => e.id);
	assert.equal(new Set(ids).size, ids.length, "出厂价目表里有重复模型 id");
	assert.ok(raw.models.some((e) => m.hasPrice(e)), "出厂价目表至少要有一条真价格，否则这功能等于没开");
	ok(`出厂 pricing.json 过校验：${raw.models.length} 个模型，${raw.models.filter((e) => m.hasPrice(e)).length} 个有价`);
}

console.log(`\nselftest-pricing：${passed} 项全过`);
