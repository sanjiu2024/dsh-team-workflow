#!/usr/bin/env node
/**
 * 成本拆账（REQ-041）：`dsh-team bill --anatomy`。
 *
 * ## 为什么
 *
 * `bill` 回答「今天花了多少」，回答不了**「花在哪」**。没有归因，每次优化都是盲改 ——
 * 不知道该砍工具输出、砍基线提示，还是砍历史。
 *
 * 依据 arXiv 2611.12122（System Optimizations for Cost-Efficient Agent Harnesses）：
 * harness 侧改动对**准确率**几乎无影响，对**成本**能差 2.6 倍；它的方法是先按 trace
 * 看 token 怎么累积，再对症下药。
 *
 * ## 数据从哪来
 *
 * 审计日志里本来就有：`system_message.chars`、`user_message.chars`、
 * `tool_result.resultChars` + `toolName`，以及 `assistant_usage.usage` 的真实 token。
 * **不需要新埋点、不需要解压会话文件**（解压那条例说要 2.7 秒一次）。
 *
 * ## 口径要说清（别把估算当实测）
 *
 * 真实 token 只有 `assistant_usage` 那一条路子；**来源占比是按字符算的**，再乘到
 * `input + cacheRead` 上得到「估算成本」。字符 ≠ token，中英混排时差得还不小 ——
 * 所以输出里明写「估算」，别让人拿它去对账。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 审计日志目录（与 `lib/bill.js` 同源）。 */
export function auditDir(home) {
	return path.join(home, "storages", "audit-log");
}

/** 读一天的审计记录。文件不在就返回 null（审计可以关，关了就是没有，不编）。 */
export function readAuditDay(date, { home } = {}) {
	if (!home) return null;
	const file = path.join(auditDir(home), `${date}.jsonl`);
	if (!fs.existsSync(file)) return null;
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	const records = [];
	let bad = 0;
	for (const line of lines) {
		try {
			records.push(JSON.parse(line));
		} catch {
			bad += 1;
		}
	}
	return { file, records, bad };
}

/**
 * 从审计记录里算出「钱花在哪」。纯函数。
 *
 * @param {Array<object>} records
 */
export function anatomyFromRecords(records) {
	const list = Array.isArray(records) ? records : [];
	const byTool = new Map();
	const turns = new Set();
	let calls = 0;
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let output = 0;
	let systemChars = 0;
	let userChars = 0;
	let toolChars = 0;
	let toolErrors = 0;
	let compactions = 0;

	for (const r of list) {
		if (!r || typeof r !== "object") continue;
		if (r.turn !== undefined) turns.add(r.turn);
		switch (r.event) {
			case "assistant_usage": {
				calls += 1;
				const u = r.usage ?? {};
				input += Number(u.input) || 0;
				cacheRead += Number(u.cacheRead) || 0;
				cacheWrite += Number(u.cacheWrite) || 0;
				output += Number(u.output) || 0;
				break;
			}
			case "system_message":
				systemChars += Number(r.chars) || 0;
				break;
			case "user_message":
				userChars += Number(r.chars) || 0;
				break;
			case "tool_result": {
				const name = typeof r.toolName === "string" && r.toolName ? r.toolName : "(未命名)";
				const chars = Number(r.resultChars) || 0;
				const slot = byTool.get(name) ?? { name, chars: 0, calls: 0, errors: 0 };
				slot.chars += chars;
				slot.calls += 1;
				if (r.isError === true) {
					slot.errors += 1;
					toolErrors += 1;
				}
				byTool.set(name, slot);
				toolChars += chars;
				break;
			}
			case "compaction_summary":
				compactions += 1;
				break;
			default:
				break;
		}
	}

	const bodyChars = systemChars + userChars + toolChars;
	const sentTokens = input + cacheRead + cacheWrite;

	return {
		turns: turns.size,
		calls,
		input,
		cacheRead,
		cacheWrite,
		output,
		sentTokens,
		bodyChars,
		bySource: { system: systemChars, tool: toolChars, user: userChars },
		byTool: [...byTool.values()].sort((a, b) => b.chars - a.chars),
		toolErrors,
		compactions,
	};
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

function bar(pct) {
	const filled = Math.round((pct / 100) * 20);
	return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

/** 渲染成人读的几行。 */
export function formatAnatomy(a, { date } = {}) {
	if (!a) return "没有可拆的账：审计日志不存在（审计可能关着）。";
	if (a.bodyChars === 0 && a.calls === 0) return "这一天没有可拆的记录。";

	const L = [];
	L.push(
		`${date ?? ""} · ${a.turns} turn · ${a.calls} 次调用 · 输入 ${fmt(a.input)} / cacheRead ${fmt(a.cacheRead)} / 输出 ${fmt(a.output)}`,
	);
	L.push("");
	if (a.bodyChars === 0) {
		L.push("上下文构成：这一天没有记录到正文（只有调用计数）。");
	} else {
		L.push("上下文构成（按字符，估算）：");
		const rows = [
			["system 基线", a.bySource.system],
			["工具结果", a.bySource.tool],
			["用户输入", a.bySource.user],
		];
		for (const [label, chars] of rows) {
			const pct = pctOf(chars, a.bodyChars);
			// 用**比例**（0–1）乘，不是百分比 —— 拿 pct 去乘会把结果放大 100 倍
			const share = a.bodyChars > 0 ? (chars / a.bodyChars) * a.sentTokens : 0;
			L.push(`  ${label.padEnd(12)} ${bar(pct)} ${pct.toFixed(1).padStart(5)}%  ${fmt(chars)} 字符 · 约 ${fmt(Math.round(share))} token`);
		}
		L.push("");
		L.push("按这个分摊，最该砍的是占比最高的那一行：system 高就砍基线文本，工具结果高就加预算/压输出。");
	}

	if (a.byTool.length > 0) {
		L.push("");
		L.push("工具结果排行（谁在吃上下文）：");
		for (const t of a.byTool.slice(0, 8)) {
			const avg = t.calls > 0 ? Math.round(t.chars / t.calls) : 0;
			const flag = avg >= 20000 ? "  ← 平均偏大，先看它" : "";
			L.push(`  ${t.name.padEnd(18)} ${String(t.chars).padStart(9)} 字符 · ${String(t.calls).padStart(3)} 次 · 平均 ${String(avg).padStart(7)}${t.errors > 0 ? ` · 失败 ${t.errors}` : ""}${flag}`);
		}
	}
	if (a.compactions > 0) L.push(`\n压缩发生 ${a.compactions} 次。`);
	return L.join("\n");
}
