#!/usr/bin/env node
/**
 * 自检：会话交接。
 *
 * 盯的是四条，按「错了会怎样」排序：
 *   1. **触发条件必须精确**：只有 `agent/error` + `CONTEXT_WINDOW_EXCEEDED`
 *      才交接。别的错误（限流、断网、认证）也跟着交接 = 用户正常会话被无故打断。
 *   2. **一个会话只交一次**：新会话万一又溢出，不能无限建会话。
 *   3. **顺序与内容对**：文档要落到 storages/handoffs 且含未完成任务；注入的文本
 *      必须短（它一进去就是新会话第一条消息）；旧会话要收到一条指向新会话的提示。
 *   4. **降级不炸**：没有 sessionController（精简 profile）时整块关掉；建会话失败
 *      时仍写真文档 + 在旧会话里给出可手工执行的出路。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-handoff-"));
process.env.DSH_HOME = tempHome;

const { collectHandoff, installHandoff, renderHandoffDoc, renderHandoffPrompt, splitTodos } = await import(
	new URL("../lib/handoff.js", import.meta.url).href
);

// ── 0. 纯函数：从事件流回收未完成任务 ────────────────────────────────────────

{
	// 最后一条「用户」消息才是原始请求；中间那条 plugin 注入的不算
	const { request, todos } = collectHandoff([
		{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第一句" }] } },
		{ type: "todo/write", data: { todos: [{ content: "旧的", status: "pending" }] } },
		{ type: "user/message", data: { source: { kind: "plugin" }, content: [{ type: "text", text: "注入的" }] } },
		{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "最后一句" }] } },
		{ type: "todo/write", data: { todos: [{ content: "新的", status: "in_progress" }] } },
	]);
	assert.equal(request, "最后一句", "原始请求取的应该是最后一条用户消息，不是 plugin 注入的");
	assert.equal(todos.length, 1, "todo 快照应取最后一条 todo/write");
	assert.equal(todos[0].content, "新的", "todo 快照不是最后一条");

	// 跨 turn 的旧清单仍要保留（dsh 自己的 backscanTodos 会在 turn/start 处停，
	// 那是给 UI 显示「当前计划」的语义；交接要的是「干到哪了」）
	const acrossTurn = collectHandoff([
		{ type: "todo/write", data: { todos: [{ content: "跨 turn 的活", status: "pending" }] } },
		{ type: "turn/start", data: { turn: 2 } },
	]);
	assert.equal(acrossTurn.todos.length, 1, "交接应该保留跨 turn 的 todo（否则丢掉未完成的活）");

	// 事件里没有 todo 时不能编
	assert.deepEqual(collectHandoff([{ type: "user/message", data: { source: { kind: "user" }, content: [] } }]).todos, []);

	// 空/坏数据不许抛
	assert.deepEqual(collectHandoff([]), { request: "", todos: [], agentPreset: undefined });
	assert.deepEqual(collectHandoff([null, undefined, { type: "todo/write" }]).todos, []);

	// preset：运行时切换过就以日志为准（header 只是「启动时那个」）
	assert.equal(
		collectHandoff([
			{ type: "agent-preset/selected", data: { agentPreset: "team" } },
			{ type: "agent-preset/selected", data: { agentPreset: "minimal" } },
		]).agentPreset,
		"minimal",
		"preset 该取最后一次切换",
	);
	assert.equal(collectHandoff([{ type: "user/message", data: { source: { kind: "user" }, content: [] } }]).agentPreset, undefined, "没切换过时不该编 preset");

	// content 是块数组，不是字符串
	assert.equal(
		collectHandoff([{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }]).request,
		"a\nb",
	);
}

// ── 1. 纯函数：文档与注入文本 ──────────────────────────────────────────────

{
	const todos = [
		{ content: "已完成的", status: "completed" },
		{ content: "干到一半的", status: "in_progress" },
		{ content: "还没动的", status: "pending" },
	];
	const { open, done } = splitTodos(todos);
	assert.deepEqual(open.map((t) => t.content), ["干到一半的", "还没动的"], "未完成 = pending + in_progress");
	assert.deepEqual(done.map((t) => t.content), ["已完成的"], "completed 归到已完成");

	const doc = renderHandoffDoc({
		sessionId: "session-old",
		cwd: "C:/work",
		newSessionId: "session-new",
		request: "把功能做完",
		todos,
		now: new Date(2026, 0, 2, 3, 4, 5),
		reason: "上下文超限",
		maxChars: 20000,
	});
	assert.ok(doc.includes("session-old"), "文档没写来源会话");
	assert.ok(doc.includes("session-new"), "文档没写新会话（不知道去哪接着干）");
	assert.ok(doc.includes("C:/work"), "文档没写工作目录");
	assert.ok(doc.includes("把功能做完"), "文档没带原始请求");
	assert.ok(doc.includes("干到一半的") && doc.includes("还没动的"), "文档漏了未完成任务");
	assert.ok(doc.includes("已完成的"), "文档没区分已完成（会被重做）");
	// 未完成必须排在已完成之前 —— 接手的人从上面开始读
	assert.ok(doc.indexOf("干到一半的") < doc.indexOf("已完成的"), "未完成应排在已完成之前");

	// 没有 todo 时也得有出路（不能输出空白让人干瞪眼）
	const bare = renderHandoffDoc({ sessionId: "s", todos: [], now: new Date(), reason: "r", maxChars: 9000 });
	assert.ok(bare.includes("原始请求"), "没有 todo 时至少要交代原始请求");
	assert.ok(bare.length > 100, "文档过短，可能是渲染坏了");

	// 注入文本必须短：它一进新会话就是第一条消息
	const prompt = renderHandoffPrompt({
		sessionId: "session-old",
		docFile: "C:/home/storages/handoffs/2026-01-02-session-old.md",
		request: "把功能做完",
		todos,
		maxChars: 6000,
	});
	assert.ok(prompt.includes("C:/home/storages/handoffs/"), "注入文本必须给出交接文档路径");
	assert.ok(prompt.includes("干到一半的"), "注入文本没带未完成任务");
	assert.ok(!prompt.includes("已完成的"), "注入文本不该带已完成任务（浪费新会话的上下文）");
	assert.ok(prompt.length < 2000, `注入文本太长（${prompt.length} 字符），会把新会话也顶爆`);

	// 上限真的生效（用户把 maxInjectChars 调小）
	assert.ok(
		renderHandoffPrompt({ sessionId: "s", docFile: "d", request: "x".repeat(9999), todos, maxChars: 500 }).length <= 500,
		"maxInjectChars 没生效",
	);
	assert.ok(renderHandoffDoc({ sessionId: "s", todos: [], now: new Date(), reason: "r", maxChars: 300 }).length <= 300, "maxDocChars 没生效");
}

// ── 2. 假 ctx：只提供 sessionController 一个可选服务 ────────────────────────

/** 最小假 ctx；`withController: false` 模拟没有 sessionController 的精简 profile */
function makeCtx({ withController = true } = {}) {
	const handlers = new Map();
	const logs = [];
	const created = [];
	const prompted = [];
	const ctx = {
		logger: {
			info: (m) => logs.push(["info", m]),
			warn: (m) => logs.push(["warn", m]),
			error: (m) => logs.push(["error", m]),
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		inject(deps, callback) {
			if (deps.includes("sessionController") && !withController) return () => {};
			callback({ ...ctx, logger: ctx.logger });
			return () => {};
		},
		_handlers: handlers,
		_logs: logs,
		_created: created,
		_prompted: prompted,
	};
	if (withController) {
		ctx.sessionController = {
			async create(request) {
				created.push(request);
				return { sessionId: `session-new-${created.length}` };
			},
			async prompt(request) {
				prompted.push(request);
				return { accepted: true };
			},
		};
	}
	return ctx;
}

/** 假 session：只实现 handoff 用到的读写 */
function makeSession({ id = "session-old", cwd = "C:/work", agentPreset, events = [] } = {}) {
	const appended = [];
	return {
		id,
		header: { id, cwd, createdAt: Date.now(), version: 3, isSeeded: false, ...(agentPreset === undefined ? {} : { agentPreset }) },
		snapshotEvents: () => events,
		append(type, data, opts) {
			appended.push({ type, data, opts });
			return { seq: appended.length };
		},
		_appended: appended,
	};
}

const overflow = (session) => ({ agent: { session }, error: Object.assign(new Error("context window exceeded"), { code: "CONTEXT_WINDOW_EXCEEDED" }) });

const SAMPLE_EVENTS = [
	{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "把交接功能做出来" }] } },
	{ type: "todo/write", data: { todos: [{ content: "写 lib/handoff.js", status: "completed" }, { content: "写自检", status: "in_progress" }] } },
];

