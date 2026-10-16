#!/usr/bin/env node
/**
 * 自检：两个 CLI 子命令（REQ-016 · C1 `bill` + B6 `squad ls`）。
 *
 * 三段：
 *   1. **账单纯函数**：`summarizeUsage`（只认 `assistant_usage`、坏行计数、按模型/按会话、时间范围）、
 *      `addUsage`（缺字段当 0）、`localDate`（**本地日**，不是 UTC）、`fmt`
 *   2. **小队那半**：`squadUsageForDay` 的归属规则（`endedAt` 优先 → 回退 `startedAt` → 都没有不计）、
 *      `readSquadsForCwd` / `renderSquadRecords` / `readAllSquads`，以及**只读**（版本不认识的文件
 *      不许被改名隔离 —— 看一眼不该改用户的盘）
 *   3. **真跑子命令**（临时 `DSH_HOME` + 子进程）：空目录、有数据、坏参数、没有那天 —— 退出码与文案
 *
 * 为什么第 3 段不能省：纯函数全绿但子命令没接上（`case` 写错、flag 名写错）时，
 * 前两段照样通过，而用户那边只是「命令不存在」。
 *
 *   node scripts/selftest-cli.mjs
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const BIN = fileURLToPath(new URL("bin/dsh-team.mjs", ROOT));

const { addUsage, billForDay, emptyTotals, fmt, formatBill, localDate, squadUsageForDay, summarizeUsage } = await import(
	new URL("lib/bill.js", ROOT).href
);
const { readAllSquads, readSquadsForCwd, renderSquadRecords, squadStoreDir } = await import(new URL("lib/squad-cli.js", ROOT).href);
const { createSquadStore, SQUAD_STORE_VERSION } = await import(new URL("lib/squad-store.js", ROOT).href);

/** JSON.parse 包一层：坏了报出是哪份文件，而不是裸 SyntaxError（lens 要求 try/catch） */
function readJsonOrFail(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`读不了 ${file}：${error?.message ?? error}`);
	}
}

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

/** 造一天审计日志：usage 事件 + 一条别的 + 一条坏行 */
const usageLine = (over = {}) =>
	JSON.stringify({
		event: "assistant_usage",
		provider: "new-api",
		model: "tier-std",
		sessionId: "session-1",
		ts: "2026-10-15T01:00:00.000+08:00",
		usage: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, reasoning: 5, total: 1110 },
		...over,
	});

// ── 1. 账单纯函数 ─────────────────────────────────────────────────────────

check("summarizeUsage：只认 assistant_usage，别的行与坏行都不算（坏行计数但不炸）", () => {
	const text = [
		usageLine(),
		'{"event":"tool_call","usage":{"total":999999}}',
		"这不是 JSON",
		"",
		usageLine({ sessionId: "session-2", ts: "2026-10-15T02:00:00.000+08:00", usage: { input: 1, output: 2, total: 3 } }),
	].join("\n");
	const s = summarizeUsage(text);
	assert.equal(s.totals.calls, 2, "只算两条 usage");
	assert.equal(s.totals.input, 101);
	assert.equal(s.totals.output, 12);
	assert.equal(s.totals.cacheRead, 1000);
	assert.equal(s.totals.total, 1113);
	assert.equal(s.sessions, 2);
	assert.equal(s.bad, 1, "坏行要计数");
	assert.equal(s.byModel.size, 1);
	assert.equal(s.byModel.get("new-api/tier-std").calls, 2);
	assert.equal(s.first, "2026-10-15T01:00:00.000+08:00");
	assert.equal(s.last, "2026-10-15T02:00:00.000+08:00");
});

check("summarizeUsage：空输入与没有 usage 字段的行都不炸", () => {
	assert.equal(summarizeUsage("").totals.calls, 0);
	assert.equal(summarizeUsage([]).totals.calls, 0);
	assert.equal(summarizeUsage('{"event":"assistant_usage"}').totals.calls, 1, "没有 usage 也算一次调用");
	assert.equal(summarizeUsage('{"event":"assistant_usage"}').totals.total, 0);
});

check("addUsage：缺字段当 0，字符串数字不算（宁可少算不瞎算）", () => {
	const t = addUsage(emptyTotals(), { input: 5, total: 7 });
	assert.equal(t.calls, 1);
	assert.equal(t.input, 5);
	assert.equal(t.output, 0);
	assert.equal(t.total, 7);
	assert.equal(addUsage(emptyTotals(), null).total, 0);
	assert.equal(addUsage(emptyTotals(), { input: "12" }).input, 0, "字符串不是数字");
	assert.equal(addUsage(emptyTotals(), { input: Number.NaN }).input, 0);
});

