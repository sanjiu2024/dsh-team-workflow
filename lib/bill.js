/**
 * 账单（REQ-016 · C1）：`dsh-team bill` 的数据层。
 *
 * 数据源是**本包自己的审计日志** `<DSH_HOME>/storages/audit-log/<本地日期>.jsonl` 里的
 * `assistant_usage` 事件 —— 它自带 `provider` / `model` / `ts` 与四个计数，所以「按天 + 按模型」
 * 都是一次顺序读，**不需要解压会话文件**（`~/.dsh/sessions/<会话目录>/session.v4.jsonl.zstd` 那边
 * 100MiB / 59751 帧，全量扫一遍要 2.7 秒）。
 *
 * 2026-10-16 实测对账：拿 `2026-10-15` 的审计日志算出来
 * `input 5,417,230 / output 1,226,172 / cacheRead 194,059,648 / total 200,703,050`，
 * 与之前用会话文件逐帧解压算的**逐项相等**。调用次数会差一点（审计 1111 vs 会话 1098）——
 * 审计按 `assistant_usage` 事件计、会话按消息计，差的是没有用量的那几条。
 *
 * 三个已知边界：
 * 1. **审计可以关**（`lib/audit.js` 的 `AUDIT_DEFAULTS`）。关了就**没有账单** —— 这里会明说，
 *    不会拿别的东西凑一个看着像的数字。
 * 2. 只覆盖**本机**：另一台机器的日志不在这里。
 * 3. **没有钱**：只有 token。要算钱得先有价目表（本包没有，也不猜）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dshHome } from "./util.js";

/** 六个计数（dsh 的 `inputTokens` 只是**未命中缓存**的部分，cacheRead 是另一笔）。 */
const COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"];

