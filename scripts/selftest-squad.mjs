#!/usr/bin/env node
/**
 * 自检：小队（REQ-009）。
 *
 * 七段：
 *   1. 名册与黑板（纯函数：建队 / 加人 / 改行 / 写黑板 / 收队 / 裁剪）
 *   2. 权限（authorize：所有者、成员、外人三种视角）
 *   3. 快照（snapshot 只给自己的队；snapshotAll 给全部）
 *   4. 6 个工具**真跑**一遍（假 ctx + 真 execute），返回值逐条过 output.schema
 *   5. 装配（enabled=false 一个工具不注册；webServer 缺失时面板不挂但不连累工具；
 *      session/disposed 真清状态）
 *   6. HTTP 路由 + **信任栅栏的负例**（跨站 / 非回环 / 写方法一律拒）
 *   7. 客户端面板：真加载 classic script，**真渲染**出成员与黑板，
 *      并真点一次「进入会话」看它有没有把 agentId 交给 uiWorkspace
 *
 * 为什么第 6、7 段不能省：这块功能有两条「看不见的失败」——
 * 栅栏写错了，本机任何进程都能读走全部小队内容（而面板照样工作、自检照样绿）；
 * 面板里那个「进入会话」按钮若把 id 传错（比如传成成员名），点下去只会静默没反应。
 * 纯函数一条都测不出这两种。
 *
 *   node scripts/selftest-squad.mjs
 */
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";

const ROOT = new URL("../", import.meta.url);
const {
	MEMBER_STATUS,
	MAX_BOARD_TEXT,
	MAX_NAME,
	SQUAD_DEFAULTS,
	SQUAD_ROUTE_PREFIX,
	addMember,
	appendBoard,
	authorize,
	closeSquad,
	createState,
	findSquad,
	installSquad,
	newSquad,
	snapshot,
	snapshotAll,
	squadOfMember,
	updateMember,
} = await import(new URL("lib/squad.js", ROOT).href);

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

check("加成员：状态初始为待派，绑定 id 后成员能反查到自己的队；同一个人不能进两个队", () => {
	const { state, squad } = fixture();
	const r = addMember(state, squad, { label: "调研-A", role: "调研", task: "查上游怎么做" });
	assert.equal(r.ok, true, r.detail);
	assert.equal(r.member.status, "待派");
	// 面板是按 `agentId === null` 判断「进入会话」按钮能不能点的，所以「没绑」在
	// **视图里**必须是 null，不能是「字段不存在」—— JSON 会把 undefined 的键整个丢掉，
	// 客户端拿到 undefined 时 `=== null` 不成立，按钮就会亮着而点下去没反应。
	const view = snapshot(state, "owner-1").squads[0].members[0];
	assert.equal(view.agentId, null);
	assert.equal(view.note, null);

	const bound = addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", agentId: "sub-1", worktree: "/tmp/wt-a" });
	assert.equal(bound.ok, true, bound.detail);
	assert.equal(bound.member.status, "在跑", "绑了 id 就该是在跑");
	assert.equal(squadOfMember(state, "sub-1").squad.name, "登录改造", "成员要能反查自己的队");

	assert.equal(addMember(state, squad, { label: "调研-A", role: "调研", task: "重复" }).ok, false, "队内成员名唯一");
	assert.equal(addMember(state, squad, { label: "又一个", role: "实现", task: "t", agentId: "sub-1" }).ok, false, "同一个子代理不能进两个队");

	const other = newSquad(state, "o2", { name: "别的队", objective: "y" }).squad;
	assert.equal(addMember(state, other, { label: "x", role: "实现", task: "t", agentId: "sub-1" }).ok, false, "跨队也不行");
	assert.equal(addMember(state, other, { label: "x", role: "实现", task: "" }).ok, false, "任务不能空");
	assert.equal(addMember(state, other, { label: "", role: "实现", task: "t" }).ok, false);
});