check("localDate：按**本地日**算（审计日志就是本地日分文件的）", () => {
	const at = new Date(2026, 9, 15, 23, 30, 0).getTime(); // 本地 2026-10-15 23:30
	assert.equal(localDate(at), "2026-10-15");
	assert.equal(localDate(at + 60 * 60 * 1000), "2026-10-16", "跨到第二天要变");
});

check("fmt：千分位", () => {
	assert.equal(fmt(0), "0");
	assert.equal(fmt(999), "999");
	assert.equal(fmt(1000), "1,000");
	assert.equal(fmt(200703050), "200,703,050");
	assert.equal(fmt(undefined), "0");
});

// ── 2. 小队那半 ───────────────────────────────────────────────────────────

check("squadUsageForDay：endedAt 优先、回退 startedAt、都没有就不计、跨天排除", () => {
	const day = "2026-10-15";
	const at = new Date(2026, 9, 15, 12, 0, 0).getTime();
	const records = [
		{
			name: "队",
			members: [
				{ label: "收工的", endedAt: at, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
				{ label: "还在跑的", startedAt: at, usage: { totalTokens: 5 } },
				{ label: "跨天的", endedAt: at + 24 * 60 * 60 * 1000, usage: { totalTokens: 999 } },
				{ label: "没时间的", usage: { totalTokens: 777 } },
			],
		},
	];
	const out = squadUsageForDay(records, day);
	assert.equal(out.members.length, 2, `只该算两个：${JSON.stringify(out.members.map((m) => m.label))}`);
	assert.equal(out.totals.calls, 2);
	assert.equal(out.totals.total, 35);
	assert.equal(out.totals.input, 10);
	assert.deepEqual(out.members.map((m) => m.label).sort(), ["收工的", "还在跑的"].sort());
	assert.equal(squadUsageForDay([], day).members.length, 0);
	assert.equal(squadUsageForDay(undefined, day).members.length, 0);
});

check("billForDay：真读文件（临时 DSH_HOME），没有那天就明说「没有审计日志」", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "bill-home-"));
	fs.mkdirSync(path.join(home, "storages", "audit-log"), { recursive: true });
	fs.writeFileSync(path.join(home, "storages", "audit-log", "2026-10-15.jsonl"), `${usageLine()}\n`, "utf8");
	const got = billForDay("2026-10-15", { home, squads: [] });
	assert.equal(got.audit.totals.total, 1110);
	assert.equal(got.audit.sessions, 1);
	const text = formatBill(got);
	assert.match(text, /2026-10-15 · 1 次调用/);
	assert.match(text, /1,110/);
	// 没有那天
	const none = billForDay("1999-01-01", { home, squads: [] });
	assert.equal(none.audit, undefined);
	assert.match(formatBill(none), /没有审计日志/);
	assert.match(formatBill(none), /关了就没有账单/, "要告诉人为什么可能是空的");
});

check("renderSquadRecords：读得到落盘的小队，渲染出队名与成员", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-home-"));
	const cwd = "/tmp/某个工作目录";
	const store = createSquadStore({ dir: squadStoreDir(home), log: () => {} });
	store.save(cwd, () => [
		{
			name: "登录改造",
			objective: "把登录改了",
			closed: null,
			board: [{ at: 1, from: "A", text: "查完了" }],
			members: new Map([
				["A", { label: "A", role: "实现", task: "改登录", worktree: "/tmp/wt", status: "完成", usage: {}, attempts: 1, durationMs: 1000 }],
			]),
		},
	]);
	store.flush();
	const { file, records } = readSquadsForCwd(cwd, { home });
	assert.ok(fs.existsSync(file), `要写到 ${file}`);
	assert.equal(records.length, 1);
	const text = renderSquadRecords(records);
	assert.match(text, /登录改造/);
	assert.match(text, /把登录改了/);
	assert.match(text, /A/, "成员要在里面");
	assert.equal(renderSquadRecords([]), "", "空数组返回空串（由调用方说「没有」）");
});

