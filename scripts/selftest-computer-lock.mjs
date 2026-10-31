#!/usr/bin/env node
/**
 * 自检：紧急解锁闩（REQ-024 步骤 3 补）。
 *
 * 为什么单独一条：`scripts/selftest-computer.mjs` 的汇总行写着「…空闲解锁-紧急闩-fail-open…」，
 * 但那个文件里**没有紧急解锁的测试**（第二实例只覆盖了空闲解锁、fail-open、dispose）。
 * 2026-10-31 实测证据：把 `core/lock.js` 里的 `parseStatus(st).emergency === 1`
 * 改成 `=== 2`（紧急解锁永不生效），原自检**仍然全绿**。
 *
 * 为什么这值得单独一条而不是顺手加进原自检：REQ-024 §6 划的分界线是「步骤 1–4 纯重构，
 * 原自检一字不改必须全绿」；补测试会改那 568 行，把「纯重构」的验收判据搅浑。
 *
 * 覆盖的链路（全部真跑，不 mock）：
 *   真 daemon → 真键盘钩子（合成 Ctrl+Alt+L，钩子不区分人与 AI）→ Emergency 置位
 *   → status 应答 → parseStatus 解析 → lock.ensureArmed 必须拒绝并进入终态。
 *
 * 反向验证（改坏必须红）：
 *   - `core/lock.js` 的 `=== 1` 改成 `=== 2` → 本自检红
 *   - `core/protocol.js` 的 parseStatus 步长 `i += 2` 改成 `i += 3` → 本自检红
 *
 *   node scripts/selftest-computer-lock.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { COMPUTER_DEFAULTS } from "../lib/computer/core/config.js";
import { createDaemonClient } from "../lib/computer/core/daemon-client.js";
import { createLock } from "../lib/computer/core/lock.js";
import { buildCommand, parseStatus } from "../lib/computer/core/protocol.js";

const ROOT = new URL("../", import.meta.url);
const DAEMON_PS = fs.readFileSync(new URL("lib/computer/drivers/win32/daemon.ps1", ROOT), "utf8");

const VK_CONTROL = 17;
const VK_ALT = 18;
const VK_L = 76;

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures += 1;
		console.error(`  ✗ ${name}\n      ${err?.message ?? err}`);
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures += 1;
		console.error(`  ✗ ${name}\n      ${err?.message ?? err}`);
	}
}

if (process.platform !== "win32") {
	console.log("· 跳过：紧急解锁闩依赖 Windows 键盘钩子");
	process.exit(0);
}

// ── parseStatus 本体（纯函数，先钉死，否则下面的集成测试输了也说不清是谁的锅）──

check("parseStatus：标准应答解析成对象", () => {
	const st = parseStatus("armed 1 emergency 0 blocked 3 injected 2 passed 5");
	assert.deepEqual(st, { armed: 1, emergency: 0, blocked: 3, injected: 2, passed: 5 });
});

check("parseStatus：缺字段不补 0（「没报」不等于「是 0」）", () => {
	const st = parseStatus("emergency 1");
	assert.equal(st.emergency, 1);
	assert.equal(st.armed, undefined);
});

check("parseStatus：空应答解析成空对象，不抛", () => {
	assert.deepEqual(parseStatus(""), {});
	assert.deepEqual(parseStatus(undefined), {});
});

check("parseStatus：emergency 10 不会被误读成 1（includes 时代的坑）", () => {
	const st = parseStatus("armed 0 emergency 10 blocked 0 injected 0 passed 0");
	assert.equal(st.emergency, 10);
	assert.notEqual(st.emergency, 1);
	// 旧写法 st.includes("emergency 1") 在 "emergency 10" 上会误判为 true
	assert.equal("armed 0 emergency 10".includes("emergency 1"), true, "这正是旧写法会误判的证明");
});

// ── 集成：真钩子触发紧急解锁 → lock 必须拒绝 ───────────────────────────────

const dir = path.join(os.tmpdir(), `dsh-computer-lock-selftest-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(dir, "in"), { recursive: true });
fs.mkdirSync(path.join(dir, "out"), { recursive: true });

const config = { ...COMPUTER_DEFAULTS, startTimeoutMs: 60000 };
const daemon = createDaemonClient(dir, config);
fs.writeFileSync(daemon.scriptPath, `\uFEFF${DAEMON_PS}`, "utf8");

const warnings = [];
const lock = createLock({ daemon, config, log: { warn: (m) => warnings.push(m) } });

try {
	await checkAsync("守护进程起来并成功上锁", async () => {
		await daemon.start();
		assert.equal(daemon.isAlive(), true, "守护进程应存活");
		await lock.ensureArmed();
		const st = parseStatus(await daemon.send(buildCommand("status"), config.runTimeoutMs));
		assert.equal(st.armed, 1, `上锁后应报 armed 1，实际：${JSON.stringify(st)}`);
		assert.equal(st.emergency, 0, "此时不该是紧急状态");
	});

	await checkAsync("合成 Ctrl+Alt+L → 钩子置位 emergency", async () => {
		// 钩子不区分人与 AI（键盘永不拦、只监听组合键），所以合成键能触发真实路径。
		await daemon.send(buildCommand("keys", { vks: [VK_CONTROL, VK_ALT, VK_L] }), config.runTimeoutMs);
		await new Promise((r) => setTimeout(r, 300));
		const st = parseStatus(await daemon.send(buildCommand("status"), config.runTimeoutMs));
		assert.equal(st.emergency, 1, `按 Ctrl+Alt+L 后应报 emergency 1，实际：${JSON.stringify(st)}`);
		assert.equal(st.armed, 0, "紧急解锁应同时解除上锁");
	});

	await checkAsync("**闩生效**：ensureArmed 必须抛错且进入终态", async () => {
		let thrown = null;
		try {
			await lock.ensureArmed();
		} catch (err) {
			thrown = err;
		}
		assert.ok(thrown !== null, "紧急解锁后 ensureArmed 必须抛错（不允许静默继续操控）");
		assert.match(String(thrown.message), /紧急解除/, `错误文案应说明已紧急解除，实际：${thrown.message}`);
		assert.equal(lock.isEmergency(), true, "isEmergency() 应进入终态");
		assert.ok(
			warnings.some((m) => String(m).includes("紧急解除")),
			"必须 warn 一次（用户得知道操控被停用了）",
		);
	});

	await checkAsync("闩是粘性的：再查一次仍然拒绝，不会自己恢复", async () => {
		let thrown = null;
		try {
			await lock.ensureArmed();
		} catch (err) {
			thrown = err;
		}
		assert.ok(thrown !== null, "第二次调用也必须拒绝");
		const st = parseStatus(await daemon.send(buildCommand("status"), config.runTimeoutMs));
		assert.equal(st.emergency, 1, "daemon 侧也不该自己清掉 emergency");
	});

	await checkAsync("daemon 侧自保护：紧急状态拒绝再次 arm", async () => {
		const reply = await daemon.send(buildCommand("arm"), config.runTimeoutMs);
		assert.match(String(reply), /err|紧急/, `紧急状态下 arm 应被拒，实际：${reply}`);
	});
} finally {
	try {
		lock.dispose();
		daemon.dispose();
	} catch {
		/* ignore */
	}
	await new Promise((r) => setTimeout(r, 1500));
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

if (failures > 0) {
	console.error(`\n✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("\n✓ 自检通过：parseStatus 解析 + 真钩子触发的紧急解锁闩（粘性、拒绝操控、daemon 侧自保护）");
}
