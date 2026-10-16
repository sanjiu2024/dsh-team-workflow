#!/usr/bin/env node
/**
 * 自检：小队（REQ-009 / REQ-011）。
 *
 * 九段（第 9 段是 REQ-015 的用量 / 落盘捡回 / 续聊 / 直投 / 重试 / 超时）：
 *   1. 名册与黑板（纯函数：建队 / 加人 / 改行 / 写黑板 / 收队 / 裁剪）
 *   2. 权限（authorize：只有所有者进得来 —— 成员不是 dsh agent，没有工具可调）
 *   3. 快照（snapshot 只给自己的队；snapshotAll 给全部）
 *   4. 全部小队工具**真跑**一遍（假 ctx + 真 execute），返回值逐条过 output.schema
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

/**
 * 工具数写死在这里（**不**从模块里算）：从模块算出来就成了同义反复，加了工具测试照样绿。
 * REQ-015 起小队工具 8 个（多了 squad_send / squad_say）、成员工具 12 个；
 * REQ-016 块 2 起小队工具 10 个（多了 squad_stop / squad_review）、成员工具 14 个（多了 wait / check）
 * （多了 say / web_search / web_fetch / worktree_new / worktree_list）。
 */
const SQUAD_TOOL_COUNT = 10;
const MEMBER_TOOL_COUNT = 14;

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
	formatDuration,
	markAcceptance,
	normalizeAcceptance,
	renderSnapshot,
	roleModel,
	updateMember,
	usageLine,
} = await import(new URL("lib/squad.js", ROOT).href);
const { flattenSquadConfig } = await import(new URL("lib/squad-config.js", ROOT).href);
const { formatReport, parseReport } = await import(new URL("lib/squad-report.js", ROOT).href);
const { readJsonConfig } = await import(new URL("lib/util.js", ROOT).href);
const { fileURLToPath } = await import("node:url");
const {
	LOCK_STALE_MS,
	PERSIST_TRANSCRIPT_LIMIT,
	PERSIST_TRANSCRIPT_TEXT_MAX,
	SQUAD_STORE_KNOWN,
	SQUAD_STORE_VERSION,
	compactSquad,
	compactTranscript,
	createSquadStore,
	lockIsStale,
	processAlive,
	reviveSquad,
	safeMemberFileName,
	workspaceKey,
} = await import(new URL("lib/squad-store.js", ROOT).href);

// REQ-011：成员不是子 agent —— 循环在 lib/squad-loop.js、工具在 lib/squad-tools.js，
// 两个都是纯函数/注入依赖，所以能直接单测（不用起 dsh）。
const { LOOP_DEFAULTS, parseToolArguments, runMemberLoop, trimMessages, userMessage } = await import(new URL("lib/squad-loop.js", ROOT).href);
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
	// REQ-016 A3 起多了「排队」：并发满了的名册行先建好、不跑，有人收工自动补位
	// REQ-016 A3/A6 起多了「排队」与「等待」：都是**进程内**状态，重启后都判「卡住」
	assert.deepEqual(MEMBER_STATUS, ["在跑", "排队", "等待", "完成", "卡住"], "状态词表是面板与工具的共同契约（没有「待派」——建行即开跑）");

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
	const call = async (name, args, caller, cwd) => {
		const tool = tools[name];
		assert.ok(tool !== undefined, `工具 ${name} 没注册`);
		// cwd 可选：模板里相对路径要按小队 cwd 解析，不给就是 undefined（与旧行为一致）
		const value = await tool.execute(args, { agent: { id: caller, session: { header: { cwd } } } });
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
	assert.equal(record.tools.length, SQUAD_TOOL_COUNT);
	assert.deepEqual(
		record.tools.map((t) => t.name).sort(),
		["squad_board", "squad_close", "squad_new", "squad_review", "squad_say", "squad_send", "squad_spawn", "squad_status", "squad_stop", "squad_update"],
	);

	assert.match(await call("squad_new", { name: "登录改造", objective: "把登录改成 OAuth" }, "main-1"), /已建小队「登录改造」/);
	const spawned = await call("squad_spawn", { squad: "登录改造", member: "实现-A", role: "实现", task: "改代码", worktree: wt }, "main-1");
	assert.match(spawned, /已派「实现-A」/);
	assert.match(spawned, /new-api\/tier-std/, "要告诉所有者它跑在哪一档");

	const one = squad.state.get("main-1").get("登录改造");
	const member = one.members.get("实现-A");
	assert.equal(member.running !== undefined, true, "派完当场就在跑（后台，不 await）");
	// 等它把 kit 加载完并发出第一个请求。**别去掉这个 tick**：加载器多一层 await
	// （共享的 lib/dsh-exports.js）就会让「spawn 一返回就有请求」这个假设失效 ——
	// 2026-10-09 就这么红过一次，那是测试太脆，不是产品错。
	await tick();
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

check("成员工具·工具表：14 个、schema 合法（描述/必填齐），护栏值都是正数", () => {
	assert.deepEqual(
		MEMBER_TOOLS.map((t) => t.name),
		["read", "write", "edit", "grep", "glob", "bash", "board", "wait", "check", "say", "web_search", "web_fetch", "worktree_new", "worktree_list"],
	);
	for (const t of MEMBER_TOOLS) {
		assert.equal(typeof t.description, "string");
		assert.ok(t.description.length > 10, `${t.name} 的描述太短 —— 模型就靠它选工具`);
		assert.equal(t.parameters.type, "object");
		assert.equal(t.parameters.additionalProperties, false);
		assert.ok(Array.isArray(t.parameters.required), `${t.name} 的 required 得是数组`);
		// 有参数的工具有必填项才算写全；**没有参数**的工具（如 worktree_list）允许 required 为空
		const props = Object.keys(t.parameters.properties ?? {});
		assert.ok(props.length === 0 || t.parameters.required.length > 0, `${t.name} 有参数却一个必填都没写？`);
		for (const key of t.parameters.required) {
			assert.ok(t.parameters.properties[key] !== undefined, `${t.name}.${key} 标了必填却没定义`);
		}
		assert.equal(typeof t.run, "function");
	}
	for (const [key, value] of Object.entries(TOOL_LIMITS)) assert.ok(value > 0, `${key} 要是正数`);

	// bash 开关：关掉之后成员的工具表里**不能**再有 bash（那是唯一等于宿主权限的工具）
	const noBash = memberToolsFor({ bash: false });
	assert.deepEqual(noBash.tools.map((t) => t.name), ["read", "write", "edit", "grep", "glob", "board", "wait", "check", "say", "web_search", "web_fetch", "worktree_new", "worktree_list"]);
	assert.equal(noBash.schemas.some((t) => t.name === "bash"), false);
	assert.equal(noBash.schemas.some((t) => "run" in t), false, "线上字段里不能有 run");
	assert.equal(memberToolsFor().schemas.length, MEMBER_TOOL_COUNT, "默认就是全部 14 个");

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
	// REQ-016 E1：文件升了 v2（分组），先归一再看 —— 意图不变（文件与 schema 必须对齐）
	const flat = flattenSquadConfig(json, () => {});
	const keys = Object.keys(flat).filter((key) => !key.startsWith("_"));
	assert.deepEqual(keys.sort(), Object.keys(SQUAD_FIELDS).sort(), "配置文件的键与 SQUAD_FIELDS 要对齐（加了键就得两处一起加）");
	for (const key of keys) {
		assert.equal(typeof SQUAD_FIELDS[key], "function", `${key} 没有校验器`);
		assert.notEqual(SQUAD_FIELDS[key](flat[key]), undefined, `${key} 的现值被自己的校验器拒了：${JSON.stringify(flat[key])}`);
		// roles 是**分工**、templates 是**分工模板**：出厂文件里给了真表，而 SQUAD_DEFAULTS 故意是空表 —— 不比这两项
		if (key === "roles" || key === "templates") continue;
		assert.deepEqual(SQUAD_DEFAULTS[key], flat[key], `${key} 的出厂值与 SQUAD_DEFAULTS 不一致`);
	}
	// 越界的值要拒（免得「能写进 JSON 就能生效」）
	assert.equal(SQUAD_FIELDS.maxSteps(0), undefined);
	assert.equal(SQUAD_FIELDS.maxSteps(201), undefined);
	assert.equal(SQUAD_FIELDS.enabled("true"), undefined);
	assert.equal(SQUAD_FIELDS.provider("   "), undefined);
});

check("装配：webServer 缺失 → 面板不挂，但工具照常（headless 也要能用）", () => {
	const { ctx, record } = fakeCtx({ services: ["tools"] });
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	assert.equal(squad.enabled, true);
	assert.equal(record.tools.length, SQUAD_TOOL_COUNT, "没有 webServer 不该连累工具");
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
	assert.match(squad.describe(), new RegExp(`${SQUAD_TOOL_COUNT} 个工具`));
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
	assert.equal(names.length, MEMBER_TOOL_COUNT - 1, "关掉 bash 之后少一个");
	assert.match(seen[0].system, new RegExp(`工具就 ${MEMBER_TOOL_COUNT - 1} 个`), "提示词里的工具数要跟着变");
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

		// B3：SSE 走**真 socket** —— 假 res 只能证明 handler 会调 write，证不了
		// 「宿主的 webServer 真允许一条长连接流」（缓冲、超时、prefix 路由都可能是坑）。
		const sse = await new Promise((resolve, reject) => {
			const r = http.request({ host: "127.0.0.1", port, method: "GET", path: `${SQUAD_ROUTE_PREFIX}/events` }, (res) => {
				let text = "";
				res.on("data", (chunk) => {
					text += chunk;
					// 第一帧到手就够：证明头是 SSE、快照真推出来了
					if (text.includes("\n\n")) {
						res.destroy();
						resolve({ status: res.statusCode, headers: res.headers, text });
					}
				});
				res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, text }));
			});
			r.on("error", reject);
			r.end();
		});
		assert.equal(sse.status, 200, "SSE 要真能连上");
		assert.match(sse.headers["content-type"], /text\/event-stream/, "真 header 也得是 SSE");
		assert.match(sse.text, /^event: squads\ndata: /, "开场就要有第一帧");
		assert.equal(JSON.parse(sse.text.split("data: ")[1].split("\n")[0]).squads[0].name, "队");
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
		useRef(initial) {
			// 真 React 里 useRef 的对象跨渲染保持同一个 —— 替身也得这样（不然节流状态每帧清零）
			const index = cursor++;
			if (!(index in hooks)) hooks[index] = { current: initial };
			return hooks[index];
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
	assert.match(texts, /落盘/, "顺手说清寿命：落盘 + 重启后同 cwd 捡回");
});


// ── REQ-015：用量 / 落盘 / 续聊 / 直投 / 重试 / 超时 ──────────────────────────

/** 超时用例复用上面已有的 `hangingStream`（它听 signal，abort 就 reject —— 跟真 provider 一样）。 */

check("REQ-015·耗时格式化：0/秒/分/时/天的边界", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(-5), "0s");
	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(90_000), "1m30s");
	assert.equal(formatDuration(3_600_000), "1h00m");
	assert.equal(formatDuration(90_000_000), "1d01h");
});

check("REQ-015·落盘纯函数：workspaceKey 稳定且区分路径、转录裁剪、revive 补回运行时字段", () => {
	assert.equal(workspaceKey("/a/b/c"), workspaceKey("/a/b/c"), "同一个 cwd 必须同一个键");
	assert.notEqual(workspaceKey("/a/b/c"), workspaceKey("/a/b/d"), "不同 cwd 不能撞");
	assert.notEqual(workspaceKey("/a/b"), workspaceKey("/a-b"), "净化后同名也要靠 hash 区分");
	assert.equal(workspaceKey(""), "unknown");
	assert.equal(workspaceKey(undefined), "unknown");

	const long = Array.from({ length: 150 }, (_, i) => ({ role: "assistant", text: "x".repeat(2000), step: i }));
	const compacted = compactTranscript(long);
	assert.equal(compacted.length, PERSIST_TRANSCRIPT_LIMIT, `落盘只留 ${PERSIST_TRANSCRIPT_LIMIT} 条`);
	assert.equal(compacted[0].step, 50, "留的是**最后** 100 条");
	assert.ok(compacted[0].text.length <= PERSIST_TRANSCRIPT_TEXT_MAX + 20, "单条正文要压到 1000 字符级");

	const revived = reviveSquad({
		name: "n",
		members: [{ label: "A", transcript: [{ role: "assistant", text: "t" }], usage: { inputTokens: 3 }, attempts: 2, durationMs: 500 }],
		board: [{ at: 1, from: "x", text: "y" }],
	});
	assert.ok(revived.members instanceof Map, "members 要变回 Map");
	assert.deepEqual(revived.members.get("A").inbox, [], "运行时字段给回默认值");
	assert.equal(revived.members.get("A").running, undefined);
	assert.equal(revived.members.get("A").usage.inputTokens, 3);
	assert.equal(revived.members.get("A").attempts, 2);
	assert.equal(revived.board.length, 1);
});

await checkAsync("REQ-015·用量：结构化 usage + attempts + durationMs，小队合计 = 各成员之和", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-usage-"));
	const { squad, call, settle } = install({ stream: scriptedStream([{ text: "干完了" }]), config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "t", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("A");
	assert.equal(member.usage.inputTokens, 10, "假流的 usage 要落进成员");
	assert.equal(member.usage.outputTokens, 5);
	assert.equal(member.attempts, 1);
	assert.equal(typeof member.durationMs, "number");
	assert.ok(member.durationMs >= 0);

	const snap = snapshotAll(squad.state).squads[0];
	assert.equal(snap.members[0].usage.inputTokens, 10, "快照里要有结构化用量（面板要用）");
	assert.equal(snap.members[0].attempts, 1);
	assert.equal(snap.members[0].durationMs >= 0, true);
	assert.equal(snap.usage.inputTokens, 10, "小队合计 = 各成员之和");
	assert.equal(snap.members[0].inbox, 0);
	// 渲染也要带上（工具输出与面板一条数据路径）
	const text = await call("squad_status", {}, "main-1");
	assert.match(text, /in 10/, "状态文本里要能看到用量");
});

await checkAsync("REQ-015·续聊：squad_send 带历史续跑、转录追加不清空、attempts 累加", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-resume-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "第一次做完了" }, { text: "接着也做完了" }], seen),
		config: { persist: false },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "改登录", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("A");
	const before = member.transcript.length;
	assert.ok(before > 0);

	const said = await call("squad_send", { squad: "队", member: "A", text: "再把登出也改了" }, "main-1");
	assert.match(said, /接着干/);
	await settle();

	assert.equal(seen.length, 2, "第二次真的又发了请求");
	const second = JSON.stringify(seen[1].messages);
	assert.match(second, /第一次做完了/, "第二次请求里带着上次的历史（不是从零开始）");
	assert.match(second, /再把登出也改了/, "新要求也在");
	assert.ok(member.transcript.length > before, "续聊是**追加**转录，不是清空");
	assert.equal(member.attempts, 2, "attempts 累加");
	assert.equal(member.usage.inputTokens, 20, "用量也是累加的（两次各 10）");
});

