#!/usr/bin/env node
/**
 * 自检：小队（REQ-009 / REQ-011）。
 *
 * 八段：
 *   1. 名册与黑板（纯函数：建队 / 加人 / 改行 / 写黑板 / 收队 / 裁剪）
 *   2. 权限（authorize：只有所有者进得来 —— 成员不是 dsh agent，没有工具可调）
 *   3. 快照（snapshot 只给自己的队；snapshotAll 给全部）
 *   4. 6 个工具**真跑**一遍（假 ctx + 真 execute），返回值逐条过 output.schema
 *   5. 成员的循环与工具（**C 路的核心**）：假模型流把 `runMemberLoop` 整条路径跑通
 *      （每个 tool call 恰好一条结果、参数坏 JSON 也要回结果、单步上限、maxSteps、
 *      中止、模型报错），以及成员工具的路径越界与 bash 沙箱拦截
 *   6. 装配（enabled=false 一个工具不注册；webServer 缺失时面板不挂但不连累工具；
 *      session/disposed 真清状态并掐掉还在跑的成员）
 *   7. HTTP 路由 + **信任栅栏的负例**（跨站 / 非回环 / 写方法一律拒）
 *   8. 客户端面板：真加载 classic script，**真渲染**出成员与黑板
 *
 * 为什么第 5、7 段不能省：这两处各有一条「看不见的失败」——
 * 循环少回一条 tool 结果，provider 会直接拒下一次请求（而本地看着一切正常）；
 * 栅栏写错了，本机任何进程都能读走全部小队内容（面板照样工作、自检照样绿）。
 * 纯函数一条都测不出这两种。
 *
 *   node scripts/selftest-squad.mjs
 */
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const {
	MEMBER_STATUS,
	MAX_BOARD_TEXT,
	TRANSCRIPT_TEXT_MAX,
	MAX_NAME,
	SQUAD_DEFAULTS,
	SQUAD_FIELDS,
	SQUAD_ROUTE_PREFIX,
	addMember,
	appendBoard,
	authorize,
	closeSquad,
	createState,
	findSquad,
	installSquad,
	memberSystemPrompt,
	memberTaskText,
	newSquad,
	snapshot,
	snapshotAll,
	updateMember,
	usageLine,
} = await import(new URL("lib/squad.js", ROOT).href);

// REQ-011：成员不是子 agent —— 循环在 lib/squad-loop.js、工具在 lib/squad-tools.js，
// 两个都是纯函数/注入依赖，所以能直接单测（不用起 dsh）。
const { LOOP_DEFAULTS, parseToolArguments, runMemberLoop, trimMessages } = await import(new URL("lib/squad-loop.js", ROOT).href);
const { MEMBER_TOOLS, MEMBER_TOOL_SCHEMAS, TOOL_LIMITS, globToRegExp, memberToolsFor, resolveInside, runMemberTool } = await import(new URL("lib/squad-tools.js", ROOT).href);

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

/** 建一个队并把成员塞进去，返回 { state, squad, ... } */
function fixture(owner = "owner-1") {
	const state = createState();
	const created = newSquad(state, owner, { name: "登录改造", objective: "把登录改成 OAuth，跑通 e2e" });
	assert.equal(created.ok, true, `建队失败：${created.detail}`);
	return { state, owner, squad: created.squad };
}

// ── 1. 名册与黑板 ───────────────────────────────────────────────────────────

check("建队：目标必填、名字要干净、重名拒绝、同名的不同所有者互不影响", () => {
	const state = createState();
	assert.equal(newSquad(state, "o1", { name: "A", objective: "做 A" }).ok, true);
	assert.equal(newSquad(state, "o1", { name: "A", objective: "又做 A" }).ok, false, "同一个所有者不能同名");
	assert.equal(newSquad(state, "o2", { name: "A", objective: "别人的 A" }).ok, true, "名字只在所有者内唯一");
	assert.equal(newSquad(state, "o1", { name: "", objective: "x" }).ok, false);
	assert.equal(newSquad(state, "o1", { name: "B", objective: "" }).ok, false, "目标不能空");
	assert.equal(newSquad(state, "o1", { name: "B", objective: "  " }).ok, false, "目标不能只有空白");
	assert.equal(newSquad(state, "o1", { name: "C".repeat(MAX_NAME + 1), objective: "x" }).ok, false, "名字超长要拒");
	assert.equal(newSquad(state, "o1", { name: "B", objective: "x" }).ok, true, `刚好 ${MAX_NAME} 内要收`);
	assert.equal(newSquad(state, "", { name: "D", objective: "x" }).ok, false, "拿不到所有者会话 id 就不该建");
	assert.equal(newSquad(state, undefined, { name: "D", objective: "x" }).ok, false);
	assert.equal(findSquad(state, "o1", "A").name, "A");
	assert.equal(findSquad(state, "o2", "A").objective, "别人的 A");
	assert.equal(findSquad(state, "o1", "不存在"), undefined);
});

check("加成员：worktree 必填、建行即「在跑」；队内名字唯一；路径不压内部空白", () => {
	const { state, squad } = fixture();
	const r = addMember(state, squad, { label: "调研-A", role: "调研", task: "查上游怎么做", worktree: "/tmp/wt-a" });
	assert.equal(r.ok, true, r.detail);
	assert.equal(r.member.status, "在跑", "C 里没有「待派」这个中间态 —— 建行就是为了马上跑");
	assert.equal(r.member.running, undefined, "纯函数不启动循环（启动在 squad_spawn 里）");
	assert.deepEqual(r.member.transcript, [], "建行时转录是空的");

	// 快照里的运行时字段：`running` 是布尔（AbortController 不能进 JSON），
	// `transcript` 不进快照（可能很长，正文走 /transcript 那条路由）。
	const view = snapshot(state, "owner-1").squads[0].members[0];
	assert.equal(view.running, false);
	assert.equal(view.events, 0);
	assert.equal(view.transcript, undefined, "转录不能进快照");
	assert.equal(view.note, null);
	assert.equal(view.worktree, "/tmp/wt-a");

	assert.equal(addMember(state, squad, { label: "调研-A", role: "调研", task: "重复", worktree: "/tmp/wt-a" }).ok, false, "队内成员名唯一");
	// worktree 必填：它是 `resolveInside` 的根，没有它成员连读都读不了。
	assert.equal(addMember(state, squad, { label: "x", role: "实现", task: "t" }).ok, false, "不给 worktree 要拒");
	assert.equal(addMember(state, squad, { label: "x", role: "实现", task: "t", worktree: "   " }).ok, false);
	assert.equal(addMember(state, squad, { label: "x", role: "实现", task: "", worktree: "/tmp/wt" }).ok, false, "任务不能空");
	assert.equal(addMember(state, squad, { label: "", role: "实现", task: "t", worktree: "/tmp/wt" }).ok, false);
	// 路径只去首尾空白，不压内部空白（`oneLine` 会把连续空格压成一个 —— 那会把路径改坏）
	const spaced = addMember(state, squad, { label: "带空格", role: "实现", task: "t", worktree: "  /tmp/a  b  " });
	assert.equal(spaced.ok, true, spaced.detail);
	assert.equal(spaced.member.worktree, "/tmp/a  b", "路径里的连续空格必须原样留着");
});

check("改成员那一行：状态只认三个词，角色/任务/worktree 可改，成员名不可改", () => {
	const { state, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });
	assert.deepEqual(MEMBER_STATUS, ["在跑", "完成", "卡住"], "状态词表是面板与工具的共同契约（没有「待派」——建行即开跑）");

	assert.equal(updateMember(squad, "实现-A", { status: "完成" }).ok, true);
	assert.equal(squad.members.get("实现-A").status, "完成");
	assert.equal(updateMember(squad, "实现-A", { status: "做完了" }).ok, false, "状态词表外一律拒");
	// 超长状态：`oneLine` 失败时没有 `.value`，报错文案不能变成「收到的是「undefined」」
	const tooLong = updateMember(squad, "实现-A", { status: "很".repeat(MAX_NAME + 1) });
	assert.equal(tooLong.ok, false, "超长状态要拒");
	assert.match(tooLong.detail, /太长/, `要说是太长，不是别的：${tooLong.detail}`);
	assert.doesNotMatch(tooLong.detail, /undefined/, `拒绝理由里不能出现 undefined：${tooLong.detail}`);
	assert.equal(updateMember(squad, "没有这个人", { status: "完成" }).ok, false);
	assert.match(updateMember(squad, "没有这个人", { status: "完成" }).detail, /实现-A/, "拒绝时要把现有成员名报出来，别让调用方靠猜");
	assert.equal(updateMember(squad, "实现-A", { note: "n".repeat(MAX_BOARD_TEXT + 1) }).ok, false, "note 也要有上限");
	assert.equal(updateMember(squad, "实现-A", { note: "已经跑通" }).ok, true);
	assert.equal(squad.members.get("实现-A").note, "已经跑通");

	// 角色 / 任务 / worktree 都能改 —— `squad_spawn` 重跑就是走这条路复用那一行
	assert.equal(updateMember(squad, "实现-A", { role: "审查", task: "审这一版", worktree: "/tmp/wt-b" }).ok, true);
	assert.equal(squad.members.get("实现-A").role, "审查");
	assert.equal(squad.members.get("实现-A").task, "审这一版");
	assert.equal(squad.members.get("实现-A").worktree, "/tmp/wt-b");
	// 空白 = 不改（不是「清空」）
	assert.equal(updateMember(squad, "实现-A", { note: "   " }).ok, true);
	assert.equal(squad.members.get("实现-A").note, "已经跑通", "空白不算改动");
	// 改名改不到：成员名是 Map 的键，也是黑板上的作者名 —— 要换人就重派一个
	assert.equal(updateMember(squad, "审查-A", {}).ok, false, "成员名改不了");
	assert.equal(squad.members.has("实现-A"), true);
	assert.equal(state.get("owner-1").get("登录改造").members.size, 1);
});

check("黑板：作者由调用方给、超限丢最旧的、文本有上限", () => {
	const { squad } = fixture();
	assert.equal(appendBoard(squad, { from: "主 agent", text: "开始" }, 3).ok, true);
	for (const text of ["a", "b", "c"]) appendBoard(squad, { from: "实现-A", text }, 3);
	assert.equal(squad.board.length, 3, "上限 3 就只留 3 条");
	assert.deepEqual(squad.board.map((e) => e.text), ["a", "b", "c"], "第 4 条进来时丢的是最旧的「开始」");
	const r = appendBoard(squad, { from: "实现-A", text: "d" }, 3);
	assert.equal(r.dropped, 1, "丢了几条要报出来");
	assert.deepEqual(squad.board.map((e) => e.text), ["b", "c", "d"]);
	assert.equal(appendBoard(squad, { from: "实现-A", text: "" }, 3).ok, false, "空话不记");
	assert.equal(appendBoard(squad, { from: "实现-A", text: "x".repeat(MAX_BOARD_TEXT + 1) }, 3).ok, false, "超长要拒");
	assert.ok(typeof squad.board[0].at === "number", "每条都要有时间戳");
});

check("收队：关掉之后成员与黑板还在，但**一切写操作都拒**（只读），重复关要拒", () => {
	const { state, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "t", worktree: "/tmp/wt-a" });
	appendBoard(squad, { from: "主 agent", text: "记一句" }, SQUAD_DEFAULTS.boardLimit);
	assert.equal(closeSquad(squad, "目标达成").ok, true);
	assert.equal(squad.closed.reason, "目标达成");
	assert.ok(typeof squad.closed.at === "number");
	assert.equal(squad.members.size, 1, "收队不删名册");
	assert.equal(squad.board.length, 1, "收队不删黑板");
	// 「关」= 只读。不拒的话 `closed` 只是个标签，名册和黑板收队之后照样能改。
	const board = appendBoard(squad, { from: "实现-A", text: "偷偷再写一条" }, SQUAD_DEFAULTS.boardLimit);
	assert.equal(board.ok, false, "收队后不能再写黑板");
	assert.match(board.detail, /收队/, `要说清是收队了：${board.detail}`);
	assert.equal(squad.board.length, 1, "被拒之后黑板不能变长");
	assert.equal(updateMember(squad, "实现-A", { status: "完成" }).ok, false, "收队后不能再改成员");
	assert.equal(squad.members.get("实现-A").status, "在跑", "被拒之后状态不能变");
	assert.equal(addMember(state, squad, { label: "实现-B", role: "实现", task: "t" }).ok, false, "收队后不能再加人");
	assert.equal(squad.members.size, 1);
	assert.equal(closeSquad(squad, "再关一次").ok, false, "已经关了");
	assert.equal(closeSquad(fixture().squad, undefined).ok, true, "理由可以不写");
});

