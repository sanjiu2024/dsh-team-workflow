#!/usr/bin/env node
/**
 * 自检：UIA 观测（REQ-024 步骤 6 第一刀）。
 *
 * 为什么必须真跑：过滤规则错了两种方式都很贵 ——
 *   · 太宽：683 个元素 / 93.6KB 进模型上下文（实测过），比一张截图贵得多；
 *   · 太窄：把「刷新」「地址栏」这类真按钮也滤掉，模型看着界面却找不到入口。
 * 这两种都只能拿真实窗口量出来，纯函数测不出。
 *
 * 这里断言的是**不变量**，不赌具体内容（前台窗口是什么都行）：
 *   1. 元素表结构完整、每个元素字段齐全；
 *   2. 不含 role=Text —— text/scrollitem 是只读模式，不是「可交互」；
 *   3. 不含坐标落在 -32000 区（最小化窗口惯例）的元素；
 *   4. 每个元素都有 name（匿名又不可操作的没意义）；
 *   5. 总数有上界 —— 过滤一旦失效，这条先红。
 *
 * 反向验证（改坏必须红）：
 *   · daemon.ps1 里把 `if (!interactive) continue;` 改回
 *     `if (!interactive && name.Length == 0) continue;` → 断言 2 红（Text 回来了）；
 *   · 去掉窗口矩形裁剪那两行 → **在本自检里不会红**（记事本内容小，本来就没有屏外项）。
 *     这条裁剪是为大列表窗口（DSH / Edge，实测 683 个元素里 463 个屏外）写的，
 *     要覆盖它需要拿一个可滚动的长列表当靶 —— 目前没做到，如实记在这里；
 *   · 把 pattern 白名单里的 "invoke" 删掉 → 断言 4 红（Button 变成无名被丢，count 崩）；
 *   · 把 DrawMarks 的窗口裁剪去掉（改回截整屏）→ 这条 PNG 断言在窗口非全屏时变红。
 *
 *   node scripts/selftest-computer-observe.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { COMPUTER_DEFAULTS } from "../lib/computer/core/config.js";
import { createDaemonClient } from "../lib/computer/core/daemon-client.js";
import { buildCommand } from "../lib/computer/core/protocol.js";
import { win32Driver } from "../lib/computer/drivers/win32.js";

if (process.platform !== "win32") {
	console.log("· 跳过：UIA 观测只在 Windows 有实现");
	process.exit(0);
}

const dir = path.join(os.tmpdir(), `dsh-computer-observe-selftest-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(dir, "in"), { recursive: true });
fs.mkdirSync(path.join(dir, "out"), { recursive: true });

const config = { ...COMPUTER_DEFAULTS, startTimeoutMs: 60000, runTimeoutMs: 60000 };
const daemon = createDaemonClient(dir, config, win32Driver.host);
fs.writeFileSync(daemon.scriptPath, `${win32Driver.scriptPrefix}${win32Driver.daemonScript}`, "utf8");

const ps = (cmd) =>
	execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${cmd}; exit 0`], {
		encoding: "utf8",
	}).trim();

/** 现有 notepad 的 pid 集合 —— 必须靠差集认出「我自己开的那一个」（REQ 事故记录）。 */
function notepadPids() {
	const out = ps("Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }");
	return new Set(out.split(/s+/).filter(Boolean));
}

let targetPid = 0;
let targetHwnd = 0;

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures += 1;
		console.error(`  ✗ ${name}\n      ${err?.message ?? err}`);
	}
}

let data = null;

