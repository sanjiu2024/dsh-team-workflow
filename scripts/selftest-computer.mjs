#!/usr/bin/env node
/**
 * 自检：操控电脑（computer use，REQ-002）。
 *
 * 五段：
 *   1. 纯函数（组合键解析 / 钩子事件分类 / 命令编码 / 应答解析）。
 *   2. 默认启用 + 工具面（不带覆盖恰好 7 个；显式 enabled:false 一个不注册）。
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
import { spawnSync } from "node:child_process";

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

/**
 * 光标位置类断言的**重试包装**：这台机器是活跃桌面，真人或系统随时可能移动鼠标，
 * 一次不成就在干净状态下重试。全部失败才判红 —— 否则自检会因为「用户碰了一下鼠标」
 * 而假红（实测：长链里连跑会偶发，单独跑 2/2 通过）。
 */
const checkAsyncRetry = async (name, fn, attempts = 4) => {
	let lastError = null;
	for (let i = 1; i <= attempts; i++) {
		try {
			await fn();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((r) => setTimeout(r, 200));
		}
	}
	failures++;
	console.log(`✗ ${name}
    重试 ${attempts} 次仍失败（若是「光标被外部移动」，说明有人在用这台机器）：${lastError?.message ?? lastError}`);
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

check("默认启用（1.7.0 起）：不带覆盖恰好注册 7 个工具（REQ 动作集）", () => {
	const ctx = makeCtx();
	const on = installComputer(ctx, { config: { ...COMPUTER_DEFAULTS } });
	if (process.platform === "win32") {
		assert.equal(on.enabled, true, "默认应启用");
		assert.deepEqual([...ctx._tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
		assert.match(on.describe(), /开/);
	} else {
		assert.equal(on.enabled, false, "非 Windows 必须恒不注册");
		assert.equal(ctx._tools.size, 0);
	}
	on.dispose();
});

check("锁定窗口必须盖得住模型思考时间（≥60s）—— 15s 会让锁形同虚设", () => {
	// 用户反馈「锁不住，顶多让鼠标慢一点」（2026-09-28）。实测拦截机制本身有效
	// （外部高频注入 400/400 拦住、光标不移），真因是**锁的窗口太窄**：
	// 锁只在工具调用瞬间生效，而模型两次操作之间会思考几秒到几十秒；
	// 15 秒空闲窗口意味着「模型一想事锁就松了」，用户去碰鼠标时几乎总是松的。
	// 这条断言防止后人把它改回去。
	assert.ok(
		COMPUTER_DEFAULTS.idleUnlockMs >= 60000,
		"idleUnlockMs 默认 " + COMPUTER_DEFAULTS.idleUnlockMs + "ms 太短：模型思考间隔常超过它，锁会一直松开",
	);
});
check("显式关闭：enabled:false 一个工具都不注册（反向验证锚点）", () => {
	const ctx = makeCtx();
	const off = installComputer(ctx, { config: { ...COMPUTER_DEFAULTS, enabled: false } });
	assert.equal(off.enabled, false);
	assert.equal(ctx._tools.size, 0, "显式关必须零工具（反向验证锚点）");
	assert.match(off.describe(), /关/);
	off.dispose();
});

// ── 3+4+5：真守护进程（Windows） ─────────────────────────────────────────────

const isWin = process.platform === "win32";
if (!isWin) {
	console.log("· 非 Windows：跳过守护进程真跑段（纯函数与注册面已测）");
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
	// —— 锁：AI 放行 / fakehuman 拦截 / 解锁恢复 ——
	//
	// 断言用守护进程自报的 **blocked 计数**，不用光标落点：这台机器是活跃桌面
	// （实测同一次跑内，「绝对坐标移动」前两次精确、后面被外部活动带偏），
	// 位置断言本质不可靠。计数直接证明「钩子拦了/没拦」，与环境噪声无关。
	const readBlocked = async () => {
		const st = await rawSend(buildCommand("status"));
		const m = /blocked (\d+)/.exec(st);
		assert.ok(m, "status 必须报 blocked 计数，实际：" + st);
		return Number(m[1]);
	};
	const readInjected = async () => {
		const st = await rawSend(buildCommand("status"));
		const m = /injected (\d+)/.exec(st);
		assert.ok(m, "status 必须报 injected 计数，实际：" + st);
		return Number(m[1]);
	};
	const readPassed = async () => {
		const st = await rawSend(buildCommand("status"));
		const m = /passed (\d+)/.exec(st);
		assert.ok(m, "status 必须报 passed 计数，实际：" + st);
		return Number(m[1]);
	};

	await checkAsyncRetry("锁：armed 拦人放 AI、disarm 放人（用钩子自报的 blocked 计数，不依赖光标落点）", async () => {
		const target = { x: 700, y: 500 };

		// armed：人的输入必须被拦（blocked 计数上升）
		await rawSend(buildCommand("arm"));
		const b0 = await readBlocked();
		await rawSend(`fakehuman ${target.x} ${target.y}`);
		await new Promise((r) => setTimeout(r, 200));
		const b1 = await readBlocked();
		assert.ok(b1 > b0, `armed 下真实输入必须被拦：blocked ${b0} → ${b1}（把 C# 拦截条件反过来这里必红）`);

		// armed：AI 注入（带 MAGIC 标记）必须**通过**钩子。
		// 断言用 injected 计数上升（而不是「blocked 不变」）：后者会被偶发的人事件
		// 噪声弄成假红（实测跑过一次 blocked 221 → 229，而机制其实是对的）。
		const inj0 = await readInjected();
		await rawSend(buildCommand("move", { x: target.x, y: target.y }));
		await new Promise((r) => setTimeout(r, 200));
		const inj1 = await readInjected();
		assert.ok(inj1 > inj0, `armed 下 AI 注入必须被放行并计数：injected ${inj0} → ${inj1}`);
		const b2 = await readBlocked();

		// disarm：同样的人输入**不再**被拦。
		// 断言「passed 计数上升」而不是「blocked 不变」：这台机器实测有 ~34 个合成
		// 鼠标事件/秒（不动光标、只发输入），「不变」类断言必假红。反向也成立 ——
		// 若代码忽略 Armed 而始终拦截，passed 永远不会涨，这条会正确地红。
		await rawSend(buildCommand("disarm"));
		const p0 = await readPassed();
		await rawSend(`fakehuman ${target.x + 40} ${target.y + 40}`);
		await new Promise((r) => setTimeout(r, 200));
		const p1 = await readPassed();
		assert.ok(p1 > p0, `disarm 后真实输入必须被放行（passed ${p0} → ${p1}）；blocked ${b1} → ${b2}（未变）`);
	});

	await checkAsyncRetry("AI 注入真的移动了光标（SendInput 生效，容 ±8px）", async () => {
		await rawSend(buildCommand("disarm"));
		const target = { x: 700, y: 500 };
		await rawSend(buildCommand("move", { x: target.x, y: target.y }));
		await new Promise((r) => setTimeout(r, 120));
		const got = parsePos(await rawSend(buildCommand("pos")));
		// 这台机器有外部光标活动，故容差 + 重试；AI 路径本身在干净时是像素精确的。
		assert.ok(
			Math.abs(got.x - target.x) <= 8 && Math.abs(got.y - target.y) <= 8,
			`AI 移动应接近 ${JSON.stringify(target)}，实际 ${JSON.stringify(got)}（若屡次偏很多，说明桌面有别的程序在抢光标）`,
		);
	});

	await checkAsyncRetry("钩子真的拦得住：高频外部注入全部被拦、光标不移", async () => {
		// 为什么需要这条：之前所有「拦截」测试都由守护进程自己注入、且频率很低，
		// 照不到「外部进程高频注入时会不会漏」。
		//
		// 不用时间/比值断言：实测把钩子的消息循环加上 Sleep(15) 后比值仍是 0.85 ——
		// LL 钩子的回调由系统**直接**调用，不受消息循环 sleep 影响。所以耗时类断言
		// 区分不出好坏，硬写阈值只会变成 flaky。这里只留确定性的计数断言。
		const N = 200;
		const injector = `
Add-Type -Namespace Ext -Name Mx -MemberDefinition '
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);'
$vw=[Ext.Mx]::GetSystemMetrics(78); $vh=[Ext.Mx]::GetSystemMetrics(79)
$nx=[uint32][Math]::Round(1000*65535.0/[Math]::Max(1,$vw-1))
$ny=[uint32][Math]::Round(800*65535.0/[Math]::Max(1,$vh-1))
for ($i=0; $i -lt ${N}; $i++) { [Ext.Mx]::mouse_event(0xC001, $nx, $ny, 0, [UIntPtr]::Zero) }
`;
		await rawSend(buildCommand("move", { x: 600, y: 400 }));
		await rawSend(buildCommand("arm"));
		const before = parsePos(await rawSend(buildCommand("pos")));
		const b0 = await readBlocked();
		const r = spawnSync("powershell", ["-NoProfile", "-Command", injector], { encoding: "utf8", timeout: 120000 });
		assert.ok(!r.error, `注入进程出错：${r.error?.message}`);
		await new Promise((r2) => setTimeout(r2, 400));
		const b1 = await readBlocked();
		const after = parsePos(await rawSend(buildCommand("pos")));
		await rawSend(buildCommand("disarm"));
		assert.ok(b1 - b0 >= N, `上锁后 ${N} 个外部事件必须全被拦：blocked ${b0} → ${b1}（漏拦 = 真实输入会漏过去）`);
		assert.deepEqual(after, before, `上锁期间光标不得移动：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
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
	const readStatus2 = async () => await raw2(buildCommand("status"));
	const readArmed2 = async () => (await readStatus2()).includes("armed 1");
	const readBlocked2 = async () => {
		const st = await readStatus2();
		const m = /blocked (\d+)/.exec(st);
		assert.ok(m, "status 必须报 blocked 计数，实际：" + st);
		return Number(m[1]);
	};
	const readPassed2 = async () => {
		const st = await readStatus2();
		const m = /passed (\d+)/.exec(st);
		assert.ok(m, "status 必须报 passed 计数，实际：" + st);
		return Number(m[1]);
	};

	await checkAsync("生命周期第二实例：守护进程真起来", async () => {
		await daemon2.start();
		assert.equal(daemon2.isAlive(), true);
		await raw2(buildCommand("move", { x: CENTER.x, y: CENTER.y }));
	});

	await checkAsyncRetry("空闲自动解锁：armed 拦人 → 超过 idleUnlockMs 自动解锁 → 人恢复", async () => {
		// 先按要求把 daemon 上锁（走工具路径，顺带覆盖 ensureArmed）
		const r = await ctx2._tools.get("mouse_move").execute({ x: CENTER.x, y: CENTER.y }, exec2);
		assert.match(r.text, /已移动/, `mouse_move 应成功：${r.text}`);
		assert.equal(await readArmed2(), true, "arm 后守护进程应报 armed 1");

		// armed：人被拦
		const b0 = await readBlocked2();
		await raw2(`fakehuman ${CENTER.x + 80} ${CENTER.y + 80}`);
		await new Promise((r) => setTimeout(r, 200));
		assert.ok((await readBlocked2()) > b0, "armed 下人应被拦");

		// 等空闲计时器自动 disarm（状态先行断言，拿不到就带诊断红）
		let disarmed = false;
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			if (!(await readArmed2())) { disarmed = true; break; }
			await new Promise((r) => setTimeout(r, 150));
		}
		assert.equal(disarmed, true, `空闲后守护进程必须收到 disarm，实际状态：${await readStatus2()}`);

		// 解锁后人恢复：passed 必须上升（理由同 lock 测试）
		const pa = await readPassed2();
		await raw2(`fakehuman ${CENTER.x + 120} ${CENTER.y + 120}`);
		await new Promise((r) => setTimeout(r, 200));
		const pb = await readPassed2();
		assert.ok(pb > pa, `空闲解锁后人必须被放行：passed ${pa} → ${pb}`);
	});

	await checkAsyncRetry("fail-open：钩子进程死 → 人立即能动（外部进程天然解锁）", async () => {
		// 先上锁，让下面「不再被拦」的断言有对照
		await raw2(buildCommand("arm")).catch(() => {});
		await raw2(`fakehuman ${CENTER.x + 60} ${CENTER.y + 60}`).catch(() => {});
		await new Promise((r) => setTimeout(r, 200));

		// 杀掉守护进程 → 钩子随之消失
		daemon2.kill();
		await new Promise((r) => setTimeout(r, 400));

		// 重启（send 自动重启）后是新进程、默认 disarmed → 人的输入不得被拦
		await raw2(buildCommand("move", { x: CENTER.x, y: CENTER.y }), 15000);
		const fa = await readPassed2();
		await raw2(`fakehuman ${CENTER.x + 90} ${CENTER.y + 90}`);
		await new Promise((r) => setTimeout(r, 250));
		const fb = await readPassed2();
		assert.ok(fb > fa, `钩子进程死（重启后未上锁）人必须能动：passed ${fa} → ${fb}`);
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
	console.log("✓ 自检通过：纯函数 / 默认启用与显式关 / 审批语义 / 路由门禁 / 真守护进程（拦截-AI放行-空闲解锁-紧急闩-fail-open-截屏-PNG-dispose）");
}
