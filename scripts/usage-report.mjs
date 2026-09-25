#!/usr/bin/env node
/**
 * AI 用量日报：把审计日志（`<DSH_HOME>/storages/audit-log/<日期>.jsonl`）聚合成
 * 一份当日用量 + 薄弱点报告，供「每日复盘」定时任务消费。
 *
 * 定位：审计日志是**索引与指标**（`lib/audit.js` 只记 callId / 字符数 / sha256），
 * 本脚本只读不改，绝不碰 session 持久化原文。
 *
 * 口径（跟 `lib/audit.js` 对齐，改了一边要同步另一边）：
 *   - dsh 的计数是**互斥**的：计费输入 = input + cacheRead + cacheWrite
 *   - `usage.total` 是网关自报值，**不拿来当计费口径**（audit.js L250-252）
 *   - 字符 → token 一律标注为**粗估**，用 CHARS_PER_TOKEN，不进任何结论性数字
 *
 * 章节（1-11）：概览 / Token / 耗时分解 / 上下文放大 / 工具画像 / 联网搜索 /
 * 冗余与浪费 / 压缩 / 规范合规 / 薄弱点清单 / 值得加的功能。
 *
 * 两个关键口径，都在下面有实现，别在外面另算一份：
 *   - 「慢在哪一步」= 每步墙钟拆成 模型等待 / 工具执行 / 其他（buildLatency）
 *   - 「token 消耗在哪一步」= 工具结果会留在上下文里，之后每一步模型请求都要
 *     重新带上它，所以真实成本 ≈ 结果 tokens × 之后还剩多少步（buildAmplification）
 *
 * 退出码：0 = 正常；3 = 当天没有审计日志（正常情况，不是错误）；1 = 出错
 *
 * 用法：
 *   node scripts/usage-report.mjs [--date YYYY-MM-DD] [--audit-dir DIR]
 *                                 [--out FILE.md] [--out-dir DIR] [--json FILE.json]
 *                                 [--quiet] [--top N] [--raw-paths]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RTK_DEFAULTS, routeSectionText } from "../lib/rtk.js";
import { dayFile, dshHome } from "../lib/util.js";

/** 判定「薄弱」的阈值。全部集中在这里，便于按证据调参。 */
export const THRESHOLDS = {
	/** 某工具平均结果字符数超过它 → 该工具在往上下文里灌水 */
	resultCharsAvgHigh: 4000,
	/** 单条结果字符数超过它 → 需要分页或压缩 */
	resultCharsSingleHuge: 20000,
	/** 结果平均字符数超过它的工具才参与「灌水」评估（避免小工具噪声） */
	resultCharsMinCalls: 3,
	/** 工具错误率超过它（且调用数 >= minCallsForRate）→ 工具用法有问题 */
	errorRateHigh: 0.1,
	minCallsForRate: 5,
	/** 缓存命中率低于它 → 前缀不稳定或会话太碎 */
	cacheHitLow: 0.5,
	/** 峰值 prompt / 上下文窗口 超过它 → 压缩没兜住 */
	peakPromptRatio: 0.9,
	/** rtk 合规率低于它 → 系统提示那段没被遵守 */
	rtkComplianceLow: 0.9,
	/** 模型等待占步墙钟超过它 → 瓶颈在模型侧，不在本地工具 */
	modelShareHigh: 0.7,
	/** 单步墙钟超过它（毫秒）→ 这一步值得单独看一眼 */
	stepWallSlowMs: 30000,
	/** 单次工具调用超过它（毫秒）→ 该工具在拖后腿 */
	toolCallSlowMs: 10000,
	/** 某工具「放大器」后占总计费输入超过它 → 它是上下文主力，优先治理 */
	amplifyShareHigh: 0.2,
	/** 字符 → token 粗估除数（中英混排的经验值，只用于排量级） */
	charsPerToken: 3.5,
};

/** 默认上下文窗口；`--window` 可覆盖 */
const DEFAULT_WINDOW = 128000;

/** 这些 flag 必须带值；带上它们是为了在缺值时能报错，而不是静默当真值用 */
const VALUE_FLAGS = ["date", "audit-dir", "out", "out-dir", "json", "top", "window"];

/**
 * 有 `tool_result` 但审计里没记到工具名时的桶名。
 * 这种桶不该参与「薄弱点」判定 —— 它没名字，给不出任何可执行的修法。
 */
export const UNKNOWN_TOOL = "(未记录工具名)";

// —— 纯函数区（导出以便自检直接测） ——