check("改成员那一行：状态只认四个词，note 有长度上限，agentId 改绑要查重", () => {
	const { state, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", agentId: "sub-1" });
	addMember(state, squad, { label: "实现-B", role: "实现", task: "改代码", agentId: "sub-2" });
	const other = newSquad(state, "o2", { name: "另一个", objective: "z" }).squad;
	addMember(state, other, { label: "调研-B", role: "调研", task: "查", agentId: "sub-3" });
	assert.deepEqual(MEMBER_STATUS, ["待派", "在跑", "完成", "卡住"], "状态词表是面板与工具的共同契约");

	assert.equal(updateMember(state, squad, "实现-A", { status: "完成" }).ok, true);
	assert.equal(squad.members.get("实现-A").status, "完成");
	assert.equal(updateMember(state, squad, "实现-A", { status: "做完了" }).ok, false, "状态词表外一律拒");
	// 超长状态：`oneLine` 失败时没有 `.value`，报错文案不能变成「收到的是「undefined」」
	const tooLong = updateMember(state, squad, "实现-A", { status: "很".repeat(MAX_NAME + 1) });
	assert.equal(tooLong.ok, false, "超长状态要拒");
	assert.match(tooLong.detail, /太长/, `要说是太长，不是别的：${tooLong.detail}`);
	assert.doesNotMatch(tooLong.detail, /undefined/, `拒绝理由里不能出现 undefined：${tooLong.detail}`);
	assert.equal(updateMember(state, squad, "没有这个人", { status: "完成" }).ok, false);
	assert.equal(updateMember(state, squad, "实现-A", { note: "n".repeat(MAX_BOARD_TEXT + 1) }).ok, false, "note 也要有上限");
	assert.equal(updateMember(state, squad, "实现-A", { note: "已经跑通" }).ok, true);
	assert.equal(squad.members.get("实现-A").note, "已经跑通");
	assert.equal(updateMember(state, squad, "实现-A", { status: "待派" }).ok, true, "允许回到待派（重派）");
	assert.equal(squad.members.get("实现-A").agentId, "sub-1", "改状态不该把已绑的 id 弄丢");

	// 改绑也要查重：加人拦了、改人不拦 = 白拦。不拦的话成员能把 id 改成别人的，
	// `squadOfMember` 首命中就歧义 —— 被冒名的人可能被解析到这一行，跨队隔离跟着破。
	assert.equal(updateMember(state, squad, "实现-A", { agentId: "sub-2" }).ok, false, "不能抢队内别人的 id");
	assert.equal(updateMember(state, squad, "实现-A", { agentId: "sub-3" }).ok, false, "跨队也不能抢别人的 id");
	assert.equal(squad.members.get("实现-A").agentId, "sub-1", "被拒之后原 id 不能动");
	assert.equal(squadOfMember(state, "sub-3").squad.name, "另一个", "反查仍然指回它真正所在的那个队");
	assert.equal(updateMember(state, squad, "实现-A", { agentId: "sub-1" }).ok, true, "改成自己已有的同一个 id = 幂等");
	assert.equal(updateMember(state, squad, "实现-A", { agentId: "sub-9" }).ok, true, "换成没人用的 id 可以");
	assert.equal(squad.members.get("实现-A").agentId, "sub-9");
	assert.equal(squadOfMember(state, "sub-9").squad.name, "登录改造");
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
	addMember(state, squad, { label: "实现-A", role: "实现", task: "t", agentId: "sub-1" });
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
	assert.equal(updateMember(state, squad, "实现-A", { status: "完成" }).ok, false, "收队后不能再改成员");
	assert.equal(squad.members.get("实现-A").status, "在跑", "被拒之后状态不能变（绑了 id 就是「在跑」）");
	assert.equal(addMember(state, squad, { label: "实现-B", role: "实现", task: "t" }).ok, false, "收队后不能再加人");
	assert.equal(squad.members.size, 1);
	assert.equal(closeSquad(squad, "再关一次").ok, false, "已经关了");
	assert.equal(closeSquad(fixture().squad, undefined).ok, true, "理由可以不写");
});

// ── 2. 权限 ────────────────────────────────────────────────────────────────

check("权限：所有者 / 成员 / 外人三种视角", () => {
	const { state, owner, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", agentId: "sub-1" });

	const asOwner = authorize(state, owner, "登录改造");
	assert.equal(asOwner.ok, true);
	assert.equal(asOwner.asOwner, true);
	assert.equal(asOwner.member, undefined, "所有者不是成员");

	const asMember = authorize(state, "sub-1", "登录改造");
	assert.equal(asMember.ok, true);
	assert.equal(asMember.asOwner, false);
	assert.equal(asMember.member.label, "实现-A");

	assert.equal(authorize(state, "外人", "登录改造").ok, false, "外人不能看别人的队");
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

check("快照：snapshot 只给自己的队；snapshotAll 给全部并带上所有者", () => {
	const { state, owner, squad } = fixture();
	addMember(state, squad, { label: "实现-A", role: "实现", task: "改代码", agentId: "sub-1" });
	appendBoard(squad, { from: "主 agent", text: "开始" }, SQUAD_DEFAULTS.boardLimit);
	const other = newSquad(state, "o2", { name: "另一个", objective: "z" }).squad;
	addMember(state, other, { label: "调研-B", role: "调研", task: "查" });

	const mine = snapshot(state, owner);
	assert.equal(mine.squads.length, 1, "所有者只看得到自己的队");
	assert.equal(mine.squads[0].name, "登录改造");
	assert.equal(mine.squads[0].members[0].agentId, "sub-1");
	assert.equal(mine.squads[0].board[0].from, "主 agent");

	const asMember = snapshot(state, "sub-1");
	assert.equal(asMember.squads.length, 1, "成员也只看得到自己那个队");

	assert.equal(snapshot(state, "外人").squads.length, 0, "外人一条都看不到");
	assert.equal(snapshot(state, undefined).squads.length, 0);

	const all = snapshotAll(state);
	assert.equal(all.count, 2, "面板要的是全量");
	assert.deepEqual(all.squads.map((s) => s.name).sort(), ["另一个", "登录改造"]);
	assert.ok(all.squads.every((s) => typeof s.owner === "string" && s.owner !== ""), "全量快照必须带所有者，否则面板分不清是谁的队");
	assert.equal(structuredClone(all).count, 2, "快照必须能无损过结构化克隆（面板要 JSON 序列化它）");
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

function fakeCtx({ services = ["tools", "webServer"], logger = () => {} } = {}) {
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
	};
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
	return { squad, record, tools, call };
};

await checkAsync("工具：建队 → 加人 → 成员自己写黑板/改自己那行 → 所有者收队", async () => {
	const { squad, call, record } = install();
	assert.deepEqual(Object.keys(record.tools).length, 6);
	assert.deepEqual(
		record.tools.map((t) => t.name).sort(),
		["squad_add", "squad_board", "squad_close", "squad_new", "squad_status", "squad_update"],
	);

	const created = await call("squad_new", { name: "登录改造", objective: "把登录改成 OAuth" }, "main-1");
	assert.match(created, /已建小队「登录改造」/);
	const added = await call("squad_add", { squad: "登录改造", member: "实现-A", role: "实现", task: "改代码", agent_id: "sub-1", worktree: "/tmp/wt-a" }, "main-1");
	assert.match(added, /实现-A/);
	assert.match(added, /id=sub-1/);

	// 成员自己（caller = sub-1）写黑板：作者必须是它的成员名，不能是「主 agent」
	const memberWrote = await call("squad_board", { squad: "登录改造", text: "改完了，e2e 过了" }, "sub-1");
	assert.match(memberWrote, /实现-A/, "成员写的要署成员的名");
	const ownerWrote = await call("squad_board", { squad: "登录改造", text: "收到" }, "main-1");
	assert.match(ownerWrote, /主 agent/);

	const memberUpdated = await call("squad_update", { squad: "登录改造", member: "实现-A", status: "完成", note: "已跑通" }, "sub-1");
	assert.match(memberUpdated, /完成/);
	assert.match(await call("squad_status", { squad: "登录改造" }, "main-1"), /实现-A/);
	assert.match(await call("squad_close", { squad: "登录改造", reason: "目标达成" }, "main-1"), /已关掉小队/);

	// 状态确实进了 state（工具不是自己另存一份）
	assert.equal(squad.state.get("main-1").get("登录改造").members.get("实现-A").status, "完成");
});

await checkAsync("工具：权限负例 —— 外人看不到、成员改不了别人那行、成员关不了队", async () => {
	const { call } = install();
	await call("squad_new", { name: "队", objective: "目标" }, "main-1");
	await call("squad_add", { squad: "队", member: "实现-A", role: "实现", task: "t", agent_id: "sub-1" }, "main-1");
	await call("squad_add", { squad: "队", member: "实现-B", role: "实现", task: "t", agent_id: "sub-2" }, "main-1");

	assert.match(await call("squad_status", { squad: "队" }, "外人"), /\[失败\]/, "外人不能看别人的队");
	assert.match(await call("squad_board", { squad: "队", text: "我插一句" }, "外人"), /\[失败\]/);
	assert.match(await call("squad_update", { squad: "队", member: "实现-B", status: "完成" }, "sub-1"), /\[失败\]/, "成员不能改别人那行");
	// `agent_id` 是身份字段：成员能改的话，就能把自己那行绑到任意 id 上（`addMember`
	// 只查「有没有被别人占」，查不了「这个 id 是不是真的是你」）= 自己造一个身份。
	assert.match(await call("squad_update", { squad: "队", member: "实现-A", agent_id: "别人的会话 id" }, "sub-1"), /\[失败\]/, "成员不能绑 agent_id");
	assert.match(await call("squad_update", { squad: "队", member: "实现-A", status: "完成", note: "我跑完了" }, "sub-1"), /完成/, "但状态和结论随便改");
	assert.match(await call("squad_update", { squad: "队", member: "实现-B", agent_id: "sub-3" }, "main-1"), /sub-3|实现-B/, "所有者能绑");
	// 收队 = 只读：所有写口都要拒
	await call("squad_close", { squad: "队", reason: "完了" }, "main-1");
	assert.match(await call("squad_board", { squad: "队", text: "收队后再写一条" }, "main-1"), /\[失败\]/, "收队后不能写黑板");
	assert.match(await call("squad_board", { squad: "队", text: "成员再写一条" }, "sub-1"), /\[失败\]/);
	assert.match(await call("squad_update", { squad: "队", member: "实现-A", status: "卡住" }, "sub-1"), /\[失败\]/, "收队后不能改成员");
	assert.match(await call("squad_add", { squad: "队", member: "实现-C", role: "实现", task: "t" }, "main-1"), /\[失败\]/, "收队后不能加人");
	assert.match(await call("squad_status", { squad: "队" }, "main-1"), /实现-A/, "但还看得到（收队不删数据）");
	assert.match(await call("squad_add", { squad: "队", member: "X", role: "实现", task: "t" }, "sub-1"), /\[失败\]/, "成员不能加人");
	assert.match(await call("squad_close", { squad: "队" }, "sub-1"), /\[失败\]/, "成员不能关队");
	assert.match(await call("squad_new", { name: "队", objective: "重名" }, "main-1"), /\[失败\]/);
	// 失败一律是「一段文本」，不是抛异常
	assert.match(await call("squad_status", { squad: "不存在" }, "main-1"), /\[失败\]/);
	// 空/纯空白的队名：schema 的 `required` 挡不住空串。曾经 authorize 给所有者返回了
	// 一个没有 squad 的成功 → 这四个工具当场 TypeError（不是「友好失败」）。
	for (const name of ["", "   ", "\t\n"]) {
		assert.match(await call("squad_board", { squad: name, text: "x" }, "main-1"), /\[失败\]/, `squad_board 收到 ${JSON.stringify(name)} 要友好拒`);
		assert.match(await call("squad_add", { squad: name, member: "X", role: "实现", task: "t" }, "main-1"), /\[失败\]/);
		assert.match(await call("squad_update", { squad: name, member: "实现-A", status: "完成" }, "main-1"), /\[失败\]/);
		assert.match(await call("squad_close", { squad: name }, "main-1"), /\[失败\]/);
	}
});

await checkAsync("工具：squad_status 点名 = 只看那一个（不是「点名等于不点名」）", async () => {
	const { call } = install();
	await call("squad_new", { name: "甲", objective: "a" }, "main-1");
	await call("squad_new", { name: "乙", objective: "b" }, "main-1");
	const one = await call("squad_status", { squad: "甲" }, "main-1");
	assert.match(one, /甲/);
	assert.doesNotMatch(one, /乙/, "点名了就别把别的队也倒出来");
	assert.match(await call("squad_status", { squad: "乙" }, "main-1"), /乙/);
	// 成员点名自己的队照样只看那一个
	await call("squad_add", { squad: "甲", member: "实现-A", role: "实现", task: "t", agent_id: "sub-1" }, "main-1");
	assert.match(await call("squad_status", { squad: "甲" }, "sub-1"), /实现-A/);
	assert.doesNotMatch(await call("squad_status", { squad: "甲" }, "sub-1"), /乙/);
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

// ── 5. 装配 ────────────────────────────────────────────────────────────────

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

// ── 6. HTTP 路由 + 信任栅栏 ────────────────────────────────────────────────

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

// ── 7. 客户端面板 ──────────────────────────────────────────────────────────

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
	const opened = [];
	const ctx = {
		uiWorkspace: { openSession: (target) => opened.push(target) },
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
	return { ctx, record, opened };
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
const textsOf = (node) => {
	const out = [];
	walk(node, (n) => {
		if (typeof n.props?.children === "string") out.push(n.props.children);
	});
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
				{ label: "实现-A", role: "实现", task: "改代码", status: "在跑", note: "已改完一半", agentId: "sub-1", worktree: "/tmp/wt-a" },
				{ label: "调研-B", role: "调研", task: "查上游", status: "待派", note: null, agentId: null, worktree: null },
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
	assert.ok(fresh !== null, "渲染不该返回空");
});

await checkAsync("客户端面板：「进入会话」把 agentId 交给 uiWorkspace；没绑 id 时按钮禁用", async () => {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const { ctx, record, opened } = fakeClientCtx();
	const tree = await withFetch(
		async (url) => (url.endsWith("/squads") ? reply(200, SQUAD_FIXTURE)() : reply(200, { ok: true, boardLimit: 500 })()),
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

	// 两个成员各有一个「进入会话」按钮：绑了 id 的那个可点，没绑的禁用
	const buttons = findButtons(tree, "进入会话");
	assert.equal(buttons.length, 2, "每个成员一个按钮");
	const enabled = buttons.filter((b) => b.props.disabled !== true);
	const disabled = buttons.filter((b) => b.props.disabled === true);
	assert.equal(enabled.length, 1, "只有绑了 agentId 的成员能点进去");
	assert.equal(disabled.length, 1, "没绑 id 的成员按钮必须禁用（点了也没地方去）");

	enabled[0].props.onClick();
	assert.deepEqual(opened, ["sub-1"], "必须把子会话 id 原样交给 uiWorkspace.openSession");
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
	assert.match(texts, /不落盘/, "顺手说清寿命：只在当前会话");
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

if (failures > 0) {
	console.log(`\n✗ ${failures} 项失败`);
	process.exit(1);
}
console.log("✓ 自检通过：名册与黑板 / 权限三种视角 / 快照 / 6 个工具真跑（返回值过 schema）/ 装配与会话清理 / HTTP 路由与信任栅栏负例 / 真 socket 端到端（路由挂载 + prefix 匹配）/ 客户端面板真渲染与进入会话");
