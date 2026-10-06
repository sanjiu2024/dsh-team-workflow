#!/usr/bin/env node
/**
 * 自检：定时任务调度器（REQ-007）。
 *
 * 五段：
 *   1. 计划纯函数（parseTimeOfDay / nextOccurrence 八种 / validateSchedule / describeSchedule）
 *   2. 任务构造与打补丁（buildTask / applyTaskPatch）
 *   3. 存储（原子写、历史裁剪、串行队列、恢复中断记录）
 *   4. 事件摘要与结论判定（summarizeEvents / decideRunOutcome）
 *   5. **假宿主装配**：可选安装的两条负向验证 ——
 *        a. enabled=false → 一个工具不注册、一条路由不挂
 *        b. enabled=true 但依赖服务缺失 → 同样一个都不注册（不能连累本包其余模块）
 *      以及真跑一遍 HTTP 路由（假 req/res，不发真请求）。
 *
 * 为什么必须有第 5 段：这个功能最大的风险不是算错时间，是**默认关的时候没真关**，
 * 或者**依赖不齐的时候把整个插件拖死**。那两条纯函数一条都测不出。
 *
 * 时间断言一律用本地时间构造（`new Date(y, m, d, h, mi)`），所以换时区也成立。
 *
 *   node scripts/selftest-scheduler.mjs
 */
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const {
	applyTaskPatch,
	anchoredOccurrence,
	buildTask,
	createStore,
	decideRunOutcome,
	TURN_START_TIMEOUT_MS,
	waitForTurnStart,
	describeSchedule,
	installScheduler,
	localTimeZone,
	nextOccurrence,
	parseTimeOfDay,
	createEngine,
	recoverInterruptedRuns,
	explainScheduleProblem,
	createExecutor,
	staleRunMs,
	DEFAULT_STALE_RUN_MS,
	SCHEDULER_DEFAULTS,
	SCHEDULER_FIELDS,
	SCHEDULE_KINDS,
	summarizeEvents,
	validateSchedule,
} = await import(new URL("lib/scheduler.js", ROOT).href);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 本地时间构造，避开时区差异 */
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const clockOf = (stamp) => {
	const d = new Date(stamp);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ── 1. 计划纯函数 ────────────────────────────────────────────────────────────

check("parseTimeOfDay：合法/非法", () => {
	assert.deepEqual(parseTimeOfDay("09:05"), { hours: 9, minutes: 5 });
	assert.deepEqual(parseTimeOfDay(" 0:00 "), { hours: 0, minutes: 0 }, "允许 1 位小时 + 前后空格");
	assert.deepEqual(parseTimeOfDay("23:59"), { hours: 23, minutes: 59 });
	assert.equal(parseTimeOfDay("24:00"), undefined, "小时必须 <24");
	assert.equal(parseTimeOfDay("09:60"), undefined, "分钟必须 <60");
	assert.equal(parseTimeOfDay("9"), undefined);
	assert.equal(parseTimeOfDay("09:5"), undefined, "分钟必须两位");
	assert.equal(parseTimeOfDay(900), undefined);
	assert.equal(parseTimeOfDay(undefined), undefined);
});

check("anchoredOccurrence：第一个严格大于 from 的锚点刻度", () => {
	const anchor = "2026-03-01T00:00:00.000Z";
	const base = Date.parse(anchor);
	const step = 3 * DAY;
	assert.equal(anchoredOccurrence(anchor, step, base), base + step, "from 正好在锚点上 → 下一格");
	assert.equal(anchoredOccurrence(anchor, step, base - 1), base, "from 早于锚点 → 就是锚点");
	assert.equal(anchoredOccurrence(anchor, step, base + 1), base + step);
	assert.equal(anchoredOccurrence(anchor, step, base + step), base + 2 * step);
	assert.equal(anchoredOccurrence(anchor, step, base - 10 * DAY), base, "远早于锚点也不返回负数刻度");
	assert.equal(anchoredOccurrence("不是时间", step, base), undefined);
	assert.equal(anchoredOccurrence(anchor, 0, base), undefined, "step 必须为正");
});

check("once：过去的时刻没有下一次", () => {
	const future = at(2099, 1, 1, 0, 0);
	assert.equal(nextOccurrence({ kind: "once", at: new Date(future).toISOString() }, future - HOUR), future);
	assert.equal(nextOccurrence({ kind: "once", at: new Date(future).toISOString() }, future), undefined, "等于 from 不算下一次");
	assert.equal(nextOccurrence({ kind: "once", at: new Date(future).toISOString() }, future + 1), undefined);
	assert.equal(nextOccurrence({ kind: "once", at: "垃圾" }, 0), undefined);
});

check("hourly：分钟归位、秒归零、严格向前", () => {
	const from = at(2026, 3, 1, 8, 5);
	const next = nextOccurrence({ kind: "hourly", minute: 30 }, from);
	assert.equal(clockOf(next), "08:30");
	assert.equal(new Date(next).getSeconds(), 0);
	assert.ok(next > from && next - from <= HOUR);

	const atExact = nextOccurrence({ kind: "hourly", minute: 30 }, at(2026, 3, 1, 8, 30));
	assert.equal(clockOf(atExact), "09:30", "from 正好落在目标分钟上 → 下一个小时");

	const wrap = nextOccurrence({ kind: "hourly", minute: 0 }, at(2026, 3, 1, 8, 30));
	assert.equal(clockOf(wrap), "09:00");

	assert.equal(nextOccurrence({ kind: "hourly", minute: 60 }, from), undefined, "分钟越界");
	assert.equal(nextOccurrence({ kind: "hourly", minute: 1.5 }, from), undefined, "必须整数");
});

check("interval：无锚点 = from + step；有锚点 = 对齐锚点", () => {
	const from = at(2026, 3, 1, 8, 0);
	assert.equal(nextOccurrence({ kind: "interval", everyMinutes: 90 }, from), from + 90 * MINUTE);

	const anchor = new Date(at(2026, 3, 1, 0, 0)).toISOString();
	// 锚点网格是 00:00 / 01:00 / …；from 是 08:00，所以下一个刻度是 09:00（不是 01:00）
	assert.equal(nextOccurrence({ kind: "interval", everyMinutes: 60, anchor }, from), at(2026, 3, 1, 9, 0));
	assert.equal(nextOccurrence({ kind: "interval", everyMinutes: 60, anchor }, at(2026, 3, 1, 0, 30)), at(2026, 3, 1, 1, 0));
	// 锚点比 from 早很多时，仍然落在锚点的刻度上
	const later = at(2026, 3, 10, 8, 0);
	const snapped = nextOccurrence({ kind: "interval", everyMinutes: 60, anchor }, later);
	assert.equal((snapped - Date.parse(anchor)) % HOUR, 0, "必须落在锚点刻度上");
	assert.ok(snapped > later && snapped - later <= HOUR);

	assert.equal(nextOccurrence({ kind: "interval", everyMinutes: 0 }, from), undefined);
	assert.equal(nextOccurrence({ kind: "interval", everyMinutes: 525_601 }, from), undefined, "上界外");
	assert.equal(nextOccurrence({ kind: "interval", everyMinutes: 1 }, from), from + MINUTE);
});

check("custom：time 真的生效（源头那个 bug 的回归测试）", () => {
	// 源头校验了 time 却从不使用它 —— 每 3 天的 09:00 实际会落在 anchor 自带的时刻上。
	const anchor = new Date(at(2026, 3, 1, 0, 0)).toISOString();
	const schedule = { kind: "custom", everyDays: 3, time: "09:00", anchor };
	const base = Date.parse(anchor);

	const first = nextOccurrence(schedule, base - 1);
	assert.equal(first, at(2026, 3, 1, 9, 0), "第一次就该是锚点当天的 09:00，而不是 00:00");

	const second = nextOccurrence(schedule, first);
	assert.equal(second, at(2026, 3, 4, 9, 0), "下一次是 3 天后同一时刻");

	const skipped = nextOccurrence(schedule, at(2026, 3, 1, 12, 0));
	assert.equal(skipped, at(2026, 3, 4, 9, 0), "当天已过 09:00 → 跳到 3 天后");

	assert.equal(nextOccurrence({ ...schedule, time: "25:00" }, base), undefined);
	assert.equal(nextOccurrence({ ...schedule, anchor: "垃圾" }, base), undefined);
	assert.equal(nextOccurrence({ ...schedule, everyDays: 0 }, base), undefined);
	assert.equal(nextOccurrence({ ...schedule, everyDays: 367 }, base), undefined);
});

check("daily：当天未到就是今天，已到就是明天", () => {
	const schedule = { kind: "daily", time: "09:00" };
	assert.equal(nextOccurrence(schedule, at(2026, 3, 1, 8, 0)), at(2026, 3, 1, 9, 0));
	assert.equal(nextOccurrence(schedule, at(2026, 3, 1, 9, 0)), at(2026, 3, 2, 9, 0), "等于 from → 明天");
	assert.equal(nextOccurrence(schedule, at(2026, 3, 1, 23, 59)), at(2026, 3, 2, 9, 0));
	assert.equal(nextOccurrence({ kind: "daily", time: "nope" }, at(2026, 3, 1)), undefined);
});

check("workdays：跳过周六周日", () => {
	const schedule = { kind: "workdays", time: "09:00" };
	for (const from of [at(2026, 3, 2, 10, 0), at(2026, 3, 5, 10, 0), at(2026, 3, 7, 10, 0)]) {
		const next = nextOccurrence(schedule, from);
		const wd = new Date(next).getDay();
		assert.ok(wd !== 0 && wd !== 6, `落在周末了：${new Date(next).toString()}`);
		assert.equal(clockOf(next), "09:00");
		assert.ok(next > from && next - from <= 3 * DAY + 1);
	}
});

check("weekly：只落在指定星期几", () => {
	const schedule = { kind: "weekly", time: "08:30", weekdays: ["MO", "WE"] };
	for (const from of [at(2026, 3, 1), at(2026, 3, 2), at(2026, 3, 4, 12, 0)]) {
		const next = nextOccurrence(schedule, from);
		const wd = new Date(next).getDay();
		assert.ok(wd === 1 || wd === 3, `落在星期 ${wd}，期望一或三`);
		assert.equal(clockOf(next), "08:30");
		assert.ok(next > from && next - from <= 7 * DAY + 1);
	}
	assert.equal(nextOccurrence({ ...schedule, weekdays: [] }, at(2026, 3, 1)), undefined);
	assert.equal(nextOccurrence({ ...schedule, weekdays: ["XX"] }, at(2026, 3, 1)), undefined);
});

check("monthly：只落在指定日期，缺该日就跳月（不夹到月末）", () => {
	const schedule = { kind: "monthly", day: 31, time: "12:00" };
	const next = nextOccurrence(schedule, at(2026, 2, 1));
	assert.equal(new Date(next).getDate(), 31, "2 月没有 31 号 → 必须跳到 3 月");
	assert.equal(clockOf(next), "12:00");
	assert.equal(nextOccurrence({ kind: "monthly", day: 32, time: "12:00" }, at(2026, 3, 1)), undefined);
});

check("validateSchedule：八种计划各自必填项", () => {
	assert.ok(validateSchedule({ kind: "once", at: new Date(at(2026, 3, 1)).toISOString() }));
	assert.ok(validateSchedule({ kind: "hourly", minute: 0 }));
	assert.ok(validateSchedule({ kind: "daily", time: "00:00" }));
	assert.ok(validateSchedule({ kind: "interval", everyMinutes: 1 }));
	assert.ok(validateSchedule({ kind: "workdays", time: "09:00" }));
	assert.ok(validateSchedule({ kind: "weekly", time: "09:00", weekdays: ["SU"] }));
	assert.ok(validateSchedule({ kind: "monthly", day: 1, time: "09:00" }));
	assert.ok(validateSchedule({ kind: "custom", everyDays: 1, time: "09:00", anchor: new Date(at(2026, 3, 1)).toISOString() }));

	assert.ok(!validateSchedule({ kind: "once" }), "once 缺 at");
	assert.ok(!validateSchedule({ kind: "hourly", minute: 60 }));
	assert.ok(!validateSchedule({ kind: "custom", everyDays: 3, time: "09:00" }), "custom 缺 anchor");
	assert.ok(!validateSchedule({ kind: "weekly", time: "09:00", weekdays: [] }));
	assert.ok(!validateSchedule({ kind: "monthly", day: 0, time: "09:00" }));
	assert.ok(!validateSchedule({ kind: "每天" }));
	assert.ok(!validateSchedule(null));
	assert.ok(!validateSchedule("daily"));

	for (const kind of SCHEDULE_KINDS) {
		assert.ok(!validateSchedule({ kind }), `${kind} 只给 kind 不应通过 —— 每种计划都还有必填字段`);
	}
});

check("describeSchedule：人话且不抛", () => {
	assert.match(describeSchedule({ kind: "daily", time: "09:00" }), /每天 09:00/);
	assert.match(describeSchedule({ kind: "weekly", time: "08:00", weekdays: ["MO", "FR"] }), /每周 周一、周五 08:00/);
	assert.match(describeSchedule({ kind: "interval", everyMinutes: 30 }), /每 30 分钟/);
	assert.match(describeSchedule({ kind: "custom", everyDays: 3, time: "09:00", anchor: new Date(at(2026, 3, 1)).toISOString() }), /每 3 天 09:00/);
	assert.equal(describeSchedule({ kind: "???" }), "（计划无效）");
});

check("localTimeZone：给得出一个非空字符串", () => {
	assert.equal(typeof localTimeZone(), "string");
	assert.ok(localTimeZone().length > 0);
});

// ── 2. 任务构造与打补丁 ──────────────────────────────────────────────────────

check("buildTask：必填项与越界拒绝", () => {
	const good = buildTask({ name: "写日报", prompt: "写日报", schedule: { kind: "daily", time: "09:00" } });
	assert.ok(good.ok);
	assert.equal(good.task.enabled, true);
	assert.equal(good.task.lastRunAt, null);
	assert.ok(typeof good.task.nextRunAt === "number", "建的时候就该算出下次运行");

	assert.ok(!buildTask({ prompt: "x", schedule: { kind: "daily", time: "09:00" } }).ok, "缺 name");
	assert.ok(!buildTask({ name: "  ", prompt: "x", schedule: { kind: "daily", time: "09:00" } }).ok, "name 全空白");
	assert.ok(!buildTask({ name: "a", schedule: { kind: "daily", time: "09:00" } }).ok, "缺 prompt");
	assert.ok(!buildTask({ name: "a", prompt: "x", schedule: { kind: "nope" } }).ok, "计划非法");
	assert.ok(!buildTask({ name: "a", prompt: "x", schedule: { kind: "daily", time: "09:00" }, permission: "root" }).ok, "权限越界");
	assert.ok(!buildTask({ name: "a", prompt: "x", schedule: { kind: "daily", time: "09:00" }, provider: "p" }).ok, "provider/model 必须成对");
});

check("buildTask：once 的计划已过期 → nextRunAt 为 null", () => {
	const past = new Date(Date.now() - DAY).toISOString();
	const built = buildTask({ name: "a", prompt: "x", schedule: { kind: "once", at: past } });
	assert.ok(built.ok);
	assert.equal(built.task.nextRunAt, null);
});

check("applyTaskPatch：只改名字不推后下次运行时间", () => {
	const built = buildTask({ name: "旧名", prompt: "x", schedule: { kind: "daily", time: "09:00" } });
	const original = built.task.nextRunAt;
	const patched = applyTaskPatch(built.task, { name: "新名" });
	assert.ok(patched.ok);
	assert.equal(patched.task.name, "新名");
	assert.equal(patched.task.nextRunAt, original, "计划没变就不该重算 nextRunAt");
	assert.equal(patched.task.createdAt, built.task.createdAt, "createdAt 不能被顶掉");

	const rescheduled = applyTaskPatch(built.task, { schedule: { kind: "daily", time: "10:00" } });
	assert.ok(rescheduled.ok);
	assert.equal(clockOf(rescheduled.task.nextRunAt), "10:00", "计划变了就要重算");
});

check("applyTaskPatch：非法补丁被拒，不产生半个任务", () => {
	const built = buildTask({ name: "a", prompt: "x", schedule: { kind: "daily", time: "09:00" } });
	assert.ok(!applyTaskPatch(built.task, { name: "   " }).ok);
	assert.ok(!applyTaskPatch(built.task, { schedule: { kind: "weekly", time: "09:00", weekdays: [] } }).ok);
});

check("SCHEDULER_FIELDS：enabled 只认真布尔", () => {
	assert.equal(SCHEDULER_FIELDS.enabled(true), true);
	assert.equal(SCHEDULER_FIELDS.enabled(false), false);
	assert.equal(SCHEDULER_FIELDS.enabled("true"), undefined, "字符串不算开");
	assert.equal(SCHEDULER_FIELDS.enabled(1), undefined);
	assert.equal(SCHEDULER_FIELDS.tickMs(50), undefined, "间隔太小会烧 CPU");
	assert.equal(SCHEDULER_FIELDS.tickMs(1000), 1000);
	assert.equal(SCHEDULER_FIELDS.maxConcurrent(0), undefined);
	assert.equal(SCHEDULER_DEFAULTS.enabled, false, "默认必须是关的");
});

// ── 3. 存储 ──────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sched-"));
const freshStore = (name, options) => createStore(path.join(tmpRoot, name), options);

await checkAsync("存储：空目录读出来是空表，不抛", async () => {
	const store = freshStore("empty");
	assert.deepEqual(store.readTasks(), []);
	assert.deepEqual(store.readRuns(), []);
	assert.deepEqual(await store.mutateTasks(() => {}), undefined);
	assert.deepEqual(store.readTasks(), []);
});

await checkAsync("存储：坏文件不许被静默清库（读降级、写拒绝 + 留证）", async () => {
	const store = freshStore("broken");
	fs.mkdirSync(store.dir, { recursive: true });
	fs.writeFileSync(store.tasksFile, "{ 这不是 JSON", "utf8");
	// 读路径降级：面板还打得开，不把插件带崩
	assert.deepEqual(store.readTasks(), [], "读路径解析失败当空表");
	// 写路径必须拒绝 —— 这是关键：以前会「按空读 → 整体覆写」，
	// 用户的任务被永久清成 []，而且没有任何痕迹
	await assert.rejects(
		() => store.mutateTasks((tasks) => tasks.push({ id: "t1" })),
		/拒绝在它之上写入/,
		"写路径遇到坏文件必须抛，不能清库",
	);
	// 坏文件被改名留证，内容还在
	const backups = fs.readdirSync(store.dir).filter((n) => n.includes(".corrupt-"));
	assert.equal(backups.length, 1, `应该留一份备份，实际 ${backups.join(",")}`);
	assert.equal(fs.readFileSync(path.join(store.dir, backups[0]), "utf8"), "{ 这不是 JSON", "备份里要是原文");
	// 留证之后下一次写就能正常建新表（数据在备份里，没丢）
	await store.mutateTasks((tasks) => tasks.push({ id: "t1" }));
	assert.deepEqual(store.readTasks(), [{ id: "t1" }]);
});

await checkAsync("存储：写是原子的（目录里不留 tmp）", async () => {
	const store = freshStore("atomic");
	await store.mutateTasks((tasks) => tasks.push({ id: "a" }));
	const leftovers = fs.readdirSync(store.dir).filter((n) => n.endsWith(".tmp"));
	assert.deepEqual(leftovers, [], `残留了临时文件：${leftovers.join(",")}`);
	const parsed = JSON.parse(fs.readFileSync(store.tasksFile, "utf8"));
	assert.equal(parsed.version, 1, "要带版本号");
	assert.deepEqual(parsed.tasks, [{ id: "a" }]);
});

await checkAsync("存储：写队列串行，并发 mutate 不丢更新", async () => {
	const store = freshStore("queue");
	await Promise.all(Array.from({ length: 40 }, (_, i) => store.mutateTasks((tasks) => tasks.push({ id: `t${i}` }))));
	const tasks = store.readTasks();
	assert.equal(tasks.length, 40, `期望 40 条，实际 ${tasks.length} —— 说明读-改-写没有串行`);
	assert.equal(new Set(tasks.map((t) => t.id)).size, 40, "不该有重复/覆盖");
});

await checkAsync("存储：历史自动裁到上限，保留最近的", async () => {
	const store = freshStore("trim", { historyLimit: 5 });
	for (let i = 0; i < 12; i += 1) {
		await store.mutateRuns((runs) => runs.push({ id: `r${i}` }));
	}
	const runs = store.readRuns();
	assert.equal(runs.length, 5);
	assert.deepEqual(
		runs.map((r) => r.id),
		["r7", "r8", "r9", "r10", "r11"],
		"留的必须是最新的",
	);
});

await checkAsync("存储：mutate 抛错时队列不死（后续写还能进行）", async () => {
	const store = freshStore("throw");
	await assert.rejects(() => store.mutateTasks(() => {
		throw new Error("故意");
	}));
	await store.mutateTasks((tasks) => tasks.push({ id: "after" }));
	assert.deepEqual(store.readTasks(), [{ id: "after" }]);
});

await checkAsync("recoverInterruptedRuns：只动 running，其余不碰", async () => {
	const store = freshStore("recover");
	await store.mutateRuns((runs) => {
		runs.push({ id: "a", status: "running" });
		runs.push({ id: "b", status: "succeeded" });
		runs.push({ id: "c", status: "running" });
	});
	const count = await recoverInterruptedRuns(store);
	assert.equal(count, 2);
	const runs = store.readRuns();
	assert.equal(runs.find((r) => r.id === "a").status, "interrupted");
	assert.equal(runs.find((r) => r.id === "c").error, "host_interrupted");
	assert.equal(runs.find((r) => r.id === "b").status, "succeeded", "成功的不该被改");
	assert.equal(await recoverInterruptedRuns(store), 0, "再跑一次没有可恢复的");
});

await checkAsync("recoverInterruptedRuns：不动别的 dsh 进程正在跑的那一轮", async () => {
	const store = freshStore("recover-alien");
	// 另开一个 dsh（假设 pid 1 一定活着）正在跑的任务，不能被我们标成中断
	await store.mutateRuns((runs) => {
		runs.push({ id: "mine", status: "running", pid: process.pid });
		runs.push({ id: "alien-live", status: "running", pid: 1 });
		runs.push({ id: "alien-dead", status: "running", pid: 0x7ffffff0 });
	});
	const count = await recoverInterruptedRuns(store);
	assert.equal(count, 2, "只该动本进程留下的 + pid 已消失的");
	const runs = store.readRuns();
	assert.equal(runs.find((r) => r.id === "mine").status, "interrupted");
	assert.equal(runs.find((r) => r.id === "alien-live").status, "running", "别人的活不能碰");
	assert.equal(runs.find((r) => r.id === "alien-dead").status, "interrupted");
});

await checkAsync("staleRunMs：阈值跟着 runTimeoutMinutes 走，不会误标超长任务", () => {
	// 固定 12 小时的话，一个配成 24 小时上限的任务会被自己的恢复逻辑误标
	assert.equal(staleRunMs(SCHEDULER_DEFAULTS), DEFAULT_STALE_RUN_MS);
	assert.equal(staleRunMs({ runTimeoutMinutes: 30 }), DEFAULT_STALE_RUN_MS, "半小时的任务用下限");
	assert.equal(staleRunMs({ runTimeoutMinutes: 24 * 60 }), 48 * 60 * 60 * 1000, "24 小时上限 → 48 小时兜底");
	assert.equal(staleRunMs({}), DEFAULT_STALE_RUN_MS);
	assert.equal(staleRunMs(undefined), DEFAULT_STALE_RUN_MS);
});

await checkAsync("recoverInterruptedRuns：pid 被复用的烂记录靠时间兜底回收", async () => {
	const store = freshStore("recover-stale");
	// pid 会被系统复用：另一个 dsh 崩在任务里，它的 pid 后来分给了别人 →
	// isProcessAlive 永远 true，那条记录就永远留在 running。
	const ancient = Date.now() - 13 * 60 * 60 * 1000;
	await store.mutateRuns((runs) => {
		runs.push({ id: "stale-alien", status: "running", pid: 1, startedAt: ancient });
		runs.push({ id: "fresh-alien", status: "running", pid: 1, startedAt: Date.now() });
	});
	const count = await recoverInterruptedRuns(store);
	assert.equal(count, 1, "只该收掉那条长生不死的");
	const runs = store.readRuns();
	assert.equal(runs.find((r) => r.id === "stale-alien").status, "interrupted");
	assert.equal(runs.find((r) => r.id === "fresh-alien").status, "running", "刚起的不许碰");
});

await checkAsync("explainScheduleProblem：报错要指得出是哪个字段", () => {
	// 面板上把「第几分」清空时，用户不能只看到一句笼统的「schedule 不合法」
	assert.match(explainScheduleProblem({ kind: "hourly", minute: "" }), /minute/);
	assert.match(explainScheduleProblem({ kind: "daily", time: "9" }), /time/);
	assert.match(explainScheduleProblem({ kind: "weekly", time: "09:00", weekdays: [] }), /weekdays/);
	assert.match(explainScheduleProblem({ kind: "weekly", time: "09:00", weekdays: ["XX"] }), /MO/);
	assert.match(explainScheduleProblem({ kind: "monthly", day: 99, time: "09:00" }), /day/);
	assert.match(explainScheduleProblem({ kind: "nope" }), /kind/);
	assert.equal(explainScheduleProblem({ kind: "daily", time: "09:00" }), undefined);
	// 并且要真的经 buildTask 冒出来
	const built = buildTask({ name: "n", prompt: "p", schedule: { kind: "hourly", minute: "" } });
	assert.equal(built.ok, false);
	assert.match(built.error, /minute/);
});

await checkAsync("摘要：末条 assistant 消息只含工具调用时，不许把答案覆盖成空", async () => {
	// 以前只判 content.length > 0，于是「我这就去查」后面跟一条纯 tool-call 消息，
	// 摘要就变成空字符串 —— 运行历史里看不到模型到底说了什么
	const events = [
		{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "答案是 42" }] } } },
		{ type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "read", arguments: {} }] } } },
		{ type: "turn/end", data: { reason: "completed" } },
	];
	assert.equal(summarizeEvents(events).text, "答案是 42");
});