// ── 3. 正常路径：溢出 → 建会话 + 写文档 + 注入 + 旧会话留提示 ────────────────

{
	const ctx = makeCtx();
	const handoff = installHandoff(ctx, { defaults: { enabled: true } });
	assert.ok(handoff.enabled, "默认应该开启");

	const listeners = ctx._handlers.get("agent/error");
	assert.equal(listeners?.length, 1, "没监听 agent/error");

	const session = makeSession({ events: SAMPLE_EVENTS });
	listeners[0](overflow(session));
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(ctx._created.length, 1, "应建一个新会话");
	assert.equal(ctx._created[0].cwd, "C:/work", "新会话没继承来源会话的工作目录");
	assert.equal(ctx._created[0].agentPreset, undefined, "没记录 preset 时不该编一个出来");
	assert.equal(ctx._prompted.length, 1, "应把任务注入新会话（不注入 = 新会话干等着）");
	assert.equal(ctx._prompted[0].sessionId, "session-new-1", "注入目标不是新会话");
	assert.equal(ctx._prompted[0].mode, "queue", "注入模式应为 queue");
	assert.ok(ctx._prompted[0].requestId, "prompt 需要 requestId 做幂等标识");
	const injectedText = ctx._prompted[0].content[0].text;
	assert.equal(ctx._prompted[0].content[0].type, "text", "注入内容必须是 text 块");
	assert.ok(injectedText.includes("写自检"), "注入文本没带未完成任务");
	assert.ok(!injectedText.includes("写 lib/handoff.js"), "注入文本带了已完成任务（浪费新会话上下文）");

	// 文档落盘
	const files = fs.readdirSync(handoff.dir);
	assert.equal(files.length, 1, `应写一份交接文档，实际 ${files} —— 落点：${handoff.dir}`);
	const docPath = path.join(handoff.dir, files[0]);
	assert.ok(files[0].includes("session-old"), "文档名应含来源会话 id（否则撞名覆盖）");
	const doc = fs.readFileSync(docPath, "utf8");
	assert.ok(doc.includes("session-new-1"), "文档没写新会话 id");
	assert.ok(doc.includes("把交接功能做出来"), "文档没带原始请求");
	assert.ok(doc.includes("写自检"), "文档没带未完成任务");
	assert.ok(injectedText.includes(docPath), "注入文本应指向这篇文档");

	// 旧会话留提示
	assert.equal(session._appended.length, 1, "旧会话应收到一条提示");
	const notice = session._appended[0];
	assert.equal(notice.type, "user/message", "只能用 user/message（system/message 需要 open step，此时 turn 已闭合）");
	assert.equal(notice.opts?.surfaceOp, "append", "必须带 surfaceOp: append（surface-eligible 事件不带标记会抛）");
	assert.equal(notice.data.source?.kind, "plugin", "source.kind 必须是 plugin —— 否则 UI 会当成用户发言");
	assert.notEqual(notice.data.source?.kind, "user", "source.kind=user 会被 UI 渲染成用户发言，且会改「最后活动时间」");
	assert.deepEqual(notice.data.content[0].type, "text");
	assert.ok(notice.data.content[0].text.includes("session-new-1"), "旧会话提示没说去哪");
	assert.ok(notice.data.content[0].text.includes(docPath), "旧会话提示没给文档路径");
	assert.equal(handoff.count, 1);
	assert.ok(!handoff.status.includes("降级"), `正常路径不该有降级：${handoff.status}`);
}