await checkAsync("REQ-015·续聊·重启后：没有历史时用「原任务 + 上次结论」兜底", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-resume2-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "第一次做完" }, { text: "又做完" }], seen),
		config: { persist: false },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "改登录", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("A");
	member.history = undefined;   // 模拟「dsh 重启过，消息历史没了」
	const said = await call("squad_send", { squad: "队", member: "A", text: "接着改" }, "main-1");
	assert.match(said, /兜底/, "要明说走了兜底那条路");
	await settle();
	const second = JSON.stringify(seen[1].messages);
	assert.match(second, /改登录/, "兜底里有原任务");
	assert.match(second, /第一次做完/, "兜底里有上次结论");
});

await checkAsync("REQ-015·直投：不在跑就排队，下次开跑先投给它（并写黑板）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-say-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "第一次做完" }, { text: "又做完" }], seen),
		config: { persist: false },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "改登录", worktree: wt }, "main-1");
	await settle();
	const squadObj = squad.state.get("main-1").get("队");
	const member = squadObj.members.get("A");
	const boardBefore = squadObj.board.length;

	const r = await call("squad_say", { squad: "队", to: "A", text: "记得看黑板上的接口约定" }, "main-1");
	assert.match(r, /待投队列/, "收工的成员只能排队（文案是「排在…待投队列里」）");
	assert.equal(member.inbox.length, 1);
	assert.equal(squadObj.board.length, boardBefore + 1, "直投也要记进黑板（不是悄悄话）");
	assert.ok(member.transcript.some((e) => e.injected === true), "要进目标转录");

	await call("squad_send", { squad: "队", member: "A", text: "继续" }, "main-1");
	await settle();
	const second = JSON.stringify(seen[1].messages);
	assert.match(second, /记得看黑板上的接口约定/, "开跑时先把排队的话投出去");
	assert.match(second, /队里给你的消息/);
	assert.equal(member.inbox.length, 0, "投出去之后队列要空");
});

await checkAsync("REQ-015·直投·在跑：下一步边界注入，且窗口不以 tool 消息开头", async () => {
	const seen = [];
	let drained = false;
	const result = await runMemberLoop({
		kit: { BlockAssembler: FakeAssembler, createToolResultMessage: fakeToolResult },
		stream: scriptedStream([{ text: "先查一下", calls: [{ id: "c1", name: "board", arguments: '{"text":"x"}' }] }, { text: "收工" }], seen),
		provider: "p",
		model: "m",
		system: "s",
		task: "任务",
		tools: [],
		executeTool: async () => ({ text: "ok" }),
		takeInbox: () => {
			if (drained) return [];
			drained = true;
			return [{ role: "user", content: [{ type: "text", text: "插一句话" }] }];
		},
	});
	assert.equal(result.status, "完成");
	const second = seen[1].messages;
	assert.equal(second[0].role, "user", "窗口不能以 tool 结果开头（协议约束）");
	assert.ok(second.some((m) => JSON.stringify(m).includes("插一句话")), "注入的消息要在下一次请求里");
	assert.ok(result.transcript.some((e) => e.injected === true), "注入要有转录事件");
	assert.ok(Array.isArray(result.messages) && result.messages.length > 0, "循环要把它最终的消息数组交出来（续聊靠它）");
});

await checkAsync("REQ-015·重试：基础设施失败重试一次并带上原因；maxSteps 耗尽不重试", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-retry-"));
	const seen = [];
	let round = 0;
	const flaky = (options) => {
		round += 1;
		if (round === 1) throw new Error("provider 挂了");
		return scriptedStream([{ text: "第二次成功了" }], seen)(options);
	};
	const first = install({ stream: flaky, config: { persist: false, retries: 1 } });
	await first.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await first.call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "t", worktree: wt }, "main-1");
	await first.settle();
	const member = first.squad.state.get("main-1").get("队").members.get("A");
	assert.equal(member.status, "完成", `重试之后应该成功，实际：${member.status} / ${member.note}`);
	assert.equal(member.attempts, 2, "失败一次 + 重试一次");
	assert.match(JSON.stringify(seen[0].messages), /上一次因为/, "重试要带上中断原因（不是闷头重来）");

	// maxSteps 耗尽**不**重试（那是模型真在绕圈，重试等于继续烧钱）
	const second = install({
		stream: scriptedStream([{ text: "还在干", calls: [{ id: "c1", name: "board", arguments: '{"text":"x"}' }] }]),
		config: { persist: false, retries: 3, maxSteps: 1 },
	});
	await second.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await second.call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "t", worktree: wt }, "main-1");
	await second.settle();
	const stuck = second.squad.state.get("main-1").get("队").members.get("A");
	assert.equal(stuck.status, "卡住");
	assert.equal(stuck.attempts, 1, "maxSteps 耗尽不重试");
});

await checkAsync("REQ-015·超时：超过墙钟上限就 abort，判卡住并写明是超时", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-timeout-"));
	const { squad, call, settle } = install({
		stream: hangingStream,
		config: { persist: false, memberTimeoutMinutes: 0.001, retries: 0 },   // 60ms
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "t", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("A");
	assert.equal(member.status, "卡住");
	assert.match(member.note, /分钟上限/, `note 要写明超时，实际：${member.note}`);
	assert.equal(member.attempts, 1, "超时不重试（重试只会再等一遍）");
});

await checkAsync("REQ-015·落盘与捡回：dispose 之后换个会话 id、同一个 cwd，能捡回且能写", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "squad-home-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const cwd = "/tmp/squad-ws-demo";
		const first = install({ stream: scriptedStream([{ text: "干完了" }]), config: { persist: true } });
		const exec1 = { agent: { id: "sess-1", session: { header: { cwd } } } };
		await first.tools.squad_new.execute({ name: "队", objective: "把登录改完" }, exec1);
		await first.tools.squad_board.execute({ squad: "队", text: "入口在 src/a.js:42" }, exec1);
		await first.squad.dispose();   // dispose 会 flush，并把写队列的 promise 交出来

		const dir = path.join(home, "team-workflow", "squads");
		assert.ok(fs.existsSync(dir), `落盘目录该被建出来：${dir}`);
		assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1, "一个 cwd 一份文件");

		// 新会话（id 不同）、同一个工作目录
		const second = install({ stream: scriptedStream([{ text: "x" }]), config: { persist: true } });
		const exec2 = { agent: { id: "sess-2", session: { header: { cwd } } } };
		const out = await second.tools.squad_status.execute({}, exec2);
		assert.match(out.text, /队/, "重启后要能看见");
		assert.match(out.text, /入口在 src\/a\.js:42/, "黑板内容也要在");
		const adopted = second.squad.state.get("sess-2").get("队");
		assert.equal(adopted.adoptedFrom, "sess-1", "要记下是从哪个会话接管的");
		const wrote = await second.tools.squad_board.execute({ squad: "队", text: "新会话也能写" }, exec2);
		assert.doesNotMatch(wrote.text, /\[失败\]/, `接管后必须可写，实际：${wrote.text}`);
		second.squad.dispose();
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
});

check("REQ-015·坏文件不炸：quarantine 成 .broken-* 之后从空开始", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "squad-broken-"));
	const store = createSquadStore({ dir: path.join(home, "team-workflow", "squads"), log: () => {} });
	const file = store.fileFor("/tmp/squad-ws-broken");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{ 这不是 JSON");
	assert.deepEqual(store.load("/tmp/squad-ws-broken"), [], "读坏了就当空的，不抛错");
	const kept = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".broken-"));
	assert.equal(kept.length, 1, "坏文件要改名保留（不删）");
	// 版本不认识也一样
	const store2 = createSquadStore({ dir: path.join(home, "team-workflow", "squads2"), log: () => {} });
	const file2 = store2.fileFor("/tmp/squad-ws-ver");
	fs.mkdirSync(path.dirname(file2), { recursive: true });
	fs.writeFileSync(file2, JSON.stringify({ version: 99, squads: [] }));
	assert.deepEqual(store2.load("/tmp/squad-ws-ver"), []);
	assert.equal(fs.readdirSync(path.dirname(file2)).filter((f) => f.includes(".broken-")).length, 1);
});


// ── REQ-015 复审修复（2026-10-16 std 测报回来的 4×P1 + 2×P2，每条都要能变红）────

await checkAsync("复审·P1-1：会话销毁后再开同 cwd 的会话，盘上的队要捡得回来（loadedCwds 不能留着）", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "squad-home2-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const cwd = "/tmp/squad-ws-handover";
		const first = install({ stream: scriptedStream([{ text: "干完了" }]), config: { persist: true } });
		const exec1 = { agent: { id: "sess-1", session: { header: { cwd } } } };
		await first.tools.squad_new.execute({ name: "队", objective: "别丢" }, exec1);
		await first.tools.squad_board.execute({ squad: "队", text: "这条不能在换会话后消失" }, exec1);

		// 真机上的形状：**插件常驻**，一个会话结束、随后同一个 cwd 来了新会话（不重启）。
		// 注意不能先调 `first.squad.dispose()` —— 那是插件拆除，会把状态整个清空，
		// 测的就不是「会话销毁」了（我第一次就是这么写的，第一断言靠「没有小队」里的「队」字假过了）。
		const disposed = first.record.events.find((e) => e.name === "session/disposed");
		assert.ok(disposed, "要挂上 session/disposed");
		disposed.callback({ id: "sess-1" });   // 它会 flush 落盘 + 清状态 + 清 loadedCwds
		assert.equal(first.squad.state.size, 0, "旧会话的状态要清掉");

		const exec2 = { agent: { id: "sess-2", session: { header: { cwd } } } };
		const revived = await (async () => {
			await first.tools.squad_status.execute({}, exec2);
			return first.squad.state.get("sess-2")?.get("队");
		})();
		assert.ok(revived, "同 cwd 的新会话必须捡回盘上的队（loadedCwds 留着就一个都看不到）");
		assert.equal(revived.adoptedFrom, "sess-1");
		assert.equal(revived.board.length, 1, "黑板内容也要在");
		assert.match(revived.board[0].text, /这条不能在换会话后消失/);
		first.squad.dispose();
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
});

await checkAsync("复审·P1-2：收队之后 squad_send 必须拒（收队 = 只读）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-closed-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "做完了" }, { text: "不该跑到这里" }], seen),
		config: { persist: false },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "t", worktree: wt }, "main-1");
	await settle();
	await call("squad_close", { squad: "队", reason: "收工" }, "main-1");
	const member = squad.state.get("main-1").get("队").members.get("A");
	const attemptsBefore = member.attempts;
	const r = await call("squad_send", { squad: "队", member: "A", text: "再改一处" }, "main-1");
	assert.match(r, /\[失败\]/, "收队之后不许再起成员");
	assert.match(r, /收队/, "要说清是因为收队了");
	assert.equal(member.attempts, attemptsBefore, "attempts 不能变（不能偷偷跑起来）");
	assert.equal(seen.length, 1, "也不该再发模型请求");
});

await checkAsync("复审·P1-3：模型报错早退时，悬挂的 tool-call 必须补上结果（否则续聊/重试发回去会被 provider 拒）", async () => {
	const seen = [];
	const stream = (options) => {
		seen.push(options);
		return (async function* chunks() {
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: "block-start", index: 0, blockType: "tool-call" };
			yield { type: "tool-call-delta", index: 0, id: "c9", name: "board", argumentsDelta: '{"text":"x"}' };
			yield { type: "finish", reason: { kind: "error", failure: { message: "上游 500" } } };
		})();
	};
	const result = await runMemberLoop({
		kit: { BlockAssembler: FakeAssembler, createToolResultMessage: fakeToolResult },
		stream,
		provider: "p",
		model: "m",
		system: "s",
		task: "任务",
		tools: [],
		executeTool: async () => ({ text: "不该被调用" }),
	});
	assert.equal(result.status, "卡住");
	// 协议：每个 assistant 里的 tool call 都要有且只有一条结果
	const calls = [];
	const results = [];
	for (const message of result.messages) {
		if (message.role === "assistant") for (const block of message.content ?? []) if (block.type === "tool-call") calls.push(block.id);
		if (message.role === "tool") results.push(message.callId ?? message.toolCallId ?? message.content?.[0]?.callId);
	}
	assert.equal(calls.length, 1, "这一步确实产生了 tool call");
	assert.equal(results.length, calls.length, `悬挂了：calls=${JSON.stringify(calls)} results=${JSON.stringify(results)}`);
	assert.equal(result.messages[result.messages.length - 1].role, "tool", "最后一条必须是那条结果（不能以 assistant(call) 收尾）");
});

check("复审·P1-4：捡回时校验字段（缺 text 的黑板条目、非法的 status）", () => {
	const revived = reviveSquad(
		{
			name: "n",
			board: [{ at: 1, from: "x", text: "好的" }, { at: 2, from: "x" }, { at: 3, text: "没有作者" }, null],
			members: [{ label: "A", status: "在跑" }, { label: "B", status: "编的状态" }],
		},
		{ statuses: MEMBER_STATUS },
	);
	assert.equal(revived.board.length, 1, "缺 text / 缺 from 的条目要丢掉");
	assert.equal(revived.members.get("A").status, "卡住", "「在跑」是进程内的状态，重启后它不可能还在跑");
	assert.equal(revived.members.get("B").status, "卡住", "不认识的状态落「卡住」");
	// 渲染不能炸（std 测实测到 `.replace` 上的 TypeError）
	assert.doesNotThrow(() => renderSnapshot(snapshotAll(new Map([["o", new Map([["n", revived]])]]))));
});