// ── 2. 权限 ────────────────────────────────────────────────────────────────

check("权限：只有所有者进得来（成员不是 dsh agent，根本没有工具可调）", () => {
	const { state, owner, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });

	const asOwner = authorize(state, owner, "登录改造");
	assert.equal(asOwner.ok, true);
	assert.equal(asOwner.squad, squad, "成功必须带上 squad —— 曾经返回过没有 squad 的成功，调用方一解引用就是 TypeError");
	assert.equal(asOwner.asOwner, undefined, "C 里没有「所有者/成员」二分，只剩「是不是所有者」这一条");
	assert.equal(asOwner.member, undefined);

	// 成员那一侧不走工具、也不走 authorize：它写黑板 / 改自己那行发生在自己的 loop 里
	// （由小队执行器直接落库）。所以拿它的名字（或任何别人的会话 id）来调，都该是「没有小队」。
	assert.equal(authorize(state, "sub-1", "登录改造").ok, false, "成员名不是所有者会话 id，进不来");
	assert.equal(authorize(state, "外人", "登录改造").ok, false, "外人不能动别人的队");
	assert.equal(authorize(state, "外人", "登录改造").detail.length > 0, true, "拒绝要给理由");
	assert.equal(authorize(state, owner, "不存在的队").ok, false);
	// 「不点名」只对 `squad_status`（看全部）有意义，而它不走 authorize。
	// 这里曾经给所有者返回 `{ok:true}` 却**没有 squad**，调用方一解引用就是 TypeError。
	assert.equal(authorize(state, owner, "").ok, false, "不点名一律拒（改队必须点名）");
	assert.equal(authorize(state, owner, "   ").ok, false, "纯空白也算没点名");
	assert.equal(authorize(state, "外人", "").ok, false, "外人连「看全部」也不行");
	assert.equal(authorize(state, undefined, "登录改造").ok, false, "没有 caller 一律拒");
	assert.equal(authorize(state, undefined, "").ok, false);
});

// ── 3. 快照 ────────────────────────────────────────────────────────────────

check("快照：snapshot 只给自己的队（点名只看那一个）；snapshotAll 给全部并带上所有者", () => {
	const { state, owner, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });
	appendBoard(squad, { from: "主 agent", text: "开始" }, SQUAD_DEFAULTS.boardLimit);
	const other = newSquad(state, "o2", { name: "另一个", objective: "z" }).squad;
	addMember(state, other, { label: "调研-B", role: "调研", task: "查", worktree: "/tmp/wt-b" });

	const mine = snapshot(state, owner);
	assert.equal(mine.squads.length, 1, "所有者只看得到自己的队");
	assert.equal(mine.squads[0].name, "登录改造");
	assert.equal(mine.squads[0].members[0].worktree, "/tmp/wt-a");
	assert.equal(mine.squads[0].board[0].from, "主 agent");
	assert.equal(mine.me, owner);

	// 点名 = 只看那一个（`squad_status` 与面板都靠这条）
	assert.deepEqual(snapshot(state, owner, "登录改造").squads.map((s) => s.name), ["登录改造"]);
	assert.deepEqual(snapshot(state, owner, "另一个").squads, [], "不是自己的队，点名也看不到");

	// 成员名不是所有者会话 id：快照里查不到任何队（它那一侧的视角在 /transcript 里）
	assert.equal(snapshot(state, "sub-1").squads.length, 0, "成员名不是所有者，看不到队");
	assert.equal(snapshot(state, "外人").squads.length, 0, "外人一条都看不到");
	assert.equal(snapshot(state, undefined).squads.length, 0);

	const all = snapshotAll(state);
	assert.equal(all.count, 2, "面板要的是全量");
	assert.deepEqual(all.squads.map((s) => s.name).sort(), ["另一个", "登录改造"]);
	assert.ok(all.squads.every((s) => typeof s.owner === "string" && s.owner !== ""), "全量快照必须带所有者，否则面板分不清是谁的队");
	assert.equal(structuredClone(all).count, 2, "快照必须能无损过结构化克隆（面板要 JSON 序列化它）");
	// 运行时字段绝不能混进快照：`running` 里是 AbortController，过不了 JSON
	assert.ok(all.squads.every((s) => s.members.every((m) => typeof m.running === "boolean")), "running 必须是布尔");
	assert.ok(all.squads.every((s) => s.members.every((m) => m.transcript === undefined)), "转录不进快照");
});

// ── 4. 6 个工具真跑 ────────────────────────────────────────────────────────

/**
 * 值校验（照 dsh 的 `validateJsonSchemaValue` 抄一个子集，本仓库零依赖）。
 * 理由同 selftest-scheduler.mjs：假 `tools.register` 不校验返回值，
 * 而 dsh 真注册表会在工具边界上拿 `output.schema` 校验并直接抛。
 */
function schemaViolations(schema, value, where = "value") {
	const out = [];
	if (schema?.type === "object") {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return [`${where}: 期望 object，实际 ${Array.isArray(value) ? "array" : typeof value}`];
		}
		for (const key of schema.required ?? []) {
			if (!(key in value)) out.push(`${where}.${key}: 缺必填字段`);
		}
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			if (key in value) out.push(...schemaViolations(sub, value[key], `${where}.${key}`));
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in (schema.properties ?? {}))) out.push(`${where}.${key}: 多出来的字段（additionalProperties: false）`);
			}
		}
		return out;
	}
	if (schema?.type === "string" && typeof value !== "string") out.push(`${where}: 期望 string，实际 ${typeof value}`);
	if (schema?.type === "number" && typeof value !== "number") out.push(`${where}: 期望 number，实际 ${typeof value}`);
	return out;
}

/**
 * `BlockAssembler` 的替身：按 `StreamChunk` 协议累积文本块与 tool-call 块。
 *
 * 真件在 dsh-llm（`lib/types/assembler.d.ts`），而本仓库零依赖 —— 自检不引它。
 * 所以这里复刻本包用到的那几个面：`push` / `blocks` / `usage` / `finish` / `message`。
 * **真件的契约另有盯防**：`scripts/smoke-squad-llm.mjs`（手动跑，不进 npm test）
 * 拿真的 `@deepseek-ai/dsh-llm` 把同一条路径再走一遍 —— 替身和真件一旦分叉，那里会响。
 */
class FakeAssembler {
	constructor() {
		this.parts = [];
		this.used = undefined;
		this.reason = undefined;
		this.seq = 0;
	}
	push(chunk) {
		if (chunk?.type === "block-start") {
			this.parts[chunk.index] = chunk.blockType === "tool-call" ? { type: "tool-call", id: "", name: "", arguments: "" } : { type: "text", text: "" };
			return;
		}
		if (chunk?.type === "text-delta") {
			this.parts[chunk.index].text += chunk.text;
			return;
		}
		if (chunk?.type === "tool-call-delta") {
			const block = this.parts[chunk.index];
			if (chunk.id) block.id = chunk.id;
			if (chunk.name) block.name = chunk.name;
			block.arguments += chunk.argumentsDelta ?? "";
			return;
		}
		if (chunk?.type === "usage") {
			this.used = chunk.usage;
			return;
		}
		if (chunk?.type === "finish") this.reason = chunk.reason;
	}
	blocks() {
		return this.parts.filter(Boolean);
	}
	get usage() {
		return this.used;
	}
	get finish() {
		return this.reason;
	}
	message(source) {
		this.seq += 1;
		return { id: `m${this.seq}`, role: "assistant", content: this.blocks(), source: { kind: "model", ...source } };
	}
}

/** `createToolResultMessage` 的替身（真件同样在 dsh-llm）。 */
const fakeToolResult = ({ callId, content, isError }) => ({
	role: "tool",
	toolCallId: callId,
	content,
	isError: isError === true,
	source: { kind: "tool", callId },
});

/**
 * 按脚本吐 chunk 的假模型流。脚本「一轮一项」，用完了就重复最后一项
 * （测 maxSteps 时要的就是「一直有工具调用」）。
 */
function scriptedStream(script, seen = []) {
	let round = 0;
	return (options) => {
		seen.push(options);
		const step = script[Math.min(round, script.length - 1)] ?? { text: "", calls: [] };
		round += 1;
		const calls = step.calls ?? [];
		return (async function* chunks() {
			let index = 0;
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
			if (step.text) {
				yield { type: "block-start", index, blockType: "text" };
				yield { type: "text-delta", index, text: step.text };
				index += 1;
			}
			for (const call of calls) {
				yield { type: "block-start", index, blockType: "tool-call" };
				yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: call.arguments };
				index += 1;
			}
			yield { type: "finish", reason: { kind: calls.length > 0 ? "tool-calls" : "stop" } };
		})();
	};
}

/**
 * 一个「卡住不吐字」的流：等到 signal 中止才抛错。
 * 用来测「掐掉还在跑的成员」—— 必须确定地停在「在跑」那一态，不能靠抢时序。
 */