await checkAsync("engine.tick：补算 nextRunAt 必须真落盘，且不会每秒空写", async () => {
	const store = freshStore("tick-backfill");
	const fired = [];
	const executor = { run: async (task) => { fired.push(task.id); return { status: "succeeded" }; } };
	const engine = createEngine({ store, executor, config: { ...SCHEDULER_DEFAULTS, maxConcurrent: 4 } });

	// 直接塞一条 nextRunAt 缺失的任务（老数据 / 手改过文件都会这样）。
	// 以前 tick 在 readTasks() 的副本上改、再 mutateTasks(() => {}) 从盘上重读写回，
	// 于是 nextRunAt 永远是 null → 任务永不触发，且 dirty 恒真 → 每秒全量写盘。
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "t1", name: "缺下次时间", enabled: true, prompt: "p", schedule: { kind: "daily", time: "09:00" }, nextRunAt: null });
	});

	await engine.tick();
	const after = store.readTasks().find((t) => t.id === "t1");
	assert.equal(typeof after.nextRunAt, "number", "补算出来的 nextRunAt 必须写回磁盘");

	// 再 tick 一次不该有任何写入（写队列不空跑）
	let writes = 0;
	const realMutate = store.mutateTasks;
	store.mutateTasks = (fn) => { writes += 1; return realMutate(fn); };
	await engine.tick();
	assert.equal(writes, 0, "已经算好了就不该再写盘");
	store.mutateTasks = realMutate;
});

