#!/usr/bin/env node
/**
 * 自检：操控电脑（computer use，REQ-002）。
 *
 * 五段：
 *   1. 纯函数（组合键解析 / 钩子事件分类 / 命令编码 / 应答解析）。
 *   2. 默认关 + 工具面（不开启一个都不注册；开启恰好 7 个）。
 *   3. 审批语义：首次问、本会话放行、新会话重新问、拒绝即拒绝（fail-safe）。
 *   4. 路由门禁：模型不支持 image 输入时截屏必须拒绝（反向可红）。
 *   5. **真跑守护进程**：坐标读写、AI 注入放行、fakehuman（不带标记）被拦、
 *      真截 PNG、截屏工具全链路（截图 → saveImage mock → render 出 image block）、
 *      dispose 后进程必死。
 *
 * 为什么必须真跑：这个功能的全部风险都在 PowerShell 钩子与 SendInput 上
 * （拦截条件写反 = 锁死用户鼠标 / 注入不生效 = 工具全废），纯函数一条都测不出。
 * fakehuman 命令就是端到端反向验证：把 C# 里的拦截条件反过来，这段必须红。
 *
 *   node scripts/selftest-computer.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const {
	COMPUTER_DEFAULTS,
	KEY_MAP,
	MAGIC,
	allowsOutcome,
	buildCommand,
	classifyHookEvent,
	installComputer,
	parseKeyCombo,
	parsePos,
	parseReply,
} = await import(new URL("lib/computer.js", ROOT).href);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── 1. 纯函数 ────────────────────────────────────────────────────────────────

check("parseKeyCombo：常用组合键", () => {
	assert.deepEqual(parseKeyCombo("ctrl+s"), [17, 83]);
	assert.deepEqual(parseKeyCombo("shift+tab"), [16, 9]);
	assert.deepEqual(parseKeyCombo("ctrl+shift+s"), [17, 16, 83]);
	assert.deepEqual(parseKeyCombo("enter"), [13]);
	assert.deepEqual(parseKeyCombo("f5"), [116]);
	assert.deepEqual(parseKeyCombo("a"), [65]);
	assert.deepEqual(parseKeyCombo("0"), [48]);
	assert.deepEqual(parseKeyCombo(" CTRL + S "), [17, 83], "大小写与空白要容忍");
});

check("parseKeyCombo：非法输入返回 null", () => {
	for (const bad of ["", "bogus+x", "ctrl+", "ctrl", "+", "s+ctrl", null, 42]) {
		assert.equal(parseKeyCombo(bad), null, `${JSON.stringify(bad)} 应为 null`);
	}
});

check("KEY_MAP：主键是修饰键且单独出现 = 非法，由 parseKeyCombo 拦（映射表本身完整）", () => {
	assert.equal(KEY_MAP.ctrl, 17);
	assert.equal(KEY_MAP.win, 91);
	assert.equal(KEY_MAP["1"], 49);
	assert.equal(KEY_MAP.z, 90);
});

check("classifyHookEvent：拦人放 AI", () => {
	assert.equal(classifyHookEvent({ dwExtraInfo: MAGIC, armed: true }), "allow", "AI 注入（带标记）放行");
	assert.equal(classifyHookEvent({ dwExtraInfo: 0, armed: true }), "block", "无标记真实事件拦截");
	assert.equal(classifyHookEvent({ dwExtraInfo: 99999, armed: true }), "block", "别的标记照样拦");
	assert.equal(classifyHookEvent({ dwExtraInfo: 0, armed: false }), "allow", "未上锁全放行");
	assert.equal(classifyHookEvent({ armed: true }), "block", "缺字段按无标记处理");
	assert.equal(classifyHookEvent({ dwExtraInfo: BigInt(MAGIC), armed: true }), "allow", "bigint 同值放行");
});

check("buildCommand：协议编码", () => {
	assert.equal(buildCommand("arm"), "arm");
	assert.equal(buildCommand("move", { x: 10, y: -20 }), "move 10 -20");
	assert.equal(buildCommand("click", { button: "left", count: 2, x: 5, y: 6 }), "click left 2 5 6");
	assert.equal(buildCommand("click", { button: "right" }), "click right 1");
	assert.equal(buildCommand("scroll", { lines: -3 }), "scroll -3");
	assert.equal(buildCommand("keys", { vks: [17, 83] }), "keys 17 83");
	assert.equal(buildCommand("type", { text: "你好" }), `type ${Buffer.from("你好", "utf8").toString("base64")}`);
	assert.match(buildCommand("shot", { file: "C:\\x.png" }), /^shot C:\\x\.png$/);
	assert.throws(() => buildCommand("nope"), /未知命令/);
});

check("parseReply / parsePos：应答解析", () => {
	assert.equal(parseReply("ok pos 1 2"), "pos 1 2");
	assert.equal(parseReply("ok "), "");
	assert.throws(() => parseReply("err 拒了"), /拒了/);
	assert.throws(() => parseReply("boom"), /boom/);
	assert.throws(() => parseReply(""), /空应答/);
	assert.deepEqual(parsePos("pos 10 20"), { x: 10, y: 20 });
	assert.deepEqual(parsePos("pos -3 0"), { x: -3, y: 0 });
	assert.equal(parsePos("pos oops"), null);
});

check("allowsOutcome：只有 allowed-once 放行", () => {
	assert.equal(allowsOutcome("allowed-once"), true);
	for (const no of ["rejected", "cancelled", "unavailable", undefined, null, "allow"]) {
		assert.equal(allowsOutcome(no), false, `${no} 必须拒绝`);
	}
});

// ── 2. 默认关 + 工具面 ───────────────────────────────────────────────────────

const makeCtx = () => {
	const tools = new Map();
	let approval = null;
	let llm = null;
	let attachments = null;
	const ctx = {
		tools: {
			register(def) {
				tools.set(def.name, def);
				return () => tools.delete(def.name);
			},
		},
		get(name) {
			if (name === "approval") return approval;
			if (name === "llm") return llm;
			if (name === "attachments") return attachments;
			return undefined;
		},
		logger: { info() {}, warn() {}, error() {} },
		_tools: tools,
		_setApproval: (v) => { approval = v; },
		_setLlm: (v) => { llm = v; },
		_setAttachments: (v) => { attachments = v; },
	};
	return ctx;
};

const EXPECTED_TOOLS = ["screenshot", "cursor_position", "mouse_move", "mouse_click", "scroll", "type_text", "key_press"];

check("默认关：enabled 不为 true 时一个工具都不注册", () => {
	const ctx = makeCtx();
	const off = installComputer(ctx, { config: { ...COMPUTER_DEFAULTS } });
	assert.equal(off.enabled, false);
	assert.equal(ctx._tools.size, 0, "默认关必须零工具（反向验证锚点）");
	assert.match(off.describe(), /关/);
	off.dispose();
});

check("开启后恰好注册 7 个工具（REQ 动作集）", () => {
	const ctx = makeCtx();
	const on = installComputer(ctx, { config: { ...COMPUTER_DEFAULTS, enabled: true, idleUnlockMs: 500 } });
	assert.deepEqual([...ctx._tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
	assert.match(on.describe(), /开/);
	on.dispose();
});

// ── 3+4+5：真守护进程（Windows） ─────────────────────────────────────────────

const isWin = process.platform === "win32";
if (!isWin) {
	console.log("· 非 Windows：跳过守护进程真跑段（纯函数与默认关已测）");
}

if (isWin) {
	const ctx = makeCtx();
	const config = { ...COMPUTER_DEFAULTS, enabled: true, idleUnlockMs: 60000, startTimeoutMs: 60000 };
	const handle = installComputer(ctx, { config });
	const daemon = handle.daemon;

	// 审批 mock：outcomes 队列耗尽后持续 allowed-once；记录每次请求。
	const approvals = [];
	const approvalQueue = [];
	ctx._setApproval({
		async request(req) {
			approvals.push(req);
			return approvalQueue.length > 0 ? approvalQueue.shift() : "allowed-once";
		},
	});
	ctx._setLlm({ async resolveModelInfo() { return { inputModalities: ["image"] }; } });

	const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	let saveImageCalls = 0;
	ctx._setAttachments({
		async saveImage({ data, mediaType }) {
			saveImageCalls++;
			assert.equal(mediaType, "image/png");
			assert.ok(data.length > 100, "PNG 至少百字节");
			for (let i = 0; i < 8; i++) assert.equal(data[i], PNG_MAGIC[i], "必须真 PNG 文件头");
			return { attachmentId: "att-selftest", mediaType, bytes: data.length, width: 1920, height: 1080, name: "screenshot.png" };
		},
	});

	const tools = ctx._tools;
	const mkExec = (session) => {
		session.requestHeader = () => ({ config: { provider: "new-api", model: "tier-std" } });
		return { agent: { session, options: { provider: "new-api", model: "tier-std" } }, signal: undefined };
	};
	const execA = mkExec({});
	const rawSend = (cmd, timeoutMs = config.runTimeoutMs) => daemon.send(cmd, timeoutMs);

	await checkAsync("守护进程真起来（_ready）", async () => {
		await daemon.start();
		assert.equal(daemon.isAlive(), true);
	});

	// —— 审批语义（cursor_position 会真跑 pos，一次拿到坐标后面复用）——
	await checkAsync("审批：首次询问（rejected → 拒绝执行且不碰守护进程之外的东西）", async () => {
		approvals.length = 0;
		approvalQueue.push("rejected");
		const r = await tools.get("cursor_position").execute({}, execA);
		assert.match(String(r.text), /^\[审批被拒\]/, "拒绝结果要给模型人话");
		assert.equal(approvals.length, 1, "必须真问了审批");
	});

	let basePos = null;
	await checkAsync("审批：allowed-once 首次放行；本会话后续不再问", async () => {
		approvals.length = 0;
		const r = await tools.get("cursor_position").execute({}, execA);
		const m = /\((-?\d+),\s*(-?\d+)\)/.exec(r.text);
		assert.ok(m, `坐标结果应是 (x, y)，实际：${r.text}`);
		basePos = { x: Number(m[1]), y: Number(m[2]) };
		const askedAfterFirst = approvals.length;
		assert.equal(askedAfterFirst, 1, "首次调用必须问一次并入缓存");
		const r1 = await tools.get("mouse_move").execute({ x: basePos.x, y: basePos.y }, execA);
		assert.match(r1.text, /已移动/);
		const r2 = await tools.get("mouse_click").execute({ x: basePos.x, y: basePos.y, button: "left" }, execA);
		assert.match(r2.text, /单击/);
		const r3 = await tools.get("cursor_position").execute({}, execA);
		assert.match(r3.text, /\(-?\d+/);
		assert.equal(approvals.length, askedAfterFirst, "同会话后续操作不得再问");
	});

	await checkAsync("审批：新会话重新问", async () => {
		approvals.length = 0;
		const execB = mkExec({});
		approvalQueue.push("rejected");
		const r = await tools.get("mouse_move").execute({ x: basePos.x, y: basePos.y }, execB);
		assert.match(String(r.text), /^\[审批被拒\]/);
		assert.equal(approvals.length, 1, "新会话必须重新问");
		// execB 被拒后未入缓存，再问一次 allowed-once 放行（移到原位 = 不动用户光标）
		const r2 = await tools.get("mouse_move").execute({ x: basePos.x, y: basePos.y }, execB);
		assert.match(r2.text, /已移动/);
	});

	// —— 路由门禁 ——
	await checkAsync("路由门禁：模型不支持 image 输入 → 截屏拒绝（反向锚点）", async () => {
		approvals.length = 0;
		ctx._setLlm({ async resolveModelInfo() { return { inputModalities: ["text"] }; } });
		const r = await tools.get("screenshot").execute({}, execA);
		assert.match(r.text, /不支持图像输入/, "必须明确告知模型不支持看图");
		assert.equal(saveImageCalls, 0, "被拒后不得存图");
		ctx._setLlm({ async resolveModelInfo() { return { inputModalities: ["image"] }; } });
	});

	// —— 锁：AI 放行 / fakehuman 拦截 / 解锁恢复 ——
	await checkAsync("锁：armed 时 AI 注入（带标记）放行、fakehuman（无标记）被拦；disarm 后恢复", async () => {
		const startPos = parsePos(await rawSend(buildCommand("pos")));
		assert.ok(startPos, "先拿到起始坐标");

		await rawSend(buildCommand("arm"));
		// AI 注入（MAGIC）：移动 40,40 应生效
		await rawSend(buildCommand("move", { x: startPos.x + 40, y: startPos.y + 40 }));
		const afterAi = parsePos(await rawSend(buildCommand("pos")));
		assert.equal(afterAi.x, startPos.x + 40, "armed 下 AI 移动必须生效");
		assert.equal(afterAi.y, startPos.y + 40);

		// fakehuman（不带标记）：相对移动 0,60 应被拦
		await rawSend(buildCommand("move", { x: afterAi.x, y: afterAi.y })); // 复位光标形状
		const beforeFake = parsePos(await rawSend(buildCommand("pos")));
		await rawSend(`fakehuman 0 60`);
		const afterFake = parsePos(await rawSend(buildCommand("pos")));
		assert.equal(afterFake.y, beforeFake.y, "armed 下真实输入必须被拦（C# 拦截条件）——把条件反过来这里必红");

		// 解锁后同样输入放行
		await rawSend(buildCommand("disarm"));
		await rawSend(`fakehuman 0 60`);
		await new Promise((r) => setTimeout(r, 150)); // 相对移动是异步注入，等落盘
		const afterUnlocked = parsePos(await rawSend(buildCommand("pos")));
		assert.ok(
			afterUnlocked.y > beforeFake.y + 20,
			`disarm 后真实输入应恢复（预期明显下移，实际 ${beforeFake.y} → ${afterUnlocked.y}；mouse_event 相对位移受指针加速影响，只能断方向）`,
		);

		// 复位光标
		await rawSend(buildCommand("move", { x: startPos.x, y: startPos.y }));
		const endPos = parsePos(await rawSend(buildCommand("pos")));
		assert.deepEqual(endPos, startPos, "结束时光标必须复位");
	});

	// —— 截图真跑 + 工具全链路 ——
	await checkAsync("截屏：daemon 真产 PNG（文件头验证在 attachments mock 里）", async () => {
		const shotFile = path.join(daemon.dir, "raw-shot.png");
		await rawSend(buildCommand("shot", { file: shotFile }), config.shotTimeoutMs);
		const bytes = fs.readFileSync(shotFile);
		for (let i = 0; i < 8; i++) assert.equal(bytes[i], PNG_MAGIC[i], "真 PNG 文件头");
		fs.rmSync(shotFile, { force: true });
	});

	await checkAsync("截屏工具全链路：execute → saveImage → render 出 [text, image]", async () => {
		approvals.length = 0;
		saveImageCalls = 0;
		const execS = mkExec({}); // 新会话：截屏审批必须真问一次
		const value = await tools.get("screenshot").execute({}, execS);
		assert.equal(saveImageCalls, 1, "saveImage 必须真被调用");
		assert.equal(value.image.attachmentId, "att-selftest");
		assert.ok(value.caption.includes("整屏截图"));
		const blocks = tools.get("screenshot").output.render({}, value);
		assert.equal(blocks.length, 2, "模型侧必须两块：文字说明 + 图片");
		assert.equal(blocks[0].type, "text");
		assert.equal(blocks[1].type, "image");
		assert.equal(blocks[1].attachment.attachmentId, "att-selftest", "image block 要带 attachment 引用");
		assert.equal(approvals.filter((a) => a.toolName === "screenshot").length, 1, "截屏要过审批");
	});

	// —— 参数与急停话术（不真执行危险动作）——
	await checkAsync("type_text：超长与空参数在审批前拦住", async () => {
		approvals.length = 0;
		const empty = await tools.get("type_text").execute({ text: "" }, execA);
		assert.match(empty.text, /参数错误/);
		const long = await tools.get("type_text").execute({ text: "x".repeat(4001) }, execA);
		assert.match(long.text, /参数错误/);
		assert.equal(approvals.length, 0, "参数非法不得打扰审批");
	});

	await checkAsync("key_press：非法键名参数错误；合法键用审批拒绝挡住真实注入", async () => {
		approvals.length = 0;
		const bad = await tools.get("key_press").execute({ key: "bogus+q" }, execA);
		assert.match(bad.text, /参数错误/);
		assert.equal(approvals.length, 0, "参数非法不得打扰审批");
		// 合法键：换新会话 + 审批拒绝 → 走到审批但不真按键（不能在自检里真弹任务管理器/输入框）
		const execC = mkExec({});
		approvalQueue.push("rejected");
		const good = await tools.get("key_press").execute({ key: "ctrl+shift+esc" }, execC);
		assert.match(String(good.text), /^\[审批被拒\]/, "合法键应走到审批而非参数错误");
	});

	// —— dispose：进程必死、目录清理 ——
	await checkAsync("dispose：守护进程被杀、spool 目录清掉", async () => {
		assert.equal(daemon.isAlive(), true, "dispose 前活着");
		handle.dispose();
		const dir = daemon.dir;
		const deadline = Date.now() + 8000;
		let gone = false;
		while (Date.now() < deadline) {
			if (!daemon.isAlive() && !fs.existsSync(dir)) { gone = true; break; }
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.equal(daemon.isAlive(), false, "dispose 后守护进程必须死（不留孤儿进程锁着鼠标）");
		assert.equal(fs.existsSync(dir), false, "spool 目录要清掉");
		assert.equal(gone, true, "8 秒内进程与目录都应消失");
	});

	// —— 锁生命周期第二实例：空闲解锁 / 钩子死 fail-open / 紧急解锁闩 ──
	const ctx2 = makeCtx();
	const config2 = { ...COMPUTER_DEFAULTS, enabled: true, idleUnlockMs: 900, startTimeoutMs: 60000 };
	const handle2 = installComputer(ctx2, { config: config2 });
	const daemon2 = handle2.daemon;
	ctx2._setApproval({ async request() { return "allowed-once"; } });
	ctx2._setLlm({ async resolveModelInfo() { return { inputModalities: ["image"] }; } });
	const exec2 = mkExec({});
	const raw2 = (cmd, timeoutMs = config2.runTimeoutMs) => daemon2.send(cmd, timeoutMs);
	const CENTER = { x: 640, y: 480 };
	const readPos2 = async () => parsePos(await raw2(buildCommand("pos")));
	const readStatus2 = async () => await raw2(buildCommand("status"));
	const readArmed2 = async () => (await readStatus2()).includes("armed 1");

	await checkAsync("生命周期第二实例：守护进程真起来", async () => {
		await daemon2.start();
		assert.equal(daemon2.isAlive(), true);
		await raw2(buildCommand("move", { x: CENTER.x, y: CENTER.y }));
	});

	await checkAsync("空闲自动解锁：armed → 人被拦 → 超过 idleUnlockMs → 人恢复", async () => {
		const r = await ctx2._tools.get("mouse_move").execute({ x: CENTER.x, y: CENTER.y }, exec2);
		assert.match(r.text, /已移动/);
		assert.equal(await readArmed2(), true, "arm 后守护进程应报 armed 1");
		await raw2("fakehuman 0 60");
		await new Promise((r) => setTimeout(r, 150));
		const blockedPos = await readPos2();
		assert.equal(blockedPos.y, CENTER.y, "armed 下人被拦");
		// 等空闲计时器（900ms）发 disarm —— 轮询到超时上限，状态先行断言，拿不到就带诊断红
		let disarmed = false;
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline) {
			if (!(await readArmed2())) { disarmed = true; break; }
			await new Promise((r) => setTimeout(r, 150));
		}
		assert.equal(disarmed, true, `空闲后守护进程必须收到 disarm，实际状态：${await readStatus2()}`);
		await raw2("fakehuman 0 60");
		await new Promise((r) => setTimeout(r, 150));
		const afterIdle = await readPos2();
		assert.ok(afterIdle.y > CENTER.y + 20, `空闲后人应恢复（${CENTER.y} → ${afterIdle.y}）`);
		await raw2(buildCommand("move", { x: CENTER.x, y: CENTER.y }));
	});

	await checkAsync("紧急解锁闩：注入 ctrl+alt+L → 操控类工具全部停用（EMERGENCY_REFUSAL）", async () => {
		const r = await ctx2._tools.get("key_press").execute({ key: "ctrl+alt+l" }, exec2);
		assert.match(r.text, /已按下/, `key_press 应执行：${r.text}`);
		// 等钩子写事件文件 + fs.watch 处理
		const deadline = Date.now() + 3000;
		let moved = null;
		while (Date.now() < deadline) {
			moved = await ctx2._tools.get("mouse_move").execute({ x: 100, y: 100 }, exec2);
			if (moved.text.includes("已停用")) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.match(moved.text, /已停用/, `紧急解锁后 mouse_move 必须停用：${moved.text}`);
		const click = await ctx2._tools.get("mouse_click").execute({ x: 1, y: 1 }, exec2);
		assert.match(click.text, /已停用/, "click 也要停用");
	});

	await checkAsync("fail-open：钩子进程死 → 人立即能动（外部进程天然解锁）", async () => {
		// 紧急闩后 armed 状态：先绕过工具层直接跟守护进程说 arm（模拟还上着锁）
		// 然后杀进程 —— 进程一死钩子随之消失，fakehuman 必须能动。
		try { await raw2(buildCommand("arm"), 2000); } catch { /* 上面 ensureArmed 已停，守护进程可能还活着 */ }
		daemon2.kill();
		await new Promise((r) => setTimeout(r, 400));
		let startPos = null;
		let restartErr = "";
		try {
			await raw2(buildCommand("move", { x: CENTER.x, y: CENTER.y }), 15000); // 探活 + 归位（应答为空）
			startPos = parsePos(await raw2(buildCommand("pos"), 5000));
		} catch (err) {
			restartErr = err?.message ?? String(err);
		}
		assert.ok(startPos, `重启后应能读到坐标，实际错误：${restartErr}`);
		// kill 后 send 会重启守护进程（新进程默认 disarmed）→ fakehuman 能动
		assert.ok(startPos, "重启后应能读到坐标");
		await raw2("fakehuman 0 60");
		await new Promise((r) => setTimeout(r, 150));
		const after = parsePos(await raw2(buildCommand("pos")));
		assert.ok(after.y > startPos.y + 20, `钩子进程死（重启后未上锁）人必须能动：${startPos.y} → ${after.y}`);
	});

	await checkAsync("第二实例 dispose：进程死 + 目录清", async () => {
		handle2.dispose();
		const dir2 = daemon2.dir;
		const deadline = Date.now() + 8000;
		let ok = false;
		while (Date.now() < deadline) {
			if (!daemon2.isAlive() && !fs.existsSync(dir2)) { ok = true; break; }
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.equal(ok, true, "第二实例 dispose 后进程与目录都应消失");
	});
}

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：纯函数 / 默认关 / 审批语义 / 路由门禁 / 真守护进程（拦截-AI放行-空闲解锁-紧急闩-fail-open-截屏-PNG-dispose）");
}