/** 千分位 */
export function fmt(n) {
	if (n === null || n === undefined || Number.isNaN(n)) return "—";
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 保留 n 位小数的百分比 */
export function pct(part, whole, digits = 1) {
	if (!whole) return 0;
	return Number(((part / whole) * 100).toFixed(digits));
}

/** 粗估 token；输入是字符数。一律配「粗估」字样使用。 */
export function estTokens(chars) {
	return Math.round(chars / THRESHOLDS.charsPerToken);
}

/**
 * 从 `lib/rtk.js` 的系统提示文本里**解析**出 rtk 命令表。
 * 不另抄一份 —— 抄了就会和提示词漂移，报告就会开始骗人。
 */
export function rtkCommands() {
	const lines = routeSectionText("rtk").split("\n");
	const start = lines.findIndex((l) => l.startsWith("凡是下面这些命令"));
	if (start === -1) return new Set();
	// 那一行后面先跟一个空行，再跟命令清单 —— 必须跳过空行再开始收集，
	// 否则命令表恒为空集，rtk 合规率会假报 100%（踩过）。
	let i = start + 1;
	while (i < lines.length && lines[i].trim() === "") i += 1;
	const chunk = [];
	for (; i < lines.length && lines[i].trim() !== ""; i++) chunk.push(lines[i]);
	const out = new Set();
	for (const m of chunk.join(" ").matchAll(/`([a-z0-9]+)`/g)) out.add(m[1]);
	return out;
}

const RTK_COMMANDS = rtkCommands();

/**
 * 找出「本该走 rtk 但没走」的命令。
 * 按 `;` / 换行切语句，看每条语句的第一个词是否在 rtk 命令表里；一条命令只记一次。
 * 这是启发式：会漏掉写进变量或别名的命令，也会把 `echo git` 这种当成合规。
 */
export function rtkViolations(commands) {
	const out = [];
	for (const cmd of commands) {
		if (typeof cmd !== "string") continue;
		for (const stmt of cmd.split(/[;\n]/)) {
			const trimmed = stmt.trim();
			if (!trimmed || /^rtk\s/.test(trimmed)) continue;
			const first = (trimmed.replace(/^[&|]+/, "").split(/\s+/)[0] ?? "").toLowerCase();
			if (RTK_COMMANDS.has(first)) {
				out.push({ command: cmd, statement: trimmed });
				break;
			}
		}
	}
	return out;
}

/** 冒号后截断长命令，报告里不贴整条命令 */
function shorten(s, n = 90) {
	const one = String(s).replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * 聚合一天的事件。入参是已解析的事件对象数组（坏行由调用方先剔掉）。
 * 只依赖 `lib/audit.js` 写死的字段名。
 */
export function aggregateEvents(events) {
	const agg = {
		sessions: new Set(),
		turns: 0,
		steps: 0,
		requests: 0,
		userMessages: 0,
		systemMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		toolErrors: 0,
		tokens: {
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			reasoning: 0,
			thinkingChars: 0,
			thinkingSteps: 0,
			/** 网关真的回了 reasoning_tokens 的请求数。0 则下面那些 0 是「没数据」不是「没推理」 */
			reasoningReported: 0,
		},
		peakPrompt: 0,
		models: new Map(),
		tools: new Map(),
		pairs: new Map(),
		resultsByCallId: new Map(),
		callsByCallId: new Map(),
		sessionCwd: new Map(),
		sessionTokens: new Map(),
		sessionRequests: new Map(),
		compaction: { summaries: 0, prunes: 0, prunedTokens: 0, shadowedItems: 0 },
		shellCommands: [],
		subagentCalls: [],
		unknownResultNames: 0,
		/** 步时间线：`sessionId|turn|step` → 时间戳 + 该步工具耗时 */
		stepTimeline: new Map(),
		/** callId → 解析后的工具参数（tool_result 侧不带参数，靠它回查） */
		callArgs: new Map(),
		/** 每条工具结果一行，供「上下文放大」与「联网搜索」两个章节用 */
		toolEvents: [],
	};

	const tool = (name) => {
		const key = name || UNKNOWN_TOOL;
		if (!agg.tools.has(key)) {
			agg.tools.set(key, {
				name: key,
				calls: 0,
				results: 0,
				chars: 0,
				maxChars: 0,
				errors: 0,
				durations: [],
				maxCharsCallId: null,
			});
		}
		return agg.tools.get(key);
	};

	const model = (provider, name) => {
		const key = provider || name ? `${provider ?? "?"} / ${name ?? "?"}` : "(未记录)";
		if (!agg.models.has(key)) {
			agg.models.set(key, { key, requests: 0, billing: 0, output: 0 });
		}
		return agg.models.get(key);
	};

	const stepOf = (ev) => {
		const key = `${ev.sessionId}|${ev.turn}|${ev.step}`;
		let s = agg.stepTimeline.get(key);
		if (!s) {
			s = {
				key,
				sessionId: ev.sessionId ?? null,
				turn: ev.turn ?? null,
				step: ev.step ?? null,
				startTs: null,
				usageTs: null,
				endTs: null,
				toolMs: 0,
				toolCalls: 0,
				toolChars: 0,
				prompt: 0,
				output: 0,
				tools: new Map(),
			};
			agg.stepTimeline.set(key, s);
		}
		return s;
	};

	for (const ev of events) {
		switch (ev.event) {
			case "session":
				agg.sessions.add(ev.sessionId);
				if (typeof ev.cwd === "string" && ev.cwd) agg.sessionCwd.set(ev.sessionId, ev.cwd);
				break;

			case "turn_start":
				agg.turns += 1;
				break;

			case "step_start": {
				agg.steps += 1;
				const s = stepOf(ev);
				const t = tsOf(ev.ts);
				if (t !== null && s.startTs === null) s.startTs = t;
				break;
			}

			case "step_end": {
				const s = stepOf(ev);
				const t = tsOf(ev.ts);
				if (t !== null && s.endTs === null) s.endTs = t;
				break;
			}

			case "user_message":
				agg.userMessages += 1;
				break;

			case "system_message":
				agg.systemMessages += 1;
				break;

			case "assistant_usage": {
				agg.requests += 1;
				const u = ev.usage ?? {};
				const input = num(u.input);
				const cacheRead = num(u.cacheRead);
				const cacheWrite = num(u.cacheWrite);
				const output = num(u.output);
				agg.tokens.input += input;
				agg.tokens.cacheRead += cacheRead;
				agg.tokens.cacheWrite += cacheWrite;
				agg.tokens.output += output;
				agg.tokens.reasoning += num(u.reasoning);
				// reasoning 这一项来自网关 usage.completion_tokens_details.reasoning_tokens，
				// 网关不回这个字段时它恒为 null，日报上就是恒 0 —— 看上去像「没有推理」，
				// 实际是「没这个数据」。审计层记录的 thinkingChars 是本地量的思维块字符数，
				// 网关给不给都在，缺 reasoning 时用它兜底，总比印个假的 0 强。
				agg.tokens.thinkingChars += num(ev.thinkingChars);
				if (num(ev.thinkingChars) > 0) agg.tokens.thinkingSteps += 1;
				if (u.reasoning !== null && u.reasoning !== undefined) agg.tokens.reasoningReported += 1;
				// 计费输入口径：三项互斥相加
				const billing = input + cacheRead + cacheWrite;
				if (billing > agg.peakPrompt) agg.peakPrompt = billing;
				// 落到步时间线：模型等待 = assistant_usage 的 ts − step_start 的 ts
				// （一步理论上可能有多条 usage，取最后一条；实测当日每步最多一条）
				const st = stepOf(ev);
				const usageTs = tsOf(ev.ts);
				if (usageTs !== null && (st.usageTs === null || usageTs > st.usageTs)) st.usageTs = usageTs;
				st.prompt += billing;
				st.output += output;
				const m = model(ev.provider, ev.model);
				m.requests += 1;
				m.billing += billing;
				m.output += output;
				if (ev.sessionId) {
					agg.sessionTokens.set(ev.sessionId, (agg.sessionTokens.get(ev.sessionId) ?? 0) + billing);
					agg.sessionRequests.set(ev.sessionId, (agg.sessionRequests.get(ev.sessionId) ?? 0) + 1);
				}
				break;
			}

			case "tool_call": {
				agg.toolCalls += 1;
				const callId = ev.toolCallId ?? null;
				const t = tool(ev.toolName);
				t.calls += 1;
				if (callId) agg.callsByCallId.set(callId, { tool: t.name, argsSha: ev.argsSha256 });
				const args = parseArgs(ev.argsPreview);
				if (callId && args) {
					agg.callArgs.set(callId, args);
					agg.resultsByCallId.set(callId, undefined);
				}
				// 同一工具 + 同一参数摘要 = 重复调用。
				// 键里必须带 sessionId：两个会话不共享上下文，同一个参数各调一次
				// 谁都没付第二遍钱，算成「重复」是虚报（曾经把跨 3 个会话的 9 次
				// read 报成「同参数调了 9 次」）。
				const pairKey = `${ev.sessionId ?? "?"}|${ev.toolName ?? "?"}|${ev.argsSha256 ?? "?"}`;
				if (!agg.pairs.has(pairKey)) {
					agg.pairs.set(pairKey, {
						tool: ev.toolName ?? "?",
						sessionId: ev.sessionId ?? null,
						count: 0,
						callIds: [],
						args,
					});
				}
				const pair = agg.pairs.get(pairKey);
				pair.count += 1;
				if (callId) pair.callIds.push(callId);
				if (args) {
					// shell 类工具收集命令，供 rtk 合规检查
					const shellKey = RTK_DEFAULTS.shellArgKeys.find((k) => typeof args[k] === "string");
					if (shellKey) agg.shellCommands.push(args[shellKey]);
					if (ev.toolName === "subagent") agg.subagentCalls.push(args);
				}
				break;
			}

			case "tool_result": {
				agg.toolResults += 1;
				const chars = num(ev.resultChars);
				const name = ev.toolName || null;
				if (!name) agg.unknownResultNames += 1;
				const t = tool(name);
				t.results += 1;
				t.chars += chars;
				if (chars > t.maxChars) {
					t.maxChars = chars;
					t.maxCharsCallId = ev.toolCallId ?? null;
				}
				if (typeof ev.durationMs === "number") t.durations.push(ev.durationMs);
				if (ev.isError) {
					t.errors += 1;
					agg.toolErrors += 1;
				}
				if (ev.toolCallId) agg.resultsByCallId.set(ev.toolCallId, chars);
				// 落到步时间线 + 汇总成一条 toolEvents（新章节的两个数据源）
				const st = stepOf(ev);
				const tname = name || UNKNOWN_TOOL;
				if (!st.tools.has(tname)) st.tools.set(tname, { ms: 0, calls: 0 });
				const te = st.tools.get(tname);
				te.calls += 1;
				if (typeof ev.durationMs === "number") {
					te.ms += ev.durationMs;
					st.toolMs += ev.durationMs;
				}
				st.toolCalls += 1;
				st.toolChars += chars;
				agg.toolEvents.push({
					sessionId: ev.sessionId ?? null,
					turn: ev.turn ?? null,
					step: ev.step ?? null,
					tool: name,
					chars,
					ms: typeof ev.durationMs === "number" ? ev.durationMs : null,
					isError: ev.isError === true,
					callId: ev.toolCallId ?? null,
				});
				break;
			}

			case "compaction_summary":
				agg.compaction.summaries += 1;
				agg.compaction.prunedTokens += num(ev.shadowedTokenCount);
				agg.compaction.shadowedItems += num(ev.shadowedCount);
				break;

			case "compaction_prune":
				agg.compaction.prunes += 1;
				agg.compaction.prunedTokens += num(ev.shadowedTokenCount);
				agg.compaction.shadowedItems += num(ev.shadowedCount);
				break;

			default:
				break;
		}
	}

	return agg;
}

function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 解析审计日志的 ISO 时间戳；解析不了返回 null（宁可跳过，也不拿 0 冒充） */
function tsOf(v) {
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

/** 已排序数组的分位数；空数组返回 null */
export function quantile(sorted, p) {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
	return sorted[i];
}

/** argsPreview 是**被截断过**的 JSON；解析失败就返回 null，不猜 */
function parseArgs(preview) {
	if (typeof preview !== "string" || preview === "") return null;
	try {
		const v = JSON.parse(preview);
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

/**
 * 把聚合结果整理成「可直接渲染 + 可直接判定」的结构。
 */
export function buildReport(agg, options = {}) {
	const topN = options.top ?? 10;
	const window = options.window ?? DEFAULT_WINDOW;
	const tokens = agg.tokens;
	const billing = tokens.input + tokens.cacheRead + tokens.cacheWrite;

	// —— 工具画像 ——
	const tools = [...agg.tools.values()]
		.map((t) => ({
			name: t.name,
			calls: t.calls,
			results: t.results,
			chars: t.chars,
			avgChars: t.results ? Math.round(t.chars / t.results) : 0,
			maxChars: t.maxChars,
			errors: t.errors,
			errorRate: t.results ? t.errors / t.results : 0,
			avgMs: t.durations.length
				? Math.round(t.durations.reduce((a, b) => a + b, 0) / t.durations.length)
				: null,
		}))
		.sort((a, b) => b.chars - a.chars || b.calls - a.calls);

	// —— 重复调用（按浪费的结果字符数排序）——
	const duplicates = [];
	for (const pair of agg.pairs.values()) {
		if (pair.count < 2) continue;
		const chars = pair.callIds.map((id) => agg.resultsByCallId.get(id)).filter(isNumber);
		const avg = chars.length ? chars.reduce((a, b) => a + b, 0) / chars.length : 0;
		duplicates.push({
			tool: pair.tool,
			count: pair.count,
			avgChars: Math.round(avg),
			// 多调的那几次，结果字符数基本全浪费
			wastedChars: Math.round(avg * (pair.count - 1) * (chars.length ? 1 : 0)),
			sample: sampleArg(pair.args),
		});
	}
	duplicates.sort((a, b) => b.wastedChars - a.wastedChars || b.count - a.count);

	// —— 同一文件重复读取 ——
	// 按「会话 + 文件」计，不按文件路径全局计：跨会话各读一次不算浪费。
	// 同时分开数「同参数（同 offset/limit）」的真重复 —— 顺序翻页读同一文件
	// 的不同区段是正常做法，按路径混在一起数会把它算成重复读。
	const readFiles = new Map();
	for (const pair of agg.pairs.values()) {
		if (pair.tool !== "read") continue;
		for (const id of pair.callIds) {
			const a = agg.callArgs.get(id);
			if (!a) continue;
			const f = a.file_path ?? a.path;
			if (typeof f !== "string") continue;
			const key = `${pair.sessionId ?? "?"}|${f}`;
			let entry = readFiles.get(key);
			if (!entry) readFiles.set(key, (entry = { file: f, count: 0, byArgs: new Map() }));
			entry.count += 1;
			const argKey = `${a.offset ?? ""},${a.limit ?? ""}`;
			entry.byArgs.set(argKey, (entry.byArgs.get(argKey) ?? 0) + 1);
		}
	}
	const repeatedReads = [...readFiles.values()]
		.filter((e) => e.count > 1)
		.map((e) => ({
			file: e.file,
			count: e.count,
			sameArgs: Math.max(...e.byArgs.values()),
		}))
		.sort((a, b) => b.sameArgs - a.sameArgs || b.count - a.count);

	// —— 单条超大结果 ——
	const bigResults = tools
		.filter((t) => t.maxChars >= THRESHOLDS.resultCharsSingleHuge)
		.map((t) => ({ tool: t.name, chars: t.maxChars, estTokens: estTokens(t.maxChars) }))
		.sort((a, b) => b.chars - a.chars);

	// —— 会话 Top ——
	const sessions = [...agg.sessionTokens.entries()]
		.map(([id, tok]) => ({
			id,
			billing: tok,
			requests: agg.sessionRequests.get(id) ?? 0,
			cwd: agg.sessionCwd.get(id) ?? null,
		}))
		.sort((a, b) => b.billing - a.billing)
		.slice(0, topN);

	// —— 合规 ——
	const violations = rtkViolations(agg.shellCommands);
	const rtkCompliance = agg.shellCommands.length
		? 1 - violations.length / agg.shellCommands.length
		: 1;
	const subagentTotal = agg.subagentCalls.length;
	const subagentWithRoute = agg.subagentCalls.filter(
		(a) => typeof a.provider === "string" && typeof a.model === "string",
	).length;

	const cacheHitRate = billing ? tokens.cacheRead / billing : 0;
	const peakRatio = window ? agg.peakPrompt / window : 0;

	// —— 耗时分解 / 上下文放大 / 联网搜索（第 3、4、6 章）——
	const latency = buildLatency(agg, topN);
	const amplification = buildAmplification(agg, billing, topN);
	const web = buildWeb(agg, topN);
	const slowCalls = agg.toolEvents
		.filter((e) => typeof e.ms === "number" && e.ms >= THRESHOLDS.toolCallSlowMs)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, topN)
		.map((e) => ({
			tool: e.tool || UNKNOWN_TOOL,
			ms: e.ms,
			chars: e.chars,
			stepKey: `${e.sessionId}|${e.turn}|${e.step}`,
		}));

	const base = {
		tokens: {
			billing,
			...tokens,
			cacheHitRate: Number(cacheHitRate.toFixed(4)),
			avgPromptPerRequest: agg.requests ? Math.round(billing / agg.requests) : 0,
			peakPrompt: agg.peakPrompt,
			peakRatio: Number(peakRatio.toFixed(4)),
			window,
		},
		counts: {
			sessions: agg.sessions.size,
			turns: agg.turns,
			steps: agg.steps,
			requests: agg.requests,
			userMessages: agg.userMessages,
			systemMessages: agg.systemMessages,
			toolCalls: agg.toolCalls,
			toolResults: agg.toolResults,
			toolErrors: agg.toolErrors,
		},
		models: [...agg.models.values()].sort((a, b) => b.billing - a.billing),
		tools,
		duplicates,
		repeatedReads,
		bigResults,
		sessions,
		latency,
		amplification,
		web,
		slowCalls,
		compaction: agg.compaction,
		compliance: {
			rtkEligible: agg.shellCommands.length,
			rtkViolations: violations.length,
			rtkComplianceRate: Number(rtkCompliance.toFixed(4)),
			rtkSamples: violations.slice(0, topN).map((v) => shorten(v.statement)),
			subagentCalls: subagentTotal,
			subagentWithRoute,
			unknownResultNames: agg.unknownResultNames,
		},
	};

	base.findings = buildFindings(base);
	base.features = buildFeatureIdeas(base);
	return base;
}

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

function sampleArg(args) {
	if (!args) return null;
	if (typeof args.file_path === "string") return args.file_path;
	if (typeof args.path === "string") return args.path;
	if (typeof args.command === "string") return shorten(args.command, 70);
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.query === "string") return shorten(args.query, 70);
	if (typeof args.description === "string") return args.description;
	return null;
}

/**
 * 薄弱点判定。每条都要给出**证据数字**，没证据的不列 ——
 * 这份清单会被定时任务当成改代码的依据，含糊等于害人。
 */
export function buildFindings(r) {
	const f = [];
	const push = (severity, id, title, evidence, suggestion) =>
		f.push({ severity, id, title, evidence, suggestion });

	// 1. 往上下文灌水的工具
	const floods = r.tools.filter(
		(t) =>
			t.name !== UNKNOWN_TOOL &&
			t.results >= THRESHOLDS.resultCharsMinCalls &&
			t.avgChars > THRESHOLDS.resultCharsAvgHigh,
	);
	for (const t of floods.slice(0, 5)) {
		push(
			"high",
			`tool-flood:${t.name}`,
			`\`${t.name}\` 平均每次回 ${fmt(t.avgChars)} 字符（${t.results} 次共 ${fmt(t.chars)}）`,
			`平均 ${fmt(t.avgChars)} 字符/次，粗估 ${fmt(estTokens(t.chars))} tokens`,
			floodSuggestion(t.name),
		);
	}

	// 2. 单条超大结果
	if (r.bigResults.length) {
		const worst = r.bigResults[0];
		push(
			"high",
			"single-huge-result",
			`最大单条结果 ${fmt(worst.chars)} 字符（\`${worst.tool}\`）`,
			`粗估 ${fmt(worst.estTokens)} tokens 一次性进上下文`,
			worst.tool === "read"
				? "read 不在压缩白名单（截断会断行号）：应改用 offset/limit 分页，或先 grep 定位再局部读"
				: "给该工具加分页参数，或纳入压缩白名单",
		);
	}

	// 3. 重复调用浪费
	const wasteChars = r.duplicates.reduce((a, b) => a + b.wastedChars, 0);
	if (wasteChars > 0) {
		const top = r.duplicates[0];
		push(
			wasteChars > 20000 ? "high" : "medium",
			"duplicate-calls",
			`重复调用浪费约 ${fmt(wasteChars)} 字符`,
			`最重的一条：\`${top.tool}\` 同参数调了 ${top.count} 次${top.sample ? `（${shorten(top.sample, 60)}）` : ""}`,
			"同一份材料读一次就够；重复读说明在反复确认，应收敛成一次读全",
		);
	}

	// 4. 工具错误率
	const flaky = r.tools.filter(
		(t) =>
			t.name !== UNKNOWN_TOOL &&
			t.results >= THRESHOLDS.minCallsForRate &&
			t.errorRate > THRESHOLDS.errorRateHigh,
	);
	for (const t of flaky.slice(0, 5)) {
		const allFailed = t.errorRate === 1;
		push(
			allFailed ? "high" : "medium",
			`tool-error:${t.name}`,
			`\`${t.name}\` 错误率 ${pct(t.errors, t.results)}%`,
			`${t.errors}/${t.results} 次失败`,
			allFailed
				? "当天一次都没成：先确认这个工具在本部署里到底能不能用，再谈参数写法"
				: "看 argsPreview 里失败调用的形状，多半是参数或路径写法的固定毛病",
		);
	}

	// 5. 缓存命中率
	if (r.tokens.billing > 0 && r.tokens.cacheHitRate < THRESHOLDS.cacheHitLow) {
		push(
			"medium",
			"low-cache-hit",
			`缓存命中率仅 ${(r.tokens.cacheHitRate * 100).toFixed(1)}%`,
			`cacheRead ${fmt(r.tokens.cacheRead)} / 计费输入 ${fmt(r.tokens.billing)}`,
			"前缀不稳定或会话过碎。检查是否有东西每轮改动系统提示（时间戳、随机 id）",
		);
	}

	// 6. 压缩兜底
	if (r.tokens.peakRatio > THRESHOLDS.peakPromptRatio) {
		push(
			"high",
			"peak-prompt",
			`峰值 prompt 已达窗口的 ${(r.tokens.peakRatio * 100).toFixed(1)}%`,
			`峰值 ${fmt(r.tokens.peakPrompt)} / 窗口 ${fmt(r.tokens.window)}`,
			"压缩没兜住：要么调低压缩阈值，要么查是谁把上下文撑到这么大",
		);
	}

	// 7. rtk 合规
	if (r.compliance.rtkEligible >= 10 && r.compliance.rtkComplianceRate < THRESHOLDS.rtkComplianceLow) {
		push(
			"medium",
			"rtk-compliance",
			`rtk 合规率 ${(r.compliance.rtkComplianceRate * 100).toFixed(1)}%`,
			`${r.compliance.rtkViolations}/${r.compliance.rtkEligible} 条 shell 命令该走 rtk 却走了原命令`,
			"系统提示那段没被遵守。看样本是命令写法问题，还是提示本身不够显眼",
		);
	}

	// 8. 子代理档位
	if (r.compliance.subagentCalls > 0 && r.compliance.subagentWithRoute < r.compliance.subagentCalls) {
		push(
			"low",
			"subagent-route",
			`${r.compliance.subagentCalls - r.compliance.subagentWithRoute}/${r.compliance.subagentCalls} 次 subagent 调用没显式传 provider/model`,
			"不传就继承主 agent 档位，等于白开选档能力",
			"这属于规则执行问题（team/RULES.md 已写明），一般不靠改代码解决",
		);
	}

	// 9. 慢在哪一步：模型等待占大头
	if (r.latency.steps >= 10 && r.latency.modelShare >= THRESHOLDS.modelShareHigh) {
		push(
			"medium",
			"model-wait",
			`模型等待占步墙钟 ${(r.latency.modelShare * 100).toFixed(1)}%`,
			`${fmt(r.latency.modelMs)}ms / ${fmt(r.latency.wallMs)}ms（${r.latency.steps} 步，p90 ${fmt(r.latency.wall.p90)}ms，最慢 ${fmt(r.latency.wall.max)}ms）`,
			"时间大头在等模型返回，不在本地工具。削 prompt 长度比优化 shell 更快见效",
		);
	}

	// 9b. 单个慢步
	const slowSteps = r.latency.slowest.filter((s) => s.wallMs >= THRESHOLDS.stepWallSlowMs);
	if (slowSteps.length) {
		const w = slowSteps[0];
		push(
			"medium",
			"slow-steps",
			`${slowSteps.length} 步墙钟超过 ${fmt(THRESHOLDS.stepWallSlowMs)}ms`,
			`最慢一步 ${fmt(w.wallMs)}ms（模型 ${fmt(w.modelMs)}ms / 工具 ${fmt(w.toolMs)}ms，prompt ${fmt(w.prompt)} tokens，${w.toolCalls} 次工具）`,
			"看这几步的 prompt 里塞了什么：多半是几条超大工具结果把每一步都撑大了",
		);
	}

	// 9c. 时间戳缺口（数据质量）
	const gaps = r.latency.missingStart + r.latency.missingEnd + r.latency.missingUsage;
	if (gaps > 0) {
		push(
			"low",
			"latency-gaps",
			`${gaps} 步缺时间戳，未计入耗时分解`,
			`缺 step_start ${r.latency.missingStart} / 缺 step_end ${r.latency.missingEnd} / 缺 usage ${r.latency.missingUsage}`,
			"缺时间戳的步被整步跳过（宁可少报也不拿别的值凑）。会话被强杀会导致这种情况，持续出现才需要查",
		);
	}

	// 10. token 消耗在哪一步：上下文放大
	if (r.amplification.byTool.length && r.tokens.billing) {
		const top = r.amplification.byTool[0];
		push(
			top.ampTokens / r.tokens.billing >= THRESHOLDS.amplifyShareHigh ? "high" : "medium",
			"context-amplification",
			`工具结果放大后占计费输入 ${(r.amplification.share * 100).toFixed(1)}%`,
			`粗估 ${fmt(r.amplification.totalTokens)} tokens 来自工具结果在后续各步的重复携带；最重是 \`${top.name}\` ${fmt(top.ampTokens)} tokens`,
			"结果只进上下文一次、却要付到会话结束：缩小单条结果的体积（分页/压缩）比减少调用次数收益更大",
		);
	}

	// 11. 联网搜索
	const slowWeb = r.web.slowest.filter((w) => (w.ms ?? 0) >= 3000);
	if (slowWeb.length) {
		const w = slowWeb[0];
		push(
			"low",
			"slow-web",
			`${slowWeb.length} 次联网请求超过 3s（最慢 ${fmt(w.ms)}ms）`,
			`\`${w.tool}\` ${fmt(w.ms)}ms${w.sample ? `：${w.sample}` : ""}`,
			"联网等待是纯外部延迟，本地优化不了：能并行就并行，能缓存就缓存",
		);
	}
	for (const q of r.web.repeated.slice(0, 3)) {
		push(
			"low",
			"repeated-web-query",
			`同一组搜索词在 ${q.sessions} 个会话里共搜了 ${q.count} 次：\`${q.query}\``,
			`累计返回 ${fmt(q.chars)} 字符`,
			"跨会话的网络时间是白花的（缓存是进程级，本该拦住）；上下文只在同会话内重复付费",
		);
	}

	const order = { high: 0, medium: 1, low: 2 };
	return f.sort((a, b) => order[a.severity] - order[b.severity]);
}

// —— 耗时分解 / 上下文放大 / 联网搜索（第 3、4、6 章的纯函数）——

/** 该步内真正吃掉时间的工具（按累计 durationMs 排）；没工具就返回 null */
function dominantTool(tools) {
	if (!tools || !tools.size) return null;
	let best = null;
	for (const [name, v] of tools) if (!best || v.ms > best.ms) best = { name, ms: v.ms, calls: v.calls };
	return best;
}

/**
 * 耗时分解 —— 「慢在哪一步」的唯一依据。
 *
 * 每一步的墙钟拆成三段：
 *   模型等待 = assistant_usage 的 ts − step_start 的 ts（含网关排队与流式返回）
 *   工具执行 = 该步内所有 tool_result.durationMs 之和
 *   其他     = 墙钟 − 模型 − 工具（本地事件处理，通常接近 0）
 *
 * 三个时间戳缺一个就**跳过该步并单独计数**，不拿别的值凑 ——
 * 少报几步不会让结论反向，凑出来的数字会让结论反向。
 */
export function buildLatency(agg, topN = 10) {
	const steps = [];
	let missingStart = 0;
	let missingEnd = 0;
	let missingUsage = 0;

	for (const s of agg.stepTimeline.values()) {
		if (s.startTs === null) {
			missingStart += 1;
			continue;
		}
		if (s.endTs === null) {
			missingEnd += 1;
			continue;
		}
		if (s.usageTs === null) {
			missingUsage += 1;
			continue;
		}
		const wallMs = s.endTs - s.startTs;
		const modelMs = Math.max(0, s.usageTs - s.startTs);
		const toolMs = s.toolMs;
		steps.push({
			key: s.key,
			sessionId: s.sessionId,
			turn: s.turn,
			step: s.step,
			wallMs,
			modelMs,
			toolMs,
			otherMs: Math.max(0, wallMs - modelMs - toolMs),
			toolCalls: s.toolCalls,
			prompt: s.prompt,
			output: s.output,
			dominant: dominantTool(s.tools),
		});
	}

	const sum = (k) => steps.reduce((a, b) => a + b[k], 0);
	const wallMs = sum("wallMs");
	const modelMs = sum("modelMs");
	const toolMs = sum("toolMs");
	const otherMs = sum("otherMs");
	const sortedWall = steps.map((s) => s.wallMs).sort((a, b) => a - b);
	const sortedModel = steps.map((s) => s.modelMs).sort((a, b) => a - b);
	const perf = (arr) => ({
		p50: quantile(arr, 0.5),
		p90: quantile(arr, 0.9),
		p99: quantile(arr, 0.99),
		max: arr.length ? arr.at(-1) : null,
	});

	return {
		steps: steps.length,
		missingStart,
		missingEnd,
		missingUsage,
		wallMs,
		modelMs,
		toolMs,
		otherMs,
		modelShare: wallMs ? modelMs / wallMs : 0,
		toolShare: wallMs ? toolMs / wallMs : 0,
		wall: perf(sortedWall),
		model: perf(sortedModel),
		slowest: [...steps].sort((a, b) => b.wallMs - a.wallMs).slice(0, topN),
	};
}

/**
 * 上下文放大 —— 「token 消耗在哪一步」的正解。
 *
 * 一条工具结果不是只进上下文一次：它会**留在上下文里**，之后这个会话每一次
 * 模型请求都要重新带上它。所以真实成本 ≈ 结果 tokens × 之后还剩多少步。
 *
 * 按原始字符数排名会骗人：5 万字符的结果出现在最后一步，实际只付一次钱；
 * 反过来 2 千字符的结果出现在第 3 步，会被付几十次。这里按放大后的量排名。
 */
export function buildAmplification(agg, billing, topN = 10) {
	const bySession = new Map();
	for (const s of agg.stepTimeline.values()) {
		if (!s.sessionId) continue;
		if (!bySession.has(s.sessionId)) bySession.set(s.sessionId, []);
		bySession.get(s.sessionId).push(s);
	}
	const posOf = new Map();
	for (const list of bySession.values()) {
		list.sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
		list.forEach((s, i) => posOf.set(s.key, { index: i, total: list.length }));
	}

	const byTool = new Map();
	const contributors = [];
	let totalTokens = 0;
	for (const ev of agg.toolEvents) {
		if (typeof ev.chars !== "number" || ev.chars <= 0) continue;
		const pos = posOf.get(`${ev.sessionId}|${ev.turn}|${ev.step}`);
		if (!pos) continue;
		const remaining = pos.total - 1 - pos.index;
		if (remaining <= 0) continue;
		const once = estTokens(ev.chars);
		const amp = once * remaining;
		totalTokens += amp;
		const name = ev.tool || UNKNOWN_TOOL;
		byTool.set(name, (byTool.get(name) ?? 0) + amp);
		contributors.push({
			tool: name,
			chars: ev.chars,
			estTokens: once,
			remaining,
			ampTokens: amp,
			stepKey: `${ev.sessionId}|${ev.turn}|${ev.step}`,
		});
	}

	return {
		totalTokens,
		share: billing ? totalTokens / billing : 0,
		byTool: [...byTool.entries()]
			.map(([name, ampTokens]) => ({ name, ampTokens }))
			.sort((a, b) => b.ampTokens - a.ampTokens)
			.slice(0, topN),
		top: contributors.sort((a, b) => b.ampTokens - a.ampTokens).slice(0, topN),
	};
}

/** web_search 的参数是 queries[]，web_fetch 是 url —— 都压成一行 */
function webSample(args) {
	if (!args) return null;
	if (Array.isArray(args.queries) && args.queries.length) return shorten(args.queries.join(" / "), 70);
	if (typeof args.url === "string") return shorten(args.url, 70);
	return null;
}

/** 联网搜索专项：次数 / 耗时 / 结果量 / 重复查询 */
export function buildWeb(agg, topN = 10) {
	const items = agg.toolEvents.filter((e) => e.tool === "web_search" || e.tool === "web_fetch");
	const byTool = new Map();
	for (const it of items) {
		if (!byTool.has(it.tool)) byTool.set(it.tool, { name: it.tool, calls: 0, ms: 0, chars: 0, errors: 0, maxMs: 0 });
		const t = byTool.get(it.tool);
		t.calls += 1;
		t.ms += it.ms ?? 0;
		t.chars += it.chars ?? 0;
		if (it.isError) t.errors += 1;
		if ((it.ms ?? 0) > t.maxMs) t.maxMs = it.ms ?? 0;
	}

	// 同一组搜索词被搜多次 = 白花的网络时间（缓存是进程级，跨会话也算）
	// + 白花的上下文（只在同会话内成立）。两个数分开给，不混成一个「重复」。
	const queries = new Map();
	for (const it of items) {
		if (it.tool !== "web_search") continue;
		const args = it.callId ? agg.callArgs.get(it.callId) : null;
		const qs = Array.isArray(args?.queries) ? args.queries : [];
		const key = qs
			.map((q) => String(q).trim().toLowerCase())
			.filter(Boolean)
			.sort()
			.join(" | ");
		if (!key) continue;
		if (!queries.has(key)) queries.set(key, { query: key, count: 0, chars: 0, sessions: new Set() });
		const q = queries.get(key);
		q.count += 1;
		q.chars += it.chars ?? 0;
		if (it.sessionId) q.sessions.add(it.sessionId);
	}

	return {
		calls: items.length,
		ms: items.reduce((a, b) => a + (b.ms ?? 0), 0),
		chars: items.reduce((a, b) => a + (b.chars ?? 0), 0),
		errors: items.filter((b) => b.isError).length,
		byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls),
		repeated: [...queries.values()]
			.filter((q) => q.count > 1)
			.map((q) => ({ ...q, sessions: q.sessions.size }))
			.sort((a, b) => b.count - a.count)
			.slice(0, topN),
		slowest: [...items]
			.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
			.slice(0, topN)
			.map((it) => ({
				tool: it.tool,
				ms: it.ms,
				chars: it.chars,
				isError: it.isError,
				sample: webSample(it.callId ? agg.callArgs.get(it.callId) : null),
			})),
	};
}

/**
 * 「值得加的功能」——从当天证据反推、可以写进 backlog 的能力。
 *
 * 与「薄弱点清单」的分工：薄弱点回答「今天哪里不对」，这里回答
 * 「把哪件事做成能力，明天就不用再操心」。
 * 每条都挂当天的一个数字 —— 没有证据的灵感不进这份清单，
 * 否则定时任务会把它当待办，凭空想的会污染 backlog。
 */
export function buildFeatureIdeas(r) {
	const ideas = [];
	const add = (impact, idea) => ideas.push({ impact, ...idea });

	// 1) 上下文主力工具：谁在放大，就先治谁
	const topAmp = r.amplification.byTool[0];
	if (topAmp && r.tokens.billing && topAmp.ampTokens / r.tokens.billing >= THRESHOLDS.amplifyShareHigh) {
		const repeated = r.repeatedReads[0];
		add(topAmp.ampTokens, {
			id: "result-cache",
			title: `${topAmp.name} 结果的会话内缓存`,
			evidence:
				`\`${topAmp.name}\` 放大后约 ${fmt(topAmp.ampTokens)} tokens，占计费输入的 ${pct(topAmp.ampTokens, r.tokens.billing)}%` +
				(repeated ? `；同一会话内同一文件最多读 ${repeated.count} 次，其中同参数重复 ${repeated.sameArgs} 次` : ""),
			why: "工具结果留在上下文里，之后每一步模型请求都重新带上它 —— 同一份材料在同会话里读两次，就是把它在每一步都付两遍钱",
			now: "缓存落地前：先 grep 定位再 read；read 带上 offset/limit，但同一区段别重读 —— 分页翻同一文件不同区段是正常的，" +
				"浪费的是同一区段读两遍",
		});
	}

	// 2) 模型等待占大头 → 瓶颈不在本地
	if (r.latency.steps >= 10 && r.latency.modelShare >= THRESHOLDS.modelShareHigh) {
		const worst = r.latency.slowest[0];
		add(r.latency.modelMs, {
			id: "latency-watch",
			title: "模型等待监控与长 prompt 拆分",
			evidence:
				`模型等待占步墙钟 ${(r.latency.modelShare * 100).toFixed(1)}%` +
				`（${fmt(r.latency.modelMs)}ms / ${fmt(r.latency.wallMs)}ms）` +
				(worst ? `；最慢一步 ${fmt(worst.wallMs)}ms，prompt ${fmt(worst.prompt)} tokens` : ""),
			why: "时间大头花在等模型返回，而 prompt 越大等待越久 —— 削 prompt 就是直接削墙钟",
			now: "先看最慢那几步的 prompt 里塞了什么，多半是几条超大工具结果",
		});
	}

	// 3) 上下文水位顶到天花板 → 护栏
	if (r.tokens.peakRatio >= THRESHOLDS.peakPromptRatio) {
		add(r.tokens.peakPrompt, {
			id: "context-guard",
			title: "上下文水位护栏",
			evidence: `单次峰值 prompt ${fmt(r.tokens.peakPrompt)} tokens，已是窗口的 ${(r.tokens.peakRatio * 100).toFixed(1)}%`,
			why: "顶到窗口上限时压缩开始丢内容，而且越接近上限每一步越贵",
			now: "先把折叠阈值下调一档，让它早一点触发",
		});
	}

	// 4) 同一组搜索词被搜了多次 → 查询缓存
	if (r.web.repeated.length) {
		const q = r.web.repeated[0];
		add(r.web.chars, {
			id: "web-cache",
			title: "联网搜索的查询缓存",
			evidence: `同一组搜索词当天在 ${q.sessions} 个会话里被搜了 ${q.count} 次（\`${q.query}\`）；全天联网 ${r.web.calls} 次共 ${fmt(r.web.ms)}ms`,
			why: "跨会话重复搜的网络时间是白花的 —— 同一进程内结果几乎一样，缓存一次就够",
			now: "当天先复用上一次结果，别换着措辞反复搜",
		});
	}

	// 5) 慢工具
	if (r.slowCalls.length) {
		const worst = r.slowCalls[0];
		add(
			r.slowCalls.reduce((a, b) => a + b.ms, 0),
			{
				id: "slow-tool-timeout",
				title: "慢工具的超时与后台化",
				evidence: `当天 ${r.slowCalls.length} 次工具调用超过 ${fmt(THRESHOLDS.toolCallSlowMs)}ms，最慢 ${fmt(worst.ms)}ms（\`${worst.tool}\`）`,
				why: "前台干等的慢调用会整段占住会话，而它往往是能后台化的长命令",
				now: "长命令改用后台 job，先做别的再回来收结果",
			},
		);
	}

	// 6) 审计自身的缺口：结果没工具名 → 归因断链
	if (r.compliance.unknownResultNames > 0) {
		add(r.compliance.unknownResultNames, {
			id: "audit-toolname",
			title: "审计补齐 tool_result 的工具名",
			evidence: `${fmt(r.compliance.unknownResultNames)} 条工具结果没记到工具名，这些字符无法归因到任何工具`,
			why: "归因断链会让工具画像和放大分析同时漏掉一整块消耗，报告就看不到真凶",
			now: "先修 lib/audit.js：tool_result 落盘时按 callId 回查工具名再写",
		});
	}

	// 7) 完全失效的工具
	for (const t of r.tools) {
		if (t.calls < THRESHOLDS.minCallsForRate || t.errorRate < 1) continue;
		add(t.errors, {
			id: `dead-tool:${t.name}`,
			title: `失效工具体检：\`${t.name}\``,
			evidence: `\`${t.name}\` 当天 ${t.errors}/${t.calls} 次全部失败`,
			why: "一个恒失败的工具会反复骗模型再试，每次重试都要重新付一遍上下文",
			now: "先确认它在当前部署里能不能用；不能用就从工具表里摘掉",
		});
	}

	// 8) rtk 合规
	if (r.compliance.rtkEligible >= 10 && r.compliance.rtkComplianceRate < THRESHOLDS.rtkComplianceLow) {
		add(r.compliance.rtkViolations, {
			id: "rtk-enforce",
			title: "rtk 包装兜底",
			evidence: `rtk 合规率 ${(r.compliance.rtkComplianceRate * 100).toFixed(1)}%（${r.compliance.rtkViolations}/${r.compliance.rtkEligible} 条没走 rtk）`,
			why: "没走 rtk 的命令输出是原始体积，直接进上下文",
			now: "在 shell 层强制包装，别指望每次都想起来",
		});
	}

	// 只留影响最大的几条：清单太长等于没有清单
	return ideas.sort((a, b) => b.impact - a.impact).slice(0, 5);
}

/** 该工具是否已被 rtk 输出压缩覆盖 */
function inRTKCompactList(name) {
	return RTK_DEFAULTS.compactTools.some((t) => t.toLowerCase() === String(name).toLowerCase());
}

/**
 * 给「灌水工具」配建议。
 * `read` 必须单独说 —— `lib/rtk.js` 有意把它排除在压缩白名单外
 * （截断会切断行号），照搬「加进白名单」等于让定时任务去推翻这条设计。
 */
function floodSuggestion(name) {
	if (String(name).toLowerCase() === "read") {
		return "read 有意不在压缩白名单（截断会断行号）：应改用 offset/limit 分页，或先 grep 定位再局部读";
	}
	if (inRTKCompactList(name)) {
		return "已在 rtk 压缩白名单里：调低 maxChars/maxLines，或让它分页返回";
	}
	return "考虑加入 rtk 的 compactTools 白名单，或要求调用方限定范围/分页";
}

// —— 渲染 ——

export function renderMarkdown(report, meta) {
	const out = [];
	const c = report.counts;
	const t = report.tokens;
	out.push(`# AI 用量日报 — ${meta.date}`, "");
	out.push(`> 数据源：\`${meta.source}\`（${fmt(meta.lines)} 行，${fmt(meta.badLines)} 坏行）`);
	out.push(
		`> 口径：计费输入 = input + cacheRead + cacheWrite；字符→token 为粗估` +
			`（${THRESHOLDS.charsPerToken} 字符/token）`,
	);
	out.push("");

	out.push("## 1. 概览", "");
	out.push("| 指标 | 值 |");
	out.push("| --- | ---: |");
	out.push(`| 会话 | ${fmt(c.sessions)} |`);
	out.push(`| 轮次 | ${fmt(c.turns)} |`);
	out.push(`| 步（step） | ${fmt(c.steps)} |`);
	out.push(`| 模型请求 | ${fmt(c.requests)} |`);
	out.push(`| 工具调用 / 结果 | ${fmt(c.toolCalls)} / ${fmt(c.toolResults)} |`);
	out.push(`| 工具错误 | ${fmt(c.toolErrors)} |`);
	out.push(`| 用户消息 / 系统消息 | ${fmt(c.userMessages)} / ${fmt(c.systemMessages)} |`);
	out.push("");

	out.push("## 2. Token", "");
	out.push("| 项 | tokens |");
	out.push("| --- | ---: |");
	out.push(`| **计费输入** | **${fmt(t.billing)}** |`);
	out.push(`| ├ 未命中 input | ${fmt(t.input)} |`);
	out.push(`| ├ 缓存读 cacheRead | ${fmt(t.cacheRead)} |`);
	out.push(`| └ 缓存写 cacheWrite | ${fmt(t.cacheWrite)} |`);
	out.push(`| 输出 output | ${fmt(t.output)} |`);
	if (num(t.reasoningReported) > 0) {
		out.push(`| └ 其中推理 reasoning | ${fmt(t.reasoning)} |`);
	} else {
		// 这里曾经无条件印一行「推理 reasoning 0」。网关不回
		// completion_tokens_details.reasoning_tokens 时它恒为 null，日报上就成了
		// 一个好看的 0 —— 读的人会以为「模型没推理」，而真相是「没这个数据」。
		// 没数据就说没数据，本地能量到的思维字符数照旧拿出来。
		out.push(
			`| └ 其中推理 reasoning | 无此数据（网关 ${fmt(c.requests)} 次请求都没回 ` +
				"`reasoning_tokens`） |",
		);
		out.push(
			`| └ 思维字符数 thinkingChars | ${fmt(t.thinkingChars)}` +
				`（${fmt(t.thinkingSteps)} 步有思考） |`,
		);
	}
	out.push("");
	out.push(`- 缓存命中率：**${(t.cacheHitRate * 100).toFixed(1)}%**（${fmt(t.cacheRead)}/${fmt(t.billing)}）`);
	out.push(`- 平均每次请求 prompt：${fmt(t.avgPromptPerRequest)} tokens`);
	out.push(
		`- 单次峰值 prompt：${fmt(t.peakPrompt)} tokens` +
			`（窗口 ${fmt(t.window)} 的 ${(t.peakRatio * 100).toFixed(1)}%）`,
	);
	out.push("");
	if (report.models.length) {
		out.push("按模型：", "");
		out.push("| 模型 | 请求 | 计费输入 | 输出 |");
		out.push("| --- | ---: | ---: | ---: |");
		for (const m of report.models) {
			out.push(`| ${m.key} | ${fmt(m.requests)} | ${fmt(m.billing)} | ${fmt(m.output)} |`);
		}
		out.push("");
	}

	out.push("## 3. 耗时分解", "");
	out.push("慢在哪一步：每一步的墙钟拆成「模型等待 / 工具执行 / 其他」。", "");
	const L = report.latency;
	out.push(
		`- 计入 ${fmt(L.steps)} 步；缺 step_start ${L.missingStart} / 缺 step_end ${L.missingEnd} / ` +
			`缺 usage ${L.missingUsage}（缺一个就整步跳过，不拿别的值凑）`,
	);
	out.push("");
	if (L.steps) {
		out.push("| 项 | 毫秒 | 占比 | p50 | p90 | p99 | max |");
		out.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
		out.push(
			`| **步墙钟合计** | **${fmt(L.wallMs)}** | 100% | ${fmt(L.wall.p50)} | ${fmt(L.wall.p90)} | ` +
				`${fmt(L.wall.p99)} | ${fmt(L.wall.max)} |`,
		);
		out.push(
			`| ├ 模型等待 | ${fmt(L.modelMs)} | ${(L.modelShare * 100).toFixed(1)}% | ${fmt(L.model.p50)} | ` +
				`${fmt(L.model.p90)} | ${fmt(L.model.p99)} | ${fmt(L.model.max)} |`,
		);
		out.push(`| ├ 工具执行 | ${fmt(L.toolMs)} | ${(L.toolShare * 100).toFixed(1)}% | — | — | — | — |`);
		out.push(`| └ 其他 | ${fmt(L.otherMs)} | ${pct(L.otherMs, L.wallMs)}% | — | — | — | — |`);
		out.push("");
		if (L.modelShare >= THRESHOLDS.modelShareHigh) {
			out.push(
				`- **瓶颈在模型侧**：模型等待占 ${(L.modelShare * 100).toFixed(1)}%，本地工具只占 ` +
					`${(L.toolShare * 100).toFixed(1)}% —— 削 prompt 比优化 shell 更快见效`,
			);
			out.push("");
		}
		if (L.slowest.length) {
			out.push(`最慢的 ${L.slowest.length} 步：`, "");
			out.push("| 会话 | turn/step | 墙钟 | 模型 | 工具 | prompt | 主力工具 |");
			out.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
			for (const s of L.slowest) {
				out.push(
					`| \`${String(s.sessionId ?? "?").slice(0, 14)}…\` | ${s.turn}/${s.step} | ${fmt(s.wallMs)}ms | ` +
						`${fmt(s.modelMs)}ms | ${fmt(s.toolMs)}ms | ${fmt(s.prompt)} | ` +
						`${s.dominant ? `\`${s.dominant.name}\` ${fmt(s.dominant.ms)}ms` : "—"} |`,
				);
			}
			out.push("");
		}
	} else {
		out.push("- 当天没有三个时间戳齐全的步，无法分解耗时。", "");
	}

	out.push("## 4. 上下文放大", "");
	out.push("消耗在哪一步：工具结果会留在上下文里，之后每一步模型请求都要重新带上它。", "");
	out.push("所以真实成本 ≈ 结果 tokens × 之后还剩多少步（粗估）。", "");
	out.push("这是**上界**：被压缩挪出上下文的部分没扣掉，缓存读也没按更便宜的价格折算 —— 看趋势和排序，别当绝对值读。", "");
	const A = report.amplification;
	if (A.byTool.length) {
		out.push(
			`计费输入里约 **${(A.share * 100).toFixed(1)}%** 来自工具结果在后续各步的重复携带` +
				`（粗估 ${fmt(A.totalTokens)} tokens）：`,
			"",
		);
		out.push("| 工具 | 放大后 tokens |");
		out.push("| --- | ---: |");
		for (const x of A.byTool) out.push(`| \`${x.name}\` | ${fmt(x.ampTokens)} |`);
		out.push("");
		out.push("单条最贵的工具结果：", "");
		out.push("| 工具 | 结果字符 | 一次 tokens | 之后还有几步 | 放大后 tokens |");
		out.push("| --- | ---: | ---: | ---: | ---: |");
		for (const x of A.top) {
			out.push(`| \`${x.tool}\` | ${fmt(x.chars)} | ${fmt(x.estTokens)} | ${x.remaining} | ${fmt(x.ampTokens)} |`);
		}
		out.push("");
	} else {
		out.push("- 当天没有可归因到具体步的工具结果。", "");
	}

	out.push("## 5. 工具画像", "");
	out.push("| 工具 | 调用 | 结果总字符 | 平均 | 最大 | 错误率 | 耗时均值 | rtk 压缩 |");
	out.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |");
	for (const tool of report.tools) {
		out.push(
			`| \`${tool.name}\` | ${fmt(tool.calls)} | ${fmt(tool.chars)} | ${fmt(tool.avgChars)} | ` +
				`${fmt(tool.maxChars)} | ${pct(tool.errors, tool.results)}% | ` +
				`${tool.avgMs === null ? "—" : `${fmt(tool.avgMs)}ms`} | ` +
				`${inRTKCompactList(tool.name) ? "是" : "否"} |`,
		);
	}
	out.push("");

	out.push("## 6. 联网搜索", "");
	const W = report.web;
	if (W.calls) {
		out.push(
			`全天 ${fmt(W.calls)} 次联网（${fmt(W.ms)}ms，结果 ${fmt(W.chars)} 字符，错误 ${fmt(W.errors)} 次）：`,
			"",
		);
		out.push("| 工具 | 调用 | 总耗时 | 最慢一次 | 结果字符 | 错误 |");
		out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
		for (const w of W.byTool) {
			out.push(
				`| \`${w.name}\` | ${fmt(w.calls)} | ${fmt(w.ms)}ms | ${fmt(w.maxMs)}ms | ` +
					`${fmt(w.chars)} | ${fmt(w.errors)} |`,
			);
		}
		out.push("");
		if (W.slowest.length) {
			out.push("最慢的几次：", "");
			for (const w of W.slowest) {
				out.push(
					`- \`${w.tool}\` ${fmt(w.ms)}ms，${fmt(w.chars)} 字符` +
						`${w.isError ? "（**失败**）" : ""}${w.sample ? `：${w.sample}` : ""}`,
				);
			}
			out.push("");
		}
		if (W.repeated.length) {
			out.push("同一组搜索词被搜了多次（网络时间白花的，会重复搜就说明缓存没拦住）：", "");
			out.push("| 搜索词 | 次数 | 其中会话数 | 累计结果字符 |");
			out.push("| --- | ---: | ---: | ---: |");
			for (const q of W.repeated) {
				out.push(`| ${q.query} | ${q.count} | ${q.sessions} | ${fmt(q.chars)} |`);
			}
			out.push(
				"",
				"上下文的账只在同会话内算 —— 跨会话各搜一次不重复付上下文钱，但网络时间是真花了。",
				"",
			);
		}
	} else {
		out.push("- 当天没有联网调用。", "");
	}

	out.push("## 7. 冗余与浪费", "");
	if (report.duplicates.length) {
		out.push("重复调用（同一会话内 + 同一工具 + 同一参数摘要）：", "");
		out.push("| 工具 | 次数 | 平均结果字符 | 重复浪费（粗估） |");
		out.push("| --- | ---: | ---: | ---: |");
		for (const d of report.duplicates.slice(0, 10)) {
			out.push(
				`| \`${d.tool}\` | ${d.count} | ${fmt(d.avgChars)} | ` +
					`${fmt(d.wastedChars)} 字符 ≈ ${fmt(estTokens(d.wastedChars))} tokens |`,
			);
		}
		out.push("");
	} else {
		out.push("- 没有重复调用。", "");
	}

	if (report.repeatedReads.length) {
		out.push("同一会话内重复读取的文件：", "");
		out.push("| 文件 | 次数 | 其中同参数 |");
		out.push("| --- | ---: | ---: |");
		for (const r2 of report.repeatedReads.slice(0, 10)) out.push(`| \`${r2.file}\` | ${r2.count} | ${r2.sameArgs} |`);
		out.push(
			"",
			"「同参数」= offset/limit 也一样的真重复；次数多但同参数少，说明是在翻同一个文件的不同区段，不算浪费。",
			"",
		);
	}

	if (report.bigResults.length) {
		out.push(`单条结果 ≥ ${fmt(THRESHOLDS.resultCharsSingleHuge)} 字符：`, "");
		out.push("| 工具 | 最大字符 | 粗估 tokens |");
		out.push("| --- | ---: | ---: |");
		for (const b of report.bigResults) out.push(`| \`${b.tool}\` | ${fmt(b.chars)} | ${fmt(b.estTokens)} |`);
		out.push("");
	}

	if (report.sessions.length) {
		out.push("占用最高的会话：", "");
		out.push("| 会话 | cwd | 请求 | 计费输入 |");
		out.push("| --- | --- | ---: | ---: |");
		for (const s of report.sessions) {
			out.push(`| \`${s.id.slice(0, 20)}…\` | ${s.cwd ?? "—"} | ${fmt(s.requests)} | ${fmt(s.billing)} |`);
		}
		out.push("");
	}

	out.push("## 8. 压缩", "");
	const cp = report.compaction;
	out.push("| 项 | 值 |");
	out.push("| --- | ---: |");
	out.push(`| summary 折叠次数 | ${fmt(cp.summaries)} |`);
	out.push(`| pruner 裁剪次数 | ${fmt(cp.prunes)} |`);
	out.push(`| 折叠条目数 | ${fmt(cp.shadowedItems)} |`);
	out.push(`| 从上下文拿掉的 tokens | ${fmt(cp.prunedTokens)} |`);
	out.push("");
	if (!cp.summaries && !cp.prunes) out.push("- 当天没触发任何压缩。", "");

	out.push("## 9. 规范合规", "");
	out.push("| 项 | 值 |");
	out.push("| --- | --- |");
	out.push(
		`| rtk 合规率 | ${(report.compliance.rtkComplianceRate * 100).toFixed(1)}%` +
			`（${report.compliance.rtkViolations}/${report.compliance.rtkEligible} 条未走 rtk） |`,
	);
	out.push(
		`| subagent 显式选档 | ${report.compliance.subagentWithRoute}/${report.compliance.subagentCalls} |`,
	);
	out.push(`| 工具结果未记录工具名 | ${fmt(report.compliance.unknownResultNames)} |`);
	out.push("");
	if (report.compliance.rtkSamples.length) {
		out.push("未走 rtk 的命令样本：", "");
		for (const s of report.compliance.rtkSamples) out.push(`- \`${s}\``);
		out.push("");
	}

	out.push("## 10. 薄弱点清单", "");
	if (!report.findings.length) {
		out.push("没有命中任何薄弱点阈值。", "");
	} else {
		out.push("| 严重度 | 薄弱点 | 证据 | 建议 |");
		out.push("| --- | --- | --- | --- |");
		const label = { high: "高", medium: "中", low: "低" };
		for (const x of report.findings) {
			out.push(
				`| ${label[x.severity]} | ${x.title} | ${x.evidence} | ${x.suggestion} |`,
			);
		}
		out.push("");
	}

	out.push("## 11. 值得加的功能", "");
	if (!report.features.length) {
		out.push("当天证据不足以支撑一条有把握的新功能，宁可不提。", "");
	} else {
		out.push("从当天数字反推的能力缺口 —— 每条都挂了当天的证据，不是凭空想的：", "");
		for (const f of report.features) {
			out.push(`### ${f.title}`, "");
			out.push(`- **证据**：${f.evidence}`);
			out.push(`- **为什么值得**：${f.why}`);
			out.push(`- **现在就能做的**：${f.now}`);
			out.push("");
		}
	}

	out.push("---", "");
	out.push("本报告由 `scripts/usage-report.mjs` 生成，只读审计日志，不改任何数据。");
	return `${out.join("\n")}\n`;
}

// —— IO 与主流程 ——

function parseArgv(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq !== -1) {
				flags[a.slice(2, eq)] = a.slice(eq + 1);
			} else {
				const key = a.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i += 1;
				} else {
					flags[key] = true;
				}
			}
		} else {
			positional.push(a);
		}
	}
	return { flags, positional };
}

