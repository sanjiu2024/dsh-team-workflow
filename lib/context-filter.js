#!/usr/bin/env node
/**
 * 出处过滤（REQ-018 的 ②）：压缩产生的 checkpoint 里，**逐条判「这条有没有环境输出支撑」，没有的删掉**。
 *
 * ## 为什么
 *
 * 实测：**83% 的失败 run 可追溯到「执行了某条摘要条目」，而多数条目没有任何环境输出支撑**
 * （arXiv 2610.20927）。它的做法（SJC）不改 agent、不改压缩器，只在**压缩之后**加一道过滤 ——
 * 正好绕开 dsh「摘要提示词零配置面」这个死结。收益：可靠性 +2.1%~8.9%，token 不增。
 *
 * ## 缝在哪（第一版接错过，记在这里免得再踩）
 *
 * 我最初把过滤挂在 `agent/pre-step` 上，靠它的 decision `{kind:'enter', messages}` 替换消息。
 * **那条路是死的**：`agent/pre-step` 只能替换「inbox 里待入场的 `UserMessage`」，而模型侧的消息
 * 数组是 `dsh-agent-loop` 的 `deriveMessages()` **现场从 surface 导出的，中间没有任何钩子**
 * （`agent/request` 的类型注释明写 "cannot mutate messages"，`llm/stream` 拿到的是 deep-frozen
 * 请求）。checkpoint 是**已经落在 surface 上的节点**，根本不经过 pre-step —— 所以那个接线在真实
 * 宿主里是**空操作**，而假 ctx 把它演成了对的、套件全绿。
 *
 * 正确的缝：`surfaceOp:{op:'replace'}` **原地换节点**。先例是宿主的
 * `dsh-compaction-tool-result-pruner`（`lib/index.js:139-177`），dsh 自己的压缩也走同一条路
 * （`dsh-compaction-basic/lib/index.js:650`）。本文件照抄那条路：
 *
 * ```js
 * for (const seq of [...session.surface.nodes]) {
 *   const event = session.eventAt(seq);
 *   if (event?.type !== "user/message") continue;
 *   const original = session.deriveEventMessage(event);          // 模型侧消息
 *   const filtered = await 过滤(纯文本(original));                // 本文件的纯函数
 *   session.append("user/message", freezeMessage({ ...original, content: [{ type: "text", text: filtered }] }), {
 *     surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
 *     sourceEventSeqs: [seq],
 *   });
 * }
 * ```
 *
 * **触发点两个**：`agent/pre-step`（常规）与 `agent/request-error`（overflow 重试不重跑 pre-step）。
 * 时序靠**注册顺序**：团队预设叠在标准预设之上，所以本包的 pre-step 监听在 compaction-basic
 * 之后跑 —— 同一轮里压缩刚写完 checkpoint，接着就被这里换掉，**赶在本次请求之前**。
 *
 * **做不到**的：删节点 / 减节点数（两种 `surfaceOp` 都保留节点）→ 只能改写内容，不能删消息。
 * 过滤本来就只改内容，所以不影响。
 *
 * `freezeMessage` 走 `lib/dsh-exports.js` 的宿主加载器（本包是 symlink，realpath 下没有
 * `@deepseek-ai/`，裸 import 解析不到）；拿不到就退回 `Object.freeze` 并记一笔，不静默失效。
 *
 * ## 三条安全约束（宁可少删，不可错删）
 *
 * 1. **只碰 checkpoint**：正文里没有 `<compacted-summary>` 的消息一律不动（普通消息绝不改）。
 * 2. **查不了就留**：检索服务不可用 / 抛错 / 这条没有可查的标识 → **保留**（fail-open 到「留」）。
 * 3. **删太多就不删**：删掉的条目超过一半 → **整段放弃过滤**并记一笔（把摘要掏空比不过滤更危险）。
 *
 * 删除**不静默**：留下的正文里会写明删了几条（transparent-compact 的「显式丢失标记」）。
 */

import { createHash } from "node:crypto";
import { makeHostLoader } from "./dsh-exports.js";

const OPEN_TAG = "<compacted-summary>";
const CLOSE_TAG = "</compacted-summary>";

