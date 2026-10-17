#!/usr/bin/env node
/**
 * 自检：出处过滤（REQ-018 的 ②）。
 *
 * 四段：
 *   1. 纯函数：`distinctiveTokens`（挑可查标识，纯数字不算）/ `parseCheckpoint`（条目 vs 结构）
 *   2. 过滤本身：删无出处的、留有出处的、写清删了几条
 *   3. **安全闸**：查不了就留、删太多就整段放弃（混合场景只删该删的那条）
 *   4. **装配**：pre-step / request-error 真的把 surface 上的 checkpoint 节点换掉（surfaceOp replace）、
 *      幂等、只碰 checkpoint、waterfall 契约、缺服务/已中止不动、拿不到 freezeMessage 也不静默失效
 *
 * 为什么这几条必须钉住：这个功能的破坏面是**上下文本身** —— 删错一条，模型就永远看不到它了。
 * 所以「宁可不删」的三条约束（只碰 checkpoint / 查不了就留 / 删太多放弃）都要有断言守着。
 *
 *   node scripts/selftest-context-filter.mjs
 */
import * as assert from "node:assert/strict";
import {
	distinctiveTokens,
	isCheckpointEvent,
	filterCheckpointText,
	installContextFilter,
	messageText,
	parseCheckpoint,
	SUPPORT_TOKENS_PER_ENTRY,
} from "../lib/context-filter.js";

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures += 1;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
	} catch (error) {
		failures += 1;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

const ckpt = (body) =>
	`This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n<compacted-summary>${body}</compacted-summary>\n\n继续干活。`;

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

check("distinctiveTokens：挑标识符/路径，纯数字不算，去重且限量", () => {
	// 候选要**给够**（超过 SUPPORT_TOKENS_PER_ENTRY）—— 否则「限量」那句断言是空的（变异测不出来）
	const t = distinctiveTokens(
		"- 改了 lib/squad-round.js，把 startMember 和 appendBoard 与 roleToolsFor 都动了，还有 lib/util.js 和 scripts/selftest-squad.mjs（见 REQ-017）",
	);
	assert.ok(t.includes("scripts/selftest-squad.mjs"), `要挑出路径，实际 ${JSON.stringify(t)}`);
	assert.ok(t.includes("lib/squad-round.js"), "要挑出路径");
	assert.ok(!t.includes("1234567"), "纯数字不当证据");
	// 限量的守门员：候选给够时，返回的条数必须**正好**是上限（变异：去掉 slice → 变红）
	assert.equal(t.length, SUPPORT_TOKENS_PER_ENTRY, `要限量，实际 ${JSON.stringify(t)}`);
	assert.ok(t.every((x) => x.length >= 6), "太短的不要");
	assert.deepEqual(distinctiveTokens("- 都是短词 a b c"), [], "太短的不算");
	assert.deepEqual(distinctiveTokens(""), []);
});

check("parseCheckpoint：不是 checkpoint 就返回 null；条目含续行，标题算结构", () => {
	assert.equal(parseCheckpoint("普通用户消息"), null);
	assert.equal(parseCheckpoint("<compacted-summary>没有闭合"), null);
	const p = parseCheckpoint(ckpt("\n## 标题\n- 第一条\n  续行还在第一条里\n- 第二条\n\n散文\n"));
	assert.ok(p, "要能解析");
	const kinds = p.blocks.map((b) => b.kind);
	// 结尾的空行也算一块（它照样原样保留）—— 所以是 7 块不是 6 块
	assert.deepEqual(kinds, ["other", "other", "entry", "entry", "other", "other", "other"], `实际 ${JSON.stringify(kinds)}`);
	assert.match(p.blocks[2].text, /续行还在第一条里/, "续行要归到同一条");
});

// ── 2. 过滤本身 ─────────────────────────────────────────────────────────────

await checkAsync("过滤：删掉无出处的条目、留有出处的、并写清删了几条", async () => {
	const text = ckpt("\n- 有出处的条目 lib/util.js\n- 没出处的条目 幻觉模块/xyz.js\n- 另一条有出处的 lib/index.js\n");
	const out = await filterCheckpointText(text, async (entry) => !entry.includes("幻觉"));
	assert.match(out.text, /lib\/util\.js/, "有出处的要留");
	assert.match(out.text, /lib\/index\.js/, "有出处的要留");
	assert.doesNotMatch(out.text, /幻觉模块/, "无出处的要删");
	assert.match(out.text, /删掉了 1 条/, "要写清删了几条（显式丢失标记）");
	assert.match(out.text, /session_recall/, "要告诉模型原文去哪取");
	assert.equal(out.dropped, 1);
	assert.equal(out.checked, 3);
	assert.match(out.text, /<\/compacted-summary>/, "闭合标签要留着");
});

await checkAsync("过滤：全都有出处 → 一个字节都不动（连标记都不加）", async () => {
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 lib/b.js\n");
	const out = await filterCheckpointText(text, async () => true);
	assert.equal(out.text, text);
	assert.equal(out.dropped, 0);
});

await checkAsync("过滤：没有条目（只有散文）→ 原样返回", async () => {
	const text = ckpt("\n这是一段没有条目的散文。\n");
	const out = await filterCheckpointText(text, async () => false);
	assert.equal(out.text, text);
	assert.equal(out.checked, 0);
});

// ── 3. 安全闸 ───────────────────────────────────────────────────────────────

await checkAsync("安全闸：查不了（isSupported 抛错）→ 留，不当成无出处", async () => {
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 lib/b.js\n");
	const out = await filterCheckpointText(text, async () => {
		throw new Error("检索挂了");
	});
	assert.equal(out.text, text, "查不了就不许删");
	assert.equal(out.dropped, 0);
});

await checkAsync("安全闸：要删的超过一半 → 整段放弃过滤并标记 aborted", async () => {
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 lib/b.js\n- 丙 lib/c.js\n- 丁 lib/d.js\n");
	const out = await filterCheckpointText(text, async () => false);
	assert.equal(out.text, text, "删太多就整段别删");
	assert.equal(out.dropped, 0);
	assert.equal(out.aborted, true, "要标记放弃过（好记一笔）");
});

await checkAsync("安全闸：混合场景（有的无出处、有的查不了）→ 只删无出处的那条，不是整段放弃", async () => {
	// 这条是 catch 里 `ok = true` 的守门员：改成 false 就会多删一条（dropped 从 1 变 2）。
	const text = ckpt("\n- 甲 lib/a.js\n- 乙 hallucinated/x.js\n- 丙 boom/throw.js\n- 丁 lib/d.js\n");
	const out = await filterCheckpointText(text, async (entry) => {
		if (entry.includes("boom")) throw new Error("这条查不了");
		return !entry.includes("hallucinated");
	});
	assert.equal(out.dropped, 1, `只该删无出处那条，实际删了 ${out.dropped}`);
	assert.doesNotMatch(out.text, /hallucinated/);
	assert.match(out.text, /boom\/throw\.js/, "查不了的要留");
	assert.equal(out.aborted, undefined, "没超过一半就不该放弃");
});


check("isCheckpointEvent：真实形状是**块数组**（日志实测），字符串兜底，别的类型一律 false", () => {
	// 真实事件长这样（本机会话日志实测）：data={content:[{type:'text',text},…],source,role,id}
	const asBlocks = { type: "user/message", data: { role: "user", source: "compaction", content: [{ type: "text", text: ckpt("\n- 甲\n") }] } };
	assert.equal(isCheckpointEvent(asBlocks), true, "块数组那条是主力，必须认");
	const asString = { type: "user/message", data: { content: ckpt("\n- 甲\n") } };
	assert.equal(isCheckpointEvent(asString), true, "字符串兜底");
	assert.equal(isCheckpointEvent({ type: "user/message", data: { content: "普通消息" } }), false);
	assert.equal(isCheckpointEvent({ type: "tool/result", data: { content: ckpt("x") } }), false, "别的类型一律不是");
	assert.equal(isCheckpointEvent({ type: "user/message", data: {} }), false);
	assert.equal(isCheckpointEvent(undefined), false);
	// 混在别的块里的文本也要能认出来
	const mixed = { type: "user/message", data: { content: [{ type: "image" }, { type: "text", text: ckpt("x") }] } };
	assert.equal(isCheckpointEvent(mixed), true);
});

// ── 4. 装配：surfaceOp replace（这一节才是「缝」的守门员）─────────────────────
//
// 假替身照**真实 API** 造（先例 dsh-compaction-tool-result-pruner:139-177）：
//   surface.nodes 是 Set（那边用 [...nodes] 展开）、eventAt(seq)、deriveEventMessage(event)、
//   append(type, data, { surfaceOp, sourceEventSeqs })。
// 上一版接线挂错缝（agent/pre-step 的 decision）时这一节不存在，所以套件全绿也说明不了什么 ——
// 现在它在了：钩子必须真的**改到 surface 上那份数据**。

function fakeSession({ id = "sess-1", startSeq = 100, nodes = [] } = {}) {
	const surface = { nodes: [] }; // 宿主是数组（surface.js:186，靠 push/splice/indexOf），不是 Set
	const events = new Map();
	const appends = [];
	let nextSeq = startSeq;
	const session = {
		id,
		surface,
		events,
		appends,
		eventAt: (seq) => events.get(seq),
		// 照**真实投影**（dsh-session/lib/types/surface.js:75-105）：user/message → data；
		// tool/result → data.message；空 content 的投成 null。别按想象简化 —— 上一版这里
		// 直接返回 data，于是 tool/result 节点根本走不到 messageText，type 守卫的变异咬不住。
		deriveEventMessage: (event) => {
			if (event.type === "user/message") return event.data;
			const message = event.data?.message ?? null;
			// 空 content 投成 null 只对 system/developer/assistant（surface.js:75-105）——
			// 对 tool/result 也这么做是「假替身自己发明规则」。
			const emptyIsNull = event.type === "system/message" || event.type === "developer/message" || event.type === "assistant/message";
			if (emptyIsNull && message && Array.isArray(message.content) && message.content.length === 0) return null;
			return message;
		},
		append(type, data, opts) {
			const event = {
				seq: nextSeq++,
				type,
				data,
				...(opts ? { surfaceOp: opts.surfaceOp, sourceEventSeqs: opts.sourceEventSeqs } : {}),
			};
			events.set(event.seq, event);
			appends.push({ type, data, opts, seq: event.seq });
			if (opts?.surfaceOp?.op === "replace") {
				const at = surface.nodes.indexOf(opts.surfaceOp.startSeq);
				if (at >= 0) surface.nodes.splice(at, 1);
			}
			surface.nodes.push(event.seq);
			return event;
		},
	};
	for (const node of nodes) {
		events.set(node.seq, node);
		surface.nodes.push(node.seq);
	}
	return session;
}

const checkpointNode = (seq, body) => ({
	seq,
	type: "user/message",
	data: { role: "user", source: "compaction", id: `ckpt-${seq}`, content: ckpt(body) },
});

/** 假 ctx：捕获两个 waterfall 监听器；loader.import 供 makeHostLoader 用。 */
function fakeCtx({ engine, freeze = true } = {}) {
	const listeners = new Map();
	const ctx = {
		logger: { info: () => {} },
		on(event, listener) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(listener);
			return () => listeners.get(event)?.splice(listeners.get(event).indexOf(listener), 1);
		},
		get: (name) => (name === "sessionQuery" ? engine : undefined),
		loader: {
			import: async () => (freeze ? { freezeMessage: (message) => Object.freeze(message) } : {}),
		},
	};
	const fire = async (event, payload, next = async () => ({ kind: "enter" })) => {
		const chain = listeners.get(event) ?? [];
		let decision;
		let i = 0;
		const step = async () => {
			if (i >= chain.length) return next();
			const listener = chain[i];
			i += 1;
			return listener(payload, step);
		};
		decision = await step();
		return decision;
	};
	return { ctx, fire, listeners };
}

