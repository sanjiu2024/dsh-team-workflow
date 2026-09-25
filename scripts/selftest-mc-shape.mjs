#!/usr/bin/env node
/**
 * 自检：mc 写进磁盘的每个事件，形状必须能通过 **dsh 加载期校验**。
 *
 * 为什么单独一个自检：`session.append` 对 `user/message` **不校验 role**
 * （`dsh-session/types/invariant.js` 里 `case 'user/message': break`），
 * 所以错形状会安静写进磁盘，直到下次重启重载才暴炸 —— 整个会话加载失败、
 * 用户的对话全部消失。实测发生过：158 条坏事件、5 个会话打不开。
 *
 * 零依赖：直接复刻 dsh 的 `assertMessageEventShape` 判定（见下 MESSAGE_ROLE_BY_TYPE），
 * 不去 import 安装树（本包是纯 host 插件，自检不该硬依赖 dsh 装在哪）。
 *
 *   node scripts/selftest-mc-shape.mjs
 */
import assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const { stripOrdinal, textOfMessage, alignSurface } = await import(new URL("lib/mc-adapter.js", ROOT).href);

// ── 1. dsh 加载期校验的等价复刻 ──────────────────────────────────────────
// 抄自 @deepseek-ai/dsh-session/lib/index.js:929 MESSAGE_ROLE_BY_TYPE +
// assertMessageEventShape。这里只保留「role 必须匹配事件类型」这一条 ——
// 它是唯一会被 mc 写坏的字段（其余字段 mc 自己构造）。
const ROLE_BY_TYPE = { "system/message": "system", "user/message": "user", "assistant/message": "assistant", "tool/result": "user" };

/** 对一个事件做加载期校验，形状不对就抛（与 dsh 同义）。 */
function assertLoadable(event) {
	const expected = ROLE_BY_TYPE[event?.type];
	if (!expected) return;
	const message = event.type === "user/message" ? event.data : event.data?.message;
	if (!message || typeof message !== "object") throw new Error(`${event.type} lacks an identified message`);
	if (typeof message.id !== "string" || message.id === "") throw new Error(`${event.type} lacks an identified message`);
	if (message.role !== expected) throw new Error(`${event.type} message must have role "${expected}"`);
	const source = message.source;
	if (!source || typeof source.kind !== "string" || source.kind === "") throw new Error(`${event.type} message has invalid source`);
	if (!Array.isArray(message.content)) throw new Error(`${event.type} message has invalid content`);
}

// ── 2. stripOrdinal 必须剥到「拼接串中段」的 §N§ ─────────────────────────
// 这是真事故的根因：textOfMessage 把 reasoning 拼在 text 前面，而 bundle 只
// 给 text 块打 §N§。只锚 ^ 的话 ordinal 落在中段剥不掉 → 同一条消息在两轮
// 之间被判成「变了」→ 已存在的 assistant 消息被当作新增注入块 → 写坏。
{
	// 真实形状：reasoning 块在前，带 §N§ 的 text 块在后
	const reasoning = { type: "reasoning", text: "先想一遍\n第二行" };
	const text = { type: "text", text: "§5§ 今天是 2026-09-25，按文档执行" };
	const joined = textOfMessage({ content: [reasoning, text] });
	assert.ok(joined.includes("§5§"), "前置条件：拼接串里确实有 §N§");
	assert.ok(joined.indexOf("§") > 0, "前置条件：§ 不在开头（否则测不到这个 bug）");
	const stripped = stripOrdinal(joined);
	assert.ok(!stripped.includes("§5§"), `中段的 §N§ 必须被剥掉，实际：${JSON.stringify(stripped)}`);
	assert.ok(stripped.includes("先想一遍"), "不该误伤 reasoning 文本");
	assert.equal(stripped.trim(), "先想一遍\n第二行\n今天是 2026-09-25，按文档执行", "剥离后内容应逐字保留");

	// 开头就是 § 的（纯 text 块消息）仍要剥
	assert.equal(stripOrdinal("§1§ 你好"), "你好");
	// 没有 § 的原样返回
	assert.equal(stripOrdinal("你好"), "你好");
	assert.equal(stripOrdinal(""), "");
	assert.equal(stripOrdinal(undefined), "");
	// 多个块各自带 ordinal
	assert.equal(stripOrdinal("§1§ a\n§2§ b"), "a\nb");
	// 行内的 § 不是 ordinal，不能误删（模型文本里可能真有这个符号）
	assert.equal(stripOrdinal("价格 §5§ 元"), "价格 §5§ 元");
}