/** 一次最多查几个标识（查得越多越准，也越慢；这是每条条目的预算）。 */
export const SUPPORT_TOKENS_PER_ENTRY = 3;

/** 删掉超过这个比例就整段放弃（安全闸）。 */
export const MAX_DROP_RATIO = 0.5;

/**
 * 从条目里挑「可查的标识」：路径 / 标识符 / 带字母的版本号之类。
 * 纯数字不当证据（`3` 到处都有），所以要求至少含一个字母。
 */
export function distinctiveTokens(text, { min = 6, max = SUPPORT_TOKENS_PER_ENTRY } = {}) {
	const found = String(text ?? "").match(/[A-Za-z0-9_./\\-]{6,}/g) ?? [];
	const uniq = [];
	for (const raw of found) {
		const token = raw.replace(/^[./-]+|[./-]+$/g, "");
		if (token.length < min) continue;
		if (!/[A-Za-z]/.test(token)) continue;
		if (uniq.includes(token)) continue;
		uniq.push(token);
	}
	// 长的更可能是标识（`lib/squad-round.js` 比 `session` 值钱），但别只挑最长的 —— 取前 max 个
	return uniq.sort((a, b) => b.length - a.length).slice(0, max);
}

/**
 * 把 checkpoint 正文切成块：每个 `- ` 条目算一块（含它的续行），其余（标题 / 空行 / 散文）各算一块。
 * 返回 `null` 表示「这不是 checkpoint」。
 */
export function parseCheckpoint(text) {
	const raw = String(text ?? "");
	const open = raw.indexOf(OPEN_TAG);
	if (open < 0) return null;
	const close = raw.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
	if (close < 0) return null;
	const body = raw.slice(open + OPEN_TAG.length, close);
	const blocks = [];
	let current = null;
	for (const line of body.split("\n")) {
		const isBullet = /^\s*([-*+]|\d+[.)])\s+/.test(line);
		const isContinuation = current !== null && /^\s+\S/.test(line) && !isBullet;
		if (isBullet) {
			current = { kind: "entry", lines: [line] };
			blocks.push(current);
		} else if (isContinuation) {
			current.lines.push(line);
		} else {
			current = { kind: "other", lines: [line] };
			blocks.push(current);
		}
	}
	return {
		head: raw.slice(0, open + OPEN_TAG.length),
		tail: raw.slice(close),
		blocks: blocks.map((b) => ({ kind: b.kind, text: b.lines.join("\n") })),
	};
}

/**
 * 过滤一段 checkpoint 正文。`isSupported(text)` 由调用方给（异步）。
 *
 * @returns {Promise<{text: string, dropped: number, checked: number, aborted?: boolean}>}
 */
export async function filterCheckpointText(text, isSupported) {
	const parsed = parseCheckpoint(text);
	if (!parsed) return { text, dropped: 0, checked: 0 };
	const entries = parsed.blocks.filter((b) => b.kind === "entry");
	if (entries.length === 0) return { text, dropped: 0, checked: 0 };

	const verdicts = [];
	for (const entry of entries) {
		let ok = true;
		try {
			ok = (await isSupported(entry.text)) !== false;
		} catch {
			ok = true; // 查不了 = 不当成无出处（见文件头第 2 条）
		}
		verdicts.push(ok);
	}
	const dropped = verdicts.filter((v) => v === false).length;
	if (dropped === 0) return { text, dropped: 0, checked: entries.length };
	// 安全闸：删太多就整段放弃 —— 把摘要掏空比不过滤更危险
	if (dropped / entries.length > MAX_DROP_RATIO) {
		return { text, dropped: 0, checked: entries.length, aborted: true };
	}
	let i = 0;
	const kept = parsed.blocks
		.map((b) => {
			if (b.kind !== "entry") return b.text;
			const ok = verdicts[i];
			i += 1;
			return ok ? b.text : undefined;
		})
		.filter((s) => s !== undefined);
	const marker = `（出处过滤：删掉了 ${dropped} 条没有环境输出支撑的条目 —— 原文都在会话日志里，可用 \`session_recall\` 取回）`;
	return { text: `${parsed.head}\n${kept.join("\n")}\n${marker}\n${parsed.tail}`, dropped, checked: entries.length };
}