await checkAsync("复审·P2-1：新加的五个成员工具至少各跑一次（负例也要优雅失败，不能抛）", async () => {
	// say：目标不存在 → 失败文本，不抛
	const noTarget = await runMemberTool("say", { to: "没人", text: "喂" }, { say: () => ({ ok: false, detail: "没有这个成员" }) });
	assert.equal(noTarget.isError, true);
	assert.match(noTarget.text, /没有这个成员/);
	// say：成功路径
	const okSay = await runMemberTool("say", { to: "B", text: "看黑板" }, { say: () => ({ ok: true, queued: true }) });
	assert.doesNotMatch(okSay.text ?? "", /\[失败\]/);
	assert.match(okSay.text, /队列/);
	// web_*：宿主没有 web 服务 → 明确说不可用，而不是崩
	const noWeb = { ctx: { get: () => undefined } };
	const ws = await runMemberTool("web_search", { query: "x" }, noWeb);
	assert.equal(ws.isError, true);
	assert.match(ws.text, /web 服务/);
	const wf = await runMemberTool("web_fetch", { url: "https://example.com" }, noWeb);
	assert.equal(wf.isError, true);
	// web_*：有服务时真的调它（用假服务，不联网）
	const fakeWeb = {
		ctx: {
			get: () => ({
				search: async () => ({ provider: "fake", results: [{ title: "T", url: "https://e.com", snippet: "S" }] }),
				fetch: async () => ({ title: "页", content: "正文" }),
			}),
		},
	};
	const searched = await runMemberTool("web_search", { query: "x" }, fakeWeb);
	assert.doesNotMatch(searched.text ?? "", /\[失败\]/);
	assert.match(searched.text, /https:\/\/e\.com/);
	const fetched = await runMemberTool("web_fetch", { url: "https://e.com" }, fakeWeb);
	assert.match(fetched.text, /正文/);
	// worktree_*：在一个不是 git 仓库的临时目录里 → 失败文本（不抛）
	const plain = fs.mkdtempSync(path.join(os.tmpdir(), "squad-nogit-"));
	const badName = await runMemberTool("worktree_new", { name: "a/b/../c" }, { worktree: plain });
	assert.equal(badName.isError, true);
	const listed = await runMemberTool("worktree_list", {}, { worktree: plain });
	assert.equal(listed.isError, true, "不是 git 仓库要优雅失败");
});

await checkAsync("复审·P2-2：durationMs 真的累计（不是恒真的 >=0）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-dur-"));
	// 慢一点的假流：每轮 5ms，好让耗时断言有意义
	const slow = (options) => {
		const inner = scriptedStream([{ text: "第一轮" }, { text: "第二轮" }])(options);
		return (async function* chunks() {
			await new Promise((resolve) => setTimeout(resolve, 5));
			yield* inner;
		})();
	};
	const { squad, call, settle } = install({ stream: slow, config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "t", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("A");
	const first = member.durationMs;
	assert.ok(first >= 5, `一轮至少要记到那次 5ms，实际 ${first}`);
	await call("squad_send", { squad: "队", member: "A", text: "再来一轮" }, "main-1");
	await settle();
	assert.ok(member.durationMs >= first + 5, `续聊之后要累加，实际 ${member.durationMs}（第一轮 ${first}）`);
});


// ── REQ-016 E1：配置升 v2 与自动迁移 ────────────────────────────────────────
// 迁移是**读入时**做的（不写回文件），所以这一段的重点是「v1 形状照常生效」+「坏东西不炸」。

check("配置 v2：分组形状压成一层，值都在", () => {
	const flat = flattenSquadConfig({
		configVersion: 2,
		enabled: true,
		persist: false,
		boardLimit: 100,
		defaults: { provider: "p", model: "m" },
		limits: { maxSteps: 7, retries: 2, memberTimeoutMinutes: 3 },
		sandbox: { bash: false },
		roles: { 审查: "tier-power" },
	});
	assert.deepEqual(flat, {
		enabled: true,
		persist: false,
		boardLimit: 100,
		provider: "p",
		model: "m",
		maxSteps: 7,
		retries: 2,
		memberTimeoutMinutes: 3,
		bash: false,
		roles: { 审查: "tier-power" },
	});
});

check("配置 v1（扁平）照常读，并提示一句「还是 v1 形状」", () => {
	const said = [];
	const flat = flattenSquadConfig({ provider: "old", model: "tier-std", bash: true }, (m) => said.push(m));
	assert.equal(flat.provider, "old");
	assert.equal(flat.bash, true);
	assert.ok(said.some((m) => /v1 形状/.test(m)), `要说清是 v1 形状，实际：${JSON.stringify(said)}`);
});

check("配置：分组优先于同名扁平键；坏分组与未知键要说出来、不炸", () => {
	const said = [];
	const flat = flattenSquadConfig(
		{ model: "扁平", defaults: { model: "分组" }, limits: "不是对象", 乱写: 1, sandbox: { bash: true, 多余: 1 }, _说明: [] },
		(m) => said.push(m),
	);
	assert.equal(flat.model, "分组", "分组更明确，应该赢");
	assert.equal(flat.bash, true);
	assert.ok(said.some((m) => /limits 应该是一个对象/.test(m)), JSON.stringify(said));
	assert.ok(said.some((m) => /乱写 不认识/.test(m)), JSON.stringify(said));
	assert.ok(said.some((m) => /sandbox\.多余 不认识/.test(m)), JSON.stringify(said));
	assert.ok(!said.some((m) => /_说明/.test(m)), "_ 开头的是给人看的说明，不算未知键");
});

check("配置：坏形状（null/字符串/数组/数字）不炸，返回空", () => {
	for (const bad of [null, undefined, "x", 42, [], true]) assert.deepEqual(flattenSquadConfig(bad), {});
});

check("端到端：v1 形状的文件经真实加载路径，值真的生效", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-cfg-"));
	const file = path.join(dir, "squad.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			enabled: true,
			provider: "v1-p",
			model: "v1-m",
			maxSteps: 9,
			bash: false,
			retries: 0,
			memberTimeoutMinutes: 2,
			boardLimit: 11,
			persist: false,
		}),
		"utf8",
	);
	const cfg = readJsonConfig(file, SQUAD_DEFAULTS, SQUAD_FIELDS, () => {}, flattenSquadConfig);
	assert.equal(cfg.provider, "v1-p");
	assert.equal(cfg.model, "v1-m");
	assert.equal(cfg.maxSteps, 9);
	assert.equal(cfg.bash, false);
	assert.equal(cfg.retries, 0);
	assert.deepEqual(cfg.roles, {}, "v1 文件里没有 roles → 默认空表");
});

check("出厂 squad.json 是 v2 形状且能过校验（文件与 schema 不许漂移）", () => {
	const file = fileURLToPath(new URL("../team/extensions/squad.json", import.meta.url));
	const said = [];
	const cfg = readJsonConfig(file, SQUAD_DEFAULTS, SQUAD_FIELDS, (m) => said.push(m), flattenSquadConfig);
	assert.equal(cfg.model, "tier-std");
	assert.equal(cfg.maxSteps, 30);
	assert.equal(cfg.bash, true);
	assert.equal(cfg.retries, 1);
	assert.equal(cfg.memberTimeoutMinutes, 20);
	assert.equal(cfg.roles.审查, "tier-power");
	assert.equal(cfg.roles.侦察, "tier-std");
	assert.deepEqual(said, [], `出厂文件不该有任何提示：${JSON.stringify(said)}`);
});

check("配置：v2 文件里的坏值仍会被字段校验拦下并报出来（归一不绕过校验）", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-cfg2-"));
	const file = path.join(dir, "squad.json");
	fs.writeFileSync(file, JSON.stringify({ configVersion: 2, limits: { maxSteps: "三十" } }), "utf8");
	const said = [];
	const cfg = readJsonConfig(file, SQUAD_DEFAULTS, SQUAD_FIELDS, (m) => said.push(m), flattenSquadConfig);
	assert.equal(cfg.maxSteps, SQUAD_DEFAULTS.maxSteps, "坏值要回落默认");
	assert.ok(said.some((m) => /maxSteps/.test(m)), `要说出来：${JSON.stringify(said)}`);
});

// ── REQ-016 D3：角色 → 档位 ────────────────────────────────────────────────

check("D3 roleModel：归一「型」、去空白、命中不了给 undefined", () => {
	const roles = { 侦察: "tier-std", 审查: "tier-power" };
	assert.equal(roleModel(roles, "审查"), "tier-power");
	assert.equal(roleModel(roles, "审查型"), "tier-power", "尾部「型」要归一");
	assert.equal(roleModel(roles, " 审查 "), "tier-power");
	assert.equal(roleModel(roles, "打杂"), undefined);
	assert.equal(roleModel(undefined, "审查"), undefined);
	assert.equal(roleModel({ 审查: "  " }, "审查"), undefined, "空档位不算命中");
	assert.equal(roleModel({ 审查: 42 }, "审查"), undefined);
});

await checkAsync("D3：spawn 不传 model 时按角色取档，记在成员身上，续聊沿用", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-role-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "审完了" }, { text: "再审一轮" }, { text: "侦察完" }], seen),
		config: { persist: false, roles: { 审查: "tier-power", 侦察: "tier-std" } },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "R", role: "审查型", task: "审", worktree: wt }, "main-1");
	await settle();
	const members = squad.state.get("main-1").get("队").members;
	assert.equal(members.get("R").model, "tier-power", "角色「审查型」要命中 roles 表");
	assert.equal(seen[0].model, "tier-power", `真跑的档位要对：${JSON.stringify(seen[0]?.model)}`);
	// 续聊沿用原来那一档（不是 config.model）—— 否则审查型跑第二轮会悄悄掉档
	await call("squad_send", { squad: "队", member: "R", text: "再改一处" }, "main-1");
	await settle();
	assert.equal(seen[1].model, "tier-power", "续聊不能掉回默认档");
	// 显式 model 优先于角色表
	await call("squad_spawn", { squad: "队", member: "S", role: "侦察", model: "tier-max", task: "t", worktree: wt }, "main-1");
	await settle();
	assert.equal(members.get("S").model, "tier-max", "显式 model 要赢");
	assert.equal(members.get("S").provider, "new-api", "provider 仍取默认");
});

check("D3：档位跟着成员落盘、重启后还在（续聊不掉档）", () => {
	const revived = reviveSquad(
		{ name: "n", members: [{ label: "R", role: "审查", model: "tier-power", provider: "new-api" }] },
		{ statuses: MEMBER_STATUS },
	);
	assert.equal(revived.members.get("R").model, "tier-power");
	assert.equal(revived.members.get("R").provider, "new-api");
	// 老文件（没有这两个字段）读回来是 undefined，不该是怪值
	const old = reviveSquad({ name: "n", members: [{ label: "O", role: "实现" }] }, { statuses: MEMBER_STATUS });
	assert.equal(old.members.get("O").model, undefined);
	// 落盘/读回一整圈
	const compacted = compactSquad({ name: "n", members: new Map([["R", revived.members.get("R")]]) });
	assert.equal(compacted.members[0].model, "tier-power");
});


/** 造一个最小的队（走真 API：createState + newSquad + addMember），给下面几条断言用 */
const makeSquad = ({ members = [] } = {}) => {
	const state = createState();
	const created = newSquad(state, "owner-1", { name: "队", objective: "目标" });
	assert.equal(created.ok, true, created.detail);
	for (const m of members) {
		const added = addMember(state, created.squad, { label: m.label, role: m.role ?? "实现", task: "t", worktree: "/tmp/wt" });
		assert.equal(added.ok, true, added.detail);
	}
	return { state, squad: created.squad };
};

// ── REQ-016 复审修复（2026-10-16 std 测报回来的 1×P1 + 5×P2）──────────────────

check("复审·P2：updateMember 真能改档位（原来这条零断言 —— 拆掉实现自检仍全绿）", () => {
	const { squad } = makeSquad({ members: [{ label: "A", role: "实现" }] });
	const r = updateMember(squad, "A", { model: "tier-max", provider: "new-api" });
	assert.equal(r.ok, true, r.detail);
	assert.equal(squad.members.get("A").model, "tier-max");
	assert.equal(squad.members.get("A").provider, "new-api");
	// modelFromRole 也跟着走
	updateMember(squad, "A", { modelFromRole: true });
	assert.equal(squad.members.get("A").modelFromRole, true);
	updateMember(squad, "A", { modelFromRole: false });
	assert.equal(squad.members.get("A").modelFromRole, false);
});

check("复审·P2：SQUAD_FIELDS.roles 有坏条目就整体拒（借 readJsonConfig 的提示说出来）", () => {
	assert.deepEqual(SQUAD_FIELDS.roles({ 审查: "tier-power" }), { 审查: "tier-power" });
	assert.deepEqual(SQUAD_FIELDS.roles({ " 审查 ": " tier-power " }), { 审查: "tier-power" }, "键值都要去空白");
	assert.equal(SQUAD_FIELDS.roles({ 审查: 42 }), undefined, "坏值整体拒（不能静默清成空表）");
	assert.equal(SQUAD_FIELDS.roles({ "": "x" }), undefined, "空键整体拒");
	assert.deepEqual(SQUAD_FIELDS.roles({}), {}, "空表是合法的（= 都用默认档）");
	assert.equal(SQUAD_FIELDS.roles([]), undefined);
	assert.equal(SQUAD_FIELDS.roles("x"), undefined);
});

check("复审·P2：squadView 带出成员的档位（原来这条零断言）", () => {
	const { squad } = makeSquad({ members: [{ label: "A", role: "审查" }] });
	squad.members.get("A").model = "tier-power";
	const view = snapshotAll(new Map([["o", new Map([[squad.name, squad]])]]));
	assert.equal(view.squads[0].members[0].model, "tier-power");
	squad.members.get("A").model = undefined;
	const view2 = snapshotAll(new Map([["o", new Map([[squad.name, squad]])]]));
	assert.equal(view2.squads[0].members[0].model, null, "没档位就是 null，不是 undefined");
});

check("复审·P2：configVersion 写了不认识的版本，提示不能说「还是 v1 形状」", () => {
	const said = [];
	flattenSquadConfig({ configVersion: 3, defaults: { model: "m" } }, (m) => said.push(m));
	assert.ok(
		said.some((m) => /只认 2/.test(m)),
		`要说清版本不认识：${JSON.stringify(said)}`,
	);
	assert.ok(!said.some((m) => /还是 v1 形状/.test(m)), "v3 不是「没写」，别撒谎");
	const said2 = [];
	flattenSquadConfig({ model: "m" }, (m) => said2.push(m));
	assert.ok(said2.some((m) => /还是 v1 形状/.test(m)), "没写才说 v1 形状");
});

await checkAsync("复审·P1：spawn 重跑时 role 传空白 —— 角色与档位不能自相矛盾", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-p1-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "一审" }, { text: "二审" }], seen),
		config: { persist: false, roles: { 审查: "tier-power" } },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "R", role: "审查", task: "审", worktree: wt }, "main-1");
	await settle();
	assert.equal(seen[0].model, "tier-power");
	// 重跑：role 传空白 → 角色保持「审查」，档位也必须还是 tier-power
	const out = await call("squad_spawn", { squad: "队", member: "R", role: "", task: "再审", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("R");
	assert.equal(member.role, "审查", "空白角色不该改掉原来的角色");
	assert.equal(member.model, "tier-power", `角色与档位不能矛盾（输出：${out}）`);
	assert.equal(seen[1].model, "tier-power");
});

