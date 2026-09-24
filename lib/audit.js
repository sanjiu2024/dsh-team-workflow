/**
 * 审计日志：把 dsh 的 `session/event` 流落成按天的 JSONL。
 *
 * 定位与 pi 版一致 —— 审计日志 = 索引 + 指标，session 持久化才是内容。
 * 只记 callId / 字符数 / sha256，要原文用 callId 回 session 日志 join。
 *
 * 三条硬约束：
 *   1. 对模型完全不可见：不碰 systemPrompt、不改 tool 参数/结果、不发消息、不注册工具
 *   2. 绝不抛异常出 handler（每个 handler 都过 guard）
 *   3. 绝不阻塞、绝不联网：只有 appendFileSync 级别的本地写
 *
 * 落点：`<DSH_HOME>/storages/audit-log/<本地日期>.jsonl`
 * （可用 DSH_TEAM_AUDIT_DIR 覆盖；`DAILY_DIR` 布局与 dsh 其他 storage 目录一致）
 *
 * dsh 事件形状：`SessionEvent = {type, seq, time, data}` —— **payload 全在 `data` 下**。
 * 别按 pi 的 `event.text` / `event.name` 写，那些键在 dsh 里不存在。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { clip, dayFile, dshHome, isoLocal, redact, redactRecord, safeStringify, sha256, walkStrings } from "./util.js";

const SCHEMA_VERSION = 1;
const MAX_LINE_BYTES = 8192;
const DEFAULT_MAX_FIELD_CHARS = 2000;
const PROMPT_PREVIEW_CHARS = 500;

/** Config 校验器：字段类型不对就回退默认值，不抛 */
export const AUDIT_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	maxFieldChars: (v) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined),
	recordFullPrompt: (v) => (typeof v === "boolean" ? v : undefined),
	dir: (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined),
};

export const AUDIT_DEFAULTS = {
	enabled: true,
	maxFieldChars: DEFAULT_MAX_FIELD_CHARS,
	recordFullPrompt: false,
	dir: undefined,
};

