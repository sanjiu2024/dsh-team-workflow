#!/usr/bin/env node
/**
 * 自检：会话取回通道（REQ-018 的 ③）。
 *
 * 五段：
 *   1. 纯函数：`eventText`（各种 data 形状 + **未识别类型要标出来**）、`collapseSeqs`（连续序号并区间）
 *   2. 索引模式：总事件数 / seq 区间 / **被折叠过的区间**（从日志里的 compaction 事件读 `shadowedSeqs`）
 *   3. 关键词模式与区间模式：取回的是**逐字原文**，超预算要说清「只取了 N 条」
 *   4. 失败路径：没有 `sessionQuery` 服务 / 拿不到会话 id → **必须 throw**（返回「失败」文本会让模型
 *      以为取到了东西 —— 契约要求失败就抛）
 *   5. 输出契约：`execute` 返回的 value 能过 `output.schema`，`render` 出文本（本包踩过
 *      「工具跑通但一个字到不了模型」的坑，见 lib/mc-adapter.js:597）
 *
 * 为什么这几条必须钉住：取回通道的价值全在**忠实**上 —— 它要是把摘要当原文、把别的会话
 * 当本会话、或者在失败时假装成功，模型就会拿它当证据去行动（那正是 83% 失败 run 的形态）。
 *
 *   node scripts/selftest-session-recall.mjs
 */
import * as assert from "node:assert/strict";
import { collapseSeqs, eventText, installSessionRecall, RECALL_MAX_EVENTS } from "../lib/session-recall.js";

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

/** 造一份假日志：seq 0..count-1，每条一个可辨认的正文；可选插一条 compaction 事件。 */
function fakeLog({ count = 20, folded = null, sessionId = "sess-1" } = {}) {
	const events = [];
	for (let seq = 0; seq < count; seq += 1) {
		events.push({
			sessionId,
			seq,
			type: seq % 2 === 0 ? "user/message" : "assistant/message",
			time: 1_700_000_000_000 + seq,
			data: { content: `第 ${seq} 条的正文（原文）` },
		});
	}
	if (folded) {
		events.push({
			sessionId,
			seq: count,
			type: "compaction/summary",
			time: 1_700_000_000_000 + count,
			data: { shadowedSeqs: folded, shadowedTokenCount: 1234 },
		});
	}
	return events;
}

/** 假 engine：形状照 dsh-session-query 的类型（readEvent / listEvents / searchEvents）。 */
function fakeEngine(events, { searchHits = null } = {}) {
	const bySeq = new Map(events.map((e) => [e.seq, e]));
	return {
		async listEvents(sessionId) {
			return events
				.filter((e) => e.sessionId === sessionId)
				.map(({ sessionId: sid, seq, type, time }) => ({ sessionId: sid, seq, type, time, surface: "log" }));
		},
		async readEvent({ sessionId, seq, before = 0 }) {
			const target = bySeq.get(seq);
			if (!target || target.sessionId !== sessionId) throw new Error(`没有 seq ${seq}`);
			const startSeq = Math.max(0, seq - before);
			const window = [];
			for (let s = startSeq; s <= seq; s += 1) {
				const e = bySeq.get(s);
				if (e && e.sessionId === sessionId) window.push(e);
			}
			return { session: { id: sessionId }, inheritedEventCount: 0, target, events: window, startSeq, endSeq: seq };
		},
		async searchEvents({ sessionId, query, limit = 10 }) {
			const hits =
				searchHits ??
				events
					.filter((e) => e.sessionId === sessionId && String(e.data?.content ?? "").includes(query))
					.slice(0, limit)
					// **照真实形状来**：`dsh-session-query-sqlite` 的 `_eventHit` 只给
					// `{sessionId,seq,type,time,surface,snippet}` —— **没有 `data`、没有 `text`**。
					// 2.2.1 之前这里伪造了 `text`，于是把错字段钉死了（独立测的 P0）。
					.map((e) => ({ sessionId: e.sessionId, seq: e.seq, type: e.type, time: e.time, surface: "log", snippet: e.data.content }));
			return { items: hits };
		},
	};
}

/** 假 ctx：捕获注册进来的工具定义；`get("sessionQuery")` 给假 engine。 */
function fakeCtx(engine) {
	const captured = {};
	const ctx = {
		logger: { info: () => {} },
		tools: {
			register(definition) {
				captured.definition = definition;
				return () => {
					captured.disposed = true;
				};
			},
		},
		get(name) {
			return name === "sessionQuery" ? engine : undefined;
		},
	};
	return { ctx, captured };
}

const execFor = (sessionId) => (sessionId === null ? {} : { agent: { session: { id: sessionId } } });
const textOf = async (definition, args, exec) => {
	const value = await definition.execute(args, exec);
	return value.text;
};

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