// ── 3b. preset 继承：运行时切换过就以日志为准，没切换用 header ─────────────

{
	// 只有 header：用 header 的
	const ctx = makeCtx();
	installHandoff(ctx, { defaults: { enabled: true } });
	ctx._handlers.get("agent/error")[0](overflow(makeSession({ id: "p1", agentPreset: "team" })));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx._created[0].agentPreset, "team", "header 里的 preset 该被继承（否则新会话丢掉团队能力）");

	// 日志里切换过：日志赢，header 是过期的
	const ctx2 = makeCtx();
	installHandoff(ctx2, { defaults: { enabled: true } });
	ctx2._handlers.get("agent/error")[0](
		overflow(
			makeSession({
				id: "p2",
				agentPreset: "team",
				events: [{ type: "agent-preset/selected", data: { agentPreset: "minimal" } }],
			}),
		),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		ctx2._created[0].agentPreset,
		"minimal",
		"运行时切换过 preset 时该用日志里的（header 只记「启动时那个」）—— 否则新会话拿到一个旧 preset",
	);
}

// ── 4. 触发条件：别的错误一律不许交接 ──────────────────────────────────────

{
	const cases = [
		["限流", Object.assign(new Error("rate limited"), { code: "RATE_LIMIT" })],
		["认证", Object.assign(new Error("auth"), { code: "AUTH" })],
		["未知", new Error("boom")],
		["没 code", new Error("unnamed")],
	];
	for (const [name, error] of cases) {
		const ctx = makeCtx();
		installHandoff(ctx, { defaults: { enabled: true } });
		const session = makeSession();
		ctx._handlers.get("agent/error")[0]({ agent: { session }, error });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(ctx._created.length, 0, `${name} 错误不该触发交接（会无故打断用户会话）`);
		assert.equal(session._appended.length, 0, `${name} 错误不该往会话里写东西`);
	}

	// error.code 只在 message 里（不是结构化 code）也不许触发
	const ctx2 = makeCtx();
	installHandoff(ctx2, { defaults: { enabled: true } });
	ctx2._handlers.get("agent/error")[0]({ agent: { session: makeSession() }, error: new Error("CONTEXT_WINDOW_EXCEEDED") });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx2._created.length, 0, "只有 message 文本像、没有结构化 code 时不该交接（会误伤）");

	// payload 畸形不许抛（emit 的异常会被 catch 成 warn，但也不能崩）
	for (const payload of [undefined, {}, { agent: {} }, { error: { code: "CONTEXT_WINDOW_EXCEEDED" } }]) {
		const ctx = makeCtx();
		installHandoff(ctx, { defaults: { enabled: true } });
		ctx._handlers.get("agent/error")[0](payload);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(ctx._created.length, 0, `畸形 payload ${JSON.stringify(payload)} 不该建会话`);
	}
}