await checkAsync("复审·P1：squad_update 改角色 → 按角色取的档位跟着变；显式指定过的不许被改", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-p1b-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "一" }, { text: "二" }, { text: "三" }], seen),
		config: { persist: false, roles: { 审查: "tier-power", 侦察: "tier-std" } },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	// 按角色取档（modelFromRole = true）
	await call("squad_spawn", { squad: "队", member: "R", role: "审查", task: "审", worktree: wt }, "main-1");
	await settle();
	const members = squad.state.get("main-1").get("队").members;
	assert.equal(members.get("R").model, "tier-power");
	await call("squad_update", { squad: "队", member: "R", role: "侦察" }, "main-1");
	assert.equal(members.get("R").model, "tier-std", "改角色要跟着重算档位（否则「只影响下一次」是空话）");
	// 续聊用新档位
	await call("squad_send", { squad: "队", member: "R", text: "再来" }, "main-1");
	await settle();
	assert.equal(seen[1].model, "tier-std");
	// 显式指定过档位的成员：改角色不许悄悄改掉它
	await call("squad_spawn", { squad: "队", member: "X", role: "审查", model: "tier-max", task: "t", worktree: wt }, "main-1");
	await settle();
	assert.equal(members.get("X").model, "tier-max");
	assert.equal(members.get("X").modelFromRole, false);
	await call("squad_update", { squad: "队", member: "X", role: "侦察" }, "main-1");
	assert.equal(members.get("X").model, "tier-max", "显式指定的档位不许被角色表改掉");
});

await checkAsync("复审·P2：老落盘成员（没有 model）续聊要查角色表，不能掉到默认档", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-p2-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "一" }, { text: "二" }], seen),
		config: { persist: false, roles: { 审查: "tier-power" } },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "R", role: "审查", task: "审", worktree: wt }, "main-1");
	await settle();
	// 模拟 2.0 之前落盘的记录：没有 model/provider
	const member = squad.state.get("main-1").get("队").members.get("R");
	member.model = undefined;
	member.provider = undefined;
	await call("squad_send", { squad: "队", member: "R", text: "接着来" }, "main-1");
	await settle();
	assert.equal(seen[1].model, "tier-power", `老记录也要查角色表，实际 ${seen[1].model}`);
});

check("复审·P2：squadConfig 真把 v2 分组读进来了（漏传归一会被这条逮到）", async () => {
	const { makeLayered, squadConfig } = await import(new URL("lib/index.js", ROOT).href);
	const { ctx } = fakeCtx({ services: [] });
	const layered = makeLayered(ctx);
	// 用一份**值故意不等于默认值**的 v2 文件：否则「读进来了」与「回落默认值」结果一样，
	// 断言就是假的 —— 第一次写这条时就踩了（出厂文件的值恰好都等于默认值，漏传归一照样全绿）。
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-cfg3-"));
	const file = path.join(dir, "squad.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			configVersion: 2,
			enabled: false,
			persist: false,
			boardLimit: 42,
			defaults: { provider: "p-x", model: "m-x" },
			limits: { maxSteps: 7, retries: 4, memberTimeoutMinutes: 3 },
			sandbox: { bash: false },
			roles: { 审查: "tier-max" },
		}),
		"utf8",
	);
	const cfg = squadConfig(layered, undefined, file);
	assert.equal(cfg.provider, "p-x", "v2 的 defaults.provider 要读进来");
	assert.equal(cfg.model, "m-x", "v2 的 defaults.model 要读进来");
	assert.equal(cfg.maxSteps, 7, "v2 的 limits.maxSteps 要读进来");
	assert.equal(cfg.retries, 4);
	assert.equal(cfg.memberTimeoutMinutes, 3);
	assert.equal(cfg.bash, false, "v2 的 sandbox.bash 要读进来");
	assert.equal(cfg.boardLimit, 42);
	assert.equal(cfg.enabled, false);
	assert.equal(cfg.roles.审查, "tier-max");
	// 出厂文件走同一条路（这条只钉「真读了文件」）
	const real = squadConfig(layered, undefined);
	assert.equal(real.maxSteps, SQUAD_DEFAULTS.maxSteps);
	assert.equal(real.roles.审查, "tier-power");
});


// ── REQ-016 块 2：可控性（A1 停止 / A2 预算 / A3 并发 / A4 角色白名单）────────

await checkAsync("A1 squad_stop：只掐那一个成员，同队其他人不受影响，原因留在结论栏", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a1-"));
	// 「挂着别动」那个挂住不返回，「干完」那个正常收工 —— 用任务正文区分
	const stream = (options) =>
		JSON.stringify(options.messages).includes("挂着别动") ? hangingStream(options) : scriptedStream([{ text: "我干完了" }])(options);
	const { squad, call, settle } = install({ stream, config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "挂一", role: "实现", task: "挂着别动一", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "挂二", role: "实现", task: "挂着别动二", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "干", role: "实现", task: "干完它", worktree: wt }, "main-1");
	// ⚠️ 这里**不能**用 `settle()`：它会 await 那两个永远不返回的成员 → 自检当场死锁
	// （我第一次就是这么写的，跑了两分钟没结束）。只等正常的那个。
	const members = squad.state.get("main-1").get("队").members;
	await members.get("干").promise;
	assert.equal(members.get("挂一").status, "在跑", "挂着的那个还在跑");
	assert.equal(members.get("挂二").status, "在跑", "**必须留第二个还在跑的** —— 否则「只掐一个」和「掐整队」在测试里看不出区别（R2 反向实验第一次就是这么漏的）");
	assert.equal(members.get("干").status, "完成", "第三个已经收工");
	const attempts = members.get("挂一").attempts;
	assert.match(await call("squad_stop", { squad: "队", member: "挂一", reason: "跑偏了" }, "main-1"), /已停掉「挂一」/);
	await members.get("挂一").promise;
	assert.equal(members.get("挂一").status, "卡住");
	assert.match(members.get("挂一").note, /跑偏了/, `停它的原因要留住，实际：${members.get("挂一").note}`);
	assert.equal(members.get("挂一").attempts, attempts, "停掉不是重试");
	assert.equal(members.get("挂二").status, "在跑", "同队其他人不受影响（整队掐法会在这里露馅）");
	assert.equal(members.get("干").status, "完成", "已收工的更不该被牵连");
	// 收尾：把第二个也停掉，免得自检挂在它身上
	await call("squad_stop", { squad: "队", member: "挂二", reason: "收尾" }, "main-1");
	await members.get("挂二").promise;
	// 边界：没在跑的、不存在的、已收队的
	assert.match(await call("squad_stop", { squad: "队", member: "干" }, "main-1"), /现在没在跑/);
	assert.match(await call("squad_stop", { squad: "队", member: "没有" }, "main-1"), /没有成员/);
	await call("squad_close", { squad: "队", reason: "收工" }, "main-1");
	assert.match(await call("squad_stop", { squad: "队", member: "干" }, "main-1"), /收队/);
});

await checkAsync("A2 token 预算：到步边界收工（判「卡住」并写明是预算），不限时不拦", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a2-"));
	// 假流每步报 input 10 + output 5 = 15：预算 25 → 跑完 2 步、第 3 步边界收工。
	// ⚠️ 每步都要带一个工具调用 —— 没有工具调用时循环判定「它答完了」，第 1 步就收工，
	// 预算根本轮不到（我第一次就是这么写的，结果成员「完成」了）。
	const busy = (text) => ({ text, calls: [{ id: "c", name: "board", arguments: `{"text":"${text}"}` }] });
	const { squad, call, settle } = install({
		stream: scriptedStream([busy("一"), busy("二"), busy("三"), busy("四")]),
		config: { persist: false, memberTokenBudget: 25 },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "干活", worktree: wt }, "main-1");
	await settle();
	const member = squad.state.get("main-1").get("队").members.get("A");
	assert.equal(member.status, "卡住", "被预算掐掉不是「完成」");
	assert.match(member.note, /token 预算/, `要写明原因，实际：${member.note}`);
	assert.equal(member.attempts, 1, "预算用尽不是 infra，不该重试");
	// 假流不给 totalTokens，所以账是按各项算的（预算判定走的也是「优先 totalTokens，没有就把各项加起来」）
	assert.equal(member.usage.inputTokens, 20, "跑了两步：input 10×2");
	assert.equal(member.usage.outputTokens, 10, "output 5×2");
	// 小队级上限走同一条路
	const bySquad = install({ stream: scriptedStream([busy("一"), busy("二")]), config: { persist: false, tokenBudget: 10 } });
	await bySquad.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await bySquad.call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "干活", worktree: wt }, "main-1");
	await bySquad.settle();
	assert.match(bySquad.squad.state.get("main-1").get("队").members.get("A").note, /token 预算/);
	// 不限（0）时照常跑完
	const free = install({ stream: scriptedStream([{ text: "干完了" }]), config: { persist: false } });
	await free.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await free.call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "干活", worktree: wt }, "main-1");
	await free.settle();
	assert.equal(free.squad.state.get("main-1").get("队").members.get("A").status, "完成");
});

await checkAsync("A3 并发上限：满了就排队，有人收工自动补位（挂 then 会堵死队列）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a3-"));
	const seen = [];
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "干完了" }], seen),
		config: { persist: false, maxRunning: 2 },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	const outs = [];
	for (const name of ["A", "B", "C", "D"]) {
		outs.push(await call("squad_spawn", { squad: "队", member: name, role: "实现", task: "干活", worktree: wt }, "main-1"));
	}
	assert.match(outs[2], /排进/, `第三个该排队：${outs[2]}`);
	assert.match(outs[3], /排进/);
	const members = squad.state.get("main-1").get("队").members;
	const byStatus = (s) => [...members.values()].filter((m) => m.status === s).length;
	assert.equal(byStatus("在跑"), 2, `同一时刻最多 2 个在跑，实际 ${byStatus("在跑")}`);
	assert.equal(byStatus("排队"), 2);
	// 补位是异步的（在 finally 里）——多等几轮把队排空
	for (let i = 0; i < 8; i += 1) await settle();
	assert.equal(byStatus("完成"), 4, `四个都该跑完：${[...members.values()].map((m) => `${m.label}=${m.status}`).join(" ")}`);
	assert.equal(seen.length >= 4, true, `四个成员都真跑过（实际 ${seen.length} 次调用）`);
});

await checkAsync("A4 角色工具白名单：给了就收窄，与 bash 闸门是「与」", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a4-"));
	const seen = [];
	const { call, settle } = install({
		stream: scriptedStream([{ text: "侦察完" }, { text: "实现完" }], seen),
		config: { persist: false, roleTools: { 侦察: ["read", "grep", "glob", "board"] } },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "查", role: "侦察", task: "查", worktree: wt }, "main-1");
	await settle();
	assert.deepEqual(seen[0].tools.map((t) => t.name).sort(), ["board", "glob", "grep", "read"], "白名单要真的收窄发给 provider 的工具表");
	assert.doesNotMatch(seen[0].system, /write|bash/, "提示词里也不能出现被收窄掉的工具（漏一处 = 说给不到其实能调）");
	// 没配白名单的角色照旧拿全部
	await call("squad_spawn", { squad: "队", member: "写", role: "实现", task: "写", worktree: wt }, "main-1");
	await settle();
	assert.equal(seen[1].tools.length, MEMBER_TOOL_COUNT, "没配的角色不该被收窄");
	// 「与」：白名单里写了 bash，但全局 bash 关着 → 还是没有
	const offSeen = [];
	const off = install({
		stream: scriptedStream([{ text: "x" }], offSeen),
		config: { persist: false, bash: false, roleTools: { 侦察: ["read", "bash"] } },
	});
	await off.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await off.call("squad_spawn", { squad: "队", member: "查", role: "侦察", task: "查", worktree: wt }, "main-1");
	await off.settle();
	assert.deepEqual(offSeen[0].tools.map((t) => t.name), ["read"], "bash 全局关着，白名单也救不回来（两个闸门是「与」）");
});

check("A3/A4：配置校验器 —— 空表合法、坏条目整体拒、越界值拒", () => {
	assert.deepEqual(SQUAD_FIELDS.roleTools({}), {}, "空表 = 不限制，是合法值");
	assert.deepEqual(SQUAD_FIELDS.roleTools({ 侦察: ["read", " grep "] }), { 侦察: ["read", "grep"] }, "工具名要去空白");
	assert.equal(SQUAD_FIELDS.roleTools({ 侦察: ["read", ""] }), undefined, "有坏条目整体拒（别静默清）");
	assert.equal(SQUAD_FIELDS.roleTools({ 侦察: "read" }), undefined, "不是数组就拒");
	assert.equal(SQUAD_FIELDS.roleTools([]), undefined);
	assert.equal(SQUAD_FIELDS.tokenBudget(0), 0, "0 = 不限，合法");
	assert.equal(SQUAD_FIELDS.tokenBudget(-1), undefined);
	assert.equal(SQUAD_FIELDS.tokenBudget(1.5), undefined);
	assert.equal(SQUAD_FIELDS.maxRunning(0), 0);
	assert.equal(SQUAD_FIELDS.maxRunning(51), undefined, "上限 50，别让人配出个荒唐值");
	assert.equal(SQUAD_FIELDS.maxRunning("2"), undefined);
});

