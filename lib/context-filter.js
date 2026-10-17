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
 * ## ⚠️ 还没接线 —— 而第一版接线是**错的**（已撤，别照着写）
 *
 * 我最初把过滤挂在 `agent/pre-step` 上，靠它的 decision `{kind:'enter', messages}` 替换消息。
 * **那是错的**：`agent/pre-step` 只能替换「inbox 里待入场的 `UserMessage`」，而模型侧的消息数组是
 * `dsh-agent-loop` 的 `deriveMessages()` **现场从 surface 导出的，中间没有任何钩子**
 * （`agent/request` 的类型注释明写 "cannot mutate messages"，`llm/stream` 拿到的是 deep-frozen 请求）。
 * checkpoint 是**已经落在 surface 上的节点**，根本不经过 pre-step —— 所以那个接线在真实宿主里是
 * **空操作**（自检却全绿：假替身替它把行为演了一遍）。
 *
 * ## 正确的缝（已查明，照这个重写）
 *
 * 用 `surfaceOp:{op:'replace'}` **原地换节点**，先例是 `dsh-compaction-tool-result-pruner`
 * （`lib/index.js:139-177`），dsh 自己的压缩也用同一条路（`dsh-compaction-basic/lib/index.js:650`）：
 *
 * ```js
 * for (const seq of [...session.surface.nodes]) {
 *   const event = session.eventAt(seq);
 *   if (event?.type !== "user/message") continue;
 *   const original = session.deriveEventMessage(event);          // 模型侧消息
 *   const text = 拼出纯文本(original);                            // 见 textOfMessage
 *   const filtered = await 过滤(text);                            // 本文件下面那些纯函数
 *   if (filtered === text) continue;
 *   const message = freezeMessage({ ...original, content: [{ type: "text", text: filtered }] });
 *   session.append("user/message", message, {
 *     surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
 *     sourceEventSeqs: [seq],
 *   });
 * }
 * ```
 *
 * 触发点要**两个**：`agent/pre-step`（常规）与 `agent/request-error`（overflow 重试不重跑 pre-step）。
 * **做不到**的：删节点/减节点数（两种 surfaceOp 都保留节点）—— 所以只能「改写」不能「删除」。
 *
 * 本文件现在只导出**纯函数**（解析 / 挑标识 / 过滤 + 三道安全闸）—— 它们与缝无关，接线时直接用。
 *
 * ## 三条安全约束（宁可少删，不可错删）
 *
 * 1. **只碰 checkpoint**：正文里没有 `<compacted-summary>` 的消息一律不动（普通消息绝不改）。
 * 2. **查不了就留**：检索服务不可用 / 抛错 / 这条没有可查的标识 → **保留**（fail-open 到「留」）。
 * 3. **删太多就不删**：删掉的条目超过一半 → **整段放弃过滤**并记一笔（把摘要掏空比不过滤更危险）。
 *
 * 删除**不静默**：留下的正文里会写明删了几条（transparent-compact 的「显式丢失标记」）。
 */

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