// ── 5. 一个会话只交一次（防无限建会话）──────────────────────────────────────

{
	const ctx = makeCtx();
	installHandoff(ctx, { defaults: { enabled: true } });
	const session = makeSession({ id: "loop-session" });
	for (let i = 0; i < 5; i++) ctx._handlers.get("agent/error")[0](overflow(session));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx._created.length, 1, `同一会话溢出多次只该交一次，实际建了 ${ctx._created.length} 个会话（新会话再溢出会无限建会话）`);

	// 换个会话要能再交
	ctx._handlers.get("agent/error")[0](overflow(makeSession({ id: "another-session" })));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx._created.length, 2, "另一个会话溢出应能再交接（去重是按会话的，不是全局一次）");
}

// ── 6. 降级一（续）：链式失控也要收住 ───────────────────────────────────────
// 按会话去重挡不住 A→B→C：每代新会话都是「新」会话。
// 任务本身一个上下文装不下时就会一直建下去，必须有个总数上限。

{
	const ctx = makeCtx();
	const handoff = installHandoff(ctx, { defaults: { enabled: true } });
	const listener = ctx._handlers.get("agent/error")[0];
	// 模拟一条链：每个新会话自己也溢出
	for (let i = 0; i < handoff.maxHandoffs + 4; i++) listener(overflow(makeSession({ id: `chain-${i}` })));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		ctx._created.length,
		handoff.maxHandoffs,
		`链式交接必须在 ${handoff.maxHandoffs} 次处收住，实际建了 ${ctx._created.length} 个会话`,
	);
	assert.equal(handoff.count, handoff.maxHandoffs + 4, "超过上限的会话仍要计数并写文档（只是不再自动建会话）");
	// 到上限仍写文档、仍给提示 —— 否则「不再自动建会话」退化成「什么都不做」
	const overflowed = fs.readdirSync(handoff.dir).filter((f) => f.includes("chain-8"));
	assert.equal(overflowed.length, 1, `超限的会话也必须写好文档（那是人接手时唯一能看的东西），实际 ${JSON.stringify(fs.readdirSync(handoff.dir))}`);
	const overDoc = fs.readFileSync(path.join(handoff.dir, overflowed[0]), "utf8");
	assert.ok(overDoc.includes("未完成"), "超限时的文档内容也得完整");
	// 状态是「最后完成者写入」，并发下不一定是超限那个 —— 查日志更实。
	assert.ok(
		ctx._logs.some(([level, m]) => level === "info" && m.includes(`上限 ${handoff.maxHandoffs}`)),
		"超过上限时应明确报出上限（不能静默不建会话）",
	);
	// 超限那次也得在旧会话里留话（不然用户完全不知道发生了啥）
	const overSession = makeSession({ id: "chain-with-append", events: SAMPLE_EVENTS });
	// 先把这一个配额用光，确保下一个走 exhausted 分支
	const fresh = makeCtx();
	const freshHandoff = installHandoff(fresh, { defaults: { enabled: true } });
	const freshListener = fresh._handlers.get("agent/error")[0];
	for (let i = 0; i <= freshHandoff.maxHandoffs; i++) freshListener(overflow(makeSession({ id: `fill-${i}` })));
	freshListener(overflow(overSession));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fresh._created.length, freshHandoff.maxHandoffs, "配额用光后不该再建会话");
	assert.equal(overSession._appended.length, 1, "超限的会话也必须收到旧会话提示（否则用户不知道发生了什么）");
	assert.ok(
		overSession._appended[0].data.content[0].text.includes("上限"),
		"超限提示该说清是因为达到上限（而不是笼统报「失败」）",
	);
}