/** 本地日期字符串 */
export function ymd(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 解析 `--date`：`YYYY-MM-DD` / `today` / `yesterday`。
 * 相对日期放在这里算 —— 定时任务在无人值守下自己算「昨天」，跨月、跨时区都容易翻车。
 */
export function resolveDate(spec) {
	const s = typeof spec === "string" && spec ? spec : "today";
	const now = new Date();
	if (s === "today") return ymd(now);
	if (s === "yesterday") return ymd(new Date(now.getTime() - 86400000));
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		// 正则只管形状：2026-02-30 / 2026-13-45 都能过，但 new Date 得 Invalid Date，
		// dayFile 于是产出 NaN-NaN-NaN.jsonl，文件必然不存在 → 伪装成 exit 3
		// 「当天没有审计日志」。无人值守下日期写错会被当成「那天没数据」静默吞掉，
		// 所以这里做一次往返校验，把配置错误暴露成 exit 1。
		if (ymd(new Date(`${s}T12:00:00`)) !== s) throw new Error(`不存在的日期：${s}`);
		return s;
	}
	throw new Error(`无法识别的 --date：${spec}（支持 YYYY-MM-DD / today / yesterday）`);
}

/** 读 jsonl，返回 {events, lines, badLines}。缺文件由调用方处理。 */
export function readEvents(file) {
	const raw = fs.readFileSync(file, "utf8");
	const lines = raw.split("\n");
	const events = [];
	let badLines = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			badLines += 1;
		}
	}
	return { events, lines: lines.filter((l) => l.trim() !== "").length, badLines };
}