/**
 * 假检索：语料是**事件文档列表**，并且**真的按 filters 过滤**。
 *
 * 为什么必须这样：上一版把语料写成外部字符串、且忽略 filters，于是「只认环境输出」这个修复
 * 根本测不出来 —— checkpoint 自己就在日志里（`user/message`，正文即摘要），
 * 不按类型过滤时它会给自己的每条条目当证据，过滤器在真实宿主里就是空操作而套件全绿。
 */
const searchEngine = (docs) => ({
	calls: 0,
	lastFilters: undefined,
	async searchEvents({ query, filters }) {
		this.calls += 1;
		this.lastFilters = filters;
		const allowed = (doc) =>
			!filters || filters.every((f) => f.kind !== "type" || f.values.includes(doc.type));
		return {
			items: docs
				.filter((doc) => allowed(doc) && doc.text.includes(query))
				.map((doc) => ({ seq: doc.seq, type: doc.type, snippet: doc.text.slice(0, 40) })),
		};
	},
});

/** 造语料：默认全是环境输出（tool/result）。 */
const envDocs = (text) => [{ seq: 1, type: "tool/result", text }];

await checkAsync("事件触发：checkpoint 刚落盘就换（这条与注册顺序无关，是主力）", async () => {
	// 为什么必须有这条：waterfall 按注册顺序跑，而本包是 profile bundle（启动时注册）、
	// compaction-basic 在预设里（后注册）→ 光靠 pre-step 会跑在压缩之前，晚一步。
	// 那时「刚压完、模型第一次看到摘要」的那次请求会看到没过滤的版本。
	const engine = searchEngine(envDocs("lib/real.js lib/util.js"));
	const session = fakeSession({ nodes: [] });
	const { ctx, listeners } = fakeCtx({ engine });
	installContextFilter(ctx);

	// 照宿主的顺序：先把 checkpoint append 进 surface，再发 session/event
	const node = checkpointNode(7, "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n");
	session.events.set(7, node);
	session.surface.nodes.push(7);

	const emit = listeners.get("session/event")?.[0];
	assert.ok(emit, "要挂上 session/event 监听");
	emit(session, node); // emit 是同步的，不是 waterfall
	assert.equal(session.appends.length, 0, "emit 回调里**不能**直接 append（append 不可重入）—— 要排微任务");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(session.appends.length, 1, "微任务里该把它换掉");
	assert.doesNotMatch(messageText(session.appends[0].data), /xyz\/module\.js/);
});