/** 单行 8192 字节兜底：反复砍最长的字符串值；仍超则退化成最小记录 */
function fitLine(rec, fallback) {
	let line = safeStringify(rec);
	const bytes = () => Buffer.byteLength(line, "utf8");
	if (bytes() <= MAX_LINE_BYTES) return line;
	rec.truncated = true;
	for (let pass = 0; pass < 16 && bytes() > MAX_LINE_BYTES; pass++) {
		let touched = false;
		walkStrings(rec, (parent, key, value) => {
			if (value.length > 64) {
				parent[key] = value.slice(0, Math.max(64, Math.floor(value.length / 2)));
				touched = true;
			}
		});
		if (!touched) {
			let hit = null;
			walkStrings(rec, (parent, key, value) => {
				if (!hit || value.length > hit.value.length) hit = { parent, key, value };
			});
			if (!hit) break;
			delete hit.parent[hit.key];
		}
		line = safeStringify(rec);
	}
	if (bytes() > MAX_LINE_BYTES) return safeStringify(fallback);
	return line;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 已合并的审计配置
 */
export function installAuditLog(ctx, config) {
	const dir =
		process.env.DSH_TEAM_AUDIT_DIR ??
		config.dir ??
		path.join(dshHome(), "storages", "audit-log");
	const log = (msg) => ctx.logger.warn(`[team:audit-log] ${msg}`);

	let seq = 0;
	let broken = false;
	const ensured = new Set();
	const reported = new Set();
	/** callId → 开始时间戳 */
	const toolStarts = new Map();
	/** callId → 工具名；tool/result 事件不自带工具名，得靠 callId 回查 */
	const toolNames = new Map();
	/** sessionId → 会话级折叠状态 */
	const sessions = new Map();
	const sessionWritten = new Set();

	function reportOnce(key, err) {
		if (reported.has(key)) return;
		reported.add(key);
		log(`${key}: ${err?.message ?? err}`);
	}

	function stateOf(session) {
		let st = sessions.get(session.id);
		if (!st) {
			st = {
				lastStopReason: null,
				turnCalls: 0,
				turnErrors: 0,
				run: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
			};
			sessions.set(session.id, st);
		}
		return st;
	}

	function emit(session, event, fields) {
		const rec = {
			// 先展开 fields，再盖住 v/ts/event/sessionId/seq：
			// 外部插件可以往 fields 里塞同名键，覆盖自己那条记录的结构
			...fields,
			v: SCHEMA_VERSION,
			ts: isoLocal(new Date()),
			event,
			sessionId: session.id,
			seq: seq++,
		};
		redactRecord(rec);
		const line = fitLine(rec, {
			v: SCHEMA_VERSION,
			ts: rec.ts,
			event,
			sessionId: session.id,
			seq: rec.seq,
			truncated: true,
			note: "line_over_limit",
		});
		const file = path.join(dir, dayFile(new Date()));
		try {
			if (!ensured.has(dir)) {
				fs.mkdirSync(dir, { recursive: true });
				ensured.add(dir);
			}
			// 追加写、不缓冲：进程被 kill 也留下已发生的事件
			fs.appendFileSync(file, `${line}\n`, { encoding: "utf8" });
		} catch (err) {
			broken = true;
			reportOnce("write", err);
		}
	}

	const preview = (value, limit = config.maxFieldChars) =>
		clip(
			(() => {
				try {
					return redact(typeof value === "string" ? value : safeStringify(value));
				} catch (err) {
					reportOnce("redact", err);
					return "<redacted:error>";
				}
			})(),
			limit,
		);

	/** 会话头：只在第一次看到这个 session 时写一条，替代 pi 的 before_agent_start */
	function writeSessionHeader(session) {
		if (sessionWritten.has(session.id)) return;
		sessionWritten.add(session.id);
		const header = session.header ?? {};
		emit(session, "session", {
			cwd: typeof header.cwd === "string" ? header.cwd : null,
			formatVersion: header.version ?? null,
			createdAt: num(header.createdAt) || null,
			isSeeded: header.isSeeded === true,
			inheritedEventCount: num(session.inheritedEventCount),
		});
	}

	const dispose = ctx.on("session/event", (session, event) => {
		if (!config.enabled || broken) return;
		try {
			writeSessionHeader(session);
			route(session, event);
		} catch (err) {
			reportOnce("dispatch", err);
		}
	});

	function route(session, event) {
		const d = event.data ?? {};
		const st = stateOf(session);
		switch (event.type) {
			case "turn/start":
				st.turnCalls = 0;
				st.turnErrors = 0;
				st.run = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
				return emit(session, "turn_start", { turn: d.turn });

			case "turn/end":
				return emit(session, "turn_end", {
					turn: d.turn,
					// dsh 的 reason 是对象：{kind:'completed'} / …
					reason: d.reason?.kind ?? (typeof d.reason === "string" ? d.reason : null),
					toolCalls: st.turnCalls,
					toolErrors: st.turnErrors,
					lastStopReason: st.lastStopReason,
					turnTokens: { ...st.run },
				});

			case "step/start":
				return emit(session, "step_start", { turn: d.turn, step: d.step });

			case "step/end":
				return emit(session, "step_end", { turn: d.turn, step: d.step });

			case "user/message": {
				const text = contentText(d.content);
				return emit(session, "user_message", {
					// source 是对象：{kind:'user',…} / {kind:'plugin',…}
					source: d.source?.kind ?? null,
					sourceName: d.source?.name ?? d.source?.plugin ?? null,
					chars: text.length,
					sha256: sha256(text),
					preview: preview(
						text,
						config.recordFullPrompt ? Number.POSITIVE_INFINITY : PROMPT_PREVIEW_CHARS,
					),
				});
			}

			case "system/message": {
				const text = contentText(d.message?.content);
				return emit(session, "system_message", {
					turn: d.turn,
					step: d.step,
					chars: text.length,
					sha256: sha256(text),
				});
			}

			case "assistant/message": {
				const usage = d.usage ?? {};
				const input = num(usage.inputTokens);
				const output = num(usage.outputTokens);
				const cacheRead = num(usage.cacheReadTokens);
				const cacheWrite = num(usage.cacheWriteTokens);
				const reasoning = num(usage.reasoningTokens);
				st.run.input += input;
				st.run.cacheRead += cacheRead;
				st.run.cacheWrite += cacheWrite;
				st.run.output += output;
				st.run.reasoning += reasoning;
				// dsh 的计数是**互斥**的：inputTokens 只是未命中的部分，
				// 计费输入 = input + cacheRead + cacheWrite
				st.run.total += input + output + cacheRead + cacheWrite;
				// stopReason 只在 source.replayState.response 里，够不着就留 null
				st.lastStopReason = d.message?.source?.replayState?.response?.stopReason ?? null;
				return emit(session, "assistant_usage", {
					turn: d.turn,
					step: d.step,
					interrupted: d.interrupted === true,
					provider: d.message?.source?.provider ?? null,
					model: d.message?.source?.model ?? null,
					usage: {
						input,
						cacheRead,
						cacheWrite,
						output,
						total: num(usage.totalTokens),
						reasoning: usage.reasoningTokens === undefined ? null : reasoning,
					},
					...blockCounts(d.message?.content),
					streamEvents: Array.isArray(d.stream) ? d.stream.length : 0,
				});
			}

			case "assistant/attempt":
				return emit(session, "assistant_attempt", {
					turn: d.turn,
					step: d.step,
					streamEvents: Array.isArray(d.stream) ? d.stream.length : 0,
				});

			case "tool/call": {
				st.turnCalls += 1;
				if (d.callId) {
					toolStarts.set(d.callId, Date.now());
					toolNames.set(d.callId, d.name ?? null);
				}
				// 契约：arguments 是模型产出的**原始 JSON 字符串**
				let parsed;
				try {
					parsed = JSON.parse(d.arguments);
				} catch {
					// 模型给了非 JSON 参数：只记原文摘要
				}
				return emit(session, "tool_call", {
					turn: d.turn,
					step: d.step,
					toolName: d.name ?? null,
					toolCallId: d.callId ?? null,
					argsSha256: sha256(typeof d.arguments === "string" ? d.arguments : safeStringify(d.arguments)),
					argsPreview: preview(parsed ?? d.arguments),
				});
			}

			case "tool/result": {
				// content 是 [ToolResultBlock]：{type,toolCallId,content,isError}
				const block = Array.isArray(d.message?.content) ? d.message.content[0] : undefined;
				const callId = block?.toolCallId ?? d.message?.source?.callId ?? null;
				const started = callId ? toolStarts.get(callId) : undefined;
				const name = callId ? toolNames.get(callId) : undefined;
				if (callId) {
					toolStarts.delete(callId);
					toolNames.delete(callId);
				}
				const isError = d.error !== undefined || block?.isError === true;
				if (isError) st.turnErrors += 1;
				const text = contentText(block?.content);
				return emit(session, "tool_result", {
					turn: d.turn,
					step: d.step,
					toolName: name ?? d.message?.source?.name ?? null,
					toolCallId: callId,
					isError,
					errorCode: d.error?.code ?? null,
					durationMs: typeof started === "number" ? Date.now() - started : null,
					resultChars: text.length,
					resultSha256: sha256(text),
				});
			}

			case "compaction/start":
				return emit(session, "compaction_start", {
					compactionId: d.compactionId,
					turn: d.turn ?? null,
				});

			case "compaction/summary":
				return emit(session, "compaction_summary", {
					compactionId: d.compactionId,
					provider: d.provider ?? null,
					model: d.model ?? null,
					summaryChars: contentChars(d.summary),
					shadowedCount: Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : 0,
					shadowedTokenCount: num(d.shadowedTokenCount),
				});

			case "compaction/prune":
				return emit(session, "compaction_prune", {
					shadowedCount: Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : 0,
					shadowedTokenCount: num(d.shadowedTokenCount),
				});

			case "compaction/end":
				return emit(session, "compaction_end", {
					compactionId: d.compactionId,
					error: typeof d.error === "string" ? d.error : null,
				});

			default:
				// 外部插件可以往 SessionEventMap 里加事件；只记形状不记内容。
				return emit(session, "other", { type: event.type });
		}
	}

	return {
		dispose,
		get dir() {
			return dir;
		},
		get seq() {
			return seq;
		},
	};
}

function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 把 ContentBlock[] 拍成纯文本。dsh 的思维块是 `{type:'reasoning', text}` */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function contentChars(content) {
	return contentText(content).length;
}

function blockCounts(content) {
	if (!Array.isArray(content)) return { textChars: 0, thinkingChars: 0, blockTypes: {} };
	let textChars = 0;
	let thinkingChars = 0;
	const blockTypes = {};
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const type = typeof block.type === "string" ? block.type : "unknown";
		blockTypes[type] = (blockTypes[type] ?? 0) + 1;
		if (typeof block.text !== "string") continue;
		if (type === "reasoning") thinkingChars += block.text.length;
		else if (type === "text") textChars += block.text.length;
	}
	return { textChars, thinkingChars, hasThinking: thinkingChars > 0, blockTypes };
}

/** 供 /team-baseline 显示用的一行 */
export function auditStatus(info) {
	return `${info.seq} 条 → ${info.dir}`;
}