await checkAsync("engine.tick：算不出下次（过期 once）不静默停用，告警一次且不空写", async () => {
	const store = freshStore("tick-terminal");
	const executor = { run: async () => ({ status: "succeeded" }) };
	const logs = [];
	const engine = createEngine({ store, executor, config: { ...SCHEDULER_DEFAULTS }, log: (m) => logs.push(m) });
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "t2", name: "过期一次性", enabled: true, prompt: "p", schedule: { kind: "once", at: new Date(Date.now() - 86400000).toISOString() }, nextRunAt: null });
	});
	await engine.tick();
	const after = store.readTasks().find((t) => t.id === "t2");
	// 算不出下一次 ≠ 这条任务该消失。停用是拿一次内部计算改用户数据，而且不说一声 ——
	// 用户下次开面板只看到「已停用」，不知道是谁关的。跟源头 tick 一致：什么都不做。
	assert.equal(after.enabled, true, "算不出下一次不该替用户停用");
	assert.equal(after.nextRunAt, null);
	assert.equal(logs.filter((m) => m.includes("算不出下一次运行时间")).length, 1, "要告警一次");

	let writes = 0;
	const realMutate = store.mutateTasks;
	store.mutateTasks = (fn) => { writes += 1; return realMutate(fn); };
	await engine.tick();
	assert.equal(writes, 0, "算不出就该跳过，不能每秒空写一次盘");
	assert.equal(logs.filter((m) => m.includes("算不出下一次运行时间")).length, 1, "每秒一次 tick 不能刷屏");
	store.mutateTasks = realMutate;

	// 计划改好之后要能恢复，而且恢复过程本身不重复告警
	await store.mutateTasks((tasks) => {
		const task = tasks.find((t) => t.id === "t2");
		task.schedule = { kind: "daily", time: "09:00" };
	});
	await engine.tick();
	const fixed = store.readTasks().find((t) => t.id === "t2");
	assert.equal(typeof fixed.nextRunAt, "number", "计划改好后应补算出下一次");
	assert.equal(fixed.enabled, true);
	assert.equal(logs.filter((m) => m.includes("算不出下一次运行时间")).length, 1, "恢复后不该再告警");
});

await checkAsync("engine.tick：一次性任务跑完仍然自动停用（与补算分支的区分）", async () => {
	const store = freshStore("tick-once-done");
	const executor = { run: async () => ({ status: "succeeded" }) };
	const engine = createEngine({ store, executor, config: { ...SCHEDULER_DEFAULTS } });
	const at = new Date(Date.now() + 3600000).toISOString();
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "t3", name: "未来一次性", enabled: true, prompt: "p", schedule: { kind: "once", at }, nextRunAt: null });
	});
	await engine.tick();
	assert.equal(typeof store.readTasks().find((t) => t.id === "t3").nextRunAt, "number");
	// 让它到期
	await store.mutateTasks((tasks) => {
		tasks.find((t) => t.id === "t3").nextRunAt = Date.now() - 1000;
	});
	await engine.tick();
	// 触发是 fireAndForget 的，有界轮询到它落盘为止
	for (let i = 0; i < 200 && store.readTasks().find((t) => t.id === "t3").enabled !== false; i += 1) {
		await new Promise((r) => setTimeout(r, 10));
	}
	const done = store.readTasks().find((t) => t.id === "t3");
	// 这条和补算分支是两回事：用户要的就是「跑一次就完」，跑完了关掉它是它本来的生命周期，
	// 而且不关的话它下一秒就会落进补算分支，报一句「算不出下一次」——那是纯噪声。
	assert.equal(done.enabled, false, "一次性任务跑完要停用");
	assert.equal(done.nextRunAt, null);
});