// ── 3. 同一条消息带/不带 §N§ 必须判为「没变」（否则会重复 append）─────────
// 这是事故的直接触发路径：判成「变了」→ alignSurface 走 append → 写坏数据。
{
	const mk = (text, withOrdinal) => ({
		role: "assistant",
		content: [
			{ type: "reasoning", text: "想一下" },
			{ type: "text", text: withOrdinal ? `§5§ ${text}` : text },
		],
	});
	const before = [mk("今天做什么", false)];
	const after = [mk("今天做什么", true)];
	const plan = alignSurface(before, after);
	assert.deepEqual(plan, [], `同一条消息只差 §N§ 时不该产生任何落地操作（那会写出重复的 assistant 副本），实际 ${JSON.stringify(plan)}`);
}

// ── 4. 非 user 的消息绝不能被写成 user/message ───────────────────────────
// mc.js 的 toEventData 是唯一写盘点。这里直接测它的契约：把 assistant
// 消息喂进去，产出的 user/message 的 role 必须被强制成 "user"。
// （不能 import mc.js —— 它 import 了 bundle；所以这里复刻那三行判定，
//   真正的守卫在上面的 §3：判成「没变」就不会走到写入。）
{
	// 复刻 mc.js 的 role 强制逻辑
	const toRole = (type, message) => (type === "user/message" ? "user" : (message?.role ?? "user"));
	const assistant = { role: "assistant", content: [{ type: "text", text: "x" }] };
	assert.equal(toRole("user/message", assistant), "user", "assistant 消息写进 user/message 时必须被改成 user，否则重载会暴炸");
	assert.equal(toRole("assistant/message", assistant), "assistant", "其他类型的 role 应保留");
	assert.equal(toRole("user/message", { role: undefined }), "user");

	// 端到端形状检查：构造 mc 会产出的两种事件，都必须可加载
	assertLoadable({
		type: "user/message",
		data: { id: "mc-1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "plugin", plugin: "magic-context" } },
	});
	assertLoadable({
		type: "system/message",
		data: { turn: 0, step: 0, message: { id: "mc-2", role: "system", content: [], source: { kind: "plugin", plugin: "magic-context" } } },
	});
	assertLoadable({
		type: "tool/result",
		data: { turn: 0, step: 0, message: { id: "mc-3", role: "user", content: [{ type: "tool-result", toolCallId: "mc", content: [] }], source: { kind: "plugin", plugin: "magic-context" } } },
	});

	// 反向：这个校验器必须真的能抓出事故里的那种坏事件
	assert.throws(
		() => assertLoadable({ type: "user/message", data: { id: "bad", role: "assistant", content: [], source: { kind: "plugin", plugin: "magic-context" } } }),
		/must have role "user"/,
		"校验器必须能抓出「assistant 写进 user/message」—— 抓不出的话这个自检就是摆设",
	);
}

// ── 4b. message 必须有 id（第二类事故：team:lens 漏了 id）────────────────────
// 同一类事故的另一种写法：role 对了但 id 缺了。加载期同样拒绝
// （`lacks an identified message`），append 时同样安静通过。
{
	assert.throws(
		() => assertLoadable({ type: "user/message", data: { role: "user", content: [], source: { kind: "plugin", plugin: "team:lens" } } }),
		/lacks an identified message/,
		"缺 id 必须被抳住 —— 实测这么写过 12 条（team:lens 的 additionalContexts）",
	);
	assert.throws(() => assertLoadable({ type: "user/message", data: { id: "", role: "user", content: [], source: { kind: "plugin", plugin: "x" } } }), /lacks an identified message/, "空 id 同样不算");
}

// ── 5. 真实事故数据回归 ──────────────────────────────────────────────────
// 从坏掉的会话里取那条真实事件的形状（已脱敏），确认修复后不再产生 -- 即
// 同消息带 ordinal 时 alignSurface 无操作。
{
	const real = {
		id: "56f60ad0-87b9-4641-b41c-3fa6ba1301ac",
		role: "assistant",
		content: [
			{ type: "reasoning", text: "今天是 2026-09-25（北京时间），昨天是 2026-09-24。\n\n按照 docs/AUTOMATIONS.md 的「每日用量日报」一节：" },
			{ type: "text", text: "§5§ 今天是 2026-09-25（+08:00），昨天 = 2026-09-24。按 docs/AUTOMATIONS.md「每日用量日报」一节执行。先检查这天是否已做过判读：" },
			{ type: "tool-call", id: "call_2d5660953d514f2298faaa6d", name: "glob", arguments: "{}" },
		],
		source: { kind: "model", provider: "deepseek", model: "x" },
	};
	const twin = { ...real, content: real.content.map((b) => (b.type === "text" ? { ...b, text: b.text.replace(/^§\d+§ /, "") } : b)) };
	assert.deepEqual(alignSurface([twin], [real]), [], "真实事故形状：带 ordinal 的副本必须与原件判为同一条，不能再产生 append");
}

// ── 6. 多帧 zstd 扫帧：必须结构化解析，不能搜 magic 字节 ─────────────────
// 第一版修复脚本靠 Buffer.indexOf 找 `28 B5 2F FD` 切帧 —— 压缩数据里偶然
// 出现这 4 个字节就会切错，把一行 JSON 劈成 `"9"` `"1"` 这类碎片。
// dsh 自己用结构化扫帧（`dsh-session-persistence-jsonl` 的 `scanZstdFrames`），
// 这里用同样的算法并守住它。
{
	const { scanZstdFrames, readSessionLog, writeSessionLog } = await import(new URL("lib/session-log.js", ROOT).href);
	const zlib = await import("node:zlib");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const payload = ['{"type":"a","seq":0}', '{"type":"b","seq":1}', '{"type":"c","seq":2}'];
	// 逐帧压缩后拼接，模拟 dsh 的追加写
	const frames = payload.map((s) => zlib.zstdCompressSync(Buffer.from(`${s}\n`, "utf8")));
	const joined = Buffer.concat(frames);

	const scanned = scanZstdFrames(joined);
	assert.equal(scanned.frames.length, payload.length, "应扫出与帧数相同的范围");
	assert.equal(scanned.tornStart, undefined, "完整数据不该报截断");
	// 帧边界必须首尾相接且铺满整个 buffer
	assert.equal(scanned.frames[0].start, 0);
	for (let i = 1; i < scanned.frames.length; i++) {
		assert.equal(scanned.frames[i].start, scanned.frames[i - 1].end, "帧必须首尾相接，不能重叠也不能漏字节");
	}
	assert.equal(scanned.frames.at(-1).end, joined.length, "最后一帧必须铺到 buffer 末尾");

	// 圆回：写出去再读回来，事件逐字段一致
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "session-log-"));
	const file = path.join(scratch, "session.v3.jsonl.zstd");
	try {
		const events = payload.map((s) => JSON.parse(s));
		writeSessionLog(file, events);
		assert.deepEqual(readSessionLog(file).events, events, "写出去再读回来必须逐字段一致");
		assert.equal(readSessionLog(file).torn, false);

		// 截断的尾帧要报 torn（dsh 靠这个做修复），且之前的帧仍可读
		const truncated = fs.readFileSync(file).subarray(0, fs.readFileSync(file).length - 3);
		const tf = path.join(scratch, "trunc.v3.jsonl.zstd");
		fs.writeFileSync(tf, truncated);
		const tornRead = readSessionLog(tf);
		assert.equal(tornRead.torn, true, "截断的尾帧必须报 torn");
		assert.ok(tornRead.events.length >= 1, "截断不影响前面完整帧的读取");

		// 非 zstd 的纯文本路径也要能读
		const plain = path.join(scratch, "session.v3.jsonl");
		fs.writeFileSync(plain, `${payload.join("\n")}\n`);
		assert.equal(readSessionLog(plain).events.length, 3);

		// 坏 JSON 必须报出位置，不能静默跳过（静默跳过 = 修复时默默丢事件）
		fs.writeFileSync(plain, '{"type":"a"}\n{ 坏\n');
		assert.throws(() => readSessionLog(plain), /JSON 解析失败/, "坏行必须报错，否则修复会默默丢事件");

		// ◆ 关键回归：压缩数据里含 magic 字节时，搜 magic 会切错帧。
		// 实测：payload 里嵌入 `28 B5 2F FD` 后，压缩流里 magic 命中 2 次而真实
		// 只有 1 帧 —— 搜 magic 的实现会把一行 JSON 劈成两半。
		const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
		const trap = Buffer.concat([Buffer.from('{"type":"x","text":"'), magic, Buffer.from('"}')]);
		const trapFrame = zlib.zstdCompressSync(trap);
		let magicHits = 0;
		for (let i = 0; i < trapFrame.length - 4; i++) if (trapFrame.compare(magic, 0, 4, i, i + 4) === 0) magicHits++;
		if (magicHits > 1) {
			assert.equal(scanZstdFrames(trapFrame).frames.length, 1, `含假 magic 的压缩流里只有 1 帧（magic 命中 ${magicHits} 次）—— 搜 magic 的实现会在这里切错`);
			const trapFile = path.join(scratch, "trap.v3.jsonl.zstd");
			fs.writeFileSync(trapFile, trapFrame);
			assert.deepEqual(readSessionLog(trapFile).events, [JSON.parse(trap.toString("utf8"))], "假 magic 不得把一行 JSON 劈成两半");
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

console.log("✓ 自检通过：mc 写盘形状必须能过 dsh 加载校验 / §N§ 中段剥离 / 事故形状不再重复落地 / 多帧 zstd 结构化扫帧");