function hangingStream(options) {
	return (async function* chunks() {
		await new Promise((_resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	})();
}

/** 让所有待处理的微任务跑完（`startMember` 里第一件事是 `await loadKit()`）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeCtx({
	services = ["tools", "webServer"],
	logger = () => {},
	stream = () => {
		throw new Error("这个测试没给假模型流");
	},
	shell = undefined,
	sandboxPolicy = { mode: "workspace-write", workspaceRoot: "/tmp" },
	noLlm = false,
} = {}) {
	const record = { tools: [], routes: [], events: [], logs: [] };
	const ctx = {
		logger: { info: (msg) => { record.logs.push(msg); logger(msg); } },
		tools: {
			register(tool) {
				record.tools.push(tool);
				return () => {};
			},
		},
		on(name, callback) {
			record.events.push({ name, callback });
			return () => {};
		},
		inject(deps, callback) {
			// 复刻真实现：依赖不齐**不回调**（这是本包踩过的坑，
			// 见 scripts/selftest.mjs 里那个假 ctx 的注释）。
			if (!deps.every((d) => services.includes(d))) return;
			const scope = Object.create(ctx);
			scope.webServer = {
				register(route) {
					record.routes.push(route);
					return () => {};
				},
			};
			callback(scope);
		},
		// `loader.import` 取宿主的 dsh-llm 导出（`BlockAssembler` / `createToolResultMessage`）。
		//
		// **桩必须照真形状造**（2026-10-09 的教训）：dsh-llm 的命名空间带 `__esModule`、
		// default 是个函数、命名导出在命名空间上；而 `loader.unwrapExports` 会按 `__esModule`
		// 语义**换成 default**，于是命名导出全丢（`cordis-plugin-loader/lib/index.js:664`）。
		// 老桩是个没有 `__esModule`/`default`/`unwrapExports` 的裸对象，`lib/squad.js` 里那句
		// `unwrap(...)` 恰好原样返回它 —— 于是「成员一启动就报没导出」这个真 bug 在自检里全绿。
		loader: {
			import: async () => ({
				__esModule: true,
				default: function dshLlmPlugin() {},
				BlockAssembler: FakeAssembler,
				createToolResultMessage: fakeToolResult,
			}),
			// 与 cordis-plugin-loader 的实现逐字同形（不要「简化」成返回入参）
			unwrapExports: (e) => ((typeof e === "function" || (e = e.default ?? e, !e.__esModule)) ? e : e.default ?? e),
		},
		// ── 服务只走 `get()`（REQ-011 §5 那条教训：桩必须对着真契约写） ──
		// `llm.stream` 是成员的模型入口；`shell` 给 bash；`sandboxPolicy.resolve()` 给 bash 提供
		// 策略（生产里 workspaceRoot 会被换成成员的 worktree）。
		get(name) {
			if (name === "llm") return noLlm ? undefined : { stream };
			if (name === "shell") return shell;
			if (name === "sandboxPolicy") return { resolve: () => sandboxPolicy };
			return undefined;
		},
	};
	// 复刻 cordis 的访问器代理：**没声明 inject 的服务属性，读一下就抛**。
	// 桩要是不复刻这个，`ctx.llm` 这种写法在自检里照样绿，线上却直接炸
	// （REQ-011 §5 记过这个教训：上一版的客户端桩就是这么把「进入会话」的 bug 放过去的）。
	for (const name of ["llm", "shell", "sandboxPolicy"]) {
		Object.defineProperty(ctx, name, {
			configurable: true,
			get() {
				throw new Error(`cannot get property "${name}" without inject`);
			},
		});
	}
	return { ctx, record };
}

const install = (options) => {
	const { ctx, record } = fakeCtx(options);
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS, ...options?.config } });
	const tools = Object.fromEntries(record.tools.map((t) => [t.name, t]));
	const call = async (name, args, caller) => {
		const tool = tools[name];
		assert.ok(tool !== undefined, `工具 ${name} 没注册`);
		const value = await tool.execute(args, { agent: { id: caller } });
		assert.deepEqual(schemaViolations(tool.output.schema, value), [], `${name} 的返回值不符合 output.schema`);
		return value.text;
	};
	// 成员是**后台**跑的（`squad_spawn` 故意不 await），所以断言状态之前要等一下。
	const settle = async () => {
		for (const byName of squad.state.values()) {
			for (const one of byName.values()) {
				for (const member of one.members.values()) {
					if (member.promise) await member.promise;
				}
			}
		}
	};
	return { squad, record, tools, call, settle };
};

await checkAsync("工具：建队 → spawn（真跑成员循环）→ 结论自动落黑板 → 所有者收队", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-spawn-"));
	const seen = [];
	const { squad, call, record, settle } = install({
		stream: scriptedStream(
			[
				{ text: "先看一眼", calls: [{ id: "c1", name: "board", arguments: '{"text":"入口在 src/a.js:42"}' }] },
				{ text: "干完了：改了 src/a.js" },
			],
			seen,
		),
	});
	assert.equal(record.tools.length, 6);
	assert.deepEqual(
		record.tools.map((t) => t.name).sort(),
		["squad_board", "squad_close", "squad_new", "squad_spawn", "squad_status", "squad_update"],
	);

	assert.match(await call("squad_new", { name: "登录改造", objective: "把登录改成 OAuth" }, "main-1"), /已建小队「登录改造」/);
	const spawned = await call("squad_spawn", { squad: "登录改造", member: "实现-A", role: "实现", task: "改代码", worktree: wt }, "main-1");
	assert.match(spawned, /已派「实现-A」/);
	assert.match(spawned, /new-api\/tier-std/, "要告诉所有者它跑在哪一档");

	const one = squad.state.get("main-1").get("登录改造");
	const member = one.members.get("实现-A");
	assert.equal(member.running !== undefined, true, "派完当场就在跑（后台，不 await）");
	assert.deepEqual(seen[0].messages[0].content[0].text.includes("改代码"), true, "任务正文要进第一条 user 消息");

	await settle();
	assert.equal(member.status, "完成", `成员该跑完：${member.note}`);
	assert.match(member.note, /收工/);
	assert.match(member.note, /2 步/);
	assert.match(member.note, /in 20 \/ out 10/, "结论里要带用量（主 agent 靠它判断贵不贵）");
	assert.equal(member.running, undefined, "跑完要清掉 running");
	assert.deepEqual(member.transcript.map((e) => e.role), ["assistant", "tool", "assistant"], "转录要留痕（面板看的就是它）");
	assert.equal(member.transcript[0].calls[0].name, "board");

	// 黑板：成员自己写的那条 + 收工结论那条，作者都是**成员名**（不是「主 agent」）
	assert.deepEqual(one.board.map((b) => b.from), ["实现-A", "实现-A"]);
	assert.match(one.board[0].text, /入口在 src\/a\.js:42/);
	assert.match(one.board[1].text, /实现-A 收工/);
	assert.match(one.board[1].text, /干完了：改了 src\/a\.js/);

	assert.match(await call("squad_board", { squad: "登录改造", text: "收到" }, "main-1"), /主 agent/);
	assert.match(await call("squad_close", { squad: "登录改造", reason: "目标达成" }, "main-1"), /已关掉小队/);
	fs.rmSync(wt, { recursive: true, force: true });
});

await checkAsync("工具：权限 —— 只有所有者能调；正在跑的不能重复派；收队当场掐掉它", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-perm-"));
	// 这个队里的成员会一直「卡在等模型」—— 好确定地测「正在跑」这一态
	const { squad, call, settle } = install({ stream: hangingStream });
	await call("squad_new", { name: "队", objective: "目标" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "实现-A", role: "实现", task: "t", worktree: wt }, "main-1");

	// 非所有者：**动别人的队**的 5 个工具一个都调不到（成员不是 dsh agent，没有身份，
	// 所以「成员视角」不存在）。`squad_new` 不在此列 —— 它建的是调用者自己的队。
	const anyArgs = { squad: "队", member: "实现-A", name: "队", objective: "x", text: "x", role: "实现", task: "t", worktree: wt, status: "完成" };
	for (const name of ["squad_spawn", "squad_update", "squad_board", "squad_status", "squad_close"]) {
		assert.match(await call(name, anyArgs, "sub-1"), /\[失败\]/, `${name} 不该让非所有者调`);
		assert.match(await call(name, anyArgs, "外人"), /\[失败\]/, `${name} 不该让外人调`);
	}
	assert.match(await call("squad_new", { name: "外人的队", objective: "x" }, "外人"), /已建小队/, "谁都能建自己的队");
	const stranger = await call("squad_status", {}, "外人");
	assert.match(stranger, /外人的队/);
	assert.doesNotMatch(stranger, /小队「队」/, "但看不到别人的队");
	// 正在跑：不能重复派（否则同一个成员名会有两条循环在烧模型）
	assert.match(await call("squad_spawn", { squad: "队", member: "实现-A", role: "实现", task: "t", worktree: wt }, "main-1"), /还在跑/);
	// worktree 指错了要拒：它是成员的世界边界，指错了成员一步都走不了
	assert.match(await call("squad_spawn", { squad: "队", member: "实现-B", role: "实现", task: "t", worktree: path.join(os.tmpdir(), "没有这个目录-xyz") }, "main-1"), /\[失败\]/);
	assert.equal(squad.state.get("main-1").get("队").members.size, 1, "失败的派不该留下半行");
	// 正在跑时改 worktree：记录会和它实际在用的目录对不上 → 拒；改状态随便
	assert.match(await call("squad_update", { squad: "队", member: "实现-A", worktree: os.tmpdir() }, "main-1"), /\[失败\]/);
	assert.match(await call("squad_update", { squad: "队", member: "实现-A", status: "完成", note: "我手动标一下" }, "main-1"), /完成/);

	// 收队 = 当场掐掉还在跑的成员（不会继续烧模型）
	assert.match(await call("squad_close", { squad: "队", reason: "不要了" }, "main-1"), /掐掉了 1 个还在跑的成员/);
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("实现-A");
	assert.equal(member.status, "卡住", "被掐 = 卡住");
	assert.equal(member.running, undefined, "掐完也要清 running");

	// 收队后所有写口都拒，但还看得到（收队不删数据）
	assert.match(await call("squad_board", { squad: "队", text: "收队后再写一条" }, "main-1"), /\[失败\]/, "收队后不能写黑板");
	assert.match(await call("squad_update", { squad: "队", member: "实现-A", status: "卡住" }, "main-1"), /\[失败\]/, "收队后不能改成员");
	assert.match(await call("squad_spawn", { squad: "队", member: "实现-C", role: "实现", task: "t", worktree: wt }, "main-1"), /\[失败\]/, "收队后不能派成员");
	assert.match(await call("squad_status", { squad: "队" }, "main-1"), /实现-A/, "但还看得到");
	assert.match(await call("squad_new", { name: "队", objective: "重名" }, "main-1"), /\[失败\]/);
	assert.match(await call("squad_status", { squad: "不存在" }, "main-1"), /\[失败\]/);
	// 空/纯空白的队名：schema 的 `required` 挡不住空串。曾经 authorize 给所有者返回了
	// 一个没有 squad 的成功 → 这四个工具当场 TypeError（不是「友好失败」）。
	for (const name of ["", "   ", "\t\n"]) {
		assert.match(await call("squad_board", { squad: name, text: "x" }, "main-1"), /\[失败\]/, `squad_board 收到 ${JSON.stringify(name)} 要友好拒`);
		assert.match(await call("squad_spawn", { squad: name, member: "X", role: "实现", task: "t", worktree: wt }, "main-1"), /\[失败\]/);
		assert.match(await call("squad_update", { squad: name, member: "实现-A", status: "完成" }, "main-1"), /\[失败\]/);
		assert.match(await call("squad_close", { squad: name }, "main-1"), /\[失败\]/);
	}
	fs.rmSync(wt, { recursive: true, force: true });
});

await checkAsync("工具：squad_status 点名 = 只看那一个（不是「点名等于不点名」）", async () => {
	const { squad, call } = install();
	await call("squad_new", { name: "甲", objective: "a" }, "main-1");
	await call("squad_new", { name: "乙", objective: "b" }, "main-1");
	const one = await call("squad_status", { squad: "甲" }, "main-1");
	assert.match(one, /甲/);
	assert.doesNotMatch(one, /乙/, "点名了就别把别的队也倒出来");
	assert.match(await call("squad_status", { squad: "乙" }, "main-1"), /乙/);
	// 成员那一行：直接往 state 里放一个（这一段测渲染，不必真跑循环）
	addMember(squad.state, squad.state.get("main-1").get("甲"), { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });
	const withMember = await call("squad_status", { squad: "甲" }, "main-1");
	assert.match(withMember, /实现-A/);
	assert.match(withMember, /worktree=\/tmp\/wt-a/, "worktree 要打全 —— 主 agent 要按它去审 diff");
	assert.doesNotMatch(withMember, /乙/);
});

await checkAsync("工具：squad_status 不带队名 → 列出自己相关的全部；一个都没有 → 给出下一步", async () => {
	const { call } = install();
	assert.match(await call("squad_status", {}, "main-1"), /没有小队/);
	await call("squad_new", { name: "甲", objective: "a" }, "main-1");
	await call("squad_new", { name: "乙", objective: "b" }, "main-1");
	const both = await call("squad_status", {}, "main-1");
	assert.match(both, /甲/);
	assert.match(both, /乙/);
	// 外人：不能看到别人的队（连名字都不行），但要说清下一步怎么走
	const stranger = await call("squad_status", {}, "外人");
	assert.doesNotMatch(stranger, /甲|乙/, "外人的输出里不能出现别人的队名");
	assert.match(stranger, /squad_new/, "看不到队时要给出下一步");
});

// ── 5. 成员的循环与工具（C 路的核心：小队自己驱动 loop、自己执行工具） ────────

/** 跑一次循环：默认值都填好，测哪一项就覆盖哪一项。 */
const runLoop = (overrides = {}) =>
	runMemberLoop({
		kit: { BlockAssembler: FakeAssembler, createToolResultMessage: fakeToolResult },
		stream: scriptedStream([{ text: "没事干" }]),
		provider: "new-api",
		model: "tier-std",
		system: "你是成员",
		task: "读 a.txt",
		tools: MEMBER_TOOL_SCHEMAS,
		executeTool: async () => ({ text: "ok" }),
		...overrides,
	});

check("循环·解析参数：空 = {}、非对象要拒、坏 JSON 要拒且给出理由", () => {
	assert.deepEqual(parseToolArguments(""), { ok: true, value: {} });
	assert.deepEqual(parseToolArguments("   "), { ok: true, value: {} });
	assert.deepEqual(parseToolArguments(undefined), { ok: true, value: {} });
	assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, value: { a: 1 } });
	assert.equal(parseToolArguments("[1,2]").ok, false, "数组不是对象");
	assert.equal(parseToolArguments("null").ok, false);
	assert.equal(parseToolArguments("{坏的").ok, false);
	assert.match(parseToolArguments("{坏的").detail, /JSON/, "要说清是 JSON 坏了");
});