// ── 6b. 降级一：没有 sessionController ────────────────────────────────────

{
	const ctx = makeCtx({ withController: false });
	const handoff = installHandoff(ctx, { defaults: { enabled: true } });
	assert.equal(handoff.enabled, true, "没有 sessionController 时仍应报「开」（配置是开的）");
	assert.ok(handoff.status.includes("待命"), `状态应说明还没接上并保持待命：${handoff.status}`);
	assert.equal(ctx._handlers.get("agent/error"), undefined, "没接上时不该挂监听");
	assert.ok(handoff.describe().includes("会话交接"), "describe 必须能跑（/team-baseline 依赖它）");
}

// ── 7. 降级二：建会话失败 → 仍写文档 + 给出路 ───────────────────────────────

{
	const ctx = makeCtx();
	ctx.sessionController.create = async () => {
		throw new Error("模拟 create 失败");
	};
	const handoff = installHandoff(ctx, { defaults: { enabled: true } });
	const session = makeSession({ id: "fail-session", events: SAMPLE_EVENTS });
	ctx._handlers.get("agent/error")[0](overflow(session));
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(ctx._prompted.length, 0, "没建出会话就不该注入");
	const files = fs.readdirSync(handoff.dir).filter((f) => f.includes("fail-session"));
	assert.equal(files.length, 1, "建会话失败也必须写好文档（这是唯一能救回来的东西）");
	const doc = fs.readFileSync(path.join(handoff.dir, files[0]), "utf8");
	assert.ok(doc.includes("手动新建"), `文档该说明新会话没建成：${doc.slice(0, 400)}`);

	assert.equal(session._appended.length, 1, "建会话失败也要在旧会话里留话");
	const text = session._appended[0].data.content[0].text;
	assert.ok(text.includes("自动新建会话失败"), "旧会话提示该说明失败");
	assert.ok(text.includes(path.join(handoff.dir, files[0])), "旧会话提示该给出文档路径（让人能手工接上）");
	assert.ok(handoff.status.includes("降级"), `状态该标出降级：${handoff.status}`);
}

// ── 8. 降级三：prompt 失败 → 会话已建、文档已在，状态标降级 ──────────────────

{
	const ctx = makeCtx();
	ctx.sessionController.prompt = async () => {
		throw new Error("模拟 prompt 失败");
	};
	const handoff = installHandoff(ctx, { defaults: { enabled: true } });
	const session = makeSession({ id: "prompt-fail", events: SAMPLE_EVENTS });
	ctx._handlers.get("agent/error")[0](overflow(session));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(handoff.count, 1, "prompt 失败也算完成了一次交接");
	assert.ok(handoff.status.includes("降级"), `状态该标降级：${handoff.status}`);
	const text = session._appended[0].data.content[0].text;
	assert.ok(text.includes("任务注入失败"), "旧会话提示该说明注入失败（用户得去新会话手动发一条）");
}