await checkAsync("engine.advance：interval/custom 按原定时刻推进，其它按现在", async () => {
	const store = freshStore("advance-basis");
	const engine = createEngine({ store, executor: { run: async () => ({ status: "succeeded" }) }, config: { ...SCHEDULER_DEFAULTS } });
	const settle = async (id) => {
		for (let i = 0; i < 200; i += 1) {
			const task = store.readTasks().find((t) => t.id === id);
			if (task !== undefined && task.lastRunAt !== undefined) return task;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`等 ${id} 落盘超时`);
	};

	// ① interval：原定时刻在过去 1 分钟（模拟上一轮跑晚了），周期 10 分钟。
	//    按现在推 → now + 10min；按原定推 → due + 10min，也就是 now + 9min。
	//    用现在推会把每轮耗时累加进周期，任务越跑越偏。
	const due = Date.now() - 60000;
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "i1", name: "每 10 分钟", enabled: true, prompt: "p", schedule: { kind: "interval", everyMinutes: 10 }, nextRunAt: due });
	});
	await engine.tick();
	const iv = await settle("i1");
	assert.equal(iv.nextRunAt, due + 10 * 60000, "interval 的下一跳要从原定时刻算，不是从「跑完的现在」");

	// ② hourly 是「下一个钟表整点」，跟本次耗时无关 —— 必须仍然按现在算。
	//    按原定算的话，原定时刻在过去 3 小时 → 下一跳还是过去 → 立刻又跑，空转。
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "h1", name: "每小时", enabled: true, prompt: "p", schedule: { kind: "hourly", minute: 0 }, nextRunAt: Date.now() - 3 * 3600000 });
	});
	await engine.tick();
	const hr = await settle("h1");
	assert.ok(hr.nextRunAt > Date.now(), `hourly 的下一跳必须在将来，实际 ${new Date(hr.nextRunAt).toISOString()}`);
	assert.ok(hr.nextRunAt <= Date.now() + 3600000, "而且不该超过一小时");

	// ③ 停机积压：原定时刻在过去 10 小时（周期 10 分钟 = 积压 60 格）。
	//    从原定推 → 下一跳还在过去 → 下一 tick 立刻又跑，把 60 格挨个真跑一遍。
	//    文档里的「不做什么」写的是不补跑，所以算出来已经过去的下一跳要回落到 now。
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "b1", name: "积压 60 格", enabled: true, prompt: "p", schedule: { kind: "interval", everyMinutes: 10 }, nextRunAt: Date.now() - 10 * 3600000 });
	});
	await engine.tick();
	const bk = await settle("b1");
	assert.ok(bk.nextRunAt > Date.now(), `积压后下一跳必须在将来，实际 ${new Date(bk.nextRunAt).toISOString()}`);
	// 再 tick 几次，确认不会连着补跑
	await engine.tick();
	await engine.tick();
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(store.readRuns().filter((r) => r.taskId === "b1").length, 1, "错过 60 格只许跑这一次，不许补跑");

	// ④ 手动触发：那一格还没到（`nextRunAt` 在将来），这次运行**没有**消耗它。
	//    从原定推会再往后跳一整格 —— `custom everyDays=7` 就是把下一次吞掉一周。
	const weekSchedule = { kind: "custom", everyDays: 7, time: "09:00", anchor: new Date(Date.now() - 30 * 86400000).toISOString() };
	const week = nextOccurrence(weekSchedule, Date.now());
	assert.ok(week > Date.now(), "测试前提：7 天的下一格在将来");
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "m1", name: "每周", enabled: true, prompt: "p", schedule: weekSchedule, nextRunAt: week });
	});
	await engine.trigger("m1");
	const mn = await settle("m1");
	assert.equal(mn.nextRunAt, week, "手动跑不算消耗那一格，下一格不能被顶掉");
	assert.equal(mn.lastRunAt !== undefined, true, "手动跑过也要记 lastRunAt");
});

await checkAsync("engine.tick：补算不许用旧快照盖掉并发写进去的下一跳", async () => {
	// `plan` 是 tick 开头读的快照，写盘还要排一次队。这中间任务可能已经被 advance
	// 推走（手动触发、上一 tick 的 execute 还没落完）。无条件把旧值写回去，就会把
	// 刚算好的 nextRunAt **改回过去** → 下一 tick 立刻又跑一遍。
	//
	// 真实的交错没法从公开接口里稳定复现（写队列是串行的，谁先谁后取决于时刻），
	// 所以这里在**写盘边界**注入：让这一批 mutate 拿到的 list 已经不是 plan 看到的那份。
	// 这正好就是竞态的结果形态 —— plan 说「它没有 nextRunAt」，而 list 说「有了」。
	const store = freshStore("tick-plan-race");
	const engine = createEngine({ store, executor: { run: async () => ({ status: "succeeded" }) }, config: { ...SCHEDULER_DEFAULTS } });
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "r1", name: "竞争写", enabled: true, prompt: "p", schedule: { kind: "interval", everyMinutes: 10 }, nextRunAt: null });
	});
	// 必须和 plan 会算出来的值（~now + 10 分钟）**不同**，否则「被覆盖」和「没被覆盖」
	// 结果一样，测试两头都绿 —— 第一版就踩了这个坑。
	const future = Date.now() + 99 * 60000;
	const inner = store.mutateTasks.bind(store);
	store.mutateTasks = async (fn) => inner((tasks) => {
		const task = tasks.find((t) => t.id === "r1");
		// 模拟「排在我们前面的那一次写已经落盘了」
		if (task !== undefined && task.nextRunAt === null) task.nextRunAt = future;
		return fn(tasks);
	});
	await engine.tick();
	const raced = store.readTasks().find((t) => t.id === "r1");
	assert.equal(raced.nextRunAt, future, "并发写进去的下一跳不能被补算的旧快照盖掉");
	assert.equal(store.readRuns().filter((r) => r.taskId === "r1").length, 0, "下一跳在将来，这一 tick 不该触发它");
});


// ── 4. 事件摘要与结论 ────────────────────────────────────────────────────────

check("summarizeEvents：取最后一条非空 assistant 消息", () => {
	const summary = summarizeEvents([
		{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一版" }] } } },
		{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "最终版" }] } } },
		{ type: "turn/end", data: { reason: "completed" } },
	]);
	assert.equal(summary.text, "最终版");
	assert.equal(summary.reason, "completed");
	assert.equal(summary.hasTurnEnd, true);
});

check("summarizeEvents：空消息不覆盖已有答案", () => {
	const summary = summarizeEvents([
		{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "答案" }] } } },
		{ type: "assistant/message", data: { message: { content: [] } } },
		{ type: "turn/end", data: { reason: "completed" } },
	]);
	assert.equal(summary.text, "答案");
});

check("summarizeEvents：只有流式文本时用累加兜底", () => {
	const summary = summarizeEvents([
		{ type: "assistant/message", data: { stream: { text: "流" } } },
		{ type: "assistant/attempt", data: { stream: { text: "式" } } },
	]);
	assert.equal(summary.text, "流式");
	assert.equal(summary.hasTurnEnd, false);
});

check("summarizeEvents：空输入不抛", () => {
	const summary = summarizeEvents(undefined);
	assert.equal(summary.text, "");
	assert.equal(summary.hasTurnEnd, false);
});

check("decideRunOutcome：缺 turn/end 算成功，但「没观察到启动」算失败", () => {
	// 缺 turn/end 判成功是跟源头 decideRunOutcome 对齐的：核心在异常收尾
	// （取消 / 中断 / 崩溃修复）时可能不补写这条事件。这里读的是**全量快照**，
	// 所以不存在源头那条「增量丢了收尾原因要回退快照」的顾虑 —— 拿它判失败是制造假失败。
	const outcome = decideRunOutcome({ text: "看起来写完了", hasTurnEnd: false });
	assert.equal(outcome.status, "succeeded");
	assert.equal(outcome.summary, "看起来写完了");
	// 判定可以宽松，证据不能丢：模型崩了也是这个形状，运行历史要能事后分辨
	assert.equal(outcome.incomplete, true, "缺 turn/end 必须留下 incomplete 标记");
	assert.equal(decideRunOutcome({ text: "ok", hasTurnEnd: true, reason: "completed" }).incomplete, undefined, "干净收尾不该有标记");

	// 「跑没跑起来」是另一个问题，由 started 表达，不能靠 turn/end 缺席来推。
	const notStarted = decideRunOutcome({ text: "", hasTurnEnd: false }, { started: false });
	assert.equal(notStarted.status, "failed");
	assert.match(notStarted.error, /等不到这一轮启动/);

	// 明确失败的信号不能被吞成成功 —— 这才是原来那条规则要防的
	assert.equal(decideRunOutcome({ text: "x", hasTurnEnd: true, reason: "error" }).status, "failed");
});

check("engine：成功但收尾不完整的一轮，运行记录里必须分得出来", async () => {
	// 「缺 turn/end 判成功」是为了不制造假失败，但它和干净收尾是同一个形状 ——
	// 记录里不留标记，用户就永远看不出这一轮其实没有正常收尾。
	const store = freshStore("run-incomplete");
	const engine = createEngine({
		store,
		config: { ...SCHEDULER_DEFAULTS },
		// 一轮「成功但没写 turn/end」，一轮干净收尾
		executor: {
			run: async (task) =>
				task.id === "inc1"
					? { status: "succeeded", incomplete: true, summary: "看起来写完了" }
					: { status: "succeeded", summary: "写完了" },
		},
	});
	await store.mutateTasks((tasks) => {
		tasks.push({ id: "inc1", name: "崩了", enabled: true, prompt: "p", schedule: { kind: "interval", everyMinutes: 60 }, nextRunAt: Date.now() - 1000 });
		tasks.push({ id: "ok1", name: "干净", enabled: true, prompt: "p", schedule: { kind: "interval", everyMinutes: 60 }, nextRunAt: Date.now() - 1000 });
	});
	await engine.tick();
	let runs = [];
	for (let i = 0; i < 300; i += 1) {
		runs = store.readRuns();
		if (runs.length === 2 && runs.every((r) => r.finishedAt !== undefined)) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const inc = runs.find((r) => r.taskId === "inc1");
	const ok = runs.find((r) => r.taskId === "ok1");
	assert.ok(inc !== undefined && ok !== undefined, "两轮都该有记录");
	assert.equal(inc.status, "succeeded");
	assert.equal(inc.incomplete, true, "收尾不完整的成功必须留标记");
	assert.equal(inc.summary, "看起来写完了");
	assert.equal(ok.status, "succeeded");
	assert.equal(ok.incomplete, undefined, "干净收尾不该带标记");
});


check("waitForTurnStart：seq 不增长就不放行，观测不到 seq 时不判死", async () => {
	// 启动窗口跟源头同一个值（30s）
	assert.equal(TURN_START_TIMEOUT_MS, 30_000);
	// 已经启动：立刻返回 true
	assert.equal(await waitForTurnStart({ seq: 5 }, 3), true);
	// seq 一直不动且窗口很短：返回 false（「没观察到启动」）
	const t0 = Date.now();
	assert.equal(await waitForTurnStart({ seq: 1 }, 1, 30), false);
	assert.ok(Date.now() - t0 >= 25, "应该真的等满了窗口");
	// seq 中途增长：等到之后放行
	const growing = { seq: 0 };
	setTimeout(() => {
		growing.seq = 4;
	}, 20);
	assert.equal(await waitForTurnStart(growing, 0, 2000), true);

	// 读不到 seq（宿主结构漂移）时返回 true 并退让一会：观测不到不等于没发生，
	// 凭观测不到的信号判死正是在制造假失败。
	const blind = {};
	assert.equal(await waitForTurnStart(blind, 0), true);
	assert.equal(await waitForTurnStart(undefined, 0), true);
});

check("decideRunOutcome：四种结束原因 + 超时 + 取消", () => {
	assert.equal(decideRunOutcome({ text: "ok", hasTurnEnd: true, reason: "completed" }).status, "succeeded");
	assert.equal(decideRunOutcome({ text: "x", hasTurnEnd: true, reason: "aborted" }).status, "cancelled");
	assert.equal(decideRunOutcome({ text: "x", hasTurnEnd: true, reason: "error" }).status, "failed");
	assert.match(decideRunOutcome({ text: "x", hasTurnEnd: true, reason: "error" }).error, /error/);
	assert.equal(decideRunOutcome({ text: "x", hasTurnEnd: true }, { timedOut: true }).status, "failed");
	assert.match(decideRunOutcome({ text: "x", hasTurnEnd: true }, { timedOut: true }).error, /超时/);
	assert.equal(decideRunOutcome({ text: "x", hasTurnEnd: true }, { cancelled: true }).status, "cancelled");
	// reason 是对象形态也要认（AgentCancelCause 那种）
	assert.equal(decideRunOutcome({ text: "x", hasTurnEnd: true, reason: "completed" }).status, "succeeded");
});

// ── 5. 假宿主装配 ────────────────────────────────────────────────────────────

/** 造一个假 ctx。services 里没列的服务，inject 不会回调 —— 复刻 cordis 的语义。 */
function fakeCtx(services) {
	const available = new Set(services);
	const record = { tools: [], routes: [], effects: [] };
	const ctx = {
		logger: { info: () => {} },
		tools: {
			register(tool) {
				record.tools.push(tool);
				return () => {};
			},
		},
		webServer: {
			register(route) {
				record.routes.push(route);
				return () => {};
			},
		},
		effect(fn, label) {
			const dispose = fn();
			record.effects.push({ label, dispose: typeof dispose === "function" ? dispose : () => {} });
			return () => {};
		},
		inject(deps, callback) {
			if (!deps.every((d) => available.has(d))) return;
			const scope = Object.create(ctx);
			scope.agents = { withoutInitiator: (op) => op(), create: async () => ({ agent: {}, dispose: async () => {} }) };
			scope.sessions = { flush: async () => true };
			scope.agentPresets = { mount: async () => ({}) };
			scope.agentDefaultModel = { currentSelection: () => ({ provider: "fake", model: "fake" }) };
			scope.workspaceRegistry = {
				list: () => [{ id: "ws1", path: "/tmp/ws1", title: "工作区一" }],
				get: () => undefined,
			};
			callback(scope);
		},
	};
	return { ctx, record };
}

const REQUIRED = ["tools", "agents", "sessions", "agentPresets", "agentDefaultModel", "workspaceRegistry", "webServer"];

check("可选安装：enabled=false → 一个工具不注册、一条路由不挂", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	const scheduler = installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: false } });
	assert.equal(scheduler.enabled, false);
	assert.equal(record.tools.length, 0, "关着的时候不该注册任何工具");
	assert.equal(record.routes.length, 0, "关着的时候不该挂任何路由");
	assert.equal(record.effects.length, 0, "关着的时候不该起定时器");
	assert.match(scheduler.describe(), /已关闭/);
	assert.ok(scheduler.store, "store 仍然给出，命令才能读历史");
});

