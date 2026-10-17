#!/usr/bin/env node
/**
 * 会话取回通道（REQ-018 的 ③）：把「上下文里被折掉 / 被挤出去」的原文按需取回来。
 *
 * ## 为什么必须有
 *
 * dsh 压缩时写进上下文的只有一段摘要（`<compacted-summary>`），被折掉的那些 seq
 * 模型**看不到**。而实测里 83% 的失败 run 可追溯到「执行了某条没有环境输出支撑的摘要条目」
 * （arXiv 2610.20927）；唯一真正的同条件对照里，**把「窗口外存储 + 取回通道」给两种机制之后，
 * native compaction 才被抬到共同上限**（pi-fold，Zenodo 22142456）。所以取回通道不是附赠，
 * 是一等交付物 —— 摘要丢了什么，得能查、能取回来。
 *
 * ## 两条硬约束（都是实测来的，别绕）
 *
 * 1. **不自己解会话文件**：`.jsonl.zstd` 是**多帧串联**，Node 的 `zstdDecompressSync` /
 *    `createZstdDecompress` **只解第一帧**（实测 202KB 的文件只出 281 字节）。走宿主现成的
 *    `sessionQuery` 服务（`readEvent` / `searchEvents` / `listEvents`）—— 它按后端解，不挑格式。
 * 2. **地址用 `seq`**：会话内单调、从 0 连续、append-only 下不会变。不要用「第几条消息」
 *    或 mc 的 ordinal（那些会随折叠漂移）。
 *
 * ## 和 magic-context 的关系
 *
 * mc 自己也注册了 `ctx_search` / `ctx_expand`，但它走的是**它自己的** SQLite 副本，而且
 * 本机实测 `compartments` 表 0 行、`ctx_search` 直接报 `Could not resolve project identity`
 * —— 所以取回通道不能挂在 mc 上（那样等于依赖一个已经坏掉的组件）。这里走 dsh 自己的
 * `sessionQuery` + 日志里的折叠记录，独立成立。
 */
import { toParameterSchema } from "./util.js";

/** 一次最多取多少条（`readEvent` 的窗口上限是 50，这是上面那层自己的预算）。 */
export const RECALL_MAX_EVENTS = 30;

/** 取回一条事件要展示的文本（不认识就**标出来**，别让模型以为那是全文）。 */
export function eventText(event) {
	const data = event?.data ?? {};
	const fromContent = (content) => {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts = content
				.map((p) => {
					if (typeof p === "string") return p;
					return typeof p?.text === "string" ? p.text : "";
				})
				.filter((s) => s !== "");
			return parts.length > 0 ? parts.join("\n") : undefined;
		}
		return undefined;
	};
	const direct = fromContent(data.content);
	if (direct !== undefined) return direct;
	if (typeof data.message === "string") return data.message;
	if (data.message && typeof data.message === "object") {
		const inner = fromContent(data.message.content);
		if (inner !== undefined) return inner;
	}
	for (const key of ["text", "summary", "note", "reason"]) {
		if (typeof data[key] === "string" && data[key] !== "") return data[key];
	}
	let raw = "";
	try {
		raw = JSON.stringify(data) ?? "";
	} catch {
		raw = "";
	}
	if (raw === "" || raw === "{}") return "（这条事件没有可展示的文本）";
	const cut = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
	return `${cut}\n（此事件类型未识别，上面是原始字段片段，不是全文）`;
}