await checkAsync("A6 唤醒不绕过并发上限（叫醒的活先排队，话进待投队列）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a6c-"));
	let release;
	let releaseB;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	// ⚠️ 两道闸门：只卡住乙的话，丙 会瞬间跑完、甲 立刻被补位 —— 「排队」那一态根本来不及看
	const gateB = new Promise((resolve) => {
		releaseB = resolve;
	});
	const stream = (options) => {
		const text = JSON.stringify(options.messages);
		if (text.includes("挂着别动")) {
			return (async function* gated() {
				await gate;
				yield* scriptedStream([{ text: "乙干完了" }])(options);
			})();
		}
		if (text.includes("排着")) {
			return (async function* gatedB() {
				await gateB;
				yield* scriptedStream([{ text: "丙干完了" }])(options);
			})();
		}
		return scriptedStream([{ text: "干完了" }])(options);
	};
	const { squad, call, settle } = install({ stream, config: { persist: false, maxRunning: 1 } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "乙", role: "实现", task: "挂着别动", worktree: wt }, "main-1");
	const members = squad.state.get("main-1").get("队").members;
	// 甲 在等乙（手工造这个状态，免得再绕一圈）；丙 排在队里
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "等乙的产出", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "丙", role: "实现", task: "排着", worktree: wt }, "main-1");
	assert.equal(members.get("甲").status, "排队", "上限 1，甲 该排队");
	assert.equal(members.get("丙").status, "排队", "上限 1，丙 也该排队");
	members.get("甲").status = "等待";
	members.get("甲").waitingFor = "乙";
	members.get("甲").note = "在等「乙」收工";
	// 乙 收工：补位（丙）先占掉唯一的位置 → 甲 只能排队，且那条「你等的乙收工了」进它的待投队列
	release();
	// ⚠️ 不能 `settle()`：丙 还卡在闸门上，settle 会 await 它 → 自检当场死锁（踩过第三次了）
	await members.get("乙").promise;
	assert.equal(members.get("甲").status, "排队", `唤醒不能绕过上限，实际 ${members.get("甲").status}`);
	assert.equal(members.get("甲").waitingFor, undefined, "排队之后不该还挂着等待");
	assert.match(members.get("甲").note, /并发满了/);
	assert.equal(members.get("甲").inbox.length, 1, "叫醒的话要进待投队列（不然这条话就丢了）");
	assert.match(JSON.stringify(members.get("甲").inbox), /你等的「乙」收工了/);
	assert.equal(members.get("丙").status, "在跑", "补位先把丙放出去了（它是排队里更早的那个）");
	// 丙 收工后补位 → 甲 真跑起来，并在第一步收到那条话
	releaseB();
	for (let i = 0; i < 10; i += 1) await settle();
	assert.equal(members.get("甲").status, "完成", `补位之后甲该跑完，实际 ${members.get("甲").status}：${members.get("甲").note}`);
	assert.equal(members.get("甲").inbox.length, 0, "待投的要在第一步被取走");
});

await checkAsync("A6 在等的成员停得掉；被主 agent 改过状态的不再被叫醒", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a6d-"));
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const stream = (options) => {
		const text = JSON.stringify(options.messages);
		if (text.includes("挂着别动")) {
			return (async function* gated() {
				await gate;
				yield* scriptedStream([{ text: "乙干完了" }])(options);
			})();
		}
		return scriptedStream([{ text: "干完了" }])(options);
	};
	const { squad, call, settle } = install({ stream, config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "乙", role: "实现", task: "挂着别动", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "等乙", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "丙", role: "实现", task: "也等乙", worktree: wt }, "main-1");
	const members = squad.state.get("main-1").get("队").members;
	// ⚠️ 先等它们真跑完，再手工造「等待」态 —— 否则成员还挂着 `running`（或稍后被真状态盖过），
	// 断言就落在别的东西上了（第一次就是这么漏的：停的是「正在跑」而不是「在等」）。
	// 也**不能**用 `settle()`：乙 卡在闸门上，settle 会 await 它 → 死锁。
	await members.get("甲").promise;
	await members.get("丙").promise;
	for (const label of ["甲", "丙"]) {
		members.get(label).status = "等待";
		members.get(label).waitingFor = "乙";
		members.get(label).running = undefined;
	}
	// 甲：按停止键（等在等的成员也要停得掉）
	assert.match(await call("squad_stop", { squad: "队", member: "甲", reason: "不要了" }, "main-1"), /它本来在等别人/);
	assert.equal(members.get("甲").status, "卡住");
	assert.equal(members.get("甲").waitingFor, undefined);
	// 丙：主 agent 手动改成「完成」—— 它已经做了别的决定，不该再被叫醒
	await call("squad_update", { squad: "队", member: "丙", status: "完成", note: "我替它判了" }, "main-1");
	release();
	for (let i = 0; i < 10; i += 1) await settle();
	assert.equal(members.get("甲").status, "卡住", "停掉的成员不许被叫醒");
	assert.match(members.get("甲").note, /不要了/);
	assert.equal(members.get("丙").status, "完成", "被改过状态的不许被叫醒");
	assert.equal(members.get("丙").waitingFor, undefined, "过期的等待标记要清掉");
	assert.equal(members.get("丙").inbox.length, 0, "没被叫醒就不该有待投");
	// **光看状态分不出来**：真被叫醒的话它会重新跑一遍、又跑成「完成」（R2 第一次就是这么漏的）。
	// 用量只跑一遍就是 10 —— 多跑一遍就变 20。
	assert.equal(members.get("丙").usage.inputTokens, 10, `被改过状态的不许被重新跑起来，实际用量 ${members.get("丙").usage.inputTokens}`);
});

await checkAsync("收队之后不再补位/不再叫醒；重派一个在跑的成员会被拒（且不改它的状态）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-closed-"));
	const { squad, call } = install({ stream: hangingStream, config: { persist: false, maxRunning: 1 } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "挂着", role: "实现", task: "挂着别动", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "排着", role: "实现", task: "排着", worktree: wt }, "main-1");
	const members = squad.state.get("main-1").get("队").members;
	assert.equal(members.get("排着").status, "排队");
	// 重派一个**正在跑**的成员：必须被拒，而且不许把它的状态改成「卡住」（它明明在跑）
	const again = await call("squad_spawn", { squad: "队", member: "挂着", role: "实现", task: "再来一次", worktree: wt }, "main-1");
	// `squad_spawn` 这条路**本来就有**护栏（工具描述里那句是真的）；`startMember` 里的那道是
	// 给别的调用方（`squad_review` 复用同名审查成员等）兜底的 —— 两条都在
	assert.match(again, /还在跑/, `描述里承诺过要拒：${again}`);
	assert.equal(members.get("挂着").status, "在跑", "被拒的重派不许改它在跑的状态");
	assert.equal(members.get("挂着").running !== undefined, true, "旧的那个 AbortController 不能被覆盖掉");
	// 再加一个「等着挂着」的：收队之后它也**不许被叫醒**
	members.set("等着", {
		label: "等着",
		role: "实现",
		task: "等挂着",
		worktree: wt,
		status: "等待",
		waitingFor: "挂着",
		usage: {},
		attempts: 0,
		transcript: [],
		inbox: [],
	});
	// 收队：掐掉在跑的，**排队的、等着的都不许被放出去**（否则「收队」当场又烧起来）
	assert.match(await call("squad_close", { squad: "队", reason: "不要了" }, "main-1"), /掐掉/);
	await members.get("挂着").promise;
	assert.equal(members.get("挂着").status, "卡住");
	assert.equal(members.get("排着").status, "排队", "收队之后不许再补位");
	assert.equal(members.get("排着").running, undefined);
	assert.equal(members.get("等着").status, "等待", "收队之后不许再叫醒谁");
	assert.equal(members.get("等着").running, undefined);
	assert.equal(members.get("等着").usage.inputTokens, undefined, "没被叫醒就不该有用量");
});

await checkAsync("startMember 护栏：复用同名审查成员时，正在跑的那个不会被起第二条循环", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-rev-guard-"));
	const { squad, call, settle } = install({
		stream: (options) => (JSON.stringify(options.messages).includes("挂着别动") ? hangingStream(options) : scriptedStream([{ text: "干完了" }])(options)),
		config: { persist: false },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "审-X", role: "审查", task: "挂着别动", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "写-A", role: "实现", task: "改代码", worktree: wt }, "main-1");
	const members = squad.state.get("main-1").get("队").members;
	await members.get("写-A").promise;
	const before = members.get("审-X").running;
	assert.ok(before !== undefined, "审-X 该在跑");
	// 审-X 正在跑，却又要它当审查者 → 必须被拒，且**不许**换掉它的 AbortController
	const out = await call("squad_review", { squad: "队", member: "写-A", reviewer: "审-X" }, "main-1");
	assert.match(out, /正在跑|还在跑/, `该拒：${out}`);
	assert.equal(members.get("审-X").running, before, "旧的 AbortController 不许被覆盖（覆盖了就停不掉它了）");
	assert.equal(members.get("审-X").status, "在跑", "被拒不许改它的状态");
	// 收尾：停掉它（不留挂着的东西）
	await call("squad_stop", { squad: "队", member: "审-X", reason: "收尾" }, "main-1");
	await members.get("审-X").promise;
	await settle();
});

check("A4：roleTools 的空数组是「零工具」，不是「没配」（fail-open 要挡住）", () => {
	assert.deepEqual(SQUAD_FIELDS.roleTools({ 侦察: [] }), { 侦察: [] }, "空数组是合法配置");
	// 归一之后给「零工具」的角色必须真的一个都拿不到（含 bash）
	const zero = memberToolsFor({ bash: true, allow: [] });
	assert.deepEqual(zero.tools, [], "空白名单 = 零工具");
	assert.equal(zero.schemas.length, 0);
	// 没配（undefined）才是「不限制」
	assert.equal(memberToolsFor({ bash: true, allow: undefined }).tools.length, MEMBER_TOOL_COUNT);
});

await checkAsync("A4：配了 roleTools 的角色真的拿不到工具（走 roleToolsFor 那条路，不是直接调 memberToolsFor）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-rt-zero-"));
	const seen = [];
	const { call, settle } = install({
		stream: scriptedStream([{ text: "干完了" }, { text: "干完了" }], seen),
		config: { persist: false, roleTools: { 侦察: [] } },
	});
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "查", role: "侦察", task: "查", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "写", role: "实现", task: "写", worktree: wt }, "main-1");
	await settle();
	assert.equal(seen[0].tools.length, 0, `配了空数组的角色必须零工具，实际拿到 ${seen[0].tools.length} 个`);
	// 提示词也必须说实话：零工具时不能还写着「工具就 14 个」（成员会去调不存在的工具）。
	// 这条踩过：`memberSystemPrompt` 原来把空数组回落成全部工具。
	assert.match(seen[0].system, /没有任何工具/, "提示词里也要说实话");
	assert.doesNotMatch(seen[0].system, /工具就 \d+ 个/, "零工具时不许再列工具数");
	assert.equal(seen[1].tools.length, MEMBER_TOOL_COUNT, "没配的角色照旧不受限");
});

check("队级用量：成员口径不一致时也要算全（有的报 totalTokens、有的只报分项）", () => {
	const squad = {
		name: "队",
		objective: "o",
		createdAt: 1,
		board: [],
		acceptance: [],
		members: new Map([
			["A", { label: "A", role: "实现", task: "t", status: "完成", usage: { totalTokens: 100 } }],
			["B", { label: "B", role: "实现", task: "t", status: "完成", usage: { inputTokens: 10, outputTokens: 5 } }],
		]),
	};
	const view = snapshot(new Map([["o", new Map([["队", squad]])]]), "o").squads[0];
	assert.equal(view.usage.totalTokens, 115, `队级合计要按成员折算：100 + (10+5)，实际 ${view.usage.totalTokens}`);
	assert.equal(view.usage.inputTokens, 10, "分项照旧求和");
});

check("A3：重启时「排队」判「卡住」并说明不会自动补位", () => {
	const revived = reviveSquad({ name: "n", members: [{ label: "Q", role: "实现", status: "排队" }] }, { statuses: MEMBER_STATUS });
	assert.equal(revived.members.get("Q").status, "卡住");
	assert.match(revived.members.get("Q").note, /排队/, "要说清为什么，以及怎么办");
});


// ── REQ-016 块 3：协作（A6 等待 / A7 审查 / A8 回报 / A9 模板 / A10 验收）──────

check("A8 回报解析：认四段小标题，认不出就说认不出（不编）", () => {
	const full = parseReport("我干完了。\n\n## 交付物\n改了 src/a.js:42\n\n**证据**：npm test 全绿（EXIT=0）\n\n- 没做的：文档\n\n卡点：无");
	assert.equal(full.parsed, true);
	assert.equal(full.deliverables, "改了 src/a.js:42");
	assert.equal(full.evidence, "npm test 全绿（EXIT=0）");
	assert.equal(full.todo, "文档");
	assert.equal(full.blockers, "无");
	// 多行正文要留住
	const multi = parseReport("交付物：\n第一行\n第二行\n证据：跑了 npm test");
	assert.equal(multi.deliverables, "第一行\n第二行");
	// 认不出来 → parsed:false + 原文留着（**不塞进「交付物」里**）
	const none = parseReport("随便说两句就收工了");
	assert.equal(none.parsed, false);
	assert.equal(none.deliverables, "");
	assert.equal(none.raw, "随便说两句就收工了");
	// 空输入不炸
	assert.equal(parseReport(undefined).parsed, false);
	assert.equal(parseReport("   ").parsed, false);
	// 摘要：没解析出来回原文第一行（宁可丑，也别显示成「什么都没做」）
	assert.equal(formatReport(none), "随便说两句就收工了");
	assert.match(formatReport(full), /^交付物：改了 src\/a\.js:42｜证据：/);
});

await checkAsync("A8+A10：成员按四段回报 + 自己勾验收（勾了就落盘、上黑板）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a8-"));
	const answer = [
		"干完了。",
		"## 交付物",
		"改了 src/a.js:42",
		"## 证据",
		"npm test 全绿（EXIT=0）",
		"## 没做的",
		"文档没写",
		"## 卡点",
		"无",
	].join("\n");
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "先勾一条", calls: [{ id: "c", name: "check", arguments: '{"item":"1","note":"跑了 npm test"}' }] }, { text: answer }]),
		config: { persist: false },
	});
	assert.match(await call("squad_new", { name: "队", objective: "o", acceptance: ["npm test 全绿", "CHANGELOG 有记录"] }, "main-1"), /验收清单 2 条/);
	const created = squad.state.get("main-1").get("队");
	assert.equal(created.acceptance.length, 2);
	assert.equal(created.acceptance[0].done, false);
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "干活", worktree: wt }, "main-1");
	await settle();
	// 成员勾的那条：谁勾的记在谁头上，且上了黑板
	assert.equal(created.acceptance[0].done, true);
	assert.equal(created.acceptance[0].by, "A");
	assert.equal(created.acceptance[0].note, "跑了 npm test");
	assert.equal(created.acceptance[1].done, false, "没勾的不许被顺手勾上");
	assert.equal(created.board.some((e) => e.text.includes("☑ 验收 1")), true, "勾了要上黑板（验收进度不该只活在转录里）");
	// 收工回报解析出来并落进快照
	const member = created.members.get("A");
	assert.equal(member.report.parsed, true);
	assert.equal(member.report.deliverables, "改了 src/a.js:42");
	assert.equal(member.report.todo, "文档没写");
	// 黑板写的是**摘要**（不是全文）
	assert.equal(created.board.some((e) => e.text.includes("交付物：改了 src/a.js:42")), true);
	// 状态行里看得到回报与验收进度
	const shown = renderSnapshot(snapshot(squad.state, "main-1"));
	assert.match(shown, /验收 1\/2/);
	assert.match(shown, /交付物：改了 src\/a\.js:42/);
	assert.match(shown, /没做的：文档没写/);
});