await checkAsync("事件触发：普通 user/message 事件什么都不做", async () => {
	const engine = searchEngine(envDocs("lib/real.js"));
	const session = fakeSession({ nodes: [] });
	const { ctx, listeners } = fakeCtx({ engine });
	installContextFilter(ctx);
	const node = { seq: 5, type: "user/message", data: { role: "user", content: "普通消息" } };
	session.events.set(5, node);
	session.surface.nodes.push(5);
	listeners.get("session/event")[0](session, node);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(session.appends.length, 0);
});

await checkAsync("装配：pre-step 真的换掉 surface 上的 checkpoint 节点（surfaceOp replace）", async () => {
	const engine = searchEngine(envDocs("lib/real.js"));
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 真 lib/real.js\n- 假 hallucinated/module.js\n")] });
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } });
	assert.equal(session.appends.length, 1, `该换一次，实际 ${session.appends.length}`);
	const call = session.appends[0];
	assert.equal(call.type, "user/message");
	assert.deepEqual(call.opts.surfaceOp, { op: "replace", startSeq: 7, endSeq: 7 }, "必须是原地替换同一个节点");
	assert.deepEqual(call.opts.sourceEventSeqs, [7], "要记来源事件");
	const text = messageText(call.data);
	assert.match(text, /lib\/real\.js/, "有出处的留");
	assert.doesNotMatch(text, /hallucinated/, "无出处的删");
	assert.match(text, /删掉了 1 条/);
	assert.ok(session.surface.nodes.includes(call.seq), "新节点要进 surface");
	assert.ok(!session.surface.nodes.includes(7), "被替的节点要出 surface");
});