check("readSquadsForCwd：版本不认识的文件**不许被改名**（只读命令不该改用户的盘）", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-home2-"));
	const cwd = "/tmp/坏版本";
	const store = createSquadStore({ dir: squadStoreDir(home), log: () => {} });
	store.save(cwd, () => [{ name: "x", objective: "o", closed: null, board: [], members: new Map() }]);
	store.flush();
	// 手工把版本改坏（模拟旧版本/未来版本写的文件）
	const { file } = readSquadsForCwd(cwd, { home });
	const parsed = readJsonOrFail(file);
	parsed.version = SQUAD_STORE_VERSION + 99;
	fs.writeFileSync(file, JSON.stringify(parsed), "utf8");
	const after = readSquadsForCwd(cwd, { home });
	assert.equal(after.records.length, 0, "版本不认识 → 读不出来");
	assert.ok(fs.existsSync(file), "但文件必须还在（只读命令不许隔离/改名）");
	const broken = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".broken-"));
	assert.equal(broken.length, 0, `不该产生隔离文件：${JSON.stringify(broken)}`);
});

check("readAllSquads：列全部工作目录，坏文件跳过不炸", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-home3-"));
	const store = createSquadStore({ dir: squadStoreDir(home), log: () => {} });
	store.save("/tmp/ws-a", () => [{ name: "甲", objective: "o", closed: null, board: [], members: new Map() }]);
	store.save("/tmp/ws-b", () => [{ name: "乙", objective: "o", closed: null, board: [], members: new Map() }]);
	store.flush();
	fs.writeFileSync(path.join(squadStoreDir(home), "坏文件.json"), "{ 不是 JSON", "utf8");
	const all = readAllSquads({ home });
	assert.equal(all.length, 2, `坏文件要跳过，实际 ${all.length}`);
	assert.deepEqual(all.map((e) => e.cwd).sort(), ["/tmp/ws-a", "/tmp/ws-b"]);
	assert.equal(readAllSquads({ home: path.join(home, "不存在") }).length, 0);
});

// ── 3. 真跑子命令 ─────────────────────────────────────────────────────────

/** 跑子命令（临时 DSH_HOME，免得碰真数据） */
const runCli = (args, home) =>
	spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, DSH_HOME: home } });

check("真跑：squad ls 空目录 → 退出码 0 + 说清「没有落盘的小队」+ 说明是进程内状态", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run-"));
	const r = runCli(["squad", "ls"], home);
	assert.equal(r.status, 0, `退出码该是 0：${r.stderr}`);
	assert.match(r.stdout, /没有落盘的小队/);
	assert.match(r.stdout, /面板/, "要说清实时的那份在哪");
});

check("真跑：squad ls 有数据 → 打印队名；--all 也一样", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run2-"));
	const cwd = "/tmp/真跑工作目录";
	const store = createSquadStore({ dir: squadStoreDir(home), log: () => {} });
	store.save(cwd, () => [
		{ name: "真跑的队", objective: "目标", closed: null, board: [], members: new Map([["M", { label: "M", role: "实现", task: "t", status: "完成", usage: {}, attempts: 1, durationMs: 5 }]]) },
	]);
	store.flush();
	const one = runCli(["squad", "ls", "--cwd", cwd], home);
	assert.equal(one.status, 0, one.stderr);
	assert.match(one.stdout, /真跑的队/);
	const all = runCli(["squad", "ls", "--all"], home);
	assert.equal(all.status, 0, all.stderr);
	assert.match(all.stdout, /真跑的队/);
	assert.match(all.stdout, /真跑工作目录/, "--all 要标出工作目录");
});

check("真跑：bill 没有那天 → 退出码 0 且说清原因（不是报错）", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run3-"));
	const r = runCli(["bill", "--date", "1999-01-01"], home);
	assert.equal(r.status, 0, `退出码该是 0：${r.stderr}`);
	assert.match(r.stdout, /没有审计日志/);
	assert.match(r.stdout, /没有钱/, "边界要写出来");
});

check("真跑：bill --date 写错 → 退出码非 0 且给用法", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run4-"));
	const r = runCli(["bill", "--date", "昨天"], home);
	assert.notEqual(r.status, 0, "坏参数要失败");
	assert.match(r.stdout + r.stderr, /YYYY-MM-DD/);
});

check("真跑：squad 子命令写错 → 退出码非 0 且给用法", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run5-"));
	const r = runCli(["squad", "乱写"], home);
	assert.notEqual(r.status, 0);
	assert.match(r.stdout + r.stderr, /dsh-team squad ls/);
});

check("真跑：--help 里有两个新子命令", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run6-"));
	const r = runCli(["--help"], home);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /dsh-team bill/);
	assert.match(r.stdout, /dsh-team squad ls/);
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

if (failures > 0) {
	console.log(`\n✗ ${failures} 项失败`);
	process.exit(1);
}
console.log("✓ 自检通过：账单纯函数（只认 usage·坏行·按模型会话·本地日·千分位）/ 小队那半（归属规则·只读不隔离·列全部）/ 真跑两个子命令（空·有数据·坏参数·帮助）");