check("循环·裁剪历史：窗口不以 tool 结果开头，第一条任务永远留着", () => {
	const msgs = [
		{ role: "user", content: "task" },
		{ role: "assistant" },
		{ role: "tool" },
		{ role: "assistant" },
		{ role: "tool" },
		{ role: "assistant" },
	];
	const kept = trimMessages(msgs, 2);
	assert.equal(kept[0], msgs[0], "任务那条永远在");
	assert.equal(kept.at(-1), msgs[5], "最新那条要在");
	assert.notEqual(kept[1].role, "tool", "窗口不能以 tool 结果开头（协议约束，否则 provider 直接拒）");
	assert.equal(trimMessages(msgs, 99), msgs, "没超就不动它");
	// 极端情况：窗口里全是 tool 结果 → 只剩第一条任务，不能返回一个空数组
	const allTool = [{ role: "user" }, { role: "tool" }, { role: "tool" }];
	assert.deepEqual(trimMessages(allTool, 2), [allTool[0]]);
});

await checkAsync("循环·整条路径：模型调工具 → 结果回灌 → 下一轮收工（每个 call 恰好一条结果）", async () => {
	const seen = [];
	const executed = [];
	const stream = scriptedStream(
		[
			{ text: "我先读一下", calls: [{ id: "c1", name: "read", arguments: '{"path":"a.txt"}' }] },
			{ text: "读完了，收工" },
		],
		seen,
	);
	const result = await runLoop({
		stream,
		executeTool: async (call) => {
			executed.push(call);
			return { text: "文件内容" };
		},
	});
	assert.equal(result.status, "完成");
	assert.equal(result.steps, 2);
	assert.deepEqual(executed.map((c) => c.name), ["read"]);
	assert.deepEqual(executed[0].arguments, { path: "a.txt" }, "参数要解析成对象再给执行器");
	assert.equal(seen.length, 2, "两轮 = 两次模型请求");
	assert.equal(seen[0].system, "你是成员", "system 每轮都要带（它是 provider 的 system 槽，不属于 messages）");
	assert.equal(seen[0].provider, "new-api");
	assert.deepEqual(seen[0].tools, MEMBER_TOOL_SCHEMAS, "发给 provider 的工具表要和生产一致");
	assert.equal(seen[0].tools.some((t) => "run" in t), false, "`run` 是我们自己的执行器，不该发给 provider");
	assert.equal(seen[0].model, "tier-std");
	assert.equal(seen[1].messages[0].role, "user", "第一条是任务");
	assert.equal(seen[1].messages[1].role, "assistant", "上一轮的回答要进历史");
	assert.equal(seen[1].messages.filter((m) => m.role === "tool").length, 1, "每个 call 恰好一条 tool 结果");
	assert.equal(seen[1].messages[2].toolCallId, "c1", "结果要对着 callId");
	assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 }, "两轮的用量要累加");
	assert.deepEqual(result.transcript.map((e) => e.role), ["assistant", "tool", "assistant"]);
	assert.equal(result.transcript[0].calls[0].name, "read");
});

await checkAsync("循环·协议：参数不是合法 JSON 也要回一条 isError 结果（不能跳过）", async () => {
	const seen = [];
	const stream = scriptedStream([{ calls: [{ id: "c1", name: "read", arguments: "{坏" }] }, { text: "收工" }], seen);
	const result = await runLoop({
		stream,
		executeTool: async () => {
			throw new Error("坏参数不该走到执行器");
		},
	});
	const toolMsgs = seen[1].messages.filter((m) => m.role === "tool");
	assert.equal(toolMsgs.length, 1, "坏参数也要有结果 —— 少一条 provider 会拒下一次请求");
	assert.equal(toolMsgs[0].isError, true);
	assert.match(toolMsgs[0].content[0].text, /JSON/);
	assert.equal(result.status, "完成");
});

await checkAsync("循环·护栏：单步工具数超限 → 多出来的回错误结果，不静默丢", async () => {
	const seen = [];
	const calls = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, name: "read", arguments: "{}" }));
	const stream = scriptedStream([{ calls }, { text: "收工" }], seen);
	let executed = 0;
	await runLoop({
		stream,
		limits: { ...LOOP_DEFAULTS, maxToolCallsPerStep: 2 },
		executeTool: async () => {
			executed += 1;
			return { text: "ok" };
		},
	});
	assert.equal(executed, 2, "只执行前 2 个");
	const toolMsgs = seen[1].messages.filter((m) => m.role === "tool");
	assert.equal(toolMsgs.length, 3, "3 个 call 就得有 3 条结果");
	assert.equal(toolMsgs[2].isError, true);
	assert.match(toolMsgs[2].content[0].text, /上限/);
});

await checkAsync("循环·护栏：跑满 maxSteps 还没收工 → 卡住，不假装成功", async () => {
	const stream = scriptedStream([{ calls: [{ id: "c1", name: "read", arguments: "{}" }] }]);
	const result = await runLoop({
		stream,
		limits: { ...LOOP_DEFAULTS, maxSteps: 3 },
		executeTool: async () => ({ text: "ok" }),
	});
	assert.equal(result.status, "卡住");
	assert.equal(result.steps, 3);
	assert.match(result.reason, /3 步/, `要说清是跑满步数：${result.reason}`);
});

await checkAsync("循环·护栏：单条工具结果太长要截断（别把上下文撑爆）", async () => {
	const seen = [];
	const stream = scriptedStream([{ calls: [{ id: "c1", name: "read", arguments: "{}" }] }, { text: "收工" }], seen);
	await runLoop({
		stream,
		limits: { ...LOOP_DEFAULTS, maxToolResultChars: 50 },
		executeTool: async () => ({ text: "x".repeat(500) }),
	});
	const shown = seen[1].messages.find((m) => m.role === "tool").content[0].text;
	assert.ok(shown.length < 200, `截断没生效：${shown.length} 字符`);
	assert.match(shown, /截断/);
});

await checkAsync("循环·失败：模型流抛错 / finish 报错 / 已中止 → 一律「卡住」并给出理由，不往外抛", async () => {
	const thrown = await runLoop({
		stream: () => {
			throw new Error("连接被拒");
		},
	});
	assert.equal(thrown.status, "卡住");
	assert.match(thrown.reason, /连接被拒/);

	const errored = await runLoop({
		stream: () =>
			(async function* chunks() {
				yield { type: "finish", reason: { kind: "error", failure: { message: "provider 500" } } };
			})(),
	});
	assert.equal(errored.status, "卡住");
	assert.match(errored.reason, /provider 500/);

	const abortedFinish = await runLoop({
		stream: () =>
			(async function* chunks() {
				yield { type: "finish", reason: { kind: "aborted" } };
			})(),
	});
	assert.equal(abortedFinish.status, "卡住");
	assert.match(abortedFinish.reason, /中止/);

	// max-tokens 且没有工具调用 = 结论被截断，不能当「完成」
	const cut = await runLoop({
		stream: () =>
			(async function* chunks() {
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "text-delta", index: 0, text: "说到一半" };
				yield { type: "finish", reason: { kind: "max-tokens" } };
			})(),
	});
	assert.equal(cut.status, "卡住");
	assert.match(cut.reason, /max-tokens/);

	// 已经中止的信号：一个请求都不该发
	const controller = new AbortController();
	controller.abort();
	let asked = 0;
	const stopped = await runLoop({
		signal: controller.signal,
		stream: () => {
			asked += 1;
			return (async function* chunks() {})();
		},
	});
	assert.equal(asked, 0, "已经中止就别再发请求");
	assert.equal(stopped.status, "卡住");
	assert.match(stopped.reason, /中止/);
});

await checkAsync("循环·装配：拿不到 BlockAssembler（loader 没给）→ 卡住，不是崩", async () => {
	const result = await runLoop({ kit: {} });
	assert.equal(result.status, "卡住");
	assert.match(result.reason, /BlockAssembler/);
});

// 这条钉住 loader 桩本身的形状。真 dsh 的 `unwrapExports` 会把带 `__esModule` 的命名空间
// 换成 default（default 是个函数）→ 命名导出全丢；`lib/squad.js` 的 loadKit 因此必须
// 「命名空间 → default → unwrap 结果」都找。要是有人把下面的桩改回朴素对象，
// 上面那条 fix 就又会静默失效 —— 所以这里断言桩确实复刻了那个陷阱。
check("loader 桩照真形状：unwrapExports(命名空间) 会丢命名导出，loadKit 仍能从命名空间拿到", () => {
	const ns = {
		__esModule: true,
		default: function dshLlmPlugin() {},
		BlockAssembler: FakeAssembler,
		createToolResultMessage: fakeToolResult,
	};
	const unwrap = (e) => ((typeof e === "function" || (e = e.default ?? e, !e.__esModule)) ? e : e.default ?? e);
	assert.equal(typeof unwrap(ns).BlockAssembler, "undefined", "桩没复刻出「unwrap 丢命名导出」这个陷阱，那 bug 就测不出来了");
	assert.equal(typeof ns.BlockAssembler, "function", "命名导出必须挂在命名空间上（真 dsh-llm 就是这样）");
});

check("循环·用量：token 累加、usageLine 只报有值的字段", () => {
	assert.equal(usageLine(undefined), "用量未知");
	assert.equal(usageLine({}), "用量未知");
	assert.equal(usageLine({ inputTokens: 3, outputTokens: 4 }), "in 3 / out 4");
	assert.equal(usageLine({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 100 }), "in 3 / out 4 / cacheRead 100");
	assert.equal(usageLine({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 0 }), "in 3 / out 4", "0 的缓存不显示");
});

check("成员提示词：system 说清身份/边界/收工方式；任务里带上黑板最近几条", () => {
	const { state, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });
	const member = squad.members.get("实现-A");
	const sys = memberSystemPrompt({ squad, member });
	assert.match(sys, /小队「登录改造」/);
	assert.match(sys, /成员「实现-A」/);
	assert.match(sys, /工作区是 `\/tmp\/wt-a`/, "worktree 要写死在提示里（它是成员的世界边界）");
	assert.match(sys, /没有审批通道/, "拿不到审批这件事必须告诉它，否则它只会一直试");
	assert.match(sys, /不要再调工具/, "收工的判据要写清楚 —— 循环就是按「不再调工具」判的");
	assert.match(sys, /git commit/, "不许自己提交/合并，要说清");
	assert.doesNotMatch(sys, /undefined/, "别把 undefined 拼进去");

	// 黑板最近几条要进任务 —— 这是多个成员之间唯一的共享内存
	appendBoard(squad, { from: "调研-A", text: "上游用的是 PKCE" }, SQUAD_DEFAULTS.boardLimit);
	const task = memberTaskText(squad, member);
	assert.match(task, /任务：改代码/);
	assert.match(task, /调研-A：上游用的是 PKCE/);
	assert.match(memberTaskText(squad, member, { each: 5 }), /调研-A：上游用的是…/, "单条太长要截断");
	// 黑板还空着的时候不出现那一节（别给它一个空标题）
	const fresh = newSquad(createState(), "o", { name: "空", objective: "x" }).squad;
	assert.doesNotMatch(memberTaskText(fresh, { task: "t" }), /黑板/);
});

check("成员工具·工具表：7 个、schema 合法（描述/必填齐），护栏值都是正数", () => {
	assert.deepEqual(
		MEMBER_TOOLS.map((t) => t.name),
		["read", "write", "edit", "grep", "glob", "bash", "board"],
	);
	for (const t of MEMBER_TOOLS) {
		assert.equal(typeof t.description, "string");
		assert.ok(t.description.length > 10, `${t.name} 的描述太短 —— 模型就靠它选工具`);
		assert.equal(t.parameters.type, "object");
		assert.equal(t.parameters.additionalProperties, false);
		assert.ok(t.parameters.required.length > 0, `${t.name} 一个必填参数都没有？`);
		for (const key of t.parameters.required) {
			assert.ok(t.parameters.properties[key] !== undefined, `${t.name}.${key} 标了必填却没定义`);
		}
		assert.equal(typeof t.run, "function");
	}
	for (const [key, value] of Object.entries(TOOL_LIMITS)) assert.ok(value > 0, `${key} 要是正数`);

	// bash 开关：关掉之后成员的工具表里**不能**再有 bash（那是唯一等于宿主权限的工具）
	const noBash = memberToolsFor({ bash: false });
	assert.deepEqual(noBash.tools.map((t) => t.name), ["read", "write", "edit", "grep", "glob", "board"]);
	assert.equal(noBash.schemas.some((t) => t.name === "bash"), false);
	assert.equal(noBash.schemas.some((t) => "run" in t), false, "线上字段里不能有 run");
	assert.equal(memberToolsFor().schemas.length, 7, "默认还是 7 个");

	// 发给 provider 的那份：只有线上字段，且真能序列化（`run` 混进去就发不出去了）
	assert.deepEqual(
		MEMBER_TOOL_SCHEMAS.map((t) => t.name),
		MEMBER_TOOLS.map((t) => t.name),
	);
	for (const t of MEMBER_TOOL_SCHEMAS) {
		assert.deepEqual(Object.keys(t).sort(), ["description", "name", "parameters"], `${t.name} 多了/少了字段`);
	}
	assert.doesNotThrow(() => JSON.stringify(MEMBER_TOOL_SCHEMAS));
});