await checkAsync("P0 守门员：checkpoint 自己不算证据（只认环境输出）", async () => {
	// 独立测逮到的 P0：检索语料是本会话日志，而 **checkpoint 自己就是日志里的一条 user/message**
	// （正文即摘要）—— 不按类型过滤时，每条条目都能从自己身上找到「证据」，dropped 恒为 0，
	// 真实宿主里这个过滤器是**空操作**。这条用例把「只认 tool/result」钉住。
	const body = "\n- 真 lib/real.js\n- 假 hallucinated/module.js\n";
	const engine = searchEngine([
		{ seq: 1, type: "tool/result", text: "lib/real.js 的工具输出" },
		{ seq: 2, type: "user/message", text: ckpt(body) }, // checkpoint 自己也在语料里
	]);
	const session = fakeSession({ nodes: [checkpointNode(7, body)] });
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } });
	assert.equal(session.appends.length, 1, "该换一次");
	assert.doesNotMatch(messageText(session.appends[0].data), /hallucinated/, "只被 checkpoint 自己提到 → 不算有出处");
	assert.deepEqual(engine.lastFilters, [{ kind: "type", values: ["tool/result"] }], "必须只拿环境输出当证据");
});

await checkAsync("没有可查标识的条目 → 留（不许因为「查不到」就删）", async () => {
	// 混合：1 条没有可查标识 + 2 条有出处。这样「无标识 → 留」若被改成「→ 删」，
	// 只删 1/3（不触发整段放弃闸）→ 会真的发生替换 → 断言变红。
	// 上一版是「两条全无标识」，于是变异被整段放弃闸遮住、看不出区别。
	const engine = searchEngine(envDocs("lib/real.js lib/util.js"));
	const session = fakeSession({
		nodes: [checkpointNode(7, "\n- 短词 a b\n- 有出处 lib/real.js\n- 也有出处 lib/util.js\n")],
	});
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } });
	assert.equal(session.appends.length, 0, "没有可查标识 → 留，整段不该被改");
	assert.ok(engine.calls > 0, "有出处的条目照常检索（对照）");
});