check("A10 验收清单：勾过的守住、坏输入拒、重启不丢", () => {
	const squad = { name: "队", acceptance: [{ text: "npm test 全绿", done: false }, { text: "文档有记录", done: false }] };
	const member = { label: "A" };
	assert.match(markAcceptance(squad, member, "1", "跑了 npm test").text, /已勾第 1 条/);
	assert.equal(squad.acceptance[0].by, "A");
	assert.equal(squad.acceptance[0].done, true);
	// 第二个人勾同一条 → 拒（谁验的不能被顶掉）
	assert.match(markAcceptance(squad, { label: "B" }, "1", "").detail, /已经勾了（A）/);
	// 按文字开头勾也认
	assert.match(markAcceptance(squad, member, "文档", "").text, /已勾第 2 条/);
	// 勾不存在的 → 拒，并把清单列出来
	assert.match(markAcceptance(squad, member, "第 9 条", "").detail, /清单里没有这一条/);
	assert.match(markAcceptance(squad, member, "999", "").detail, /清单里没有这一条/);
	// 没有清单时要说清怎么加
	assert.match(markAcceptance({ name: "队", acceptance: [] }, member, "1", "").detail, /没写验收清单/);
	// 归一：字符串数组、对象数组都收；空条目/非数组/超量拒
	assert.deepEqual(normalizeAcceptance(["a", "b"]).value.map((e) => e.text), ["a", "b"]);
	assert.deepEqual(normalizeAcceptance([{ text: "a", done: true, by: "A" }]).value[0].done, true);
	assert.equal(normalizeAcceptance("a").ok, false);
	assert.equal(normalizeAcceptance(["a", "  "]).ok, false);
	assert.equal(normalizeAcceptance(Array.from({ length: 13 }, (_, i) => `第 ${i} 条`)).ok, false, "最多 12 条");
	assert.deepEqual(normalizeAcceptance(undefined).value, []);
	// 重启：勾过的照旧是勾过的
	const revived = reviveSquad(compactSquad({ name: "队", acceptance: [{ text: "a", done: true, by: "A", at: 1 }], members: new Map(), board: [] }), { statuses: MEMBER_STATUS });
	assert.equal(revived.acceptance[0].done, true);
	assert.equal(revived.acceptance[0].by, "A");
	// 老文件（没有 acceptance 字段）读回空清单，不是 undefined
	assert.deepEqual(reviveSquad({ name: "老队" }, { statuses: MEMBER_STATUS }).acceptance, []);
});

await checkAsync("A6 等待：成员自己挂起，目标收工后被叫回来（不做阻塞等待）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a6-"));
	const seen = [];
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const report = (who) => `${who}干完了\n## 交付物\n${who}的产出\n## 证据\n跑了 npm test\n## 没做的\n无\n## 卡点\n无`;
	const calls = new Map();
	const stream = (options) => {
		const who = JSON.stringify(options.messages).includes("等乙") ? "甲" : "乙";
		const n = (calls.get(who) ?? 0) + 1;
		calls.set(who, n);
		if (who === "乙") {
			// 乙**卡在闸门上**：必须让甲先跑到「等待」，否则「等一个已收工的人」走的是另一条路
			return (async function* gated() {
				await gate;
				yield* scriptedStream([{ text: report("乙") }], seen)(options);
			})();
		}
		if (n === 1) {
			return scriptedStream(
				[{ text: "我先等乙", calls: [{ id: "w", name: "wait", arguments: '{"member":"乙","note":"要它的产出"}' }] }],
				seen,
			)(options);
		}
		return scriptedStream([{ text: report("甲") }], seen)(options);
	};
	const { squad, call, settle } = install({ stream, config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "乙", role: "实现", task: "先干完", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "等乙的产出再干", worktree: wt }, "main-1");
	const members = squad.state.get("main-1").get("队").members;
	// 甲这次跑完 = 它挂上了等待（promise 在 abort 之后收尾）
	await members.get("甲").promise;
	assert.equal(members.get("甲").status, "等待", `甲该挂起等乙，实际 ${members.get("甲").status}`);
	assert.match(members.get("甲").note, /在等「乙」收工/);
	assert.equal(members.get("乙").status, "在跑", "乙还在跑（被闸门卡着）");
	// **当场**停：挂起那一刻就不该再多跑一步（白烧一步 = 白烧一次上下文）
	// 只看最终状态是看不出这件事的 —— 少了这条，把 stopSelf 拆掉自检照样全绿（R10 第一次就是这么漏的）。
	assert.equal(members.get("甲").usage.inputTokens, 10, `挂起要当场停，实际跑了 ${members.get("甲").usage.inputTokens / 10} 步`);
	assert.equal(members.get("甲").attempts, 1);
	// 乙收工 → 甲被叫回来
	release();
	for (let i = 0; i < 8; i += 1) await settle();
	assert.equal(members.get("乙").status, "完成");
	assert.equal(members.get("甲").status, "完成", `甲该被叫醒并跑完，实际 ${members.get("甲").status}：${members.get("甲").note}`);
	assert.equal(members.get("甲").waitingFor, undefined, "醒来之后不该还挂着等待");
	// 醒来的那次任务里要有**乙的结论**（不然它醒了也不知道等到了什么）
	const woke = seen.find((s) => JSON.stringify(s.messages).includes("你等的「乙」收工了"));
	assert.ok(woke, "被叫回来的那次要带上被等者的结论");
	assert.match(JSON.stringify(woke.messages), /乙的产出|乙 收工/);
	assert.equal(members.get("甲").report.parsed, true, "被叫回来之后照常解析回报");
});

await checkAsync("A6 边界：等已收工的不用等；等自己/不存在/成环都拒（从真实成员跑里验）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a6b-"));
	const seen = [];
	const step = (text, member) => ({ text, calls: [{ id: "w", name: "wait", arguments: JSON.stringify({ member }) }] });
	// ⚠️ 两个坑都在这里踩过：
	//  ① 脚本要**按成员分发** —— 共享一份的话，先跑的那个成员会把本该另一个跑的步骤吃掉
	//     （第一版：丙 把甲的五步全跑了，断言全落在错的人身上）；
	//  ② 每个成员的脚本实例要**建一次**、别在分发函数里现建 —— 现建等于轮次计数每次都归零，
	//     永远停在第一步（第二版：甲 等了 30 步被 maxSteps 判「卡住」）。
	const jiaScript = scriptedStream(
		[
			step("等丙", "丙"), // 丙早就收工了 → 不该挂起，直接继续
			step("等自己", "甲"),
			step("等不存在的人", "查无此人"),
			step("空参数", ""),
			{ text: "干完了" },
		],
		seen,
	);
	const bingScript = scriptedStream([{ text: "丙先干完了" }], seen);
	const stream = (options) => (JSON.stringify(options.messages).includes("各种等") ? jiaScript : bingScript)(options);
	const { squad, call, settle } = install({ stream, config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "丙", role: "实现", task: "先干完", worktree: wt }, "main-1");
	await settle();
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "各种等", worktree: wt }, "main-1");
	await settle();
	const members = squad.state.get("main-1").get("队").members;
	assert.equal(members.get("甲").status, "完成", `等一个已收工的人不该挂起（实际 ${members.get("甲").status}：${members.get("甲").note}）`);
	assert.equal(members.get("甲").waitingFor, undefined);
	// 负例：错误文本在请求的 messages 里（转录只存 assistant 正文，工具结果在消息流里）
	const texts = JSON.stringify(seen);
	assert.match(texts, /不能等自己/);
	assert.match(texts, /没有成员「查无此人」/);
	assert.match(texts, /不能为空/);
	assert.match(texts, /已经收工了（完成）/, "等一个已收工的人要**当场**把它的结论给它，而不是挂起");
	// 成环：丙等着甲，甲再去等丙 —— 两边都会永远等下去，必须拒。
	// 单独起一个小队：这里要的是「甲**重新跑一次**去等丙」，用上面那套跑完的脚本够不着。
	const cycSeen = [];
	const cycBing = scriptedStream([{ text: "丙干完了" }], cycSeen);
	const cycJia = scriptedStream([step("等丙", "丙"), { text: "干完了" }], cycSeen);
	const cyc = install({
		stream: (options) => (JSON.stringify(options.messages).includes("等丙") ? cycJia : cycBing)(options),
		config: { persist: false },
	});
	await cyc.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await cyc.call("squad_spawn", { squad: "队", member: "丙", role: "实现", task: "先干完", worktree: wt }, "main-1");
	await cyc.settle();
	const cycMembers = cyc.squad.state.get("main-1").get("队").members;
	cycMembers.get("丙").waitingFor = "甲";
	cycMembers.get("丙").status = "等待";
	await cyc.call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "等丙", worktree: wt }, "main-1");
	await cyc.settle();
	assert.match(JSON.stringify(cycSeen), /会成环/, "环要当场拒掉（两边都等 = 两边都不动）");
});

await checkAsync("A7 squad_review：材料塞进审查成员的 task，结论挂回被审者那一行", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a7-"));
	const seen = [];
	const done = "干完了\n## 交付物\n改了 src/a.js:42\n## 证据\nnpm test 全绿\n## 没做的\n文档\n## 卡点\n无";
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: done }, { text: "审完了\n## 交付物\nP1 src/a.js:42 没验空值\n## 证据\n读了 diff + 跑了 npm test\n## 没做的\n无\n## 卡点\n无" }], seen),
		config: { persist: false },
	});
	await call("squad_new", { name: "队", objective: "o", acceptance: ["npm test 全绿"] }, "main-1");
	await call("squad_spawn", { squad: "队", member: "写-A", role: "实现", task: "改代码", worktree: wt }, "main-1");
	await settle();
	const members = squad.state.get("main-1").get("队").members;
	assert.equal(members.get("写-A").status, "完成");
	// 审查一个**还在跑的** → 拒（真挂一个，不用「刚好跑完」来假装）
	const hangSeen = [];
	const hangStream = (options) => (JSON.stringify(options.messages).includes("挂着别动") ? hangingStream(options) : scriptedStream([{ text: "干完了" }], hangSeen)(options));
	const hanging = install({ stream: hangStream, config: { persist: false } });
	await hanging.call("squad_new", { name: "队", objective: "o" }, "main-1");
	await hanging.call("squad_spawn", { squad: "队", member: "跑着的", role: "实现", task: "挂着别动", worktree: wt }, "main-1");
	assert.match(await hanging.call("squad_review", { squad: "队", member: "跑着的" }, "main-1"), /还在跑/);
	await hanging.call("squad_stop", { squad: "队", member: "跑着的", reason: "收尾" }, "main-1");
	await hanging.settle();
	const reviewOut = await call("squad_review", { squad: "队", member: "写-A", focus: "只看空值" }, "main-1");
	assert.match(reviewOut, /已派「审-写-A」（审查）/);
	await settle();
	const reviewer = members.get("审-写-A");
	assert.equal(reviewer.role, "审查");
	assert.equal(reviewer.worktree, wt, "审查成员在被审者的 worktree 里看");
	assert.equal(reviewer.reviews, "写-A");
	// 材料真的进了它的 task（它读不到别人的转录）
	const task = reviewer.task;
	assert.match(task, /它自己的回报/);
	assert.match(task, /改了 src\/a\.js:42/, "被审者自报的交付物要贴进去");
	assert.match(task, /验收清单/, "小队验收清单要贴进去");
	assert.match(task, /只看空值/, "focus 要贴进去");
	assert.match(task, /只审这一个成员的产出/, "边界要写死（否则它会全仓探索）");
	// 结论挂回被审者那一行
	assert.equal(members.get("写-A").review.by, "审-写-A");
	assert.equal(members.get("写-A").review.status, "完成");
	// 审查者的**结论正文**在它的 report 里（`note` 只是「收工（1 步…）」这种原因）
	assert.equal(members.get("写-A").review.report.parsed, true);
	assert.match(members.get("写-A").review.report.deliverables, /P1 src\/a\.js:42/);
	assert.match(renderSnapshot(snapshot(squad.state, "main-1")), /已被 审-写-A 审/);
	// 审一个没做完的（判「卡住」的）→ 拒
	assert.match(await hanging.call("squad_review", { squad: "队", member: "跑着的" }, "main-1"), /不是「完成」/);
	assert.match(await call("squad_review", { squad: "队", member: "没有" }, "main-1"), /没有成员/);
});

await checkAsync("A9 模板：一键起队（目录不存在的不进名册，并说清下一步）", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-a9-"));
	const okA = path.join(root, "查-A");
	const okB = path.join(root, "写-A");
	fs.mkdirSync(okA);
	fs.mkdirSync(okB);
	const templates = {
		"两人队": [
			{ member: "查-A", role: "侦察", task: "摸清入口", worktree: okA },
			{ member: "写-A", role: "实现", task: "改代码", worktree: "写-A" },
		],
		"缺目录": [{ member: "查-B", role: "侦察", task: "摸清", worktree: "还没建" }],
	};
	const { squad, call, settle } = install({
		stream: scriptedStream([{ text: "干完了" }, { text: "我也干完了" }]),
		config: { persist: false, templates },
	});
	const out = await call("squad_new", { name: "队", objective: "o", template: "两人队" }, "main-1", root);
	assert.match(out, /已按模板「两人队」建队/);
	assert.match(out, /派了 2 个成员/);
	const members = squad.state.get("main-1").get("队").members;
	assert.equal(members.size, 2);
	assert.equal(members.get("查-A").worktree, okA, "绝对路径照旧");
	assert.equal(members.get("写-A").worktree, okB, "相对路径按小队 cwd 解析");
	await settle();
	assert.equal(members.get("查-A").status, "完成");
	assert.equal(members.get("写-A").status, "完成");
	// 目录不存在的那条：不进名册，但要说清怎么办
	const missingOut = await call("squad_new", { name: "队二", objective: "o", template: "缺目录" }, "main-1", root);
	assert.match(missingOut, /没建的 1 条/);
	assert.match(missingOut, /先 `worktree_new` 建好/);
	assert.equal(squad.state.get("main-1").get("队二").members.size, 0);
	// 模板名写错：队照样建出来，但要说清没这个模板
	const badOut = await call("squad_new", { name: "队三", objective: "o", template: "没有这个" }, "main-1");
	assert.match(badOut, /没有模板「没有这个」/);
	assert.match(badOut, /两人队/);
	// 配置校验：坏条目整表拒、空表合法
	assert.deepEqual(SQUAD_FIELDS.templates({}), {}, "空表合法（= 一个模板都没配）");
	assert.equal(SQUAD_FIELDS.templates({ T: [{ member: "A", role: "实现", task: "x" }] }), undefined, "缺 worktree 要整表拒");
	assert.equal(SQUAD_FIELDS.templates({ T: [] }), undefined);
	assert.equal(SQUAD_FIELDS.templates([]), undefined);
});


