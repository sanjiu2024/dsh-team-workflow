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
 * 退出码：0 = 正常；3 = 当天没有审计日志（正常情况，不是错误）；1 = 出错
 *
 * 用法：
 *   node scripts/usage-report.mjs [--date YYYY-MM-DD] [--audit-dir DIR]
 *                                 [--out FILE.md] [--json FILE.json]
 *                                 [--quiet] [--top N] [--raw-paths]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RTK_DEFAULTS, routeSectionText } from "../lib/rtk.js";
import { dayFile, dshHome, isoLocal } from "../lib/util.js";

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
	/** 字符 → token 粗估除数（中英混排的经验值，只用于排量级） */
	charsPerToken: 3.5,
};

/** 默认上下文窗口；`--window` 可覆盖 */
const DEFAULT_WINDOW = 128000;

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
		tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
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

	for (const ev of events) {
		switch (ev.event) {
			case "session":
				agg.sessions.add(ev.sessionId);
				if (typeof ev.cwd === "string" && ev.cwd) agg.sessionCwd.set(ev.sessionId, ev.cwd);
				break;

			case "turn_start":
				agg.turns += 1;
				break;

			case "step_start":
				agg.steps += 1;
				break;

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
				// 计费输入口径：三项互斥相加
				const billing = input + cacheRead + cacheWrite;
				if (billing > agg.peakPrompt) agg.peakPrompt = billing;
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
				if (callId && args) agg.resultsByCallId.set(callId, undefined);
				// 同一工具 + 同一参数摘要 = 重复调用
				const pairKey = `${ev.toolName ?? "?"}|${ev.argsSha256 ?? "?"}`;
				if (!agg.pairs.has(pairKey)) {
					agg.pairs.set(pairKey, { tool: ev.toolName ?? "?", count: 0, callIds: [], args });
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
			sample: sampleArg(pair.tool, pair.args),
		});
	}
	duplicates.sort((a, b) => b.wastedChars - a.wastedChars || b.count - a.count);

	// —— 同一文件重复读取 ——
	const readFiles = new Map();
	for (const pair of agg.pairs.values()) {
		if (pair.tool !== "read" || !pair.args) continue;
		const f = pair.args.file_path ?? pair.args.path;
		if (typeof f !== "string") continue;
		readFiles.set(f, (readFiles.get(f) ?? 0) + pair.count);
	}
	const repeatedReads = [...readFiles.entries()]
		.filter(([, n]) => n > 1)
		.map(([file, count]) => ({ file, count }))
		.sort((a, b) => b.count - a.count);

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
	return base;
}

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

function sampleArg(toolName, args) {
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

	const order = { high: 0, medium: 1, low: 2 };
	return f.sort((a, b) => order[a.severity] - order[b.severity]);
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
	out.push(`> 生成时间：${meta.generatedAt}`);
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
	out.push(`| └ 其中推理 reasoning | ${fmt(t.reasoning)} |`);
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

	out.push("## 3. 工具画像", "");
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

	out.push("## 4. 冗余与浪费", "");
	if (report.duplicates.length) {
		out.push("重复调用（同一工具 + 同一参数摘要）：", "");
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
		out.push("同一文件被重复读取：", "");
		out.push("| 文件 | 次数 |");
		out.push("| --- | ---: |");
		for (const r2 of report.repeatedReads.slice(0, 10)) out.push(`| \`${r2.file}\` | ${r2.count} |`);
		out.push("");
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

	out.push("## 5. 压缩", "");
	const cp = report.compaction;
	out.push("| 项 | 值 |");
	out.push("| --- | ---: |");
	out.push(`| summary 折叠次数 | ${fmt(cp.summaries)} |`);
	out.push(`| pruner 裁剪次数 | ${fmt(cp.prunes)} |`);
	out.push(`| 折叠条目数 | ${fmt(cp.shadowedItems)} |`);
	out.push(`| 从上下文拿掉的 tokens | ${fmt(cp.prunedTokens)} |`);
	out.push("");
	if (!cp.summaries && !cp.prunes) out.push("- 当天没触发任何压缩。", "");

	out.push("## 6. 规范合规", "");
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

	out.push("## 7. 薄弱点清单", "");
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
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
	const now = new Date();
	if (s === "today") return ymd(now);
	if (s === "yesterday") return ymd(new Date(now.getTime() - 86400000));
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

	const date = resolveDate(flags.date);
	const dir = typeof flags["audit-dir"] === "string"
		? flags["audit-dir"]
		: path.join(dshHome(), "storages", "audit-log");
	const top = Number.isFinite(Number(flags.top)) ? Number(flags.top) : 10;
	const window = Number.isFinite(Number(flags.window)) ? Number(flags.window) : DEFAULT_WINDOW;

	const file = path.join(dir, dayFile(new Date(`${date}T12:00:00`)));
	const generatedAt = isoLocal(new Date());

	if (!fs.existsSync(file)) {
		const msg = `当天没有审计日志：${file}`;
		if (flags.json) {
			fs.mkdirSync(path.dirname(path.resolve(flags.json)), { recursive: true });
			fs.writeFileSync(
				flags.json,
				`${JSON.stringify({ date, source: file, exists: false, generatedAt }, null, 2)}\n`,
				"utf8",
			);
		}
		process.stderr.write(`${msg}\n`);
		return 3;
	}

	const { events, lines, badLines } = readEvents(file);
	const agg = aggregateEvents(events);
	const report = buildReport(agg, { top, window });
	const meta = { date, source: file, lines, badLines, generatedAt };
	let markdown = renderMarkdown(report, meta);
	if (!flags["raw-paths"]) markdown = redactPaths(markdown);

	if (flags.out) {
		const outFile = path.resolve(flags.out);
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
			generatedAt,
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