/**
 * 路径脱敏：报告要进公开仓库，别把本机用户名和 DSH_HOME 带出去。
 * `--raw-paths` 可以关掉（本地排查时用）。
 */
export function redactPaths(text) {
	const home = os.homedir();
	const dsh = dshHome();
	let out = text;
	for (const [from, to] of [
		[dsh, "~/.dsh"],
		[`${dsh}\\`, "~/.dsh\\"],
		[home, "~"],
		[`${home}\\`, "~\\"],
	]) {
		out = out.split(from).join(to);
	}
	return out;
}

async function main() {
	const { flags } = parseArgv(process.argv.slice(2));

	if (flags.help) {
		process.stdout.write(
			[
				"用法：node scripts/usage-report.mjs [选项]",
				"",
				"  --date YYYY-MM-DD   报告日期（默认今天）",
				"  --audit-dir DIR     审计日志目录（默认 <DSH_HOME>/storages/audit-log）",
				"  --out FILE          同时写 markdown 到文件",
				"  --out-dir DIR       写 markdown 到 DIR/<日期>.md（定时任务用，文件名由日期定，不用手拼）",
				"  --json FILE         同时写 JSON 摘要到文件",
				"  --top N             各榜单条数（默认 10）",
				"  --window N          上下文窗口 token 数（默认 128000）",
				"  --quiet             不往 stdout 打 markdown",
				"  --raw-paths         不做路径脱敏（本地排查用）",
				"",
				"退出码：0 正常 / 3 当天没有审计日志 / 1 出错",
				"",
			].join("\n"),
		);
		return 0;
	}

	// 缺值的 flag 会被 parseArgv 当成 true：--out-dir 落空只是不写文件，--window 却会让
	// Number(true) 变成 1，peakRatio 直接上天、第 10 节误报。配置错误必须响，不能静默过去。
	const missingValue = VALUE_FLAGS.filter((k) => flags[k] === true);
	if (missingValue.length > 0) {
		process.stderr.write(
			`参数缺少值：${missingValue.map((k) => `--${k}`).join("、")}\n`,
		);
		return 1;
	}
	if (typeof flags.out === "string" && typeof flags["out-dir"] === "string") {
		process.stderr.write("--out 与 --out-dir 不能同时给：两者都要写 markdown，只能留一个\n");
		return 1;
	}

	const date = resolveDate(flags.date);
	const dir = typeof flags["audit-dir"] === "string"
		? flags["audit-dir"]
		: path.join(dshHome(), "storages", "audit-log");
	const top = Number.isFinite(Number(flags.top)) ? Number(flags.top) : 10;
	const window = Number.isFinite(Number(flags.window)) ? Number(flags.window) : DEFAULT_WINDOW;

	const file = path.join(dir, dayFile(new Date(`${date}T12:00:00`)));

	if (!fs.existsSync(file)) {
		// 契约：3 = 当天没有审计日志，且不写任何文件。定时任务靠「什么都没产出」判断
		// 不该提交，所以这里连 --json 也不能写 —— 半个 json 会让它以为报告已生成。
		process.stderr.write(`当天没有审计日志：${file}\n`);
		return 3;
	}

	const { events, lines, badLines } = readEvents(file);
	const agg = aggregateEvents(events);
	const report = buildReport(agg, { top, window });
	const meta = { date, source: file, lines, badLines };
	let markdown = renderMarkdown(report, meta);
	if (!flags["raw-paths"]) markdown = redactPaths(markdown);

	if (flags.out) {
		const outFile = path.resolve(flags.out);
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, markdown, "utf8");
		process.stderr.write(`已写入 ${outFile}\n`);
	} else if (typeof flags["out-dir"] === "string") {
		// 文件名由报告日期定 —— 定时任务在无人值守下自己拼文件名，跨月/重跑都不会写错
		const outFile = path.join(path.resolve(flags["out-dir"]), `${date}.md`);
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, markdown, "utf8");
		process.stderr.write(`已写入 ${outFile}\n`);
	}
	if (flags.json) {
		const jsonFile = path.resolve(flags.json);
		fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
		const payload = {
			date,
			source: flags["raw-paths"] ? file : redactPaths(file),
			exists: true,
			lines,
			badLines,
			...report,
		};
		fs.writeFileSync(jsonFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		process.stderr.write(`已写入 ${jsonFile}\n`);
	}
	if (!flags.quiet) process.stdout.write(markdown);
	return 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err) => {
			process.stderr.write(`✗ 生成用量报告失败：${err?.stack ?? err}\n`);
			process.exitCode = 1;
		});
}