check("eventText：字符串 content / 数组 content / message 对象 / 未识别类型要标出来", () => {
	assert.equal(eventText({ data: { content: "正文" } }), "正文");
	assert.equal(eventText({ data: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } }), "甲\n乙");
	assert.equal(eventText({ data: { message: { content: "包在 message 里" } } }), "包在 message 里");
	assert.equal(eventText({ data: { summary: "摘要" } }), "摘要");
	const unknown = eventText({ data: { weird: 1 } });
	assert.match(unknown, /未识别/, "不认识的类型必须标出来，别让模型以为那是全文");
	assert.equal(eventText({ data: {} }), "（这条事件没有可展示的文本）");
});

check("collapseSeqs：连续序号并成区间、乱序去重、非整数滤掉", () => {
	assert.deepEqual(collapseSeqs([1, 2, 3, 7, 8, 20]), [[1, 3], [7, 8], [20, 20]]);
	assert.deepEqual(collapseSeqs([5, 3, 4, 4, 3]), [[3, 5]], "乱序 + 重复要归一");
	assert.deepEqual(collapseSeqs([1, "2", null, undefined, 3]), [[1, 1], [3, 3]], "非整数滤掉");
	assert.deepEqual(collapseSeqs(undefined), []);
});

// ── 2. 索引模式 ─────────────────────────────────────────────────────────────

await checkAsync("索引模式：报总事件数 / seq 区间 / 被折叠的区间（从 compaction 事件的 shadowedSeqs 读）", async () => {
	const events = fakeLog({ count: 20, folded: [3, 4, 5, 6, 7, 12] });
	const { ctx, captured } = fakeCtx(fakeEngine(events));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, {}, execFor("sess-1"));
	// 21 = 20 条消息 + 1 条折叠记录（索引算的是**全部事件**，折叠记录也是事件）
	assert.match(text, /共 21 条事件/, `要报总数，实际：${text}`);
	assert.match(text, /seq 0–20/, "要报 seq 区间");
	assert.match(text, /seq 3-7/, `要报折叠区间，实际：${text}`);
	assert.match(text, /3-7、12/, "单条折叠也要报（区间用、分隔）");
	assert.match(text, /session_recall/, "要告诉模型怎么取回来");
});

await checkAsync("索引模式：没有折叠记录时要说清「没找到」，不许编一个区间出来", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 5 })));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, {}, execFor("sess-1"));
	assert.match(text, /没有找到/, `实际：${text}`);
	assert.doesNotMatch(text, /被压缩折叠过的 seq 区间/, "没有就别摆出那个标题");
});

await checkAsync("索引模式：折叠记录**读不出来**时要说清是读失败，不许说成「没折叠过」", async () => {
	const events = fakeLog({ count: 4, folded: [1, 2] });
	const engine = fakeEngine(events);
	engine.readEvent = async () => {
		throw new Error("这条读不了");
	};
	const { ctx, captured } = fakeCtx(engine);
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, {}, execFor("sess-1"));
	assert.match(text, /读不出来/, `要如实说读失败，实际：${text}`);
	assert.doesNotMatch(text, /没有找到/, "读失败 ≠ 没折叠过");
});

// ── 3. 关键词与区间 ─────────────────────────────────────────────────────────

await checkAsync("关键词模式：取回的是宿主的检索结果（含 seq 与正文）", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 6 })));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, { query: "第 4 条" }, execFor("sess-1"));
	assert.match(text, /seq 4/, `要带 seq，实际：${text}`);
	assert.match(text, /第 4 条的正文（原文）/, "要带正文");
});

await checkAsync("关键词模式：没命中要说清没找到 + 给出下一步", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 3 })));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, { query: "绝对不存在的词" }, execFor("sess-1"));
	assert.match(text, /没找到/);
	assert.match(text, /索引模式/, "要给下一步，别让模型干瞪眼");
});

await checkAsync("区间模式：逐字取回 from..to", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 20 })));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, { from: 10, to: 12 }, execFor("sess-1"));
	assert.match(text, /逐字/, "要说清这是逐字原文");
	for (const seq of [10, 11, 12]) assert.match(text, new RegExp(`第 ${seq} 条的正文（原文）`), `缺 seq ${seq}`);
	assert.doesNotMatch(text, /第 13 条/, "别越界多取");
});

await checkAsync("区间模式：超过预算要说清「只取了 N 条」（不许假装取全了）", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 200 })));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, { from: 0, to: 199 }, execFor("sess-1"));
	assert.match(text, new RegExp(`只取了 ${RECALL_MAX_EVENTS} 条`), `实际：${text.slice(0, 200)}`);
});

await checkAsync("单条模式：seq 会带上前后各 2 条做上下文", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 20 })));
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, { seq: 8 }, execFor("sess-1"));
	assert.match(text, /第 6 条的正文/, "要带前文");
	assert.match(text, /第 10 条的正文/, "要带后文");
});