// ── REQ-016 块 4：落盘（B1 转录 .log / B2 inbox·history / B5 锁）──────────────

check("B5 纯判据：文件名消毒 / 进程存活 / 锁过期的双判据", () => {
	// 文件名：成员名是用户给的，不许穿越
	// 穿越样本：断言**性质**（没有分隔符、没有连续点），别把具体形状写死
	const traversal = safeMemberFileName("../../etc/passwd");
	assert.ok(!traversal.includes("/") && !traversal.includes("\\"), `结果里不许有路径分隔符：${traversal}`);
	assert.ok(!traversal.includes(".."), `结果里不许有 ..：${traversal}`);
	assert.equal(traversal, "____etc_passwd", "具体形状也钉住（下划线个数是确定的，别下次又猜）");
	assert.equal(safeMemberFileName("查-A"), "查-A");
	assert.equal(safeMemberFileName("a/b\\c"), "a_b_c");
	assert.equal(safeMemberFileName(""), "member", "空名给个兜底");
	assert.equal(safeMemberFileName(".."), "_", "纯点点收成下划线 —— 文件名本身无害，不穿越就行");
	assert.equal(safeMemberFileName("...x"), "_x");
	assert.ok(!safeMemberFileName("....//....//x").includes("/"), "结果里不许还有斜杠");
	// 进程存活
	assert.equal(processAlive(process.pid), true, "自己一定活着");
	assert.equal(processAlive(0), false);
	assert.equal(processAlive(-1), false);
	assert.equal(processAlive(2 ** 31 - 1), false, "不存在的 pid 要判「不活」");
	// 锁过期：**pid 与 mtime 双判据**
	const now = Date.now();
	assert.equal(lockIsStale({ pid: process.pid, at: now }, now), false, "自己持的、刚写的 → 不许抢");
	assert.equal(lockIsStale({ pid: 2 ** 31 - 1, at: now }, now), true, "持有者死了 → 抢");
	assert.equal(lockIsStale({ pid: process.pid, at: now - LOCK_STALE_MS - 1 }, now), true, "太老 → 抢");
	assert.equal(lockIsStale(null, now), true);
	assert.equal(lockIsStale({}, now), true, "没有 at 的坏锁 → 当过期");
});

await checkAsync("B1+B2：转录落 .log 全文、待投与续聊历史跨重启活着", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-b1-"));
	const store = createSquadStore({ dir, log: () => {}, debounceMs: 1 });
	const long = Array.from({ length: 150 }, (_, i) => ({ role: "assistant", text: `第 ${i} 条`, at: i }));
	const member = {
		label: "查-A",
		role: "侦察",
		task: "摸清入口",
		worktree: "/tmp/wt",
		status: "完成",
		note: "干完了",
		transcript: long,
		inbox: [userMessage("第一句"), userMessage("第二句")],
		history: [
			{ role: "user", content: [{ type: "text", text: "任务" }] },
			{ role: "assistant", content: [{ type: "text", text: "我做了 X" }] },
			{ role: "user", content: [{ type: "text", text: "接着做 Y" }] },
		],
	};
	const squad = { name: "队", objective: "o", members: new Map([["查-A", member]]), board: [] };
	store.save("/tmp/ws-b1", () => [squad]);
	store.flush();

	// B1：.log 是全文（JSON 里那份被压到 100 条）
	const logFile = store.transcriptFile("/tmp/ws-b1", "队", "查-A");
	assert.equal(fs.existsSync(logFile), true, ".log 要真的落下来");
	const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim() !== "");
	assert.equal(lines.length, 150, "全文 150 条一条不许少");
	assert.equal(JSON.parse(lines[0]).text, "第 0 条", "JSONL：一行一条，机器能解析");
	const onDisk = JSON.parse(fs.readFileSync(store.fileFor("/tmp/ws-b1"), "utf8"));
	assert.equal(onDisk.squads[0].members[0].transcript.length, PERSIST_TRANSCRIPT_LIMIT, "JSON 里那份还是摘要（安全网）");
	assert.equal(onDisk.version, SQUAD_STORE_VERSION);
	// B2：待投与历史都落了盘
	assert.equal(onDisk.squads[0].members[0].inbox.length, 2);
	assert.equal(onDisk.squads[0].members[0].history.length, 3);

	// 读回来：转录用 .log 的全文，inbox 还原成**真消息**，history 原样带回
	const loaded = store.load("/tmp/ws-b1");
	assert.equal(loaded[0].members[0].transcript.length, 150, "有全文就用全文（重启后转录不掉字）");
	const revived = reviveSquad(loaded[0], { statuses: MEMBER_STATUS });
	const revivedMember = revived.members.get("查-A");
	assert.equal(revivedMember.inbox.length, 2);
	assert.equal(revivedMember.inbox[0].role, "user");
	assert.equal(revivedMember.inbox[0].content[0].text, "第一句", "待投消息要还原成循环认得的形状");
	assert.equal(revivedMember.history.length, 3);
	assert.equal(revivedMember.history[2].content[0].text, "接着做 Y");
	// `.log` 比 JSON 里那份**少**时（写转录失败过 / 有人手改过）：以 JSON 为准 ——
	// 无脑「优先全文」会变成「丢最新几条」。
	fs.writeFileSync(logFile, `${JSON.stringify({ at: 1, role: "assistant", text: "只有一条" })}\n`, "utf8");
	const shorter = store.load("/tmp/ws-b1");
	assert.equal(shorter[0].members[0].transcript.length, PERSIST_TRANSCRIPT_LIMIT, "`.log` 更旧时不许用它覆盖 JSON");
	// 老文件（v1，没有这些字段）照常读，不 quarantine
	const v1 = { version: 1, cwd: "/tmp/ws-b1", squads: [{ name: "老队", members: [{ label: "A", status: "完成" }] }] };
	fs.writeFileSync(store.fileFor("/tmp/ws-b1"), JSON.stringify(v1), "utf8");
	const oldLoaded = store.load("/tmp/ws-b1");
	assert.equal(oldLoaded.length, 1, "v1 文件必须能读（迁移的意义就在这）");
	assert.equal(fs.readdirSync(dir).some((f) => f.includes(".broken-")), false, "读老版本不该被改名");
	const oldRevived = reviveSquad(oldLoaded[0], { statuses: MEMBER_STATUS });
	assert.deepEqual(oldRevived.members.get("A").inbox, []);
	assert.equal(oldRevived.members.get("A").history, undefined);
	assert.deepEqual(SQUAD_STORE_KNOWN.includes(1), true, "v1 要在认得列表里");
	store.dispose();
});

await checkAsync("B5 锁：另一个进程正在写就不写；持有者死了就抢过来", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-b5-"));
	const logs = [];
	const store = createSquadStore({ dir, log: (m) => logs.push(m), debounceMs: 1 });
	const squad = { name: "队", objective: "o", members: new Map(), board: [] };
	const file = store.fileFor("/tmp/ws-b5");
	const lockFile = `${file}.lock`;
	// 活着的进程持着锁（用我们自己的 pid 冒充）→ 这次不许写
	fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
	store.save("/tmp/ws-b5", () => [squad]);
	store.flush();
	assert.equal(fs.existsSync(file), false, "别人持着锁时不许写（写了就是丢更新）");
	assert.equal(logs.some((m) => m.includes("另一个进程")), true, "要说出来为什么没写");
	// 持有者死了（拿一个不存在的 pid）→ 抢过来写
	fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 31 - 1, at: Date.now() }), "utf8");
	store.flush();
	assert.equal(fs.existsSync(file), true, "持有者死了就该抢过来写");
	assert.equal(fs.existsSync(lockFile), false, "写完要放锁（不然下一次写永远被自己挡）");
	// 锁太老（哪怕 pid 是我们自己）→ 也抢
	fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1000 }), "utf8");
	store.save("/tmp/ws-b5", () => [squad]);
	store.flush();
	assert.equal(fs.existsSync(lockFile), false, "过期锁要被抢掉");
	store.dispose();
	assert.equal(fs.existsSync(lockFile), false, "dispose 之后不留锁文件");
});


// ── REQ-016 块 4：B3 实时推送（SSE）/ C2 成本面板 ───────────────────────────

await checkAsync("B3 SSE：/events 先推一份快照，状态变了才再推，close 时清定时器", async () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	const handler = record.routes[0].handler;
	newSquad(squad.state, "s1", { name: "队", objective: "o" });
	addMember(squad.state, squad.state.get("s1").get("队"), { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });

	// 自己造一个能收 SSE 的 res：writeHead / write / on("close")
	const frames = [];
	const listeners = new Map();
	const res = {
		status: 0,
		headers: null,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		write(chunk) {
			frames.push(String(chunk));
		},
		end() {},
		on(event, fn) {
			listeners.set(event, fn);
		},
	};
	const req = new EventEmitter();
	req.method = "GET";
	req.url = `${SQUAD_ROUTE_PREFIX}/events`;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost:3080" };

	await withFakeTimers(async (timers) => {
		await handler(req, res);
		assert.equal(res.status, 200);
		assert.match(res.headers["content-type"], /text\/event-stream/, "SSE 的 content-type 不能写成 JSON");
		assert.equal(res.headers["cache-control"], "no-store");
		// 开场先给一份完整快照 —— 面板不必先打一次 /squads
		assert.equal(frames.length, 1);
		assert.match(frames[0], /^event: squads\ndata: /);
		const first = JSON.parse(frames[0].split("data: ")[1]);
		assert.equal(first.squads[0].name, "队");
		// 两个定时器：变化检查 + 心跳（都在 fake timers 里，不会真跑）
		assert.equal(timers.created.length, 2, "要安排「查变化」与「心跳」两个定时器");
		const [tick] = timers.created;
		// 状态没变 → 不推（指纹一样）
		tick.callback();
		assert.equal(frames.length, 1, "没变化就不推：不然每秒一坨一样的快照");
		// 状态变了 → 推
		squad.state.get("s1").get("队").members.get("实现-A").status = "完成";
		squad.state.get("s1").get("队").members.get("实现-A").updatedAt = Date.now();
		tick.callback();
		assert.equal(frames.length, 2, "变了才推");
		assert.match(frames[1], /"status":"完成"/);
		// 连接断了必须把两个定时器都清掉（否则每开一次面板漏两个常驻定时器）
		listeners.get("close")();
		assert.equal(timers.cleared.length, 2, "close 要清定时器");
	});
	// 栅栏：非本机来源一律 403（SSE 也不能例外）
	const denied = await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/events`, { remoteAddress: "10.0.0.9" });
	assert.equal(denied.status, 403);
	squad.dispose();
});

await checkAsync("C2 /cost：与账单同一套口径，形状稳定（没有审计日志时 audit 是 null）", async () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS } });
	const handler = record.routes[0].handler;
	newSquad(squad.state, "s1", { name: "队", objective: "o" });
	addMember(squad.state, squad.state.get("s1").get("队"), { label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a" });
	// 今天收工的一个成员：小队那半要算得出来
	const member = squad.state.get("s1").get("队").members.get("实现-A");
	member.status = "完成";
	member.endedAt = Date.now();
	member.usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

	const cost = await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/cost`);
	assert.equal(cost.status, 200);
	assert.equal(cost.body.ok, true);
	assert.equal(typeof cost.body.date, "string");
	assert.match(cost.body.date, /^\d{4}-\d{2}-\d{2}$/, "日期是本地日（与 bill 同一套）");
	// 本机可能有也可能没有审计日志：两种形状都要能渲染（面板要能区分 0 与「没数据」）
	assert.ok(cost.body.audit === null || typeof cost.body.audit.totals === "object", `audit 形状：${JSON.stringify(cost.body.audit)}`);
	assert.equal(cost.body.squads.totals.calls >= 1, true, "今天收工的小队成员要算进去");
	assert.equal(cost.body.squads.totals.input, 100);
	assert.equal(cost.body.squads.members[0].squad, "队");
	assert.equal(cost.body.squads.members[0].label, "实现-A");
	// 只读：写方法 404；非本机 403
	assert.equal((await request(handler, "POST", `${SQUAD_ROUTE_PREFIX}/cost`)).status, 404);
	assert.equal((await request(handler, "GET", `${SQUAD_ROUTE_PREFIX}/cost`, { remoteAddress: "10.0.0.9" })).status, 403);
	squad.dispose();
});

await checkAsync("B3 面板：有 EventSource 就推（不轮询）；没有就退回 5 秒轮询", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	// 假的 EventSource：记下 URL，允许测试往里塞事件
	const opened = [];
	class FakeEventSource {
		constructor(url) {
			this.url = url;
			this.closed = false;
			this.listeners = new Map();
			opened.push(this);
		}
		addEventListener(name, fn) {
			this.listeners.set(name, fn);
		}
		close() {
			this.closed = true;
		}
		emit(name, payload) {
			this.listeners.get(name)?.({ data: JSON.stringify(payload) });
		}
	}
	const realEventSource = globalThis.EventSource;
	globalThis.EventSource = FakeEventSource;
	try {
		const tree = await withFetch(
			async (url) => (url.endsWith("/squads") ? reply(200, SQUAD_FIXTURE)() : reply(200, { ok: true, boardLimit: 500 })()),
			async () => {
				exports.apply(ctx);
				await settle();
				const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
				return withFakeTimers(async (timers) => {
					const first = rt.render(page.component);
					await settle();
					assert.equal(opened.length, 1, "要开一条 SSE");
					assert.match(opened[0].url, /\/events$/);
					assert.equal(timers.created.length, 0, "有 SSE 就不该再安排轮询（这就是 B3 的全部意义）");
					// 推一帧 → 面板换数据（换成空快照，树里就该出现「还没有小队」）
					opened[0].emit("squads", { ok: true, squads: [], count: 0 });
					await settle();
					// ⚠️ 用现成的 `textsOf`：`walk` 只访问**元素**，字符串节点它直接跳过（我第一版用 walk 收字符串，收到空数组）
					const pushed = textsOf(rt.render(page.component)).join(" | ");
					assert.match(pushed, /还没有小队/, `推送要真的换掉面板数据，实际：${pushed.slice(0, 200)}`);
					rt.cleanup();
					assert.equal(opened[0].closed, true, "卸载要关掉 SSE（不然每开一次面板漏一条连接）");
					return first;
				});
			},
		);
		assert.ok(tree !== undefined);
	} finally {
		if (realEventSource === undefined) delete globalThis.EventSource;
		else globalThis.EventSource = realEventSource;
	}
});