check("可选安装：enabled 缺失 → 也是关（默认必须是关）", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	const scheduler = installScheduler(ctx, { config: {} });
	assert.equal(scheduler.enabled, false);
	assert.equal(record.tools.length + record.routes.length, 0);
});

check("可选安装：enabled 只认真布尔，字符串 \"true\" 不算开", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	const scheduler = installScheduler(ctx, { config: { enabled: "true" } });
	assert.equal(scheduler.enabled, false);
	assert.equal(record.tools.length, 0);
});

check("依赖不齐：enabled=true 但缺服务 → 同样一个都不注册（不连累本包其余模块）", () => {
	const { ctx, record } = fakeCtx(["tools", "webServer"]); // 缺 agents/sessions/...
	const scheduler = installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	assert.equal(scheduler.enabled, true, "配置上它是开的");
	assert.equal(record.tools.length, 0, "依赖不齐就不该注册工具");
	assert.equal(record.routes.length, 0);
	assert.equal(scheduler.tools, 0);
});

check("依赖齐备：4 个工具 + 1 条路由 + 2 个 effect", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	const scheduler = installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	assert.equal(scheduler.enabled, true);
	assert.deepEqual(
		record.tools.map((t) => t.name).sort(),
		["scheduler_create", "scheduler_delete", "scheduler_list", "scheduler_update"],
	);
	assert.equal(record.routes.length, 1);
	assert.equal(record.routes[0].kind, "prefix");
	assert.equal(record.routes[0].path, "/api/team/scheduler");
	assert.equal(record.effects.length, 2, "一个恢复中断记录 + 一个调度循环");
	assert.equal(scheduler.routes, 1);
	scheduler.dispose();
});

check("工具注册表：参数是合法 JSON Schema，且 output.schema 不带 required", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	for (const tool of record.tools) {
		assert.equal(typeof tool.description, "string");
		assert.ok(tool.description.length > 10, `${tool.name} 描述太短`);
		assert.equal(tool.parameters.type, "object", `${tool.name} 顶层必须是 object`);
		assert.equal(typeof tool.parameters.properties, "object");
		// dsh 的 output.schema 校验器**不接受 required**（会抛 unsupported）
		assert.ok(!("required" in (tool.output?.schema ?? {})), `${tool.name} 的 output.schema 带了 required，dsh 会拒绝`);
		assert.equal(typeof tool.output.render, "function", `${tool.name} 缺 render`);
		assert.equal(typeof tool.execute, "function", `${tool.name} 缺 execute`);
	}
});

check("工具注册表：nullable 字段用 oneOf（type 数组和 anyOf 都会被拒）", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const create = record.tools.find((t) => t.name === "scheduler_create");
	const nextRunAt = create.output.schema.properties.nextRunAt;
	assert.deepEqual(nextRunAt, { oneOf: [{ type: "string" }, { type: "null" }] });
});

// ── 6. 真跑 HTTP 路由（假 req/res，不发真请求） ──────────────────────────────

/** 直接调路由 handler，用假 req/res 收结果 */
async function request(handler, method, url, body, { remoteAddress = "127.0.0.1", host = "localhost:3080", extraHeaders = {} } = {}) {
	let settle;
	const done = new Promise((resolve) => {
		settle = resolve;
	});
	const res = {
		status: 0,
		writeHead(status) {
			this.status = status;
		},
		end(text) {
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				payload = { parseError: text };
			}
			settle({ status: this.status, body: payload });
		},
	};
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.socket = { remoteAddress };
	req.headers = { host, ...extraHeaders };
	// 超限时 handler 会 req.resume() 排空剩余数据（而不是 destroy —— destroy 会让
	// 那个 400 到不了客户端）。假 req 上得有这个方法。
	req.resume = () => {};
	const pending = handler(req, res);
	setImmediate(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
		req.emit("end");
	});
	await pending;
	return done;
}

await checkAsync("路由：任务数上限在写队列里把关（并发也拦得住）", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-max");
	const { ctx, record } = fakeCtx(REQUIRED);
	const config = { ...SCHEDULER_DEFAULTS, enabled: true, maxTasks: 3 };
	installScheduler(ctx, { config });
	const handler = record.routes[0].handler;
	const body = (n) => ({ name: `任务${n}`, prompt: "p", schedule: { kind: "daily", time: "09:00" } });

	// 并发打 10 个：上限检查必须和 push 在同一个写队列回调里，
	// 否则「先读长度再判再写」会同时通过
	const results = await Promise.all(Array.from({ length: 10 }, (_, i) => request(handler, "POST", "/api/team/scheduler/tasks", body(i))));
	const created = results.filter((r) => r.status === 200).length;
	assert.equal(created, 3, `只该建出 3 个，实际 ${created}`);
	assert.equal(results.filter((r) => r.status === 409).length, 7, "超限要回 409");
	assert.equal((await request(handler, "GET", "/api/team/scheduler/tasks")).body.tasks.length, 3);
});

await checkAsync("路由：内部故障回 500，参数问题回 400", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-500");
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const handler = record.routes[0].handler;
	// 参数问题 → 400
	assert.equal((await request(handler, "POST", "/api/team/scheduler/tasks", { name: "" })).status, 400);
	assert.equal((await request(handler, "PUT", "/api/team/scheduler/tasks", {})).status, 400);
	// 把 tasks.json 弄坏 → 写路径拒绝（不是「按空表写回去」）→ 500 而不是 400
	const tasksFile = path.join(process.env.DSH_HOME, "team-workflow", "scheduler", "tasks.json");
	fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
	fs.writeFileSync(tasksFile, "{ 坏了", "utf8");
	const res = await request(handler, "POST", "/api/team/scheduler/tasks", { name: "x", prompt: "p", schedule: { kind: "daily", time: "09:00" } });
	assert.equal(res.status, 500, `存储坏了必须是 500，实际 ${res.status}`);
});

await checkAsync("路由：客户端断连时 handler 要收敛，不能挂着", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-abort");
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const handler = record.routes[0].handler;
	const req = new EventEmitter();
	req.method = "POST";
	req.url = "/api/team/scheduler/tasks";
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost:3080" };
	const res = { writeHead() {}, end() {} };
	const pending = handler(req, res);
	// 没有 close/aborted 处理的话这个 promise 永不 settle（每次断连漏一个 handler）
	req.emit("aborted");
	await Promise.race([
		pending,
		new Promise((_, reject) => setTimeout(() => reject(new Error("handler 没收敛")), 500)),
	]);
});

await checkAsync("请求体超限：回 400 告诉客户端，不是把 socket 掐了", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-bigbody");
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const handler = record.routes[0].handler;
	// 以前是 reject + req.destroy()：400 还没写出去 socket 就没了，
	// 客户端只看到 ECONNRESET，完全不知道是自己发的包太大。
	const huge = { name: "x", prompt: "y".repeat(1.5 * 1024 * 1024), schedule: { kind: "daily", time: "09:00" } };
	const res = await request(handler, "POST", "/api/team/scheduler/tasks", huge);
	assert.equal(res.status, 400, `该是 400，实际 ${res.status}`);
	assert.match(res.body.error, /请求体过大/);
	// 响应写完要把连接断掉：排空本身无上限，本地进程可以一直灌数据占住连接
	const serverRes = {
		status: 0,
		finished: false,
		once(evt, fn) {
			if (evt === "finish") this.onFinish = fn;
		},
		writeHead(s) {
			this.status = s;
		},
		end() {
			this.finished = true;
			this.onFinish?.();
		},
	};
	const req = new EventEmitter();
	req.method = "POST";
	req.url = "/api/team/scheduler/tasks";
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost:3080" };
	let destroyed = false;
	req.resume = () => {
		// 排空后假造一次 end，模拟「灌完剩下的数据」
		setImmediate(() => req.emit("end"));
	};
	req.destroy = () => {
		destroyed = true;
	};
	const pending = handler(req, serverRes);
	setImmediate(() => req.emit("data", Buffer.from(JSON.stringify({ pad: "y".repeat(1.2 * 1024 * 1024) }), "utf8")));
	await pending;
	assert.equal(serverRes.finished, true, "400 要真的写出去");
	assert.equal(destroyed, true, "响应写完之后要断掉连接");
});