await checkAsync("早退闸：缺服务 / 缺会话 id → 一次过滤都不做（不靠下游 fail-open 兜）", async () => {
	// 这两条闸以前没有独立断言：拆掉它们套件仍绿（下游 fail-open 会兜住结果）。所以这里看
	// **统计量**（checkpoints 计数）—— 只有真的没进过滤器才是 0。
	const body = "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n";

	const noEngine = fakeSession({ nodes: [checkpointNode(7, body)] });
	const a = fakeCtx({ engine: undefined });
	const handleA = installContextFilter(a.ctx);
	await a.fire("agent/pre-step", { agent: { session: noEngine }, signal: { aborted: false } });
	assert.equal(handleA.stats.checkpoints, 0, "缺服务时不该进过滤器");
	assert.equal(noEngine.appends.length, 0);

	const noId = fakeSession({ id: null, nodes: [checkpointNode(7, body)] });
	const engine = searchEngine(envDocs("lib/real.js lib/util.js"));
	const b = fakeCtx({ engine });
	const handleB = installContextFilter(b.ctx);
	await b.fire("agent/pre-step", { agent: { session: noId }, signal: { aborted: false } });
	assert.equal(handleB.stats.checkpoints, 0, "缺会话 id 时不该进过滤器");
	assert.equal(engine.calls, 0, "拿不到会话 id 就不该发检索");
	assert.equal(noId.appends.length, 0);
});

await checkAsync("装配：幂等 —— 第二遍不再换（过滤过的内容全部有出处）", async () => {
	const engine = searchEngine(envDocs("lib/real.js"));
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 真 lib/real.js\n- 假 hallucinated/module.js\n")] });
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	const payload = { agent: { session }, signal: { aborted: false } };
	await fire("agent/pre-step", payload);
	await fire("agent/pre-step", payload);
	await fire("agent/pre-step", payload);
	assert.equal(session.appends.length, 1, `只该换一次，实际 ${session.appends.length}`);
});

await checkAsync("装配：只碰 checkpoint —— 普通消息与 tool/result 一个都不换", async () => {
	const engine = searchEngine(envDocs("lib/real.js lib/util.js"));
	const session = fakeSession({
		nodes: [
			{ seq: 1, type: "user/message", data: { role: "user", content: "普通消息" } },
			{ seq: 2, type: "tool/result", data: { message: { content: [{ type: "text", text: "工具输出" }] } } },
			// 工具输出里**真的会**带着摘要块（比如 session_recall 把日志打出来）—— 它绝不能
			// 被换成 user/message（那是改节点类型，不是改内容）。这条是 type 守卫的守门员。
			{ seq: 4, type: "tool/result", data: { message: { content: [{ type: "text", text: ckpt("\n- 无出处 xyz/module.js\n- 有出处 lib/real.js\n- 也有出处 lib/util.js\n") }] } } },
			checkpointNode(3, "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n"),
		],
	});
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } });
	assert.equal(session.appends.length, 1, `只该换一次，实际 ${session.appends.length}`);
	assert.equal(session.appends[0].opts.surfaceOp.startSeq, 3, "只该换 checkpoint 那条");
	assert.doesNotMatch(messageText(session.appends[0].data), /xyz\/module\.js/, "无出处的删了");
	assert.ok(!session.appends.some((a) => a.opts.surfaceOp.startSeq === 4), "tool/result 节点绝不能被换（那会改节点类型）");
});