/** 空账本。 */
export function emptyTotals() {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

/**
 * 把一条用量累加进账本（**原地改**，返回同一个对象）。缺字段当 0 —— 历史行可能少字段。
 *
 * **只认真数字**（与 `lib/squad-loop.js` 的 `addUsage` 同一口径）：`"12"` 这种字符串不算，
 * 否则一份手改过的日志能让账单凭空多出一笔。宁可少算，不瞎算。
 */
export function addUsage(target, usage) {
	const u = usage ?? {};
	target.calls += 1;
	for (const key of COUNTERS) {
		const v = u[key];
		if (typeof v === "number" && Number.isFinite(v)) target[key] += v;
	}
	return target;
}

/**
 * 汇总一段 JSONL（**纯函数**）。只认 `event === "assistant_usage"` 的行；坏行计数但不炸。
 *
 * @param {string|string[]} input 审计日志的正文，或已经切好的行
 * @returns {{totals: object, byModel: Map<string, object>, bySession: Map<string, object>, sessions: number, bad: number, first?: string, last?: string}}
 */
export function summarizeUsage(input) {
	const lines = Array.isArray(input) ? input : String(input ?? "").split("\n");
	const totals = emptyTotals();
	const byModel = new Map();
	const bySession = new Map();
	const sessions = new Set();
	let bad = 0;
	let first;
	let last;
	for (const line of lines) {
		const text = String(line ?? "").trim();
		if (text === "") continue;
		let d;
		try {
			d = JSON.parse(text);
		} catch {
			bad += 1;
			continue;
		}
		if (!d || typeof d !== "object" || d.event !== "assistant_usage") continue;
		addUsage(totals, d.usage);
		const model = `${d.provider ?? "?"}/${d.model ?? "?"}`;
		if (!byModel.has(model)) byModel.set(model, emptyTotals());
		addUsage(byModel.get(model), d.usage);
		if (typeof d.sessionId === "string" && d.sessionId !== "") {
			sessions.add(d.sessionId);
			if (!bySession.has(d.sessionId)) bySession.set(d.sessionId, emptyTotals());
			addUsage(bySession.get(d.sessionId), d.usage);
		}
		if (typeof d.ts === "string") {
			if (first === undefined || d.ts < first) first = d.ts;
			if (last === undefined || d.ts > last) last = d.ts;
		}
	}
	return { totals, byModel, bySession, sessions: sessions.size, bad, first, last };
}

/** 本地日期 `YYYY-MM-DD`。审计日志按**本地日**分文件，所以这里也按本地算（不是 UTC）。 */
export function localDate(ms) {
	const d = new Date(Number(ms));
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 审计日志目录。 */
export function auditDir(home = dshHome()) {
	return path.join(home, "storages", "audit-log");
}

/**
 * 读某一天的审计日志。**没有这个文件不是错误** —— 那天可能没开审计，也可能没干活。
 *
 * @returns {{file: string, text: string|undefined}}
 */
export function readAuditDay(date, { home = dshHome() } = {}) {
	const file = path.join(auditDir(home), `${date}.jsonl`);
	try {
		return { file, text: fs.readFileSync(file, "utf8") };
	} catch (err) {
		if (err?.code === "ENOENT") return { file, text: undefined };
		throw err;
	}
}

/**
 * 小队那半（**纯函数**）：从落盘的小队记录里挑出**归到这天**的成员用量。
 *
 * 归属规则：优先 `endedAt`（收工时间），没有就用 `startedAt`；两者都没有就**不计** ——
 * 宁可少算，也不许瞎算（把不知道哪天烧的 token 摊到某一天上，比不报更坏）。
 */
export function squadUsageForDay(records, date) {
	const totals = emptyTotals();
	const members = [];
	for (const record of Array.isArray(records) ? records : []) {
		for (const m of Array.isArray(record?.members) ? record.members : []) {
			const at = Number.isFinite(m?.endedAt) ? m.endedAt : Number.isFinite(m?.startedAt) ? m.startedAt : undefined;
			if (at === undefined || localDate(at) !== date) continue;
			const u = m?.usage ?? {};
			addUsage(totals, {
				input: u.inputTokens,
				output: u.outputTokens,
				cacheRead: u.cacheReadTokens,
				cacheWrite: u.cacheWriteTokens,
				reasoning: u.reasoningTokens,
				total: u.totalTokens,
			});
			members.push({ squad: record?.name ?? "?", label: m?.label ?? "?", role: m?.role ?? "", model: m?.model ?? null, total: Number(u.totalTokens) || 0 });
		}
	}
	return { totals, members };
}

/** 千分位。 */
export function fmt(n) {
	return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 一天的账单（IO 壳）：审计那半 + 小队那半。
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {{home?: string, squads?: object[]}} options `squads` 是落盘的小队记录（读盘由调用方做，便于自检）
 */
export function billForDay(date, { home = dshHome(), squads = [] } = {}) {
	const { file, text } = readAuditDay(date, { home });
	const audit = text === undefined ? undefined : summarizeUsage(text);
	return { date, file, audit, squads: squadUsageForDay(squads, date) };
}

/** 渲染成人看的文字。 */
export function formatBill(report) {
	const out = [];
	const a = report.audit;
	if (a === undefined) {
		out.push(`${report.date} · 没有审计日志（${report.file}）`);
		out.push("  → 那天没开审计，或那天没干活。审计开关在 team/extensions/audit.json；关了就没有账单。");
	} else {
		out.push(`${report.date} · ${fmt(a.totals.calls)} 次调用 · ${a.sessions} 个会话 · ${a.byModel.size} 个模型${a.bad > 0 ? ` · ${a.bad} 行读不了（已跳过）` : ""}`);
		out.push(
			`  合计  input ${fmt(a.totals.input)} · output ${fmt(a.totals.output)} · cacheRead ${fmt(a.totals.cacheRead)}` +
				` · cacheWrite ${fmt(a.totals.cacheWrite)} → **${fmt(a.totals.total)}**`,
		);
		for (const [model, t] of [...a.byModel.entries()].sort((x, y) => y[1].total - x[1].total)) {
			out.push(`  ${model}  ${fmt(t.calls)} 次 · in ${fmt(t.input)} · out ${fmt(t.output)} · cacheRead ${fmt(t.cacheRead)} → ${fmt(t.total)}`);
		}
	}
	const s = report.squads;
	if (s.members.length === 0) {
		out.push(`  小队  这天没有成员的用量（成员收工才归属；跨天按 endedAt 算）`);
	} else {
		out.push(`  小队  ${s.members.length} 个成员 · ${fmt(s.totals.calls)} 次调用 → ${fmt(s.totals.total)}`);
		for (const m of s.members.slice(0, 10)) out.push(`    ${m.squad}/${m.label}（${m.role}${m.model ? ` · ${m.model}` : ""}）→ ${fmt(m.total)}`);
		if (s.members.length > 10) out.push(`    …还有 ${s.members.length - 10} 个`);
	}
	out.push("  注：只统计本机；成员用量按收工时间归属；**没有钱**（要算钱得先有价目表）。");
	return out.join("\n");
}