check("成员工具·glob：`**/` 能跨目录也能零层，`*` 不跨 `/`", () => {
	assert.ok(globToRegExp("**/*.js").test("src/a.js"));
	assert.ok(globToRegExp("**/*.js").test("a.js"), "`**/` 要能匹配零层");
	assert.ok(globToRegExp("**/*.js").test("a/b/c.js"));
	assert.ok(!globToRegExp("*.js").test("src/a.js"), "`*` 不跨目录");
	assert.ok(globToRegExp("src/*.js").test("src/a.js"));
	assert.ok(!globToRegExp("src/*.js").test("src/deep/a.js"));
	assert.ok(globToRegExp("a/**/b").test("a/b"));
	assert.ok(globToRegExp("a/**/b").test("a/x/y/b"));
	assert.ok(globToRegExp("?.js").test("a.js"));
	assert.ok(!globToRegExp("?.js").test("ab.js"));
	assert.ok(globToRegExp("src/**").test("src/a/b.js"));
	assert.ok(!globToRegExp("src/*.js").test("src/a.js.bak"), "要整条匹配，不是前缀");
});

check("成员工具·路径：`..` 与出界的绝对路径一律拒，根内的放行", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-root-"));
	assert.equal(resolveInside(root, "src/a.js"), path.join(root, "src/a.js"));
	assert.equal(resolveInside(root, "./a/../b"), path.join(root, "b"));
	assert.equal(resolveInside(root, path.join(root, "x")), path.join(root, "x"), "根内的绝对路径放行");
	for (const bad of ["../x", "a/../../x", "/etc/passwd", path.join(os.tmpdir(), "别的目录")]) {
		assert.throws(() => resolveInside(root, bad), /越出工作区/, `${bad} 要拒`);
	}
	// 符号链接：指向**外面**的软链必须照样被拒（realpath 之后再比），指向根内的照常放行
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "squad-outside-"));
	fs.mkdirSync(path.join(root, "real"));
	try {
		fs.symlinkSync(outside, path.join(root, "esc"));
		fs.symlinkSync(path.join(root, "real"), path.join(root, "in"));
		assert.throws(() => resolveInside(root, "esc/别的"), /越出工作区/, "经过软链绕到外面要拒");
		assert.equal(resolveInside(root, "in/x"), path.join(root, "in", "x"), "指向根内的软链照常放行");
		// 悬空软链：目标还不存在，realpath 会失败 —— 那时**不能**退化成字面路径，否则能顺着它写出去
		fs.symlinkSync(path.join(outside, "还没有这个文件"), path.join(root, "dangling"));
		assert.throws(() => resolveInside(root, "dangling"), /解析不了/, "悬空软链要拒");
		assert.throws(() => resolveInside(root, "dangling/x"), /解析不了/, "经过悬空软链也要拒");
		fs.rmSync(path.join(root, "dangling"), { force: true });
		// `..foo` 是工作区里一个合法文件名，不能被「以 .. 开头」误伤
		assert.equal(resolveInside(root, "..foo"), path.join(root, "..foo"));
		// 权限不足（EACCES）也属于「在、但解析不了」：不能退化成字面路径。
		// root 用户不受权限位约束，那种环境下这条没有意义，跳过。
		if (process.getuid?.() !== 0) {
			fs.mkdirSync(path.join(root, "noperm"));
			fs.chmodSync(path.join(root, "noperm"), 0o000);
			try {
				assert.throws(() => resolveInside(root, "noperm/inner/f.txt"), /解析不了/, "权限不足要拒");
			} finally {
				fs.chmodSync(path.join(root, "noperm"), 0o755);
			}
		}
	} finally {
		fs.rmSync(path.join(root, "esc"), { force: true });
		fs.rmSync(path.join(root, "in"), { force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
	// 仓库元数据一律不碰（.git/hooks 是持久后门），但 .gitignore 这种同名前缀的文件不受影响
	assert.throws(() => resolveInside(root, ".git/config"), /不碰 \.git/, ".git 里的文件要拒");
	assert.throws(() => resolveInside(root, "sub/.git/hooks/pre-commit"), /不碰 \.git/, "子目录里的 .git 也要拒");
	assert.equal(resolveInside(root, ".gitignore"), path.join(root, ".gitignore"), "`.gitignore` 是普通文件，别误伤");
	assert.throws(() => resolveInside(root, ""), /不能为空/);
	assert.throws(() => resolveInside(root, "   "), /不能为空/);
	fs.rmSync(root, { recursive: true, force: true });
});

await checkAsync("成员工具·真跑：write/read/edit/grep/glob 在真临时目录里走一遍；board 落到黑板", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-tools-"));
	const boardWrites = [];
	const env = { worktree: root, ctx: fakeCtx().ctx, signal: undefined, bashPolicy: undefined, board: (text) => { boardWrites.push(text); return { ok: true }; } };

	const wrote = await runMemberTool("write", { path: "src/a.js", content: "export const a = 1;\n" }, env);
	assert.equal(wrote.isError, undefined, wrote.text);
	assert.equal(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), "export const a = 1;\n", "父目录要自动建");

	const read = await runMemberTool("read", { path: "src/a.js" }, env);
	assert.match(read.text, /1\texport const a = 1;/, "读回来要带行号");

	const edited = await runMemberTool("edit", { path: "src/a.js", old_string: "a = 1", new_string: "a = 2" }, env);
	assert.equal(edited.isError, undefined, edited.text);
	assert.match(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), /a = 2/);
	// 找不到 / 不唯一都要失败，不能默默改
	assert.equal((await runMemberTool("edit", { path: "src/a.js", old_string: "不存在", new_string: "x" }, env)).isError, true);
	await runMemberTool("write", { path: "src/b.js", content: "// TODO 甲\n// TODO 乙\n" }, env);
	const twice = await runMemberTool("edit", { path: "src/b.js", old_string: "TODO", new_string: "DONE" }, env);
	assert.equal(twice.isError, true, "出现多次要拒（否则改错地方）");
	assert.match(fs.readFileSync(path.join(root, "src/b.js"), "utf8"), /TODO 甲/, "被拒之后文件不能变");

	// `new_string` 里的 `$&` / `` $` `` 不能被当替换模板展开（字符串形式的 replace 会）
	await runMemberTool("write", { path: "src/c.js", content: "alpha X beta\n" }, env);
	await runMemberTool("edit", { path: "src/c.js", old_string: "X", new_string: "$&$`$'" }, env);
	assert.equal(fs.readFileSync(path.join(root, "src/c.js"), "utf8"), "alpha $&$`$' beta\n", "替换文本要原样写进去");

	assert.match((await runMemberTool("grep", { pattern: "export" }, env)).text, /src\/a\.js:1:/, "grep 要给 文件:行号");
	assert.equal((await runMemberTool("grep", { pattern: "没有这个" }, env)).text, "没有匹配。");
	// `path` 指到**文件**：参数说明就是这么写的（walkFiles 只认目录，曾经这里永远返回「没有匹配」）
	assert.match((await runMemberTool("grep", { pattern: "export", path: "src/a.js" }, env)).text, /^src\/a\.js:1:/, "按文件搜要搜得到");
	// 搜子目录时，行号前缀仍然相对 **worktree** —— 否则模型照它去 read 会找错地方
	assert.match((await runMemberTool("grep", { pattern: "export", path: "src" }, env)).text, /^src\/a\.js:1:/, "前缀要相对 worktree");
	assert.equal((await runMemberTool("grep", { pattern: "x", path: "没有这个目录" }, env)).isError, true, "不存在的搜索根要友好失败");
	// 明确指到一个「搜不了」的文件（太大 / 二进制）：要说出来，不能回「没有匹配。」
	fs.writeFileSync(path.join(root, "big.txt"), `NEEDLE${"x".repeat(TOOL_LIMITS.readBytes + 10)}`);
	fs.writeFileSync(path.join(root, "bin.dat"), "NEEDLE\u0000rest");
	const tooBig = await runMemberTool("grep", { pattern: "NEEDLE", path: "big.txt" }, env);
	assert.equal(tooBig.isError, true, "文件太大要明确失败");
	assert.match(tooBig.text, /太大/);
	assert.match((await runMemberTool("grep", { pattern: "NEEDLE", path: "bin.dat" }, env)).text, /二进制/);
	fs.rmSync(path.join(root, "big.txt"));
	fs.rmSync(path.join(root, "bin.dat"));
	// 整目录里只有搜不了的文件：不能只说「没有匹配。」——那会让模型以为「这里没有」
	fs.mkdirSync(path.join(root, "onlybin"));
	fs.writeFileSync(path.join(root, "onlybin", "x.dat"), "NEEDLE\u0000rest");
	const allSkipped = await runMemberTool("grep", { pattern: "NEEDLE", path: "onlybin" }, env);
	assert.match(allSkipped.text, /没有匹配/, "没搜成也是没匹配……");
	assert.match(allSkipped.text, /1 个文件搜不了/, "……但要说清有几个没搜成");
	fs.rmSync(path.join(root, "onlybin"), { recursive: true, force: true });
	assert.deepEqual((await runMemberTool("glob", { pattern: "**/*.js" }, env)).text.split("\n"), ["src/a.js", "src/b.js", "src/c.js"]);
	assert.equal((await runMemberTool("glob", { pattern: "src/a.*" }, env)).text, "src/a.js");
	// 截断要说出来（不说的话模型会把「前 200 个」当成完整列表）
	const realGlobLimit = TOOL_LIMITS.globEntries;
	TOOL_LIMITS.globEntries = 1;
	try {
		assert.match((await runMemberTool("glob", { pattern: "**/*.js" }, env)).text, /已到上限 1 个/, "到上限要提示（措辞留余地，不能断言还有更多）");
	} finally {
		TOOL_LIMITS.globEntries = realGlobLimit;
	}

	// 越界：真跑也要拦住
	assert.equal((await runMemberTool("read", { path: "../../etc/passwd" }, env)).isError, true);
	// 悬空软链（reviewer 实测过的那条越界路）：read/write 都要拒，而且**外面一个字都不能落**
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "squad-outside-"));
	fs.symlinkSync(path.join(outside, "new.txt"), path.join(root, "broken"));
	try {
		assert.equal((await runMemberTool("read", { path: "broken" }, env)).isError, true, "悬空软链要拒");
		assert.equal((await runMemberTool("write", { path: "broken", content: "ESCAPED" }, env)).isError, true);
		assert.equal(fs.existsSync(path.join(outside, "new.txt")), false, "绝不能顺着软链写到工作区外");
	} finally {
		fs.rmSync(path.join(root, "broken"), { force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
	assert.equal((await runMemberTool("write", { path: "/tmp/越界.txt", content: "x" }, env)).isError, true);
	assert.equal(fs.existsSync("/tmp/越界.txt"), false, "越界的写不能落盘");

	// 写盘不跟随符号链接（O_NOFOLLOW）：根内的软链在 write/edit 下要拒，read 照常放行。
	// 为什么这么分：写才是「改坏东西」的那一面（TOCTOU 后能写到工作区外），读在 danger 档本来就没边界。
	await runMemberTool("write", { path: "real.txt", content: "hello\n" }, env);
	fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
	assert.equal((await runMemberTool("write", { path: "link.txt", content: "y" }, env)).isError, true, "不跟着软链写");
	assert.equal((await runMemberTool("edit", { path: "link.txt", old_string: "hello", new_string: "bye" }, env)).isError, true, "不跟着软链改");
	assert.equal(fs.readFileSync(path.join(root, "real.txt"), "utf8"), "hello\n", "软链后面的真身不能被改");
	assert.equal((await runMemberTool("read", { path: "link.txt" }, env)).isError, undefined, "读还是能读（根内的软链不该一刀切）");
	// 硬链接：`O_NOFOLLOW` 管不了它（指向的 inode 就是工作区外的那个）→ 靠 nlink 查
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-hardlink-"));
	const outsideFile = path.join(outsideDir, "target.txt");
	fs.writeFileSync(outsideFile, "外部内容\n");
	fs.linkSync(outsideFile, path.join(root, "hard.txt"));
	const hard = await runMemberTool("write", { path: "hard.txt", content: "被改了" }, env);
	assert.equal(hard.isError, true, "硬链接要拒");
	assert.match(hard.text, /硬链接/);
	assert.equal(fs.readFileSync(outsideFile, "utf8"), "外部内容\n", "工作区外的那个 inode 不能被改");
	assert.equal((await runMemberTool("edit", { path: "hard.txt", old_string: "外部", new_string: "内部" }, env)).isError, true, "edit 也要拒硬链接");
	fs.rmSync(path.join(root, "hard.txt"), { force: true });
	fs.rmSync(outsideDir, { recursive: true, force: true });

	// 黑板：真写一次，回调要收到
	assert.equal((await runMemberTool("board", { text: "查到入口在 src/a.js" }, env)).isError, undefined);
	assert.deepEqual(boardWrites, ["查到入口在 src/a.js"]);
	assert.equal((await runMemberTool("board", { text: "   " }, env)).isError, true, "空话不记");
	assert.equal((await runMemberTool("不存在的工具", {}, env)).isError, true);
	assert.match((await runMemberTool("不存在的工具", {}, env)).text, /没有这个工具/);

	fs.rmSync(root, { recursive: true, force: true });
});

await checkAsync("成员工具·bash：走 ctx.shell，沙箱拦截（sandbox.denied）不抛错而是报失败", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-bash-"));
	const seen = [];
	const shellFor = (result) => ({
		resolve: (request) => {
			seen.push(request);
			return { ...request, resolved: true };
		},
		execute: async (spec) => ({ spec, result: () => result }),
	});
	const env = (result) => ({ worktree: root, ctx: fakeCtx({ shell: shellFor(result) }).ctx, signal: undefined, bashPolicy: { mode: "workspace-write", workspaceRoot: root }, board: () => ({ ok: true }) });

	const ok = await runMemberTool("bash", { command: "echo hi" }, env({ exitCode: 0, stdout: { text: "hi\n" }, stderr: { text: "" } }));
	assert.equal(ok.isError, false, ok.text);
	assert.match(ok.text, /退出码 0/);
	assert.match(ok.text, /hi/);
	assert.equal(seen[0].workdir, root, "命令要在成员的 worktree 里跑");
	assert.deepEqual(seen[0].sandboxPolicy, { mode: "workspace-write", workspaceRoot: root }, "沙箱策略要显式带上（workspaceRoot 钉在 worktree）");

	// 沙箱拦下：**不抛错**，而是结果里带 sandbox.denied（dsh 的语义就是这样）
	const denied = await runMemberTool(
		"bash",
		{ command: "rm -rf /" },
		env({ exitCode: 1, stdout: { text: "" }, stderr: { text: "denied" }, sandbox: { mode: "workspace-write", denied: true } }),
	);
	assert.equal(denied.isError, true);
	assert.match(denied.text, /沙箱拦下/);

	const failed = await runMemberTool("bash", { command: "exit 2" }, env({ exitCode: 2, stdout: { text: "" }, stderr: { text: "boom" } }));
	assert.equal(failed.isError, true, "非零退出码算失败");
	assert.match(failed.text, /boom/);

	// 没有 shell 服务：友好失败，不是 TypeError
	const noShell = await runMemberTool("bash", { command: "echo hi" }, { worktree: root, ctx: fakeCtx().ctx, board: () => ({ ok: true }) });
	assert.equal(noShell.isError, true);
	assert.match(noShell.text, /shell/);

	assert.equal((await runMemberTool("bash", { command: "  " }, env({ exitCode: 0 }))).isError, true, "空命令要拒");
	fs.rmSync(root, { recursive: true, force: true });
});