await checkAsync("装配：waterfall 契约 —— 钩子必须 return next() 的返回值，且自己不抛", async () => {
	const engine = { async searchEvents() { throw new Error("DB 锁了"); } };
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 甲 lib/a.js\n- 乙 lib/b.js\n")] });
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	const decision = { kind: "enter", messages: [{ role: "user", content: "x" }] };
	const out = await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } }, async () => decision);
	assert.equal(out, decision, "decision 必须原样传下去（链不能断）");
	assert.equal(session.appends.length, 0, "检索挂了就不许改");
});

await checkAsync("装配：缺 sessionQuery → 一次都不换；signal 已中止 → 也不换", async () => {
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n")] });
	const { ctx, fire } = fakeCtx({ engine: undefined });
	installContextFilter(ctx);
	await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } });
	assert.equal(session.appends.length, 0, "缺服务时不许动");
	// 正向对照：同样的输入，有服务时**一定**会换 —— 否则上面那条「0」是空的
	const control = fakeSession({ nodes: [checkpointNode(7, "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n")] });
	const controlCtx = fakeCtx({ engine: searchEngine(envDocs("lib/real.js lib/util.js")) });
	installContextFilter(controlCtx.ctx);
	await controlCtx.fire("agent/pre-step", { agent: { session: control }, signal: { aborted: false } });
	assert.equal(control.appends.length, 1, "有服务时必须换（正向对照）");

	const engine = searchEngine(envDocs(""));
	const session2 = fakeSession({ nodes: [checkpointNode(7, "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n")] });
	const second = fakeCtx({ engine });
	installContextFilter(second.ctx);
	await second.fire("agent/pre-step", { agent: { session: session2 }, signal: { aborted: true } });
	assert.equal(session2.appends.length, 0, "已中止就别干活");
	assert.equal(engine.calls, 0, "已中止时一次检索都不该发");
});

await checkAsync("装配：拿不到宿主 freezeMessage → 退回 Object.freeze，照样换（不静默失效）", async () => {
	const engine = searchEngine(envDocs("lib/real.js"));
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 真 lib/real.js\n- 假 hallucinated/module.js\n")] });
	const { ctx, fire } = fakeCtx({ engine, freeze: false });
	const handle = installContextFilter(ctx);
	await fire("agent/pre-step", { agent: { session }, signal: { aborted: false } });
	assert.equal(session.appends.length, 1, "拿不到 freezeMessage 也要换");
	assert.ok(Object.isFrozen(session.appends[0].data), "退回 Object.freeze");
	assert.equal(handle.stats.rewrites, 1);
});

await checkAsync("装配：agent/request-error 也触发（overflow 重试不重跑 pre-step）", async () => {
	const engine = searchEngine(envDocs("lib/real.js"));
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 真 lib/real.js\n- 假 hallucinated/module.js\n")] });
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	await fire("agent/request-error", { agent: { session }, failure: { code: "context-window-exceeded" }, signal: { aborted: false } });
	assert.equal(session.appends.length, 1, "overflow 那条路也要过滤");
});

await checkAsync("装配：并发调用不重复换（append 不可重入，防重入闸）", async () => {
	const engine = {
		calls: 0,
		async searchEvents({ query }) {
			this.calls += 1;
			await new Promise((r) => setTimeout(r, 5));
			return { items: query.startsWith("lib/") ? [{ seq: 1, snippet: "命中" }] : [] };
		},
	};
	const session = fakeSession({ nodes: [checkpointNode(7, "\n- 有出处 lib/real.js\n- 无出处 xyz/module.js\n- 也有出处 lib/util.js\n")] });
	const { ctx, fire } = fakeCtx({ engine });
	installContextFilter(ctx);
	const payload = { agent: { session }, signal: { aborted: false } };
	await Promise.all([fire("agent/pre-step", payload), fire("agent/pre-step", payload)]);
	assert.equal(session.appends.length, 1, `并发下只该换一次，实际 ${session.appends.length}`);
});

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：出处过滤（纯函数 / 过滤与标记 / 安全闸 / surfaceOp replace 装配）");
}