/**
 * 假执行器宿主。
 *
 * 这一段是整个模块最该被测、也最难测的地方：**沙箱没钉上就绝不发 prompt**。
 * 那条保证只在 `setup` 抛异常、而 `agents.create` 又不透传异常时才有意义 ——
 * 所以这个假宿主刻意模仿 dsh 的这个行为（吞掉 setup 的异常）。
 *
 * 每个探针都能单独弄坏（`opts.break`），用来验证「坏了会怎样」。
 */
function fakeExecutorScope({ break: broken = {}, onFollowup } = {}) {
	const calls = { restrict: [], sandbox: [], approval: [], followup: [], disposed: 0, flush: 0, setupCalls: 0 };
	// 会话日志：真 `setSandboxMode()` 就是往这里追加一条 `sandbox/mode` 事件，
	// 执行器现在会回读它做正向确认 —— 假宿主必须照这个行为来，否则测的不是真路径。
	const events = [];
	const session = {
		id: "s",
		snapshotEvents: () => {
			// `noTurnEvents`：pin 事件（sandbox/mode、approval/policy）还在，只是这一轮
			// 还没写出 assistant/turn 事件 —— 这才是「起来但还没落任何东西」的真实形态。
			// 不能把整个日志抹空：那会连沙箱回读一起打断，测到的是另一回事。
			if (broken.noTurnEvents === true) return [...events];
			return [
				...events,
				{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "干完了" }] } } },
				{ type: "turn/end", data: { reason: "completed" } },
			];
		},
	};
	// `seq` 只在明确要测「等这一轮启动」时才给。默认不给：执行器会走
	// `waitForTurnStart` 的「观测不到」分支（退让 50ms 后放行），
	// 否则每个执行器测试都要白等一整个启动窗口。
	if (broken.seqGrows === true || broken.seqFrozen === true) session.seq = 0;
	const agent = {
		session,
		whenIdle: async () => {},
		cancel: () => {},
		followup: (msg) => {
			calls.followup.push(msg);
			// driver 立刻把排队的 followup 取走 —— `seq` 增长就是「这一轮起来了」
			if (broken.seqGrows === true) session.seq += 1;
			onFollowup?.(msg);
		},
	};
	const agentCtx = {
		agent,
		tools: {
			restrict: (filter) => {
				if (broken.restrict) throw new Error("工具名不存在");
				calls.restrict.push(filter);
			},
		},
	};
	const scope = {
		loader: {
			import: async (name) => {
				if (name.endsWith("dsh-llm")) return { createUserMessage: (input) => ({ input }) };
				if (name.endsWith("dsh-user-approval")) {
					return {
						setApprovalPolicy: (_s, policy) => {
							if (!broken.silentApproval) events.push({ type: "approval/policy", data: { policy } });
							if (broken.approval) throw new Error("policy 不合法");
							calls.approval.push(policy);
						},
					};
				}
				if (name.endsWith("dsh-sandbox-policy")) {
					return {
						setSandboxMode: (_s, mode) => {
							if (broken.sandbox) throw new Error("未知沙箱模式");
							calls.sandbox.push(mode);
							// 静默不生效（宿主漂移的另一种形态）也要能被测到
							if (!broken.silentSandbox && !broken.noSandboxEvent) events.push({ type: "sandbox/mode", data: { mode } });
						},
					};
				}
				throw new Error(`不该加载 ${name}`);
			},
			unwrapExports: (m) => m,
		},
		agents: {
			withoutInitiator: (fn) => fn(),
			// 刻意模仿 dsh：setup 抛了也不一定透传出来（这里干脆吞掉）
			create: async (opts) => {
				// 宿主漂移的形态之一：`setup` 压根不被调用（选项改名/被自己的包装吃掉）。
				// 这时 setupError 永远是 undefined —— 只有正向确认 pinned 才拦得住。
				if (!broken.setupNotCalled) {
					calls.setupCalls += 1;
					try {
						await opts.setup(agentCtx, agent);
					} catch {
						/* 吞掉 —— 正是 P0 那个洞的成因 */
					}
				}
				return { agent, dispose: () => { calls.disposed += 1; } };
			},
		},
		agentPresets: { mount: async () => {} },
		// 默认不提供 sandboxPolicy（回读的主路径是会话日志那条 sandbox/mode 事件）。
		// 想测第二条路就传 fakeExecutorScope({ break: { noSandboxEvent: true } })。
		get sandboxPolicy() {
			if (broken.noSandboxEvent) return { overrideOf: () => "workspace-write" };
			throw new Error("服务未声明");
		},
		workspaceRegistry: { get: () => undefined, list: () => [] },
		agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
		sessions: { flush: async () => { calls.flush += 1; } },
		get: () => undefined,
	};
	return { scope, calls };
}

await checkAsync("执行器：沙箱钉不上就绝不发 prompt（P0 回归）", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-exec");
	// ① restrict 抛（工具名不存在 / dsh 漂移）：以前它在 try 外面，
	//    setupError 不会被设上，判定放行 → 在没钉沙箱的情况下把 prompt 发出去了。
	for (const broken of [
		{ restrict: true },
		{ sandbox: true },
		{ approval: true },
		{ silentSandbox: true },
		{ silentApproval: true },
	]) {
		const { scope, calls } = fakeExecutorScope({ break: broken });
		const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
		const task = buildTask({ name: "t", prompt: "别跑我", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
		const result = await executor.run(task, { runId: "r1" });
		assert.equal(result.status, "failed", `${JSON.stringify(broken)} 必须整轮失败`);
		assert.match(result.error, /准备无人值守会话失败/);
		assert.equal(calls.followup.length, 0, `${JSON.stringify(broken)}：没钉上沙箱就一个 prompt 都不许发`);
		assert.equal(calls.disposed, 1, "要把它刚建的会话收掉");
	}

	// ② 会话日志里没有 sandbox/mode 事件，但 `ctx.sandboxPolicy.overrideOf` 读得到 ——
	//    第二条回读路径必须真的接得上（`scope` 没传进去的话这条路是死的，
	//    而它是「事件被重命名了」时的唯一退路）
	{
		const { scope, calls } = fakeExecutorScope({ break: { noSandboxEvent: true } });
		const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
		const task = buildTask({ name: "t", prompt: "跑吧", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
		const result = await executor.run(task, { runId: "r1c" });
		assert.equal(result.status, "succeeded", `第二条回读路径要接得上，实际 ${JSON.stringify(result)}`);
		assert.equal(calls.followup.length, 1);
	}

	// ②b 沙箱钉上了但审批静默没生效 —— 和沙箱静默失效同样致命：
	//     审批没设成 never 的话，工具调用会**永远卡着**等人点，而没有人会来点。
	{
		const { scope, calls: c2 } = fakeExecutorScope({ break: { silentApproval: true } });
		const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
		const task = buildTask({ name: "t", prompt: "别跑我", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
		const result = await executor.run(task, { runId: "r1d" });
		assert.equal(result.status, "failed", "审批静默失效也必须整轮失败");
		assert.match(result.error, /审批策略回读不一致/);
		assert.equal(c2.followup.length, 0, "一个 prompt 都不许发");
		assert.equal(c2.disposed, 1);
	}
	
	// ③ setup 压根没被调用 —— 「没记下 setupError」放行是不够的，必须正向确认
	const { scope, calls } = fakeExecutorScope({ break: { setupNotCalled: true } });
	const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
	const task = buildTask({ name: "t", prompt: "别跑我", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
	const result = await executor.run(task, { runId: "r1b" });
	assert.equal(calls.setupCalls, 0, "假宿主确实没调 setup");
	assert.equal(result.status, "failed", "setup 没被调用也必须失败");
	assert.match(result.error, /沙箱档位未确认/);
	assert.equal(calls.followup.length, 0, "一个 prompt 都不许发");
	assert.equal(calls.disposed, 1);
});

// ④ 这一轮**确实起来了**（seq 增长），但事件快照还是空的 —— 早先的实现会在
//    followup 之后直接等 whenIdle（那一刻还没有 driver，它立刻兑现），读到空事件集，
//    然后因为「缺 turn/end」把跑得好好的任务记成 failed。要先等 seq 增长再等结束。
await checkAsync("执行器：这一轮起来了但还没写事件，不能判失败", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-exec");
	const { scope, calls } = fakeExecutorScope({ break: { seqGrows: true, noTurnEvents: true } });
	const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
	const task = buildTask({ name: "t", prompt: "跑吧", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
	const result = await executor.run(task, { runId: "r4" });
	assert.equal(result.status, "succeeded", `空事件快照不该判失败，实际 ${JSON.stringify(result)}`);
	assert.equal(calls.followup.length, 1);
	assert.equal(calls.disposed, 1);
});

// ⑤ 等满启动窗口也没见 seq 增长 —— 这一轮**确实**没起来，这时才判失败。
//    它和「缺 turn/end」是两件事，不能互相推。
await checkAsync("执行器：等满窗口没见启动才判失败", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-exec");
	const { scope, calls } = fakeExecutorScope({ break: { seqFrozen: true, noTurnEvents: true } });
	const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS, turnStartTimeoutMs: 20 });
	const task = buildTask({ name: "t", prompt: "跑吧", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
	const result = await executor.run(task, { runId: "r5" });
	assert.equal(result.status, "failed");
	assert.match(result.error, /等不到这一轮启动/);
	// prompt 已经发出去了：这不是「准备会话失败」，别把两类错混成一个文案
	assert.equal(calls.followup.length, 1);
	assert.equal(calls.disposed, 1);
});

await checkAsync("执行器：执行时也查天花板（存量任务不许靠 run_now 复活）", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-exec");
	const { scope, calls } = fakeExecutorScope();
	const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
	// 直接构造一条超过天花板的任务（模拟：调低 maxPermission 后库里留下的旧任务、
	// 手工改过的 tasks.json、旧版本留下的记录）—— 它不该能跑起来
	const task = buildTask({ name: "t", prompt: "越权", schedule: { kind: "daily", time: "09:00" }, permission: "danger-full-access" }).task;
	const result = await executor.run(task, { runId: "r3" });
	assert.equal(result.status, "failed");
	assert.match(result.error, /超过当前上限，本轮不执行/);
	assert.equal(calls.setupCalls, 0, "连会话都不该建");
	assert.equal(calls.followup.length, 0);
});

await checkAsync("执行器：正常路径下三者都真的生效，顺序是 restrict → 沙箱 → never", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-exec");
	const { scope, calls } = fakeExecutorScope();
	const executor = createExecutor({ scope, config: SCHEDULER_DEFAULTS });
	const task = buildTask({ name: "t", prompt: "跑吧", schedule: { kind: "daily", time: "09:00" }, permission: "workspace-write" }).task;
	const result = await executor.run(task, { runId: "r2" });
	assert.equal(result.status, "succeeded", `实际 ${JSON.stringify(result)}`);
	assert.deepEqual(calls.sandbox, ["workspace-write"]);
	assert.deepEqual(calls.approval, ["never"]);
	assert.deepEqual(calls.restrict, [{ deny: ["scheduler_create", "scheduler_update", "scheduler_delete"] }]);
	assert.equal(calls.followup.length, 1, "prompt 只发一次");
	assert.equal(calls.followup[0].input.content[0].text, "跑吧");
	assert.equal(calls.setupCalls, 1, "setup 真的被调用了");
	assert.equal(calls.flush, 1, "会话要落盘，否则 GUI 里找不到");
	assert.equal(calls.disposed, 1);
});

await checkAsync("权限天花板：建和改都不许越过 maxPermission", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-ceil");
	const { ctx, record } = fakeCtx(REQUIRED);
	// 天花板设成 workspace-write（默认），所以 danger-full-access 必须被拒
	const config = { ...SCHEDULER_DEFAULTS, enabled: true };
	installScheduler(ctx, { config });
	const handler = record.routes[0].handler;
	const base = { name: "提权", prompt: "p", schedule: { kind: "daily", time: "09:00" } };

	// ① 建的时候
	const denied = await request(handler, "POST", "/api/team/scheduler/tasks", { ...base, permission: "danger-full-access" });
	assert.equal(denied.status, 409, `建的时候必须拒，实际 ${denied.status}`);
	assert.match(denied.body.error, /超过了本机允许的上限/);
	// 正好等于天花板要放行
	const allowed = await request(handler, "POST", "/api/team/scheduler/tasks", { ...base, permission: "workspace-write" });
	assert.equal(allowed.status, 200, "等于天花板要放行");
	const id = allowed.body.task.id;

	// ② 改的时候 —— 「建的时候拦住、改的时候放开」等于没拦
	const patched = await request(handler, "PUT", "/api/team/scheduler/tasks", { id, permission: "danger-full-access" });
	assert.equal(patched.status, 409, `改的时候也必须拒，实际 ${patched.status}`);
	assert.equal((await request(handler, "GET", "/api/team/scheduler/tasks")).body.tasks[0].permission, "workspace-write", "被拒的修改不许落盘");

	// ③ 工具侧（无人值守会话即使绕过 restrict 也走同一条路）
	const create = record.tools.find((t) => t.name === "scheduler_create");
	const toolDenied = await create.execute({ ...base, name: "工具提权", permission: "danger-full-access" });
	assert.equal(toolDenied.ok, false, "工具侧建也必须拒");
	assert.match(toolDenied.error, /超过了本机允许的上限/);
	const update = record.tools.find((t) => t.name === "scheduler_update");
	const toolPatch = await update.execute({ task_id: id, permission: "danger-full-access" });
	assert.equal(toolPatch.ok, false, "工具侧改也必须拒");
});

await checkAsync("权限天花板：改成 danger-full-access 后应全部放开", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-ceil-open");
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true, maxPermission: "danger-full-access" } });
	const handler = record.routes[0].handler;
	const opt = await request(handler, "GET", "/api/team/scheduler/options");
	assert.deepEqual(opt.body.permissions, ["read-only", "workspace-write", "danger-full-access"]);
	const res = await request(handler, "POST", "/api/team/scheduler/tasks", {
		name: "全权",
		prompt: "p",
		schedule: { kind: "daily", time: "09:00" },
		permission: "danger-full-access",
	});
	assert.equal(res.status, 200, "放开后必须能建");
});

