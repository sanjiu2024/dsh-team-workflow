#!/usr/bin/env node
/**
 * 自检：界面「AI 味」检查器（tools/check-ui.mjs，移植自 unslop-ai-app）。
 *
 * 盯四件事：
 *   1. 该报的要报全 —— 一组已知的坏写法，每条规则都得咬住。规则写松了等于没有。
 *   2. 干净的文件不能误报 —— 误报一次，人就不看这个工具了。
 *   3. check-ui-ignore 要能豁免 —— 确实需要那个写法的地方得留出口。
 *   4. 退出码是契约：0 干净、1 有指摘、2 用法错。CI 靠它。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

const CHECKER = new URL("../tools/check-ui.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 跑一次检查器，返回 { code, out }。它非零退出是正常结果，不是异常。 */
function run(file) {
	try {
		const out = execFileSync(process.execPath, [CHECKER, file], { encoding: "utf8" });
		return { code: 0, out };
	} catch (error) {
		return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

const dir = mkdtempSync(join(tmpdir(), "checkui-"));
const write = (name, body) => {
	const p = join(dir, name);
	writeFileSync(p, body, "utf8");
	return p;
};

try {
	// 1. 坏写法：每条规则单独一行，逐条确认能咬住
	{
		const cases = [
			["side-stripe", `<div class="border-l-4 border-red-500">x</div>`],
			["emoji", `<span>🚀 开始</span>`],
			["gradient-text", `.t { background-clip: text; }`],
			["loud-gradient", `<div class="from-purple-600 to-pink-400">x</div>`],
			["transition-all", `<button class="transition-all">x</button>`],
			["hover-scale", `<div class="hover:scale-105">x</div>`],
			["looping-motion", `<div class="animate-pulse">x</div>`],
			["heavy-weight", `<h1 class="font-black">x</h1>`],
			["tracked-uppercase", `<p class="uppercase tracking-widest">x</p>`],
			["italic", `<p class="italic">x</p>`],
			["off-grid-spacing", `<div style="padding: 7px">x</div>`],
			["small-input-font", `<input style="font-size: 13px">`],
			["hover-menu", `<div class="group-hover:block">x</div>`],
			["key-hint", `<kbd>Ctrl</kbd>`],
			["waiting-copy", `<p>正在思考…</p>`],
			["hype-copy", `<p>极致体验</p>`],
			["exclamation", `<p>已完成！</p>`],
		];
		const body = cases.map(([, line]) => line).join("\n");
		const file = write("bad.html", body);
		const { code, out } = run(file);
		assert.equal(code, 1, "有指摘时退出码必须是 1");
		for (const [id] of cases) {
			assert.ok(out.includes(`[${id}]`), `规则 ${id} 没咬住 —— 要么写松了，要么正则错位`);
		}
		ok(`17 条规则全部咬住（${cases.length} 个坏写法）`);
	}

	// 2. 干净的文件：一条都不该报
	{
		const file = write(
			"good.html",
			[
				`<div class="rounded-md bg-neutral-100 p-4 shadow-sm">`,
				`  <h2 class="text-lg font-semibold">导出记录</h2>`,
				`  <p class="text-sm text-neutral-600">按日期筛选</p>`,
				`</div>`,
			].join("\n"),
		);
		const { code, out } = run(file);
		assert.equal(code, 0, `干净文件被报了：\n${out}`);
		ok("干净文件零指摘、退出码 0");
	}

	// 3. check-ui-ignore：豁免生效
	{
		const file = write("ignore.html", `<p class="italic">check-ui-ignore 这行确实要斜体</p>`);
		const { code } = run(file);
		assert.equal(code, 0, "写了 check-ui-ignore 还报，豁免没生效");
		ok("check-ui-ignore 能豁免整行");
	}

	// 4. 用法错：不给参数退出码 2
	{
		let code = 0;
		try {
			execFileSync(process.execPath, [CHECKER], { encoding: "utf8", stdio: "pipe" });
		} catch (error) {
			code = error.status ?? -1;
		}
		assert.equal(code, 2, "不给参数时应以 2 退出（和「有指摘」区分开）");
		ok("缺参数退出码 2，与「有指摘」区分");
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\nselftest-ui-check：${passed} 项全过`);