// ── 9. 降级四：旧会话写不进去 → 不影响结果 ─────────────────────────────────

{
	const ctx = makeCtx();
	const handoff = installHandoff(ctx, { defaults: { enabled: true } });
	const session = makeSession({ id: "append-fail", events: SAMPLE_EVENTS });
	session.append = () => {
		throw new Error("模拟 append 失败（surface 校验不过之类）");
	};
	ctx._handlers.get("agent/error")[0](overflow(session));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx._created.length, 1, "旧会话写不进去不该影响建会话");
	assert.equal(ctx._prompted.length, 1, "旧会话写不进去不该影响注入");
	assert.equal(handoff.count, 1, "旧会话写不进去仍算交接完成（结果在新会话和文档里）");
	assert.ok(
		ctx._logs.some(([level, m]) => level === "warn" && m.includes("旧会话提示写入失败")),
		"应 warn 出来（不抛，但要留痕）",
	);
}

// ── 10. 开关关掉就什么都不做 ────────────────────────────────────────────────

{
	const ctx = makeCtx();
	const handoff = installHandoff(ctx, { defaults: { enabled: false } });
	assert.equal(handoff.enabled, false);
	assert.equal(ctx._handlers.get("agent/error"), undefined, "关掉时不该挂监听");
	assert.ok(handoff.status.includes("已关闭"), `状态该说明关掉了：${handoff.status}`);
	// describe 在关掉时也要能跑
	assert.ok(handoff.describe().includes("会话交接：关"));
}

// ── 11. 会话 id 里的 ../ 不能让文档落到目录外 ────────────────────────────────
// 会话 id 可以是 adopt 进来的外部字符串，不是可信文件名片段。
// 注意：`weird/../id` 这种测不出来 —— path.join 会先规范化成目录内的
// `…-id.md`；得用真能往上穿的 id 才能区分「消毒了」和「没消毒」。

{
	const ctx = makeCtx();
	// 单独目录，免得数到前面几节写的文档
	const dir = path.join(tempHome, "storages", "handoffs-weird");
	const handoff = installHandoff(ctx, { defaults: { enabled: true, dir } });
	const session = makeSession({ id: "../../../evil", events: SAMPLE_EVENTS });
	ctx._handlers.get("agent/error")[0](overflow(session));
	await new Promise((resolve) => setImmediate(resolve));
	const files = fs.readdirSync(dir);
	for (const file of files) {
		assert.ok(!file.includes("/") && !file.includes("\\"), `文件名不该含路径分隔符：${file}`);
	}
	assert.equal(files.length, 1, `应正好一份文档，实际 ${JSON.stringify(files)}`);
	assert.ok(handoff.dir, "整体不许因 id 畸形而失败");
	// 消毒是有损的：`a/b` 与 `a:b` 都会变成 `a-b`。文件名尾巴上挂 id 的 hash，
	// 否则同一天两个来源会话会互相覆盖（后写的把小提示里的路径内容换掉）。
	assert.match(files[0], /-[0-9a-f]{8}\.md$/, `文件名应带 id 的短 hash（防消毒后碰撞覆盖）：${files[0]}`);
	// 两个消毒后同名、但不同的 id 必须落成两份
	const dir2 = path.join(tempHome, "storages", "handoffs-collide");
	const ctx2 = makeCtx();
	const h2 = installHandoff(ctx2, { defaults: { enabled: true, dir: dir2 } });
	for (const id of ["a/b", "a:b"]) ctx2._handlers.get("agent/error")[0](overflow(makeSession({ id, events: SAMPLE_EVENTS })));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fs.readdirSync(dir2).length, 2, `消毒后同名的两个不同会话 id 不该互相覆盖：${JSON.stringify(fs.readdirSync(dir2))}`);
	assert.equal(h2.count, 2);
	// 文档必须真落在配置的目录内，不能在它的外面（../ 逃逸）
	const resolved = path.resolve(dir, files[0]);
	assert.ok(resolved.startsWith(path.resolve(dir) + path.sep), `文档逃出了交接目录：${resolved}`);
}

fs.rmSync(tempHome, { recursive: true, force: true });

console.log("✓ 自检通过：触发条件精确 / 单会话去重 / 文档与注入内容 / 四级降级不炸");