/** 把 `shadowedSeqs` 这种「一串序号」压成 `[起, 止]` 区间（连续的就并起来）。 */
export function collapseSeqs(seqs) {
	const list = [...new Set((seqs ?? []).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
	const ranges = [];
	for (const seq of list) {
		const last = ranges.at(-1);
		if (last && seq === last[1] + 1) last[1] = seq;
		else ranges.push([seq, seq]);
	}
	return ranges;
}

/** 会话 id：工具执行上下文里就有（`exec.agent.session.id`）。 */
function sessionIdOf(exec) {
	return exec?.agent?.session?.id ?? exec?.session?.id ?? undefined;
}

/** 取服务：cordis 的 ctx 是访问器代理，没声明 inject 的属性**读一下就抛** → 必须用 `get`。 */
function queryEngine(ctx) {
	const engine = ctx?.get?.("sessionQuery");
	if (!engine || typeof engine.readEvent !== "function") return undefined;
	return engine;
}

const TOOL_DESCRIPTION =
	"取回**本会话**的历史原文（逐字，不是摘要）。上下文被压缩后旧事件会被折成摘要，模型就看不到它们了 —— " +
	"这个工具能把它们取回来。不带参数 = 看索引（总事件数、seq 区间、**哪些 seq 区间被折叠过**）；" +
	"给 query = 按关键词找；给 seq 或 from/to = 按 seq 取逐字原文（一次最多 " +
	`${RECALL_MAX_EVENTS} 条）。地址是事件的 seq（会话内单调），不是「第几条消息」。`;

/**
 * 注册 `session_recall` 工具。
 *
 * @param {object} ctx 插件上下文
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {{dispose: () => void, name: string}}
 */
export function installSessionRecall(ctx, opts = {}) {
	const log = typeof opts.log === "function" ? opts.log : () => {};

	/** 索引模式：总事件数 + seq 区间 + **被折叠过的区间**。 */
	async function buildIndex(engine, sessionId) {
		const records = await engine.listEvents(sessionId);
		const events = Array.isArray(records) ? records : [];
		if (events.length === 0) return "这个会话还没有任何事件。";
		const seqs = events.map((e) => e.seq).filter((n) => Number.isInteger(n));
		const folded = [];
		let unreadable = 0;
		// 折叠记录在日志里：压缩写的事件带 `shadowedSeqs`（权威列表）。逐条读出来 —— 这种事件很少。
		for (const record of events) {
			if (typeof record?.type !== "string" || !record.type.includes("compaction")) continue;
			try {
				const window = await engine.readEvent({ sessionId, seq: record.seq });
				const shadowed = window?.target?.data?.shadowedSeqs;
				const ranges = collapseSeqs(shadowed);
				if (ranges.length > 0) folded.push({ seq: record.seq, ranges, count: new Set(shadowed).size });
			} catch (error) {
				// **读不出来 ≠ 没折叠过**：单独记一笔，别让它变成「没有找到」（那是把读失败说成事实）
				unreadable += 1;
				log(`[recall] 读折叠记录 seq=${record.seq} 失败：${error?.message ?? error}`);
			}
		}
		const lines =
			seqs.length > 0
				? [`本会话共 ${events.length} 条事件，seq ${Math.min(...seqs)}–${Math.max(...seqs)}。`]
				: [`本会话有 ${events.length} 条事件，但没有一条带可用的 seq（宿主没给序号）—— 取回通道定位不了。`];
		if (folded.length === 0) {
			lines.push(
				unreadable > 0
					? `**有 ${unreadable} 条折叠记录读不出来**（不是「没折叠过」—— 是读失败，别当成事实）。`
					: "没有找到「被压缩折叠过」的记录（要么没压过，要么压缩器没写 shadowedSeqs）。",
			);
		} else {
			lines.push("**被压缩折叠过的 seq 区间**（原文都在，可以取回来）：");
			for (const item of folded) {
				const span = item.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join("、");
				lines.push(`- seq ${span}（共 ${item.count} 条；折叠记录在 seq ${item.seq}）`);
			}
		}
		lines.push(`取回办法：\`session_recall({from, to})\` 取某个区间，或 \`session_recall({query})\` 按关键词找。`);
		return lines.join("\n");
	}

	/** 关键词模式。 */
	async function search(engine, sessionId, query, limit) {
		const page = await engine.searchEvents({ sessionId, query, limit });
		const hits = Array.isArray(page?.items) ? page.items : [];
		if (hits.length === 0) return `没找到含「${query}」的事件。换个词，或用不带参数的索引模式看有哪些折叠区间。`;
		const blocks = hits.map((hit) => {
			// 命中带的是 `snippet`（`dsh-session-query-sqlite` 的 `_eventHit` 只给
			// `{sessionId,seq,type,time,surface,snippet}` —— **没有 `data`**）。
			// 曾经按 `text` 读：真实宿主下每条命中都会渲染成「没有可展示的文本」，而假替身
			// 伪造了 `text`，于是套件全绿 —— 独立测逮到的 P0（2.2.1）。
			const excerpt = typeof hit?.snippet === "string" && hit.snippet !== "" ? hit.snippet : undefined;
			const text = excerpt ?? (hit?.data ? eventText(hit) : "（宿主没给这段的摘要片段）");
			return `[seq ${hit?.seq} · ${hit?.type ?? "?"}] ${text}`;
		});
		const more = page?.nextCursor ? `\n（还有更多结果，缩小关键词或调大 limit）` : "";
		return `含「${query}」的事件 ${hits.length} 条：\n\n${blocks.join("\n\n")}${more}`;
	}

	/** 区间模式：按 seq 取逐字原文。窗口上限 50，所以分块取。 */
	async function readRange(engine, sessionId, from, to, limit) {
		const start = Math.max(0, Math.min(from, to));
		const end = Math.max(from, to);
		const want = Math.min(end - start + 1, limit);
		const chunks = [];
		let cursor = end;
		let remaining = want;
		while (remaining > 0 && cursor >= start) {
			const size = Math.min(remaining, 50);
			let window;
			try {
				window = await engine.readEvent({ sessionId, seq: cursor, before: size - 1 });
			} catch (error) {
				// 宿主对不存在的 seq 会抛，而且消息里带的是它内部算出来的序号（问 99999 会报 100001）。
				// 用**请求的区间**框住它，别让那句内部序号变成结论。
				throw new Error(`seq ${Math.max(start, cursor - size + 1)}–${cursor} 这一段读不出来：${error?.message ?? error}`);
			}
			const events = Array.isArray(window?.events) ? window.events : [];
			if (events.length === 0) break;
			chunks.unshift(...events);
			const firstSeq = window?.startSeq ?? events[0]?.seq;
			cursor = Number.isInteger(firstSeq) ? firstSeq - 1 : cursor - events.length;
			remaining -= events.length;
		}
		const clipped = chunks.filter((e) => Number.isInteger(e?.seq) && e.seq >= start && e.seq <= end).slice(-want);
		if (clipped.length === 0) {
			return `seq ${start}–${end} 这个区间没有取到事件 —— 多半是超出了本会话的日志范围（用不带参数的索引模式看实际区间）。`;
		}
		const blocks = clipped.map((e) => `[seq ${e?.seq} · ${e?.type ?? "?"}] ${eventText(e)}`);
		const clippedNote =
			end - start + 1 > clipped.length ? `\n（区间共 ${end - start + 1} 条，这里只取了 ${clipped.length} 条 —— 要更多就再调一次，或调大 limit）` : "";
		return `seq ${clipped[0]?.seq}–${clipped.at(-1)?.seq} 的原文（逐字）：\n\n${blocks.join("\n\n")}${clippedNote}`;
	}

	const registration = ctx.tools.register({
		name: "session_recall",
		description: TOOL_DESCRIPTION,
		parameters: toParameterSchema({
			query: { type: "string", description: "关键词（走宿主的全文检索）。给了它就忽略 seq/from/to。" },
			seq: { type: "number", description: "取这一条事件的原文（会带上前后各 2 条做上下文）。" },
			from: { type: "number", description: "区间起点 seq（和 to 一起用）。" },
			to: { type: "number", description: "区间终点 seq。" },
			limit: { type: "number", description: `最多取几条（默认 ${RECALL_MAX_EVENTS}，上限 ${RECALL_MAX_EVENTS}）。` },
		}),
		// 契约（`@deepseek-ai/dsh-tools` 的 createSuccessResult）：execute 返回的是 **value**，
		// 先过 output.schema，再交给 output.render 出文本。三者必须自洽 —— 本包
		// `lib/mc-adapter.js:597` 记着踩过的坑：schema 声明 object 却返回字符串，
		// 工具能跑通但**一个字都到不了模型**。
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		async execute(args, exec) {
			const engine = queryEngine(ctx);
			if (!engine) {
				throw new Error("宿主没有 sessionQuery 服务（readEvent/listEvents）—— 会话取回通道用不了。");
			}
			const sessionId = sessionIdOf(exec);
			if (!sessionId) {
				throw new Error("拿不到当前会话 id（exec.agent.session.id）—— 取回通道需要它才能定位日志。");
			}
			if (args?.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
				// 静默取默认会让「我明明说了 2.5」变成没人知道为什么取了 30 条
				throw new Error(`limit 要是正整数（给的是 ${JSON.stringify(args.limit)}）。`);
			}
			const limit = args?.limit !== undefined ? Math.min(args.limit, RECALL_MAX_EVENTS) : RECALL_MAX_EVENTS;
			const query = typeof args?.query === "string" ? args.query.trim() : "";
			try {
				if (query !== "") return { text: await search(engine, sessionId, query, limit) };
				if (Number.isInteger(args?.seq)) {
					return { text: await readRange(engine, sessionId, args.seq - 2, args.seq + 2, limit) };
				}
				if (Number.isInteger(args?.from) || Number.isInteger(args?.to)) {
					const from = Number.isInteger(args?.from) ? args.from : args.to;
					const to = Number.isInteger(args?.to) ? args.to : args.from;
					return { text: await readRange(engine, sessionId, from, to, limit) };
				}
				return { text: await buildIndex(engine, sessionId) };
			} catch (error) {
				// 失败必须 throw（契约）：返回一句「失败」文本会让模型以为取到了
				throw new Error(`取回失败：${error?.message ?? error}`);
			}
		},
	});

	return {
		name: "session_recall",
		dispose: () => {
			if (typeof registration === "function") registration();
			else registration?.dispose?.();
		},
	};
}