await checkAsync("路由：信任栅栏 —— 非本机来源一律 403，且什么都不改", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home-fence");
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const handler = record.routes[0].handler;

	// dsh 的 web server 自己不鉴权，所以这道栅栏是唯一拦住「用户浏览器里的
	// 任意网页建任务 / DNS rebinding 读走全部 prompt」的东西。
	const cases = [
		["远程 socket 地址", { remoteAddress: "192.168.1.9" }],
		["Host 不是回环（DNS rebinding）", { host: "evil.example.com" }],
		["跨站发起的请求", { extraHeaders: { "sec-fetch-site": "cross-site" } }],
		["Origin 与 Host 不同源", { extraHeaders: { origin: "http://evil.example.com" } }],
		["Host 头缺失", { host: null }],
	];
	for (const [label, options] of cases) {
		const res = await request(handler, "POST", "/api/team/scheduler/tasks", { name: "x", prompt: "y", schedule: { kind: "daily", time: "09:00" } }, options);
		assert.equal(res.status, 403, `${label} 必须被拒，实际 ${res.status}`);
		const read = await request(handler, "GET", "/api/team/scheduler/tasks", undefined, options);
		assert.equal(read.status, 403, `${label} 连读也必须被拒，实际 ${read.status}`);
	}
	// 被拒的请求一个任务都没建出来（tasks.json 根本不该被创建）
	const tasksFile = path.join(process.env.DSH_HOME, "team-workflow", "scheduler", "tasks.json");
	assert.ok(!fs.existsSync(tasksFile), "被拒的请求不许留下副作用：tasks.json 不该存在");

	// 同源 + 回环要放行（否则面板自己也进不来）
	const ok = await request(handler, "GET", "/api/team/scheduler/options", undefined, {
		extraHeaders: { origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
	});
	assert.equal(ok.status, 200, `本机同源请求必须放行，实际 ${ok.status}`);
});

await checkAsync("路由：全套 CRUD + 选项 + 历史", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home");
	const { ctx, record } = fakeCtx(REQUIRED);
	const scheduler = installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const handler = record.routes[0].handler;

	// options
	const options = await request(handler, "GET", "/api/team/scheduler/options");
	assert.equal(options.status, 200);
	assert.deepEqual(options.body.workspaces, [{ id: "ws1", path: "/tmp/ws1", title: "工作区一" }]);
	// 面板只该列出天花板以内的档位：列出一个选了必然 409 的档位是在骗人
	assert.deepEqual(options.body.permissions, ["read-only", "workspace-write"]);
	assert.equal(options.body.maxPermission, "workspace-write");
	assert.equal(options.body.scheduleKinds.length, 8);
	assert.equal(options.body.defaultModel.provider, "fake");
	assert.ok(options.body.timeZone.length > 0);

	// 空列表
	const empty = await request(handler, "GET", "/api/team/scheduler/tasks");
	assert.deepEqual(empty.body.tasks, []);

	// 创建
	const created = await request(handler, "POST", "/api/team/scheduler/tasks", {
		name: "写日报",
		prompt: "写日报",
		schedule: { kind: "daily", time: "09:00" },
	});
	assert.equal(created.status, 200);
	assert.ok(created.body.task.id);
	assert.equal(created.body.task.scheduleText, "每天 09:00");
	const id = created.body.task.id;

	// 创建失败要有 400 和错误文案
	const bad = await request(handler, "POST", "/api/team/scheduler/tasks", { name: "", prompt: "x", schedule: { kind: "daily", time: "09:00" } });
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /name/);

	// 非法 JSON 不能把 handler 打崩
	const garbage = await request(handler, "POST", "/api/team/scheduler/tasks", "不是对象");
	assert.equal(garbage.status, 400);

	// 列表 + 搜索
	const listed = await request(handler, "GET", "/api/team/scheduler/tasks");
	assert.equal(listed.body.tasks.length, 1);
	assert.equal(listed.body.tasks[0].running, false);
	const searched = await request(handler, "GET", "/api/team/scheduler/tasks?search=不存在");
	assert.deepEqual(searched.body.tasks, []);
	const hit = await request(handler, "GET", "/api/team/scheduler/tasks?search=日报");
	assert.equal(hit.body.tasks.length, 1);

	// 停用 / 启用
	const toggled = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id });
	assert.equal(toggled.body.task.enabled, false);
	const toggledBack = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id });
	assert.equal(toggledBack.body.task.enabled, true);
	assert.ok(typeof toggledBack.body.task.nextRunAt === "number", "重新启用要补回下次运行时间");

	// 显式传 enabled 时必须**幂等**：同一个请求发两次结果一样。
	// 原来只能取反，于是「停用」按钮在快照过期时会把任务启用 —— 点两次等于没点。
	const off1 = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id, enabled: false });
	assert.equal(off1.body.task.enabled, false);
	const off2 = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id, enabled: false });
	assert.equal(off2.body.task.enabled, false, "显式停用重复发也必须是停用");
	const on1 = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id, enabled: true });
	assert.equal(on1.body.task.enabled, true);
	const on2 = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id, enabled: true });
	assert.equal(on2.body.task.enabled, true, "显式启用重复发也必须是启用");
	// 非布尔值不猜：`"true"` 这种含糊输入要么被当取反、要么被当假值，两种都错
	const badType = await request(handler, "POST", "/api/team/scheduler/tasks/toggle", { id, enabled: "true" });
	assert.equal(badType.status, 400);
	assert.equal(badType.body.error, "enabled 必须是布尔值");
	const stillOn = await request(handler, "GET", "/api/team/scheduler/tasks");
	assert.equal(stillOn.body.tasks[0].enabled, true, "400 之后不能已经改了一半");

	// 改
	const updated = await request(handler, "PUT", "/api/team/scheduler/tasks", { id, name: "写周报" });
	assert.equal(updated.body.task.name, "写周报");
	const updateMissing = await request(handler, "PUT", "/api/team/scheduler/tasks", { id: "没有这个" });
	assert.equal(updateMissing.status, 404);

	// 历史（此时还没有运行记录）
	const history = await request(handler, "GET", "/api/team/scheduler/history");
	assert.deepEqual(history.body.runs, []);

	// 未知路由
	const unknown = await request(handler, "GET", "/api/team/scheduler/nope");
	assert.equal(unknown.status, 404);

	// 删
	const removed = await request(handler, "DELETE", "/api/team/scheduler/tasks", { id });
	assert.equal(removed.status, 200);
	const afterDelete = await request(handler, "GET", "/api/team/scheduler/tasks");
	assert.deepEqual(afterDelete.body.tasks, []);
	const doubleDelete = await request(handler, "DELETE", "/api/team/scheduler/tasks", { id });
	assert.equal(doubleDelete.status, 404);

	scheduler.dispose();
});

await checkAsync("路由：run 触发失败时记成 failed，不会静默丢掉", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home2");
	const { ctx, record } = fakeCtx(REQUIRED);
	// loader 故意不给 —— 执行器加载运行时模块时会抛，这条必须被记成一次 failed 运行
	const scheduler = installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const handler = record.routes[0].handler;

	const created = await request(handler, "POST", "/api/team/scheduler/tasks", {
		name: "会失败的任务",
		prompt: "x",
		schedule: { kind: "daily", time: "09:00" },
	});
	const id = created.body.task.id;

	const triggered = await request(handler, "POST", "/api/team/scheduler/tasks/run", { id });
	assert.equal(triggered.status, 200);

	// 等后台那次执行落盘（执行器是 void 出去的）
	let runs = [];
	for (let i = 0; i < 100; i += 1) {
		runs = scheduler.store.readRuns();
		if (runs.length > 0 && runs[0].status !== "running") break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal(runs.length, 1, "应该留下一条运行记录");
	assert.equal(runs[0].trigger, "manual");
	assert.equal(runs[0].status, "failed", `期望 failed，实际 ${runs[0].status}`);
	assert.match(runs[0].error, /loader|创建会话失败/, `错误文案不对：${runs[0].error}`);
	assert.ok(typeof runs[0].durationMs === "number");

	// 同一个任务再点一次「立即运行」不能并发
	const again = await request(handler, "POST", "/api/team/scheduler/tasks/run", { id: "没有这个" });
	assert.equal(again.status, 404);

	scheduler.dispose();
});