// ── 6. 装配 ────────────────────────────────────────────────────────────────

check("装配：enabled=false → 一个工具不注册、一条路由不挂", () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS, enabled: false } });
	assert.equal(squad.enabled, false);
	assert.equal(record.tools.length, 0);
	assert.equal(record.routes.length, 0);
	assert.match(squad.describe(), /关/);
});

check("装配：enabled 只认真布尔", () => {
	const { ctx, record } = fakeCtx();
	assert.equal(installSquad(ctx, { config: { enabled: "true" } }).enabled, false, "字符串 \"true\" 不算开");
	assert.equal(installSquad(ctx, { config: {} }).enabled, false, "默认必须是关？—— 不，小队默认开，但缺 enabled 时按 SQUAD_DEFAULTS 走");
	assert.equal(record.tools.length, 0);
});

check("装配：team/extensions/squad.json 的每个键都有校验器，且出厂值与 SQUAD_DEFAULTS 对齐", () => {
	const json = JSON.parse(fs.readFileSync(new URL("team/extensions/squad.json", ROOT), "utf8"));
	const keys = Object.keys(json).filter((key) => !key.startsWith("_"));
	assert.deepEqual(keys.sort(), Object.keys(SQUAD_FIELDS).sort(), "配置文件的键与 SQUAD_FIELDS 要对齐（加了键就得两处一起加）");
	for (const key of keys) {
		assert.equal(typeof SQUAD_FIELDS[key], "function", `${key} 没有校验器`);
		assert.notEqual(SQUAD_FIELDS[key](json[key]), undefined, `${key} 的现值被自己的校验器拒了：${JSON.stringify(json[key])}`);
		assert.deepEqual(SQUAD_DEFAULTS[key], json[key], `${key} 的出厂值与 SQUAD_DEFAULTS 不一致`);
	}
	// 越界的值要拒（免得「能写进 JSON 就能生效」）
	assert.equal(SQUAD_FIELDS.maxSteps(0), undefined);
	assert.equal(SQUAD_FIELDS.maxSteps(201), undefined);
	assert.equal(SQUAD_FIELDS.enabled("true"), undefined);
	assert.equal(SQUAD_FIELDS.provider("   "), undefined);
});

check("装配：webServer 缺失 → 面板不挂，但 6 个工具照常（headless 也要能用）", () => {
	const { ctx, record } = fakeCtx({ services: ["tools"] });
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	assert.equal(squad.enabled, true);
	assert.equal(record.tools.length, 6, "没有 webServer 不该连累工具");
	assert.equal(record.routes.length, 0);
	assert.match(squad.describe(), /面板未挂/);
	squad.dispose();
});

check("装配：webServer 在 → 路由挂上且只认 GET（写方法一律 404）", () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	assert.equal(record.routes.length, 1);
	assert.equal(record.routes[0].kind, "prefix");
	assert.equal(record.routes[0].path, SQUAD_ROUTE_PREFIX);
	assert.match(squad.describe(), /面板已挂/);
	assert.match(squad.describe(), /6 个工具/);
	squad.dispose();
	assert.equal(squad.state.size, 0, "dispose 要清状态");
});

check("装配：会话销毁 → 它的小队被清掉（状态只在当前会话）", () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	newSquad(squad.state, "s1", { name: "队", objective: "o" });
	newSquad(squad.state, "s2", { name: "队", objective: "o" });
	assert.equal(squad.state.size, 2);
	const disposed = record.events.find((e) => e.name === "session/disposed");
	assert.ok(disposed !== undefined, "必须监听 session/disposed");
	disposed.callback({ id: "s1" });
	assert.equal(squad.state.size, 1, "只清被销毁的那个会话");
	disposed.callback({ id: undefined });
	assert.equal(squad.state.size, 1, "拿不到 id 时不清（宁可不 clean，也不能误清别人的）");
	disposed.callback(undefined);
	assert.equal(squad.state.size, 1);
});

await checkAsync("装配：bash=false → 成员的工具表里没有 bash，且幻觉出来的 bash 调用被拒", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-noshell-"));
	const seen = [];
	const { squad, call, settle } = install({
		config: { bash: false },
		// 模型「幻觉」了一个没给它的工具（关了 bash 却调 bash）
		stream: scriptedStream([{ text: "我试试", calls: [{ id: "c1", name: "bash", arguments: '{"command":"rm -rf /"}' }] }, { text: "收工" }], seen),
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "实现-A", role: "实现", task: "t", worktree: wt }, "main-1");
	await settle();

	const names = seen[0].tools.map((t) => t.name);
	assert.equal(names.includes("bash"), false, "关了 bash 就不能把它发给模型");
	assert.equal(names.length, 6);
	assert.match(seen[0].system, /工具就 6 个/, "提示词里的工具数要跟着变");
	// 用词边界：临时目录名里带「bash」会把这条断言骗过去（踩过）
	assert.doesNotMatch(seen[0].system, /\bbash\b/, "提示词里不该再提 bash");
	const member = squad.state.get("main-1").get("队").members.get("实现-A");
	const toolEvent = member.transcript.find((e) => e.role === "tool");
	assert.equal(toolEvent.isError, true, "幻觉出来的 bash 调用要拒");
	assert.match(toolEvent.text, /没有 `bash` 工具/);
	fs.rmSync(wt, { recursive: true, force: true });
});

await checkAsync("装配：转录正文有字节上限（光限条数挡不住一条超长文本）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-bigtext-"));
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "x".repeat(TRANSCRIPT_TEXT_MAX + 5000) }]),
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "实现-A", role: "实现", task: "t", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("实现-A");
	assert.ok(member.transcript[0].text.length < TRANSCRIPT_TEXT_MAX + 200, `转录要截断：${member.transcript[0].text.length}`);
	assert.match(member.transcript[0].text, /转录截断/);
	fs.rmSync(wt, { recursive: true, force: true });
});

await checkAsync("装配：宿主没有 llm 服务 → squad_spawn 友好失败，那一行落「卡住」（不是代理异常）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-nollm-"));
	const { squad, call } = install({ noLlm: true });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	const out = await call("squad_spawn", { squad: "队", member: "实现-A", role: "实现", task: "t", worktree: wt }, "main-1");
	assert.match(out, /\[失败\]/, "要友好失败，不能抛出来");
	assert.match(out, /llm/, "要说清是缺哪个服务");
	const member = squad.state.get("main-1").get("队").members.get("实现-A");
	assert.equal(member.status, "卡住", "起不来就不能停在「在跑」——否则面板永远显示在跑");
	assert.match(member.note, /llm/);
	assert.equal(member.running, undefined);
	fs.rmSync(wt, { recursive: true, force: true });
});

await checkAsync("装配：会话销毁 / dispose → **先掐掉还在跑的成员**，再清状态（不会继续烧模型）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-abort-"));
	let asked = 0;
	const { ctx, record } = fakeCtx({
		stream: (options) => {
			asked += 1;
			return hangingStream(options);
		},
	});
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	const spawn = record.tools.find((t) => t.name === "squad_spawn");
	const newOne = record.tools.find((t) => t.name === "squad_new");
	const run = (tool, args, caller) => tool.execute(args, { agent: { id: caller } });

	await run(newOne, { name: "队", objective: "o" }, "s1");
	await run(spawn, { squad: "队", member: "实现-A", role: "实现", task: "t", worktree: wt }, "s1");
	const member = squad.state.get("s1").get("队").members.get("实现-A");
	assert.equal(member.running !== undefined, true, "先确认它真在跑");
	await tick();
	assert.equal(asked, 1, "它已经在等模型了（loop 里先 await loadKit，所以 spawn 返回时还没发）");

	const disposed = record.events.find((e) => e.name === "session/disposed");
	disposed.callback({ id: "s1" });
	await member.promise;
	assert.equal(asked, 1, "掐掉之后不该再发模型请求");
	assert.equal(member.status, "卡住");
	assert.match(member.note, /中止/, `中止要说成中止，别报成 provider 的错：${member.note}`);
	assert.equal(member.running, undefined);
	assert.equal(squad.state.size, 0, "状态也清了");

	// dispose 同理：插件拆除 ≠ 会话结束，成员可能还在后台跑
	await run(newOne, { name: "队2", objective: "o" }, "s2");
	await run(spawn, { squad: "队2", member: "实现-B", role: "实现", task: "t", worktree: wt }, "s2");
	const two = squad.state.get("s2").get("队2").members.get("实现-B");
	assert.equal(two.running !== undefined, true);
	await tick();
	const before = asked;
	squad.dispose();
	await two.promise;
	assert.equal(asked, before, "dispose 之后也不该再发请求");
	assert.equal(two.running, undefined);
	assert.equal(squad.state.size, 0);
	fs.rmSync(wt, { recursive: true, force: true });
});