/**
 * 这条事件是不是一个 checkpoint？
 *
 * 真实形状（2026-10-16 从本机会话日志里捞出来的）：`data = {content, source, role, id}`，
 * 其中 **`content` 是块数组**（3 块，`{type:'text', text}`）—— 数组那条分支才是主力，
 * 字符串分支是兜底（别的生产者可能直接给字符串）。
 */
export function isCheckpointEvent(event) {
	if (event?.type !== "user/message") return false;
	const content = event.data?.content;
	if (typeof content === "string") return content.includes(OPEN_TAG);
	if (Array.isArray(content)) {
		return content.some((block) => block?.type === "text" && (block.text ?? "").includes(OPEN_TAG));
	}
	return false;
}

/** 从模型侧消息里拼出纯文本（content 可能是字符串，也可能是块数组）。 */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
	}
	return undefined;
}

/**
 * 注册出处过滤。触发点是 `agent/pre-step` 与 `agent/request-error`（都是 waterfall，必须
 * `return next()`），钩子里只做一件事：把 surface 上的 checkpoint 节点换成过滤后的内容。
 *
 * 钩子**绝不抛错**：过滤失败只记一笔，不能因为一个后处理把这一轮弄挂。
 */
export function installContextFilter(ctx, opts = {}) {
	const log = typeof opts.log === "function" ? opts.log : () => {};
	const host = makeHostLoader(ctx);
	const cache = new Map(); // checkpoint 内容 → 过滤后文本（同一段只判一次）
	const stats = { checkpoints: 0, dropped: 0, aborted: 0, rewrites: 0 };
	const inFlight = new Set(); // 会话 id → 防重入（append 不可重入，见 dsh-session:583）
	let freezeMessage;

	const loadFreeze = async () => {
		if (freezeMessage !== undefined) return freezeMessage;
		try {
			const kit = await host.load("@deepseek-ai/dsh-llm", ["freezeMessage"]);
			freezeMessage = typeof kit.freezeMessage === "function" ? kit.freezeMessage : null;
		} catch {
			freezeMessage = null;
		}
		if (freezeMessage === null) log("[filter] 拿不到宿主 freezeMessage，退回 Object.freeze");
		return freezeMessage;
	};

	const runFilter = async (text, engine, sessionId) => {
		const key = createHash("sha256").update(text).digest("hex");
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		stats.checkpoints += 1;
		const result = await filterCheckpointText(text, async (entry) => {
			const tokens = distinctiveTokens(entry);
			if (tokens.length === 0) return true; // 没有可查的标识 → 留
			for (const token of tokens) {
				// **只拿环境输出当证据**（`tool/result`）。这一条是独立测逮到的 P0：不加过滤时，
				// 检索语料是本会话自己的日志，而 **checkpoint 本身就是日志里的一条 `user/message`**
				// （正文即摘要）—— 条目挑出的 token 必然命中它自己，于是每条都算「有出处」，
				// `dropped` 恒为 0：真实宿主里这个过滤器**是个空操作**，而套件全绿。
				const page = await engine.searchEvents({
					sessionId,
					query: token,
					limit: 1,
					filters: [{ kind: "type", values: ["tool/result"] }],
				});
				if (Array.isArray(page?.items) && page.items.length > 0) return true;
			}
			return false;
		});
		if (result.dropped > 0) {
			stats.dropped += result.dropped;
			log(`[filter] 出处过滤：${result.checked} 条里删掉 ${result.dropped} 条无环境支撑的条目`);
		}
		if (result.aborted) {
			stats.aborted += 1;
			log(`[filter] 删得太多（超过 ${MAX_DROP_RATIO * 100}%）→ 整段放弃过滤，摘要原样保留`);
		}
		cache.set(key, result.text);
		return result.text;
	};

	/** 把这条会话 surface 上的 checkpoint 换成过滤后的内容。 */
	const rewriteSession = async (session) => {
		const engine = ctx.get?.("sessionQuery");
		if (!engine?.searchEvents || !session?.surface?.nodes || typeof session.append !== "function") return;
		const sessionId = session.id;
		// 拿不到会话 id 就没法检索（也不能拿 null 去检索）—— 独立测指出这道闸得自己站得住，
		// 不能靠下游 fail-open 兜（那样虽然不出错，但白跑一遍过滤）。
		if (!sessionId) return;
		if (inFlight.has(sessionId)) return;
		inFlight.add(sessionId);
		try {
			for (const seq of [...session.surface.nodes]) {
				const event = session.eventAt?.(seq);
				if (event?.type !== "user/message") continue;
				const original = session.deriveEventMessage?.(event);
				const text = messageText(original);
				if (text === undefined || !text.includes(OPEN_TAG)) continue; // 普通消息绝不碰
				let filtered = text;
				try {
					filtered = await runFilter(text, engine, sessionId);
				} catch (error) {
					log(`[filter] 过滤失败，摘要原样保留：${error?.message ?? error}`);
					continue;
				}
				if (filtered === text) continue; // 没有可删的（含：已经过滤过 = 幂等）
				const freeze = await loadFreeze();
				const content = [{ type: "text", text: filtered }];
				const message = freeze ? freeze({ ...original, content }) : Object.freeze({ ...original, content: Object.freeze(content) });
				session.append("user/message", message, {
					surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
					sourceEventSeqs: [seq],
				});
				stats.rewrites += 1;
				log(`[filter] 出处过滤：替换了 checkpoint 节点 seq=${seq}`);
			}
		} finally {
			inFlight.delete(sessionId);
		}
	};

	// 两个触发点都是 waterfall：**必须** return next()，否则链断在这里。
	const guard = (listener) => async (payload, next) => {
		try {
			if (!payload?.signal?.aborted) await listener(payload);
		} catch (error) {
			log(`[filter] 钩子出错，不影响这一轮：${error?.message ?? error}`);
		}
		return next();
	};
	/**
	 * checkpoint 刚落盘就动手 —— **这条与注册顺序无关**，是主力。
	 *
	 * 为什么不能只靠 `agent/pre-step`：waterfall 按**注册顺序**跑，而本包是 profile bundle
	 * （启动时注册），`compaction-basic` 在预设里（后注册）→ 本包的 pre-step 监听会跑在压缩**之前**，
	 * 那时 checkpoint 还没写。于是「刚压完、模型第一次看到摘要」那一次请求会看到**没过滤**的版本
	 * —— 恰恰是最该管住的一次（2026-10-16 读本机 profile 的 `dsh.profile.bundles` 与预设核对出来）。
	 *
	 * 为什么排微任务：**防御性延迟**，不是「append 不可重入」逼出来的 —— 独立测指出那个理由站不住：
	 * `rewriteSession` 是 async，它第一个 `await` 已经把 append 推到 emit 回调之外了，同步调用也不会
	 * 重入（去掉 `queueMicrotask` 的变异套件仍绿，原来那条「emit 里不能直接 append」的断言是空的）。
	 *
	 * **真正没被证明的是时序**：这条路径是 fire-and-forget，没有任何东西保证过滤后的 append 赶在
	 * 本次请求 `deriveMessages()` 之前（`agent/pre-step` 那条是 await 的，有保证）。已如实记进
	 * `docs/状态.md` §4。
	 */
	const disposers = [
		ctx.on("session/event", (session, event) => {
			if (!isCheckpointEvent(event)) return;
			queueMicrotask(() => {
				rewriteSession(session).catch((error) =>
					log(`[filter] 事件触发的过滤出错，不影响这一轮：${error?.message ?? error}`),
				);
			});
		}),
		// 这两条是兜底：常规每步都会跑一遍（幂等），overflow 重试不重跑 pre-step。
		ctx.on("agent/pre-step", guard(({ agent }) => rewriteSession(agent?.session))),
		ctx.on("agent/request-error", guard(({ agent }) => rewriteSession(agent?.session))),
	];

	return {
		name: "context-filter",
		stats,
		rewriteSession,
		dispose: () => {
			for (const disposer of disposers) {
				if (typeof disposer === "function") disposer();
				else disposer?.dispose?.();
			}
		},
	};
}