await checkAsync("关键词模式：命中只有宿主给的 snippet（真实形状没有 data）也要出正文", async () => {
	// 这条是 P0 的守门员：把代码里的 `hit.snippet` 改回 `hit.text` → 这里会渲染成
	// 「宿主没给这段的摘要片段」→ 断言变红。
	const events = fakeLog({ count: 6 });
	const engine = fakeEngine(events, {
		searchHits: [{ sessionId: "sess-1", seq: 4, type: "user/message", time: 1, surface: "log", snippet: "只有 snippet 的正文" }],
	});
	const { ctx, captured } = fakeCtx(engine);
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, { query: "随便" }, execFor("sess-1"));
	assert.match(text, /只有 snippet 的正文/, `要读宿主的 snippet，实际：${text}`);
	assert.doesNotMatch(text, /没给这段的摘要片段/, "有 snippet 就不该说没给");
});

await checkAsync("区间模式：整段超出日志范围 → 用**请求的区间**说话，别把宿主内部序号当结论", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 5 })));
	installSessionRecall(ctx);
	await assert.rejects(
		() => captured.definition.execute({ seq: 9999 }, execFor("sess-1")),
		(error) => {
			assert.match(String(error.message), /9997–10001/, `要报请求的区间，实际：${error.message}`);
			assert.match(String(error.message), /读不出来/, "要说清是读失败");
			return true;
		},
	);
});

await checkAsync("索引模式：事件都没有可用 seq 时不许输出 Infinity", async () => {
	const engine = {
		async listEvents() {
			return [{ sessionId: "sess-1", type: "user/message", time: 1, surface: "log" }];
		},
		async readEvent() {
			throw new Error("不该走到这");
		},
		async searchEvents() {
			throw new Error("不该走到这");
		},
	};
	const { ctx, captured } = fakeCtx(engine);
	installSessionRecall(ctx);
	const text = await textOf(captured.definition, {}, execFor("sess-1"));
	assert.doesNotMatch(text, /Infinity/, `不许出现 Infinity，实际：${text}`);
	assert.match(text, /没有一条带可用的 seq/);
});

// ── 4. 失败路径（必须 throw） ───────────────────────────────────────────────

await checkAsync("limit 给了但不是正整数 → 说清楚，不许静默取默认", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 4 })));
	installSessionRecall(ctx);
	await assert.rejects(() => captured.definition.execute({ limit: 2.5 }, execFor("sess-1")), /limit 要是正整数/);
	await assert.rejects(() => captured.definition.execute({ limit: 0 }, execFor("sess-1")), /limit 要是正整数/);
});

await checkAsync("没有 sessionQuery 服务 → throw（不许返回「失败」文本冒充结果）", async () => {
	const { ctx, captured } = fakeCtx(undefined);
	installSessionRecall(ctx);
	await assert.rejects(() => captured.definition.execute({}, execFor("sess-1")), /sessionQuery/);
});

await checkAsync("拿不到会话 id → throw", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 3 })));
	installSessionRecall(ctx);
	await assert.rejects(() => captured.definition.execute({}, execFor(null)), /会话 id/);
});

await checkAsync("engine 抛错 → 包一层再抛（别把宿主错误原样吞掉）", async () => {
	const engine = {
		async listEvents() {
			throw new Error("日志读不了");
		},
		async readEvent() {
			throw new Error("不该走到这");
		},
		async searchEvents() {
			throw new Error("不该走到这");
		},
	};
	const { ctx, captured } = fakeCtx(engine);
	installSessionRecall(ctx);
	await assert.rejects(() => captured.definition.execute({}, execFor("sess-1")), /取回失败.*日志读不了/);
});

// ── 5. 输出契约 ─────────────────────────────────────────────────────────────

await checkAsync("输出契约：value 过 schema、render 出文本、dispose 能调", async () => {
	const { ctx, captured } = fakeCtx(fakeEngine(fakeLog({ count: 4 })));
	const handle = installSessionRecall(ctx);
	const definition = captured.definition;
	assert.equal(definition.name, "session_recall");
	assert.equal(typeof definition.description, "string");
	const value = await definition.execute({}, execFor("sess-1"));
	assert.equal(typeof value.text, "string", "value 必须是对象且 text 是字符串（schema 要求）");
	const rendered = definition.output.render({}, value);
	assert.deepEqual(rendered, [{ type: "text", text: value.text }], "render 必须把 text 交出去");
	handle.dispose();
	assert.equal(captured.disposed, true, "dispose 要真的摘掉工具");
});

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：会话取回通道（纯函数 / 索引与折叠区间 / 关键词与区间 / 失败必抛 / 输出契约）");
}