await checkAsync("C2 面板：成本行渲染出来；/cost 挂了也不拖垮名册", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	await withFetch(
		async (url) => {
			if (url.endsWith("/squads")) return reply(200, SQUAD_FIXTURE)();
			if (url.endsWith("/cost")) {
				return reply(200, {
					ok: true,
					date: "2026-10-16",
					audit: { totals: { calls: 1111, input: 5417230, output: 1226172, cacheRead: 194059648, cacheWrite: 0, total: 200703050 } },
					squads: { totals: { calls: 3, total: 450 }, members: [] },
				})();
			}
			return reply(200, { ok: true, boardLimit: 500 })();
		},
		async () => {
			exports.apply(ctx);
			await settle();
			const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
			const tree = await withFakeTimers(async () => {
				rt.render(page.component);
				await settle();
				const rendered = rt.render(page.component);
				rt.cleanup();
				return rendered;
			});
			const text = textsOf(tree).join(" | ");
			assert.match(text, /今天（2026-10-16）本机全部/, `成本行要在面板上，实际：${text.slice(0, 200)}`);
			assert.match(text, /1,111 次调用/, "千分位要真的分开");
			assert.match(text, /其中小队：3 次/);
		},
	);
	// /cost 抛错：名册照常显示
	const rt2 = createReact();
	const second = loadClient(rt2.React);
	const { ctx: ctx2, record: record2 } = fakeClientCtx();
	await withFetch(
		async (url) => {
			if (url.endsWith("/squads")) return reply(200, SQUAD_FIXTURE)();
			// 探活那条要照常 200，否则面板压根不注册（第一版把 /options 也炸了，
			// 结果连 page.component 都取不到）
			if (url.endsWith("/cost")) throw new Error("成本这条路炸了");
			return reply(200, { ok: true, boardLimit: 500 })();
		},
		async () => {
			second.exports.apply(ctx2);
			await settle();
			const page = record2.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
			const tree = await withFakeTimers(async () => {
				rt2.render(page.component);
				await settle();
				const rendered = rt2.render(page.component);
				rt2.cleanup();
				return rendered;
			});
			const text = textsOf(tree).join(" | ");
			assert.doesNotMatch(text, /读不到小队数据/, "成本读不到不该说成「小队读不到」");
			assert.match(text, /今天|小队/, "名册照常渲染");
		},
	);
});


// ── REQ-016 · 2.0.2：独立审查报回来的 5 条 + 2 条没覆盖的边界 ──────────────────

await checkAsync("等待中的成员被重派：waitingFor 必须清掉（否则那次跑完被「等别人」分支吞掉）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-rewait-"));
	const answer = "干完了\n## 交付物\n第二次的产出\n## 证据\n跑了 npm test\n## 没做的\n无\n## 卡点\n无";
	const { squad, call, settle } = install({ stream: scriptedStream([{ text: answer }]), config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "干活", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "乙", role: "实现", task: "另一个", worktree: wt }, "main-1");
	await settle();
	const members = squad.state.get("main-1").get("队").members;
	const boardBefore = squad.state.get("main-1").get("队").board.length;
	// 造一个「等待中」的甲（它的被等者乙早就收工了）
	members.get("甲").status = "等待";
	members.get("甲").waitingFor = "乙";
	members.get("甲").waitNote = "等它的产出";
	// 重派：起新的一轮 → 这一轮跑完必须按「完成」收尾（不是又退回「等待」）
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "再来一次", worktree: wt }, "main-1");
	await settle();
	assert.equal(members.get("甲").waitingFor, undefined, "起新一轮就该把等待标记清掉");
	assert.equal(members.get("甲").status, "完成", `重派跑完该是「完成」，实际 ${members.get("甲").status}：${members.get("甲").note}`);
	assert.equal(members.get("甲").report?.parsed, true, "回报要照常解析（被吞掉的话这里是空的）");
	assert.equal(members.get("甲").report.deliverables, "第二次的产出");
	assert.ok(squad.state.get("main-1").get("队").board.length > boardBefore, "收工要照常写黑板");
});

await checkAsync("唤醒是**扫描式**的：被等者早已收工、等者当时还在收尾 → 之后也要被捞起来", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-scanwake-"));
	const { squad, call, settle } = install({ stream: scriptedStream([{ text: "干完了" }]), config: { persist: false } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "乙", role: "实现", task: "先干完", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "甲", role: "实现", task: "等乙", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "丙", role: "实现", task: "打酱油", worktree: wt }, "main-1");
	await settle();
	const members = squad.state.get("main-1").get("队").members;
	// 造出那个竞态的**事后状态**：甲在等一个早已收工的乙，而甲自己还有个（过期的）running 句柄
	members.get("甲").status = "等待";
	members.get("甲").waitingFor = "乙";
	members.get("甲").running = { abort: { abort() {} }, startedAt: 1 };
	// 让别人再收工一次（扫描发生在**任何**成员的 finally 里）
	await call("squad_spawn", { squad: "队", member: "丁", role: "实现", task: "再跑一个", worktree: wt }, "main-1");
	await settle();
	assert.equal(members.get("甲").status, "等待", "它自己还挂着 running（正在收尾）→ 这时不该被起第二条");
	assert.equal(members.get("甲").waitingFor, "乙", "没被唤醒就不许把标记清掉（清了就永远醒不来）");
	// 它的收尾终于跑完（running 被清）→ 下一次扫描必须把它捞起来
	members.get("甲").running = undefined;
	await call("squad_spawn", { squad: "队", member: "戊", role: "实现", task: "再来一个", worktree: wt }, "main-1");
	await settle();
	assert.equal(members.get("甲").waitingFor, undefined, "被等者已收工 → 它该被捞起来");
	assert.notEqual(members.get("甲").status, "等待", `不该再停在等待，实际 ${members.get("甲").status}`);
});

await checkAsync("并发上限：收工补位之后**同时在跑数**也不许超过 maxRunning（审查的探针就是这个）", async () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "squad-cap-"));
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const stream = (options) => {
		if (JSON.stringify(options.messages).includes("占着")) {
			return (async function* gated() {
				await gate;
				yield* scriptedStream([{ text: "A 干完了" }])(options);
			})();
		}
		return (async function* gatedToo() {
			// B/C 也卡住：这样「同时在跑几个」是稳定的，不会因为谁先跑完而看不出问题
			await new Promise((r) => setTimeout(r, 5));
			yield* scriptedStream([{ text: "干完了" }])(options);
		})();
	};
	const { squad, call, settle } = install({ stream, config: { persist: false, maxRunning: 1 } });
	await call("squad_new", { name: "队", objective: "o" }, "main-1");
	await call("squad_spawn", { squad: "队", member: "A", role: "实现", task: "占着", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "B", role: "实现", task: "排队一", worktree: wt }, "main-1");
	await call("squad_spawn", { squad: "队", member: "C", role: "实现", task: "排队二", worktree: wt }, "main-1");
	const members = squad.state.get("main-1").get("队").members;
	const runningNow = () => [...members.values()].filter((m) => m.running !== undefined).length;
	assert.equal(runningNow(), 1, "开局只有 A 在跑");
	release();
	// 边跑边看：任何一刻都不许超过 1
	for (let i = 0; i < 12; i += 1) {
		await new Promise((r) => setTimeout(r, 3));
		assert.ok(runningNow() <= 1, `同时在跑 ${runningNow()} 个（上限 1）—— 补位的边界算错了`);
	}
	await settle();
	assert.equal(runningNow(), 0);
	assert.equal(members.get("B").status, "完成");
	assert.equal(members.get("C").status, "完成");
});

await checkAsync("B1：两个队有同名成员时，转录各落各的（不许串队）", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-b1-two-"));
	const store = createSquadStore({ dir, log: () => {}, debounceMs: 1 });
	const mk = (squadName, text) => ({
		name: squadName,
		objective: "o",
		board: [],
		members: new Map([["查-A", { label: "查-A", role: "侦察", task: "t", status: "完成", transcript: [{ role: "assistant", text }] }]]),
	});
	store.save("/tmp/ws-b1-two", () => [mk("甲队", "甲队的转录"), mk("乙队", "乙队的转录")]);
	store.flush();
	const loaded = store.load("/tmp/ws-b1-two");
	const byName = new Map(loaded.map((s) => [s.name, s]));
	assert.equal(byName.get("甲队").members[0].transcript[0].text, "甲队的转录");
	assert.equal(byName.get("乙队").members[0].transcript[0].text, "乙队的转录", "同名成员不许读到对方的转录");
	assert.notEqual(store.transcriptFile("/tmp/ws-b1-two", "甲队", "查-A"), store.transcriptFile("/tmp/ws-b1-two", "乙队", "查-A"));
	store.dispose();
});

await checkAsync("B3：黑板满了之后新写的条目也要推（指纹不能只数条数）", async () => {
	const { ctx, record } = fakeCtx();
	const squad = installSquad(ctx, { config: { ...SQUAD_DEFAULTS, boardLimit: 3 } });
	const handler = record.routes[0].handler;
	newSquad(squad.state, "s1", { name: "队", objective: "o" });
	const one = squad.state.get("s1").get("队");
	const frames = [];
	const listeners = new Map();
	const res = {
		writeHead() {},
		write(chunk) {
			frames.push(String(chunk));
		},
		end() {},
		on(event, fn) {
			listeners.set(event, fn);
		},
	};
	const req = new EventEmitter();
	req.method = "GET";
	req.url = `${SQUAD_ROUTE_PREFIX}/events`;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost:3080" };
	await withFakeTimers(async (timers) => {
		await handler(req, res);
		assert.equal(frames.length, 1);
		const [tick] = timers.created;
		// 把黑板填满（3 条，正好到上限）
		for (let i = 1; i <= 3; i += 1) one.board.push({ at: i, from: "A", text: `第 ${i} 条` });
		tick.callback();
		assert.equal(frames.length, 2, "填满的过程要推");
		// 满盘之后再加一条：length 不变（挤掉最旧的），只有首尾 at 变了
		one.board.shift();
		one.board.push({ at: 4, from: "A", text: "第 4 条" });
		assert.equal(one.board.length, 3, "长度确实没变（这就是只数条数会漏的原因）");
		tick.callback();
		assert.equal(frames.length, 3, "黑板满了之后新写的也要推");
		assert.match(frames[2], /第 4 条/);
		listeners.get("close")();
	});
	squad.dispose();
});

await checkAsync("C2 面板：SSE 推送时成本行也跟着刷（节流，不是每帧都拉）", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record } = fakeClientCtx();
	const opened = [];
	class FakeEventSource {
		constructor(url) {
			this.url = url;
			this.listeners = new Map();
			opened.push(this);
		}
		addEventListener(name, fn) {
			this.listeners.set(name, fn);
		}
		close() {}
		emit(name, payload) {
			this.listeners.get(name)?.({ data: JSON.stringify(payload) });
		}
	}
	const realES = globalThis.EventSource;
	const realNow = Date.now;
	globalThis.EventSource = FakeEventSource;
	const urls = [];
	let now = realNow();
	Date.now = () => now;
	try {
		await withFetch(
			async (url) => {
				urls.push(url);
				if (url.endsWith("/squads")) return reply(200, SQUAD_FIXTURE)();
				if (url.endsWith("/cost")) return reply(200, { ok: true, date: "2026-10-16", audit: null, squads: { totals: { calls: 0, total: 0 }, members: [] } })();
				return reply(200, { ok: true, boardLimit: 500 })();
			},
			async () => {
				exports.apply(ctx);
				await settle();
				const page = record.registrations.find((r) => r.options.name === "main" && r.options.key === "team-squad");
				await withFakeTimers(async () => {
					rt.render(page.component);
					await settle();
					const before = urls.filter((u) => u.endsWith("/cost")).length;
					assert.equal(before, 1, "开页拉一次成本");
					// 第一帧：离上次不到 10 秒 → 节流，不重复拉
					opened[0].emit("squads", { ok: true, squads: [], count: 0 });
					await settle();
					assert.equal(urls.filter((u) => u.endsWith("/cost")).length, 1, "10 秒内不许重复拉（审计日志几 MB）");
					// 过了节流窗口 → 再推一帧就该拉
					now += 11_000;
					opened[0].emit("squads", { ok: true, squads: [], count: 0 });
					await settle();
					assert.equal(urls.filter((u) => u.endsWith("/cost")).length, 2, "过了窗口就该刷成本（否则成本行停在开页那一刻）");
					rt.cleanup();
				});
			},
		);
	} finally {
		Date.now = realNow;
		if (realES === undefined) delete globalThis.EventSource;
		else globalThis.EventSource = realES;
	}
});


await checkAsync("B1：2.0.1 落的老布局 .log（不带队名）升级后照样读得回来（升级不丢全文）", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-b1-legacy-"));
	const store = createSquadStore({ dir, log: () => {}, debounceMs: 1 });
	const member = { label: "查-A", role: "侦察", task: "t", status: "完成", transcript: [{ role: "assistant", text: "尾巴一条" }] };
	store.save("/tmp/ws-b1-legacy", () => [{ name: "队", objective: "o", members: new Map([["查-A", member]]), board: [] }]);
	store.flush();
	// 抹掉新布局那份，只留 2.0.1 时代的老文件（不带队名）
	const tdir = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".transcripts")));
	fs.rmSync(path.join(tdir, "队"), { recursive: true, force: true });
	fs.writeFileSync(path.join(tdir, "查-A.log"), [1, 2, 3].map((i) => JSON.stringify({ at: i, role: "assistant", text: `旧全文${i}` })).join("\n") + "\n", "utf8");
	const loaded = store.load("/tmp/ws-b1-legacy");
	assert.equal(loaded[0].members[0].transcript.map((e) => e.text).join("|"), "旧全文1|旧全文2|旧全文3", "老布局的全文要能读回来");
	store.dispose();
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

if (failures > 0) {
	console.log(`\n✗ ${failures} 项失败`);
	process.exit(1);
}
console.log("✓ 自检通过：名册与黑板 / 权限三种视角 / 快照 / 全部小队工具真跑（返回值过 schema）/ 装配与会话清理 / HTTP 路由与信任栅栏负例 / 真 socket 端到端（路由挂载 + prefix 匹配 + SSE 长连接）/ 客户端面板真渲染与只读转录 / REQ-015 用量·落盘捡回·续聊·直投·重试·超时 / REQ-016 配置 v2 迁移·角色档位·可控性·协作·落盘·SSE·成本");
