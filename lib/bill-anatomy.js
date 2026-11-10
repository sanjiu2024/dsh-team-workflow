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
	// 按「调用当时的上下文构成」归属 token。字符是一次性记录的，token 是按调用累加的 ——
	// 直接拿字符占比乘总量会算错（第一版就是这么错的：把 5 条 system_message 累加成了 5 份基线）。
	let attr = { system: 0, user: 0, tool: 0 };

	for (const r of list) {
		if (!r || typeof r !== "object") continue;
		if (r.turn !== undefined) turns.add(r.turn);
		switch (r.event) {
			case "assistant_usage": {
				calls += 1;
				const u = r.usage ?? {};
				const t = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
				input += Number(u.input) || 0;
				cacheRead += Number(u.cacheRead) || 0;
				cacheWrite += Number(u.cacheWrite) || 0;
				output += Number(u.output) || 0;
				const bodyNow = systemChars + userChars + toolChars;
				if (bodyNow > 0 && t > 0) {
					attr.system += (t * systemChars) / bodyNow;
					attr.user += (t * userChars) / bodyNow;
					attr.tool += (t * toolChars) / bodyNow;
				}
				break;
			}
			case "system_message":
				// **覆盖不是累加**：基线重发时会再记一条，但上下文里只有一个基线。
				// 累加等于把它算成 5 份（第一版就是这么错的，把 24.5% 报成了 50.9%）。
				systemChars = Number(r.chars) || systemChars;
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
		bySourceTokens: attr,
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
		L.push("上下文构成（按每次调用当时的构成归属，估算）：");
		// 主语是 **token**：字符是一次性记录的，token 是按调用累加的。
		// 第一版拿字符占比去乘 token 总量，还把 5 条 system_message 累加成 5 份基线，报成了 50.9%。
		const rows = [
			["system 基线", a.bySourceTokens.system, a.bySource.system],
			["用户输入", a.bySourceTokens.user, a.bySource.user],
			["工具结果", a.bySourceTokens.tool, a.bySource.tool],
		].sort((x, y) => y[1] - x[1]);
		for (const [label, tokens, chars] of rows) {
			const pct = pctOf(tokens, a.sentTokens);
			L.push(`  ${label.padEnd(12)} ${bar(pct)} ${pct.toFixed(1).padStart(5)}%  ${fmt(Math.round(tokens))} token · ${fmt(chars)} 字符`);
		}
		L.push("");
		const top = rows[0];
		L.push(`最贵的是「${top[0]}」—— ${top[0].includes("system") ? "砍基线文本（team/RULES.md、AGENTS.md、prompt-inject）" : top[0].includes("用户") ? "上下文在累积：长会话该压缩了，或把长粘贴拆成文件让模型按需读" : "加预算 / 压工具输出"}`);
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