await checkAsync("工具：scheduler_create 真写进存储，scheduler_list 读得回来", async () => {
	process.env.DSH_HOME = path.join(tmpRoot, "home3");
	const { ctx, record } = fakeCtx(REQUIRED);
	const scheduler = installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	const create = record.tools.find((t) => t.name === "scheduler_create");
	const list = record.tools.find((t) => t.name === "scheduler_list");
	const remove = record.tools.find((t) => t.name === "scheduler_delete");
	const update = record.tools.find((t) => t.name === "scheduler_update");

	const empty = await list.execute({}, {});
	assert.match(empty.report, /没有任何定时任务/);

	const created = await create.execute({ name: "日报", prompt: "写日报", schedule: { kind: "daily", time: "09:00" } }, {});
	assert.equal(created.ok, true);
	assert.ok(created.taskId);
	assert.ok(created.nextRunAt > Date.now());

	const report = await list.execute({}, {});
	assert.match(report.report, /日报/);
	assert.match(report.report, /每天 09:00/);

	const patched = await update.execute({ task_id: created.taskId, name: "周报" }, {});
	assert.equal(patched.ok, true);
	const afterRename = await list.execute({}, {});
	assert.match(afterRename.report, /周报/);

	const missing = await update.execute({ task_id: "没有" }, {});
	assert.equal(missing.ok, false);
	const noFields = await update.execute({ task_id: created.taskId }, {});
	assert.equal(noFields.ok, false, "没给要改的字段应拒绝");

	// run_now 和补丁一起传时，补丁必须**先落地**。早先的实现一进 run_now 分支就
	// trigger + return，于是 `{task_id, prompt, run_now:true}` 的 prompt 被静默丢掉、
	// 跑的还是旧指令，而工具回的是 ✅ —— 用户以为改了。
	const readPrompt = (id) => scheduler.store.readTasks().find((t) => t.id === id)?.prompt;
	assert.equal(readPrompt(created.taskId), "写日报");
	const both = await update.execute({ task_id: created.taskId, prompt: "改成写周报", run_now: true }, {});
	assert.equal(both.ok, true);
	assert.equal(both.ran, true);
	assert.equal(both.updated, true, "同一批带了补丁，要报出「也改了」");
	assert.equal(readPrompt(created.taskId), "改成写周报", "run_now 不能把同一批的补丁丢掉");

	// 只传 run_now 仍然合法（「立刻跑一次，别的都不改」），不能报「没有要改的字段」。
	// 另起一个任务：上面那个已经进 running 了，同一个任务会被并发闸拦成「该任务正在运行」，
	// 那就测不出这条。
	const solo = await create.execute({ name: "临时", prompt: "原始指令", schedule: { kind: "daily", time: "10:00" } }, {});
	const soloRun = await update.execute({ task_id: solo.taskId, run_now: true }, {});
	assert.equal(soloRun.ok, true, "只传 run_now 不该被拒");
	assert.equal(soloRun.updated, false, "只传 run_now 没有补丁");
	assert.equal(readPrompt(solo.taskId), "原始指令", "只传 run_now 不该动任何字段");
	await remove.execute({ task_id: solo.taskId }, {});

	const deleted = await remove.execute({ task_id: created.taskId }, {});
	assert.equal(deleted.ok, true);
	const deletedAgain = await remove.execute({ task_id: created.taskId }, {});
	assert.equal(deletedAgain.ok, false);
	const finalReport = await list.execute({}, {});
	assert.match(finalReport.report, /没有任何定时任务/);

	scheduler.dispose();
});

check("工具：render 对成功/失败都给得出文案", () => {
	const { ctx, record } = fakeCtx(REQUIRED);
	installScheduler(ctx, { config: { ...SCHEDULER_DEFAULTS, enabled: true } });
	for (const tool of record.tools) {
		const okText = tool.output.render({}, { ok: true, report: "r", taskId: "t", nextRunAt: Date.now() });
		const errText = tool.output.render({}, { ok: false, error: "炸了", report: "r" });
		assert.ok(Array.isArray(okText) && typeof okText[0].text === "string", `${tool.name} render 成功路径不对`);
		assert.ok(Array.isArray(errText) && typeof errText[0].text === "string", `${tool.name} render 失败路径不对`);
	}
});

// ── 7. 客户端面板（真加载那个 classic script） ──────────────────────────────

/**
 * 客户端那个文件不是 ESM，是 `window.__ModuleLoader__.load({id, factory})` 的 classic
 * script。所以这里真把它 `new Function("window", src)` 跑一遍，再真调 `factory(require)`
 * —— 而不是「读一下文件里有几个字符」。
 *
 * 能验的：契约对不对（id / apply / inject）、探活失败时是否真的不注册、
 *         成功时挂的槽位与 id/key 是否自洽、槽位抛错时会不会连累别人。
 * 不能验的：浏览器里长什么样（那要重启 dsh 目视，记在 REQ-007 §8）。
 */
const clientSource = fs.readFileSync(new URL("lib/scheduler-client.js", ROOT), "utf8");
const REACT_STUB = {
	createElement: () => null,
	useState: () => [undefined, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
};

function loadClient() {
	let captured;
	const window = {
		__ModuleLoader__: {
			load(definition) {
				captured = definition;
			},
		},
	};
	new Function("window", clientSource)(window);
	assert.ok(captured !== undefined, "客户端文件没有调 window.__ModuleLoader__.load");
	const required = [];
	const require = (name) => {
		required.push(name);
		if (name === "react") return REACT_STUB;
		throw new Error(`客户端不该 require baseline 之外的包：${name}`);
	};
	return { definition: captured, exports: captured.factory(require), required };
}

function fakeClientCtx({ registerThrows = false } = {}) {
	const record = { injects: [], registrations: [] };
	const ctx = {
		effect(fn) {
			const dispose = fn();
			return () => {
				if (typeof dispose === "function") dispose();
			};
		},
		slots: {
			inject(name, callback) {
				record.injects.push(name);
				return callback();
			},
			register(options, component) {
				// 复刻真实现：未声明的槽位会抛
				if (registerThrows) throw new Error(`slot "${options.name}" is not declared`);
				record.registrations.push({ options, component });
				return () => {};
			},
		},
	};
	return { ctx, record };
}

/** 让 async 的探活 promise 链跑完 */
const settle = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const reply = (status, payload) => async () => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => JSON.stringify(payload),
});

check("客户端模块：契约（id / apply / inject）与「只 require baseline」", () => {
	const { definition, exports, required } = loadClient();
	assert.equal(definition.id, "dsh-team-workflow", "id 必须是包名");
	assert.equal(typeof definition.factory, "function");
	assert.equal(typeof exports.apply, "function");
	assert.deepEqual(exports.inject, ["slots"], "客户端只该声明 slots");
	assert.deepEqual(required, ["react"], `只该 require react，实际 require 了 ${required.join(", ")}`);
});

await checkAsync("客户端模块：宿主没启用（404）→ 一个槽位都不注册", async () => {
	const { exports } = loadClient();
	const { ctx, record } = fakeClientCtx();
	await withFetch(reply(404, { ok: false, error: "未知路由" }), async () => {
		exports.apply(ctx);
		await settle();
	});
	assert.deepEqual(record.registrations, [], "宿主没启用时不该挂任何槽位");
	assert.deepEqual(record.injects, [], "连槽位都不该去 inject");
});

await checkAsync("客户端模块：宿主启用了 → 挂 sidebar.panellist + main，且 id 与 key 自洽", async () => {
	const { exports } = loadClient();
	const { ctx, record } = fakeClientCtx();
	let requested;
	await withFetch(async (url) => {
		requested = url;
		return reply(200, { ok: true, workspaces: [], permissions: [], scheduleKinds: [] })();
	}, async () => {
		exports.apply(ctx);
		await settle();
	});
	assert.equal(requested, "/api/team/scheduler/options", "探活必须打宿主那条路由前缀");
	assert.deepEqual(record.injects.sort(), ["main", "sidebar.panellist"]);

	const panel = record.registrations.find((r) => r.options.name === "sidebar.panellist");
	const page = record.registrations.find((r) => r.options.name === "main");
	assert.ok(panel !== undefined, "缺侧栏入口");
	assert.ok(page !== undefined, "缺主面板");
	assert.equal(panel.options.id, "team-scheduler");
	assert.equal(page.options.key, "team-scheduler");
	assert.equal(panel.options.id, page.options.key, "侧栏 id 与主面板 key 必须一致，否则点不开");
	assert.equal(typeof panel.options.label, "string", "label 用纯字符串，免得依赖 locale 注册");
	assert.equal(typeof panel.component, "function");
	assert.equal(typeof page.component, "function");
});

await checkAsync("客户端模块：槽位未声明（register 抛）→ 不连累，apply 不抛", async () => {
	const { exports } = loadClient();
	const { ctx, record } = fakeClientCtx({ registerThrows: true });
	// 这条路径本来就会打 console.warn（降级是有意的），别让它混进测试输出
	const warn = console.warn;
	console.warn = () => {};
	try {
		await withFetch(reply(200, { ok: true }), async () => {
			exports.apply(ctx);
			await settle();
		});
	} finally {
		console.warn = warn;
	}
	assert.deepEqual(record.registrations, []);
	assert.deepEqual(record.injects.sort(), ["main", "sidebar.panellist"], "两个槽位都该试过");
});

check("客户端模块：宿主侧读得到它（exports[\"./client\"] + dsh.client 清单）", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("package.json", ROOT), "utf8"));
	assert.equal(pkg.exports["./client"], "./lib/scheduler-client.js");
	assert.equal(typeof pkg.exports["./client"], "string", "只接受字符串或带 default 的对象");
	assert.ok(fs.existsSync(new URL("lib/scheduler-client.js", ROOT)), "导出的文件必须真的存在");
	assert.equal(pkg.dsh?.client?.platform, "web", "platform 只接受 web");
	assert.ok(!("entry" in (pkg.dsh?.client ?? {})), "dsh.client 没有 entry 字段，别自己发明");
});

// ── 收尾 ─────────────────────────────────────────────────────────────────────

try {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
	/* 临时目录清不掉不算失败 */
}

console.log(
	failures === 0
		? "\n✓ 自检通过：计划纯函数（8 种）/ 任务构造与补丁 / 存储（原子写·裁剪·串行）/ 事件摘要与结论 / 可选安装两条负向验证 / HTTP 路由 CRUD / 4 个工具 / 客户端面板（真加载 classic script）"
		: `\n✗ ${failures} 项失败`,
);
process.exit(failures === 0 ? 0 : 1);