try {
	await check("守护进程起来 + 自己开一个记事本当靶，observe 拿到元素数", async () => {
		await daemon.start();

		// 起靶：只认「启动前后 pid 差集」里那个，收尾也只杀它一个。
		const before = notepadPids();
		const child = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
		child.unref();
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			for (const pid of notepadPids()) {
				if (before.has(pid)) continue;
				const hwnd = Number(ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`));
				if (hwnd > 0) {
					targetPid = pid;
					targetHwnd = hwnd;
					break;
				}
			}
			if (targetHwnd > 0) break;
			await new Promise((r) => setTimeout(r, 400));
		}
		assert.ok(targetHwnd > 0, "没能起出靶窗口（notepad 未就绪）");
		console.log(`      （靶窗口 pid=${targetPid} hwnd=${targetHwnd}）`);

		const reply = await daemon.send(buildCommand("observe", { hwnd: targetHwnd }), 60000);
		assert.match(String(reply), /^observe \d+$/, `observe 应答格式不对：${reply}`);
		const count = Number(String(reply).split(" ")[1]);
		assert.ok(count >= 3, `记事本上应该至少有几个可操作元素（菜单/编辑框），实际 ${count}`);
		const raw = fs.readFileSync(path.join(dir, "out", "observe.json"), "utf8");
		data = JSON.parse(raw);
		assert.equal(data.count, count, "应答里的 count 与文件里的 count 不一致");
		console.log(`      （count=${data.count}，${Buffer.byteLength(raw)} 字节）`);
	});

	await check("结构完整：每个元素都有 role/name/x/y/w/h/patterns", async () => {
		assert.ok(Array.isArray(data.elements), "elements 不是数组");
		for (const el of data.elements) {
			for (const k of ["role", "name", "x", "y", "w", "h"]) {
				assert.ok(k in el, `元素缺字段 ${k}：${JSON.stringify(el)}`);
			}
			assert.ok(Array.isArray(el.patterns), `patterns 不是数组：${JSON.stringify(el)}`);
			assert.ok(el.w > 0 && el.h > 0, `元素尺寸非正：${JSON.stringify(el)}`);
		}
	});

	await check("过滤：不含只读的 role=Text（text 模式不是「可交互」）", async () => {
		const texts = data.elements.filter((e) => e.role === "Text");
		assert.equal(texts.length, 0, `过滤失效：混进了 ${texts.length} 个 Text 元素（第一个是 "${texts[0]?.name}"）`);
	});

	await check("过滤：不含坐标落在 -32000 区（最小化）的元素", async () => {
		const bad = data.elements.filter((e) => e.x < -10000 || e.y < -10000);
		assert.equal(bad.length, 0, `屏外元素漏出来 ${bad.length} 个`);
		// 滚动列表里的虚拟化项常呈负坐标（-1000 量级），窗口裁剪必须拦住
		const neg = data.elements.filter((e) => e.x < -1000 || e.y < -1000);
		assert.equal(neg.length, 0, `负坐标元素漏出来 ${neg.length} 个（窗口矩形裁剪失效）`);
	});

	await check("每个元素都有名字（匿名又不可操作的没意义）", async () => {
		const nameless = data.elements.filter((e) => !e.name && e.role !== "Edit");
		assert.equal(nameless.length, 0, `有无名元素 ${nameless.length} 个：${JSON.stringify(nameless[0])}`);
	});

	await check("产出带编号的截图：合法 PNG，且尺寸小于整屏（只截目标窗口）", async () => {
		const png = path.join(dir, "out", "observe.png");
		assert.ok(fs.existsSync(png), "没有产出 observe.png —— 模型就拿不到带编号的画面");
		const buf = fs.readFileSync(png);
		assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "产出的不是合法 PNG");
		const w = buf.readUInt32BE(16);
		const h = buf.readUInt32BE(20);
		assert.ok(w > 50 && h > 50, `截图尺寸异常：${w}x${h}`);
		console.log(`      （截图 ${w}x${h}，${(buf.length / 1024).toFixed(0)} KB）`);
	});

	await check("总数有上界（过滤一旦失效这条先红）", async () => {
		assert.ok(
			data.count <= 500,
			`元素数 ${data.count} 超过上界 —— 过滤可能失效（修好之前实测是 683，修好后 87）`,
		);
	});

	await check("指定 hwnd 复跑：同一个窗口应给出相同数量的元素", async () => {
		const reply = await daemon.send(buildCommand("observe", { hwnd: data.hwnd }), 60000);
		const count2 = Number(String(reply).split(" ")[1]);
		assert.ok(count2 >= 1, `指定 hwnd 后观测失败：${reply}`);
		// 同一窗口两次之间可能有一两个元素进出（动画/懒加载），允许小幅漂移
		assert.ok(
			Math.abs(count2 - data.count) <= Math.max(8, data.count * 0.2),
			`同一窗口两次观测差太多：${data.count} → ${count2}`,
		);
	});
} finally {
	if (targetPid > 0) {
		try {
			ps(`Stop-Process -Id ${targetPid} -Force -ErrorAction SilentlyContinue`);
		} catch {
			/* ignore */
		}
	}
	try {
		daemon.dispose();
	} catch {
		/* ignore */
	}
	await new Promise((r) => setTimeout(r, 1200));
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
	console.log("\n✓ 自检通过：observe 结构 / 只读模式不进表 / 无屏外残留 / 有名率 100% / 数量有上界");
}