// ── 7. HTTP 路由 + 信任栅栏 ────────────────────────────────────────────────

async function request(handler, method, url, { remoteAddress = "127.0.0.1", host = "localhost:3080", headers = {} } = {}) {
	let settle;
	const done = new Promise((resolve) => {
		settle = resolve;
	});
	const res = {
		status: 0,
		writeHead(status) {
			this.status = status;
		},
		end(text) {
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				payload = { parseError: text };
			}
			settle({ status: this.status, body: payload });
		},
	};
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.socket = { remoteAddress };
	req.headers = { host, ...headers };
	req.resume = () => {};
	await handler(req, res);
	return done;
}

await checkAsync("路由：GET /options 与 /squads；只读、未知路径 404", async () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS, boardLimit: 123 } });
	const handler = record.routes[0].handler;
	newSquad(squad.state, "s1", { name: "队", objective: "o" });

	const options = await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/options`);
	assert.equal(options.status, 200);
	assert.equal(options.body.ok, true);
	assert.equal(options.body.boardLimit, 123, "面板要知道黑板上限");
	assert.equal(options.body.transcript, true, "面板要知道转录这条路通不通（C 之后「进入会话」走它）");
	assert.equal(options.body.members, true);

	const squads = await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/squads`);
	assert.equal(squads.status, 200);
	assert.equal(squads.body.count, 1);
	assert.equal(squads.body.squads[0].owner, "s1");
	assert.equal(squads.body.squads[0].name, "队");

	assert.equal((await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/nope`)).status, 404);
	assert.equal((await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}`)).status, 404, "前缀本身没有内容");
	assert.equal((await request(handler, "POST", `${SQUAD_ROUTE_PREFIX}/squads`)).status, 404, "面板是只读的，写方法一律 404");
	assert.equal((await request(handler, "DELETE", `${SQUAD_ROUTE_PREFIX}/squads`)).status, 404);
	squad.dispose();
});

await checkAsync("路由：GET /transcript —— 转录走只读路由（成员不是 dsh 会话，没有 openSession 可调）", async () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	const handler = record.routes[0].handler;
	newSquad(squad.state, "s1", { name: "队", objective: "o" });
	addMember(squad.state, squad.state.get("s1").get("队"), { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });
	const member = squad.state.get("s1").get("队").members.get("实现-A");
	member.transcript = [
		{ role: "assistant", step: 1, text: "先看一眼", calls: [{ id: "c1", name: "read" }], at: 1 },
		{ role: "tool", step: 1, name: "read", callId: "c1", text: "文件内容", isError: false, at: 2 },
		{ role: "assistant", step: 2, text: "x".repeat(5000), calls: [], at: 3 },
	];

	const url = (q) => `${SQUAD_ROUTE_PREFIX}/transcript?${q}`;
	const ok = await request(handler, "GET", url("owner=s1&squad=队&member=实现-A"));
	assert.equal(ok.status, 200);
	assert.equal(ok.body.member.label, "实现-A");
	assert.equal(ok.body.member.task, "改代码");
	assert.equal(ok.body.member.running, false, "running 要压成布尔（AbortController 不能进 JSON）");
	assert.equal(ok.body.entries.length, 3);
	assert.equal(ok.body.entries[0].calls[0].name, "read");
	assert.equal(ok.body.entries[1].isError, false);
	assert.ok(ok.body.entries[2].text.length < 5000, "太长的正文要截断（别把响应撑爆）");
	assert.match(ok.body.entries[2].text, /…$/);

	// 定位靠三件套：缺一个就 404（小队名只在所有者的表里唯一）
	assert.equal((await request(handler, "GET", url("owner=s1&squad=队&member=查无此人"))).status, 404);
	assert.equal((await request(handler, "GET", url("owner=别人&squad=队&member=实现-A"))).status, 404, "换个 owner 就找不到 —— 这正是要 owner 的原因");
	assert.equal((await request(handler, "GET", url("owner=s1&squad=不存在&member=实现-A"))).status, 404);
	assert.equal((await request(handler, "GET", url(""))).status, 404);
	// 栅栏对转录一样有效，转录也是只读
	assert.equal((await request(handler, "GET", url("owner=s1&squad=队&member=实现-A"), { remoteAddress: "10.1.2.3" })).status, 403);
	assert.equal((await request(handler, "POST", url("owner=s1&squad=队&member=实现-A"))).status, 404);
	squad.dispose();
});

