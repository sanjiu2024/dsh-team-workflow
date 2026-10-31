#!/usr/bin/env node
/**
 * 自检：平台驱动层（REQ-024 步骤 5）。
 *
 * 核心一条：**没实现的平台必须如实说「未实现」，不许假装成功。**
 * 假装成功的形态很隐蔽 —— 工具都注册上了，模型以为能操控电脑，
 * 然后在每一步收到莫名其妙的失败；比一开始就告诉它「这个平台没有」糟糕得多。
 *
 * 第二条：驱动里的脚本原文必须与仓库里的文件一致。它是两个来源（文件 vs 驱动），
 * 只要有人改了一边，这里必须红。
 *
 * 反向验证（改坏必须红）：
 *   - darwin 驱动的 daemonScript 从 null 改成 "" → 必红（空字符串也是「假装有实现」）
 *   - win32 驱动的 daemonScript 改一个字 → 必红（与文件不一致）
 *   - computer.js 里重新出现 `process.platform !== "win32"` → 必红（回退到字面量闸门）
 *
 *   node scripts/selftest-computer-drivers.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { darwinDriver } from "../lib/computer/drivers/darwin.js";
import { isImplementable, selectDriver } from "../lib/computer/drivers/index.js";
import { linuxDriver } from "../lib/computer/drivers/linux.js";
import { win32Driver } from "../lib/computer/drivers/win32.js";

const ROOT = new URL("../", import.meta.url);
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

const FIELDS = ["id", "daemonScript", "scriptPrefix", "host", "emergencyKeyLabel"];

// ── 形状 ────────────────────────────────────────────────────────────────────

check("三个驱动字段形状一致（将来加驱动的模板）", () => {
	for (const d of [win32Driver, darwinDriver, linuxDriver]) {
		for (const f of FIELDS) {
			assert.ok(f in d, `驱动 ${d.id} 缺字段 ${f}`);
		}
	}
});

check("驱动 id 就是平台名", () => {
	assert.equal(win32Driver.id, "win32");
	assert.equal(darwinDriver.id, "darwin");
	assert.equal(linuxDriver.id, "linux");
});

// ── Windows：唯一有实现的平台 ───────────────────────────────────────────────

check("win32 有实现：daemonScript 非空、host 有 spawn/killTree", () => {
	assert.equal(isImplementable(win32Driver), true, "win32 必须可实现");
	assert.equal(typeof win32Driver.host.spawn, "function", "host.spawn 必须是函数");
	assert.equal(typeof win32Driver.host.killTree, "function", "host.killTree 必须是函数");
	assert.equal(win32Driver.host.scriptName, "daemon.ps1");
	assert.equal(win32Driver.host.readyFile, "_ready");
});

check("win32 的 daemonScript 与仓库文件逐字节一致（两个来源不许漂移）", () => {
	const file = fs.readFileSync(new URL("lib/computer/drivers/win32/daemon.ps1", ROOT), "utf8");
	assert.equal(win32Driver.daemonScript, file, "驱动里的脚本原文与 daemon.ps1 文件不一致");
	assert.ok(win32Driver.daemonScript.includes("[DshGuard]"), "脚本内容看起来不是那个守护进程");
});

check("win32 的 BOM 前缀是单个 U+FEFF（PowerShell 5.1 少了它会按 GBK 解码）", () => {
	assert.equal(win32Driver.scriptPrefix, "\uFEFF");
	assert.equal(win32Driver.scriptPrefix.length, 1);
});

check("win32 的紧急解锁按键名就在这里（describe 文案靠它，不在 core 里写死）", () => {
	assert.equal(win32Driver.emergencyKeyLabel, "Ctrl+Alt+L");
});

// ── 未实现平台：必须如实说没有 ──────────────────────────────────────────────

check("darwin / linux：daemonScript 必须是 null（不是空串）", () => {
	assert.equal(darwinDriver.daemonScript, null, "darwin 不该有实现");
	assert.equal(linuxDriver.daemonScript, null, "linux 不该有实现");
});

check("darwin / linux：isImplementable 为 false，且给出原因", () => {
	assert.equal(isImplementable(darwinDriver), false);
	assert.equal(isImplementable(linuxDriver), false);
	assert.match(selectDriver("darwin").unsupportedReason ?? "", /未实现/);
	assert.match(selectDriver("linux").unsupportedReason ?? "", /未实现/);
});

check("isImplementable 不接受空字符串（空串 = 假装有实现）", () => {
	assert.equal(isImplementable({ daemonScript: "" }), false, "空字符串必须判为不可实现");
	assert.equal(isImplementable({ daemonScript: null }), false);
	assert.equal(isImplementable({}), false);
	assert.equal(isImplementable(null), false);
});

check("未知平台：兜底驱动也要说清是哪个平台没实现", () => {
	const odd = selectDriver("freebsd");
	assert.equal(odd.daemonScript, null);
	assert.equal(isImplementable(odd), false);
	assert.match(odd.unsupportedReason ?? "", /freebsd/);
	assert.match(odd.unsupportedReason ?? "", /未实现/);
});

check("selectDriver 按平台名分派，不靠猜测", () => {
	assert.equal(selectDriver("win32"), win32Driver);
	assert.equal(selectDriver("darwin"), darwinDriver);
	assert.equal(selectDriver("linux"), linuxDriver);
});

// ── 反回退：computer.js 里不该再有平台字面量 ────────────────────────────────

check("computer.js 不再硬编码平台判断（判据走驱动）", () => {
	const src = fs.readFileSync(new URL("lib/computer.js", ROOT), "utf8");
	assert.ok(
		!src.includes('process.platform !== "win32"'),
		"computer.js 又出现了 process.platform !== \"win32\" —— 平台闸门必须走 selectDriver/isImplementable",
	);
	assert.ok(!src.includes("DAEMON_PS"), "computer.js 又直接读 daemon 脚本了 —— 应该从驱动取");
	assert.ok(src.includes("isImplementable(driver)"), "computer.js 应该用 isImplementable 判断");
});

// 只禁「会被执行的平台命令」，不禁注释里的交叉引用 ——
// 例如 core/config.js 的注释要说明 MAGIC 与 daemon.ps1 里的常量一致，那是必要信息。
check("core/ 里不许出现平台专有命令（powershell / taskkill）", () => {
	const coreDir = new URL("lib/computer/core/", ROOT);
	const offenders = [];
	for (const f of fs.readdirSync(coreDir)) {
		if (!f.endsWith(".js")) continue;
		const text = fs.readFileSync(new URL(f, coreDir), "utf8");
		for (const bad of ["powershell", "taskkill"]) {
			if (text.includes(bad)) offenders.push(`core/${f}: ${bad}`);
		}
	}
	assert.deepEqual(offenders, [], `core 层出现了平台专有字样（应只存在于 drivers/）：${offenders.join(", ")}`);
});

if (failures > 0) {
	console.error(`\n✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("\n✓ 自检通过：驱动形状 / win32 与脚本文件一致 / 未实现平台如实拒绝 / 未知平台兜底 / 无平台字面量回退");
}