await checkAsync("路由：信任栅栏 —— 非回环 / 跨站 / 异源 / 坏 Host 一律 403", async () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	const handler = record.routes[0].handler;
	newSquad(squad.state, "s1", { name: "队", objective: "o" });
	const url = `${SQUAD_ROUTE_PREFIX}/squads`;

	assert.equal((await request(handler, "GET", url)).status, 200, "本机同源要放行");
	assert.equal((await request(handler, "GET", url, { remoteAddress: "::1" })).status, 200, "IPv6 回环也要放行");
	assert.equal((await request(handler, "GET", url, { remoteAddress: "::ffff:127.0.0.1" })).status, 200, "映射过的回环也要放行");
	assert.equal((await request(handler, "GET", url, { host: "127.0.0.1:3080" })).status, 200);

	assert.equal((await request(handler, "GET", url, { remoteAddress: "10.1.2.3" })).status, 403, "非回环 socket");
	assert.equal((await request(handler, "GET", url, { host: "evil.com" })).status, 403, "DNS rebinding：Host 不是回环");
	assert.equal((await request(handler, "GET", url, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "跨站发起");
	assert.equal((await request(handler, "GET", url, { headers: { origin: "http://evil.com" } })).status, 403, "异源 Origin");
	assert.equal(
		(await request(handler, "GET", url, { headers: { origin: "http://localhost:3080" } })).status,
		200,
		"同源 Origin（浏览器发的就是这个）要放行",
	);
	assert.equal((await request(handler, "GET", url, { host: "" })).status, 403, "Host 缺失");
	// 栅栏在最前面：被拒的请求不该泄露「有几条队」
	const denied = await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/options`, { remoteAddress: "10.1.2.3" });
	assert.equal(denied.body.squads, undefined);
	squad.dispose();
});

// 真 socket：上面两段是手搓 req/res，测的是 handler 自己；这一段测的是**面板真走的那条路** ——
// 路由挂没挂上、宿主的 prefix 匹配对不对、真 header（sec-fetch-site / Origin）判得对不对。
// 手搓的 req 绕不过这三件事：`kind` 写错、`path` 少一个斜杠，production 里都是 404。
await checkAsync("真 HTTP：路由挂得上、prefix 匹配对、GET 200 / 写方法 404 / 跨站 403", async () => {
	const http = await import("node:http");
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS, boardLimit: 77 } });
	newSquad(squad.state, "s1", { name: "队", objective: "目标" });
	const route = record.routes[0];
	assert.equal(route.kind, "prefix");
	// 照抄宿主的 match()（dsh-host-webserver/lib/index.js:323）：等值，或 prefix + "/" 开头。
	// 抄错的话这段自检就变成自说自话，所以连语义一起断言。
	const server = http.createServer((req, res) => {
		const pathname = new URL(req.url, "http://x").pathname;
		if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route.handler(req, res);
		res.writeHead(404);
		res.end("fallback");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const raw = (method, path, headers = {}, body) =>
		new Promise((resolve, reject) => {
			const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
				let text = "";
				res.on("data", (c) => {
					text += c;
				});
				res.on("end", () => resolve({ status: res.statusCode, text }));
			});
			r.on("error", reject);
			// 声明了 content-length 就必须真发 body —— 否则连接被喂脏，下一个请求会被
			// node 判成 400（这个桩自己踩过：`{"content-length": 2}` 配空 body）。
			r.end(body);
		});
	try {
		const ok = await raw("GET", `${SQUAD_ROUTE_PREFIX}/squads`);
		assert.equal(ok.status, 200, "本机同源要能取到数据（面板靠这个）");
		const body = JSON.parse(ok.text);
		assert.equal(body.count, 1);
		assert.equal(body.squads[0].name, "队");
		assert.equal(body.me, undefined, "没有 me：路由拿不到调用者身份");
		assert.equal(JSON.parse((await raw("GET", `${SQUAD_ROUTE_PREFIX}/options`)).text).boardLimit, 77);
		assert.equal((await raw("POST", `${SQUAD_ROUTE_PREFIX}/squads`, { "content-type": "application/json" }, "{}")).status, 404, "写方法 404：面板改不了任何东西");
		assert.equal((await raw("GET", `${SQUAD_ROUTE_PREFIX}`)).status, 404, "prefix 本身没有路由");
		assert.equal(
			(await raw("GET", `${SQUAD_ROUTE_PREFIX}/squads`, { "sec-fetch-site": "cross-site" })).status,
			403,
			"跨站要拒（真 header）",
		);
		assert.equal(
			(await raw("GET", `${SQUAD_ROUTE_PREFIX}/squads`, { origin: "http://evil.example" })).status,
			403,
			"异源 Origin 要拒（真 header）",
		);
		assert.equal((await raw("GET", `${SQUAD_ROUTE_PREFIX}/squads`, { host: "evil.example" })).status, 403, "坏 Host 要拒");
	} finally {
		await new Promise((r) => server.close(r));
		squad.dispose();
	}
});

// ── 8. 客户端面板 ──────────────────────────────────────────────────────────

const clientExport = JSON.parse(fs.readFileSync(new URL("package.json", ROOT), "utf8")).exports["./client"];
const clientSource = fs.readFileSync(new URL(clientExport, ROOT), "utf8");

/**
 * 一个够用的 React 替身：`useState` 真的存状态并触发重渲染，`useEffect` 真的跑
 * （否则探活与轮询都不发生），`createElement` 返回可遍历的对象树。
 * 这样第 7 段才能**断言渲染出来的东西**，而不是只看注册了几个槽位。
 *
 * `deps` 必须真的比较 —— 这是 React 的语义，不是可选的优化：
 * 面板是 `useEffect(refresh, [refresh])` + `useCallback(fn, [])`，
 * 替身若不 memo，每次渲染都会得到新的 `refresh`，effect 就重跑，
 * 于是 `refresh → setData → 重渲染 → refresh …` 无限循环（实测把 node 跑成 OOM）。
 * 那是替身不忠实，不是面板的问题。
 */
function createReact() {
	const hooks = [];
	let cursor = 0;
	let rerender = null;

	const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

	const React = {
		createElement(type, props, ...children) {
			return { type, props: { ...props, children: children.length <= 1 ? children[0] : children } };
		},
		useState(initial) {
			const index = cursor++;
			if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
			const set = (next) => {
				hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
				if (rerender !== null) rerender();
			};
			return [hooks[index], set];
		},
		useCallback(fn, deps) {
			const index = cursor++;
			const prev = hooks[index];
			if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.fn;
			hooks[index] = { deps, fn };
			return fn;
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const prev = hooks[index];
			if (prev === undefined || !sameDeps(prev.deps, deps)) {
				if (typeof prev?.cleanup === "function") prev.cleanup();
				hooks[index] = { deps, cleanup: fn() };
			}
		},
	};

	return {
		React,
		/** 重渲染（React 不会因此重跑 deps 没变的 effect） */
		render(Component) {
			const render = () => {
				cursor = 0;
				return Component();
			};
			rerender = render;
			return render();
		},
		/** 卸载：跑掉所有 effect 的 cleanup。幂等（React 只卸载一次，重复调不该再清一遍） */
		cleanup() {
			for (let index = 0; index < hooks.length; index += 1) {
				const slot = hooks[index];
				if (typeof slot?.cleanup === "function") {
					slot.cleanup();
					hooks[index] = { deps: slot.deps, cleanup: undefined };
				}
			}
		},
	};
}

/**
 * 真加载客户端文件。它是 dsh 的 **classic script**（不是 ESM）：文件体自己调
 * `window.__ModuleLoader__.load({ id, factory })`。所以这里只能 `new Function("window", src)`
 * 跑一遍 —— 这不是「动态执行用户输入」，源码是仓库里自己的文件（和
 * `selftest-scheduler.mjs` 里那段同样的做法），目的正是别让面板只被注册、从没被渲染过。
 */
function loadClient(React) {
	let captured;
	const window = {
		__ModuleLoader__: {
			load(definition) {
				captured = definition;
			},
		},
	};
	new Function("window", clientSource)(window);
	assert.ok(captured !== undefined, "客户端文件没有调 window.__ModuleLoader__.load");
	const required = [];
	const require = (name) => {
		required.push(name);
		if (name === "react") return React;
		throw new Error(`客户端不该 require baseline 之外的包：${name}`);
	};
	return { definition: captured, exports: captured.factory(require), required };
}

function fakeClientCtx() {
	const record = { injects: [], registrations: [] };
	const ctx = {
		effect(fn) {
			const dispose = fn();
			return () => {
				if (typeof dispose === "function") dispose();
			};
		},
		slots: {
			inject(name, callback) {
				record.injects.push(name);
				return callback();
			},
			register(options, component) {
				record.registrations.push({ options, component });
				return () => {};
			},
		},
	};
	return { ctx, record };
}

const settle = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const reply = (status, payload) => async () => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => JSON.stringify(payload),
});

/**
 * 面板里有 `setInterval` 5 秒轮询。测试里换成假的：真定时器会让 node 一直活着
 * （进程不退出），而且换掉之后能顺手断言「确实安排了轮询、卸载时确实清干净了」。
 */
async function withFakeTimers(fn) {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	const created = [];
	const cleared = [];
	globalThis.setInterval = (callback, ms) => {
		const id = { callback, ms };
		created.push(id);
		return id;
	};
	globalThis.clearInterval = (id) => {
		cleared.push(id);
	};
	try {
		return await fn({ created, cleared });
	} finally {
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
}

/** 遍历 createElement 树，收集所有节点 / 所有文本 / 找按钮 */
function walk(node, visit) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node === "object" && node.type !== undefined) {
		visit(node);
		walk(node.props?.children, visit);
	}
}
/**
 * 树上所有文字（**任意深度**）。
 * 只收「children 直接是字符串」会漏掉 `h("div", null, h("span",…), "正文")` 这种
 * 数组子节点 —— 面板里的转录行正是这个形状。
 */
const textsOf = (node) => {
	const out = [];
	const visit = (n) => {
		if (typeof n === "string") {
			out.push(n);
			return;
		}
		if (n === null || n === undefined || typeof n !== "object") return;
		if (Array.isArray(n)) {
			for (const child of n) visit(child);
			return;
		}
		visit(n.props?.children);
	};
	visit(node);
	return out;
};
const findButtons = (tree, label) => {
	const out = [];
	walk(tree, (n) => {
		if (n.type === "button" && n.props?.children === label) out.push(n);
	});
	return out;
};

const SQUAD_FIXTURE = {
	ok: true,
	count: 1,
	squads: [
		{
			name: "登录改造",
			objective: "把登录改成 OAuth",
			note: null,
			owner: "main-1",
			closed: null,
			members: [
				{ label: "实现-A", role: "实现", task: "改代码", status: "在跑", note: "已改完一半", worktree: "/tmp/wt-a", running: true, events: 3, updatedAt: 1 },
				{ label: "调研-B", role: "调研", task: "查上游", status: "完成", note: null, worktree: "/tmp/wt-b", running: false, events: 0, updatedAt: 2 },
			],
			board: [{ at: 1_700_000_000_000, from: "实现-A", text: "登录页改完了" }],
		},
	],
};

check("客户端模块：契约与「只 require baseline」", () => {
	const rt = createReact();
	const { definition, exports, required } = loadClient(rt.React);
	assert.equal(definition.id, "dsh-team-workflow");
	assert.equal(typeof exports.apply, "function");
	assert.deepEqual(exports.inject, ["slots"]);
	assert.deepEqual(required, ["react"], `只该 require react，实际 require 了 ${required.join(", ")}`);
	assert.equal(typeof exports.SquadPage, "function", "小队页要导出来，测试才能直接渲染");
});

await checkAsync("客户端面板：小队探活 404 → 只有小队面板不挂（定时任务面板照常）", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	await withFetch(
		async (url) => (url.startsWith(SQUAD_ROUTE_PREFIX) ? reply(404, { ok: false })() : reply(200, { ok: true, workspaces: [] })()),
		async () => {
			exports.apply(ctx);
			await settle();
		},
	);
	rt.cleanup();
	const squadEntries = record.registrations.filter((r) => (r.options.id ?? r.options.key) === "team-squad");
	assert.deepEqual(squadEntries, [], "小队关着的时候不该挂小队面板");
	assert.ok(
		record.registrations.some((r) => (r.options.id ?? r.options.key) === "team-scheduler"),
		"两个面板各自探活：调度器那条 200，它必须照常挂上",
	);
});

await checkAsync("客户端面板：探活 200 → 侧栏入口 + 主面板，且 id 与 key 自洽", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	await withFetch(reply(200, { ok: true, boardLimit: 500 }), async () => {
		exports.apply(ctx);
		await settle();
	});
	rt.cleanup();

	const entry = record.registrations.find((r) => r.options.name === "sidebar.panellist" && r.options.id === "team-squad");
	const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
	assert.ok(entry !== undefined, "缺侧栏入口");
	assert.ok(page !== undefined, "缺主面板");
	assert.equal(entry.options.label, "小队", "label 用纯字符串，免得依赖 locale 注册");
	assert.equal(typeof entry.options.order, "number", "order 决定侧栏里的位置");
	assert.equal(typeof entry.component, "function");
	assert.equal(typeof page.component, "function");
});

await checkAsync("客户端面板：真渲染 —— 成员、任务、状态、worktree、黑板都在", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	// 注意：渲染必须也在 withFetch 里面 —— 面板是在 render 时发请求的，
	// 出了这个作用域 fetch 就换回真的了，页面会走「连不上宿主」的错误分支。
	const fresh = await withFetch(
		async (url) => (url.endsWith("/squads") ? reply(200, SQUAD_FIXTURE)() : reply(200, { ok: true, boardLimit: 500 })()),
		async () => {
			exports.apply(ctx);
			await settle();
			const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
			return withFakeTimers(async (timers) => {
				rt.render(page.component);
				await settle();
				// 状态更新会触发重渲染，重渲染后的树在同一个 hook 存储上
				const tree = rt.render(page.component);
				rt.cleanup();
				assert.ok(timers.created.length >= 1, "面板要安排轮询（成员随时会往黑板写）");
				assert.equal(timers.cleared.length, timers.created.length, "卸载时必须把轮询清掉，否则每开一次面板漏一个常驻定时器");
				return tree;
			});
		},
	);

	const texts = textsOf(fresh).join(" | ");
	assert.match(texts, /登录改造/, "队名");
	assert.match(texts, /把登录改成 OAuth/, "目标");
	assert.match(texts, /实现-A/, "成员名");
	assert.match(texts, /改代码/, "成员的任务");
	assert.match(texts, /在跑/, "成员状态");
	assert.match(texts, /已改完一半/, "成员的结论");
	assert.match(texts, /\/tmp\/wt-a/, "worktree 绝对路径（派活时最要紧的那条信息）");
	assert.match(texts, /登录页改完了/, "黑板内容");
	assert.match(texts, /实现-A/, "黑板要署名");
	assert.match(texts, /转录 3 条/, "成员那一行要给出转录条数（正文按需拉，不进 5 秒轮询）");
	assert.ok(fresh !== null, "渲染不该返回空");
});

await checkAsync("客户端面板：「看转录」走只读路由，渲染出成员干了什么（成员不是 dsh 会话，没有 openSession）", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	const asked = [];
	const TRANSCRIPT = {
		ok: true,
		owner: "main-1",
		squad: "登录改造",
		member: { label: "实现-A", role: "实现", task: "改代码", status: "完成", note: "收工（2 步，in 20 / out 10）", worktree: "/tmp/wt-a", running: false },
		entries: [
			{ at: 1, role: "assistant", step: 1, name: null, isError: false, calls: [{ id: "c1", name: "read" }], text: "先看一眼" },
			{ at: 2, role: "tool", step: 1, name: "read", isError: false, calls: [], text: "文件内容" },
			{ at: 3, role: "assistant", step: 2, name: null, isError: false, calls: [], text: "干完了" },
		],
	};
	const tree = await withFetch(
		async (url) => {
			asked.push(url);
			if (url.endsWith("/squads")) return reply(200, SQUAD_FIXTURE)();
			if (url.includes("/transcript?")) return reply(200, TRANSCRIPT)();
			return reply(200, { ok: true, boardLimit: 500 })();
		},
		async () => {
			exports.apply(ctx);
			await settle();
			const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
			return withFakeTimers(async () => {
				rt.render(page.component);
				await settle();
				rt.render(page.component);
				const buttons = findButtons(rt.render(page.component), "看转录");
				assert.equal(buttons.length, 2, "每个成员一个按钮");
				buttons[0].props.onClick();
				await settle();
				const rendered = rt.render(page.component);
				rt.cleanup();
				return rendered;
			});
		},
	);

	// 三件套（owner + 队名 + 成员名）一个都不能少 —— 小队名只在所有者的表里唯一
	const call = asked.find((url) => url.includes("/transcript?"));
	assert.ok(call !== undefined, "点按钮要真去拉转录");
	assert.match(call, /owner=main-1/);
	assert.match(call, new RegExp(`squad=${encodeURIComponent("登录改造")}`));
	assert.match(call, /member=%E5%AE%9E%E7%8E%B0-A/, "成员名要编码（中文）");

	const texts = textsOf(tree).join(" | ");
	assert.match(texts, /先看一眼/, "转录正文要渲染出来");
	assert.match(texts, /文件内容/, "工具结果也要");
	assert.match(texts, /read/, "工具名要标出来");
	assert.match(texts, /第 2 步/, "哪一步也要标出来");
	assert.match(texts, /收工（2 步/, "成员循环自己的结论");
	assert.match(texts, /转录 3 条/, "列表里先给条数（正文按需拉）");
});

await checkAsync("客户端面板：空数据 → 给下一步提示，而不是一片空白", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	const tree = await withFetch(
		async (url) => (url.endsWith("/squads") ? reply(200, { ok: true, count: 0, squads: [] })() : reply(200, { ok: true, boardLimit: 500 })()),
		async () => {
			exports.apply(ctx);
			await settle();
			const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
			return withFakeTimers(async () => {
				rt.render(page.component);
				await settle();
				const rendered = rt.render(page.component);
				rt.cleanup();
				return rendered;
			});
		},
	);
	const texts = textsOf(tree).join(" | ");
	assert.match(texts, /0 个/, "空就是空，别装作有");
	assert.match(texts, /squad_new/, "要告诉用户下一步用什么");
	assert.match(texts, /squad_spawn/, "派成员的工具名要对（squad_add 已经没有了）");
	assert.match(texts, /不落盘/, "顺手说清寿命：只在当前会话");
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

if (failures > 0) {
	console.log(`\n✗ ${failures} 项失败`);
	process.exit(1);
}
console.log("✓ 自检通过：名册与黑板 / 权限三种视角 / 快照 / 6 个工具真跑（返回值过 schema）/ 装配与会话清理 / HTTP 路由与信任栅栏负例 / 真 socket 端到端（路由挂载 + prefix 匹配）/ 客户端面板真渲染与只读转录");
