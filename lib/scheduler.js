/**
 * dsh-team-workflow · 定时任务调度器（REQ-007）
 *
 * 移植自 Tauri 桌面版内置插件 `dsh-tauri-scheduler`，改写成零依赖、无构建步骤的纯 ESM。
 * 那个包改编自 MichengAI/dsh-automation（Apache-2.0），Apache-2.0 的义务随链条继承 ——
 * 来源、修改声明与许可证原文见仓库根目录 `THIRD_PARTY_NOTICES.md`。
 *
 * 它做什么：按 8 种计划（once/hourly/daily/interval/workdays/weekly/monthly/custom）
 * 到点在**一个全新会话**里无人值守跑一段 prompt，记运行历史，结果可查。
 * 和官方 `@deepseek-ai/dsh-schedule` 不是一回事 —— 那个把提醒投递回原会话。
 *
 * ⚠ 本模块**是**本包里唯一碰 dsh 内部 API 的地方（`ctx.agents.create` 那套）。
 *    worktree.js 那类模块刻意只用 `ctx.tools` 来绕开「import 不了 @deepseek-ai/*」，
 *    但「起一个全新会话」这件事没有工具层的替代品，只能走宿主 API。
 *    代价是它会随 dsh 版本漂移 —— 上游桌面版专门有 docs/sync-log.md 记这种漂移。
 *
 * 三个刻意与源头不同的地方（都是「不搬坑」，不是「改需求」）：
 *   1. 不搬 `timeZone` 字段 —— 源头那个字段是死的（cron-schedule 没有时区支持，
 *      实测按进程本地时区算）。搬一个不生效的字段比不搬更坏。
 *   2. 不引 `cron-schedule` —— daily/workdays/weekly/monthly 直接算下一个本地钟表时点，
 *      比源头「先拼 cron 表达式再解析回来」更直白，也少一个依赖。
 *   3. 修了源头 `custom` 的 bug —— 源头校验了 `time` 却从不使用它（occurrence 只由
 *      anchor + N×天 算），于是「每 3 天的 09:00」实际用的是 anchor 自带的时刻。
 *      这里让 `time` 真正生效。
 *
 * 另外继承源头一个刻意的选择：**结果摘要用全量事件快照，不用增量流**。
 * 源头 docs/sync-log.md 记着这条：增量流缺 `turn/end` 时若不回退全量，
 * 失败会被静默记成成功。我们干脆一直用全量 —— 单轮任务的快照不大。
 *
 * 存储：`<DSH_HOME>/team-workflow/scheduler/{tasks,runs}.json`，
 * `{version:1,...}`，写走全局串行队列 + 临时文件 rename 原子替换。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { dshHome } from "./util.js";

/* ═══════════════════════════ 1. 常量 ═══════════════════════════ */

export const SCHEDULE_KINDS = ["once", "hourly", "daily", "interval", "workdays", "weekly", "monthly", "custom"];

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** 星期几 → 中文单字。宿主侧的工具输出与客户端面板共用这一份，别再各写一份 */
export const WEEKDAY_LABELS = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };

/** 星期几 → JS `Date.getDay()` 的取值 */
const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_EVERY_MINUTES = 525_600;
const MAX_EVERY_DAYS = 366;

/** 计划类型 → 中文名，工具输出和面板共用 */
export const SCHEDULE_KIND_LABELS = {
	once: "一次性",
	hourly: "每小时",
	daily: "每天",
	interval: "固定间隔",
	workdays: "工作日",
	weekly: "每周",
	monthly: "每月",
	custom: "自定义天数",
};

/** 权限档位（与 dsh 的 permissionPresets 目录同名的三档） */
export const PERMISSION_PRESETS = ["read-only", "workspace-write", "danger-full-access"];

/* ═══════════════════════════ 2. 配置 ═══════════════════════════ */

export const SCHEDULER_DEFAULTS = {
	/** 默认关。装了工作流 ≠ 装了调度器，要开的人自己开（REQ-007 §1） */
	enabled: false,
	/** 调度循环间隔 */
	tickMs: 1000,
	/** 全局并发上限：同时最多几个任务在跑 */
	maxConcurrent: 4,
	/** 单次运行上限，超了就 cancel */
	runTimeoutMinutes: 30,
	/** cancel 之后等收敛的上限 */
	cancelTimeoutMs: 10_000,
	/** 运行历史保留条数 */
	historyLimit: 200,
	/** 跑任务时挂的 agent preset */
	agentPreset: "standard",
	/** 任务没指定工作区时的兜底目录名（建在 <DSH_HOME>/ 下） */
	workspaceFallback: "automations",
	/**
	 * 新建任务的默认权限档位。**这是无人值守唯一的边界**（跑的时候会真的
	 * `setSandboxMode` 到这个值），所以默认取沙箱地板 `read-only`。
	 * 要写文件的定时任务得自己显式提档。
	 */
	permission: "read-only",
	/** 任务总数上限。每个任务到点都会起一个真会话，不设上限就是无界建会话 */
	maxTasks: 200,
	/**
	 * **任何**任务允许用的最高权限档位。这是任务级 `permission` 的天花板。
	 *
	 * 为什么需要它：`permission` 是每个任务的沙箱档位，也就是任务能做什么的唯一边界。
	 * 但「谁能设这个字段」不止是用户 —— 一个已经在跑的无人值守会话手里有 bash，
	 * 它可以 `curl` 打本机 `/api/team/scheduler/tasks`（回环 socket + 回环 Host、
	 * 无 Origin、无 sec-fetch-site，四条栅栏全过），自己建一个
	 * `permission: "danger-full-access"` 的任务。`tools.restrict` 只约束本会话的
	 * 工具表，管不到子代理，也管不到 shell 里的 curl。
	 *
	 * 所以真正的边界必须在**服务端**：任何创建/修改路径都不许把 permission 提到
	 * 这个值以上。默认 `workspace-write` —— 想放开到 `danger-full-access` 的人
	 * 得自己来改这个文件（那是一次有意识的操作，不是模型能顺手做的）。
	 */
	maxPermission: "workspace-write",
};

/** `recoverInterruptedRuns` 的时间兜底下限：12 小时 */
export const DEFAULT_STALE_RUN_MS = 12 * 60 * 60 * 1000;

/**
 * 时间兜底阈值 = `max(12h, runTimeoutMinutes × 2)`。
 * `runTimeoutMinutes` 没有上界，固定 12 小时的话，一个配成 24 小时上限的任务
 * 会被自己的恢复逻辑误标成中断。
 */
export function staleRunMs(config) {
	const minutes = config?.runTimeoutMinutes;
	const fromTimeout = Number.isFinite(minutes) ? minutes * MINUTE_MS * 2 : 0;
	return Math.max(DEFAULT_STALE_RUN_MS, fromTimeout);
}

/** 权限档位的强弱次序，用于天花板比较 */
export function permissionRank(preset) {
	const index = PERMISSION_PRESETS.indexOf(preset);
	return index < 0 ? PERMISSION_PRESETS.length : index;
}

/**
 * 任务的 permission 有没有超过天花板。
 * @returns {string|undefined} 超了就返回给用户看的错误，没超返回 undefined
 */
export function checkPermissionCeiling(task, maxPermission) {
	// 天花板本身不合法时**收紧到默认值**，不是放开。
	// `SCHEDULER_FIELDS` 会挡掉非法配置，但「配置来源可信」是一句假设，
	// 这里不该依赖它 —— 一个拼错的 maxPermission 变成「无上限」是最坏的失败方向。
	const ceiling = PERMISSION_PRESETS.includes(maxPermission) ? maxPermission : SCHEDULER_DEFAULTS.maxPermission;
	if (permissionRank(task?.permission) <= permissionRank(ceiling)) return undefined;
	return `权限档位「${task?.permission}」超过了本机允许的上限「${ceiling}」（改 team/extensions/scheduler.json 的 maxPermission 才能放开）`;
}

export const SCHEDULER_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	tickMs: (v) => (Number.isFinite(v) && v >= 100 ? Math.floor(v) : undefined),
	maxConcurrent: (v) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined),
	runTimeoutMinutes: (v) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined),
	cancelTimeoutMs: (v) => (Number.isFinite(v) && v >= 100 ? Math.floor(v) : undefined),
	historyLimit: (v) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined),
	agentPreset: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	// 必须是一段相对路径片段：绝对路径或 `..` 会让兜底工作目录逃出 <DSH_HOME>
	workspaceFallback: (v) => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		if (t === "" || path.isAbsolute(t)) return undefined;
		if (t.split(/[\\/]+/).includes("..")) return undefined;
		return t;
	},
	permission: (v) => (PERMISSION_PRESETS.includes(v) ? v : undefined),
	maxTasks: (v) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined),
	maxPermission: (v) => (PERMISSION_PRESETS.includes(v) ? v : undefined),
};

/* ═══════════════════════════ 3. 计划：纯函数 ═══════════════════════════ */

/** `"HH:MM"` → `{ hours, minutes }`；不合法返回 undefined */
export function parseTimeOfDay(time) {
	if (typeof time !== "string") return undefined;
	const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!m) return undefined;
	const hours = Number(m[1]);
	const minutes = Number(m[2]);
	if (!(hours >= 0 && hours < 24) || !(minutes >= 0 && minutes < 60)) return undefined;
	return { hours, minutes };
}

const isInstant = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const isTimeValue = (v) => parseTimeOfDay(v) !== undefined;
const isMinuteValue = (v) => Number.isInteger(v) && v >= 0 && v < 60;
const isBoundedNumber = (v, end) => Number.isFinite(v) && v >= 1 && v < end;
const isBoundedInteger = (v, end) => Number.isInteger(v) && v >= 1 && v < end;

/** 把某个时间戳的「本地钟表时刻」换成给定的时分，秒/毫秒归零 */
function atLocalTime(stamp, hours, minutes) {
	const d = new Date(stamp);
	d.setHours(hours, minutes, 0, 0);
	return d.getTime();
}

/** 从 `stamp` 那天起（含）算第一个本地钟表时刻，逐天往前找，跳过 `skip(date)` 为真的日子 */
function nextLocalTime(stamp, hours, minutes, from, skip) {
	const d = new Date(stamp);
	d.setHours(0, 0, 0, 0);
	// 最多找 400 天：weekly/monthly 的间隔都不会超过这个数，兜底防死循环。
	for (let i = 0; i < 400; i += 1) {
		const day = new Date(d.getTime() + i * DAY_MS);
		if (skip !== undefined && skip(day)) continue;
		const candidate = atLocalTime(day.getTime(), hours, minutes);
		if (candidate > from) return candidate;
	}
	return undefined;
}

/** `anchor + k*step` 里第一个严格大于 `from` 的（k 取整，负数归零） */
export function anchoredOccurrence(anchor, step, from) {
	const base = Date.parse(anchor);
	if (!Number.isFinite(base) || !(step > 0)) return undefined;
	const index = Math.max(0, Math.floor((from - base) / step) + 1);
	return base + index * step;
}

/**
 * 算下一次触发时刻（本地时区）。返回毫秒时间戳；该计划已经没有下一次时返回 undefined。
 *
 * @param schedule - 计划描述对象
 * @param from - 从这个时刻之后找（严格大于）
 */
export function nextOccurrence(schedule, from) {
	if (!schedule || typeof schedule !== "object") return undefined;
	switch (schedule.kind) {
		case "once": {
			const at = Date.parse(schedule.at);
			return Number.isFinite(at) && at > from ? at : undefined;
		}
		case "hourly": {
			if (!isMinuteValue(schedule.minute)) return undefined;
			// 源头写法：先 +1 分钟再归位，这样 from 正好落在整分上时也会往前跳一格。
			const next = new Date(from + MINUTE_MS);
			next.setMinutes(schedule.minute, 0, 0);
			if (next.getTime() <= from) next.setHours(next.getHours() + 1);
			return next.getTime();
		}
		case "interval": {
			if (!isBoundedNumber(schedule.everyMinutes, MAX_EVERY_MINUTES + 1)) return undefined;
			const step = schedule.everyMinutes * MINUTE_MS;
			if (schedule.anchor === undefined || schedule.anchor === null) return from + step;
			return anchoredOccurrence(schedule.anchor, step, from);
		}
		case "custom": {
			if (!isBoundedInteger(schedule.everyDays, MAX_EVERY_DAYS + 1)) return undefined;
			const tod = parseTimeOfDay(schedule.time);
			if (tod === undefined) return undefined;
			const base = Date.parse(schedule.anchor);
			if (!Number.isFinite(base)) return undefined;
			const step = schedule.everyDays * DAY_MS;
			// 从 anchor 起按 everyDays 步进；跨夏令时会让 base+k*step 漂一小时，
			// 所以每一跳都重新按 `time` 归位（这也正是让 time 生效的地方）。
			const startIndex = Math.max(0, Math.floor((from - base) / step));
			for (let i = 0; i < 400; i += 1) {
				const candidate = atLocalTime(base + (startIndex + i) * step, tod.hours, tod.minutes);
				if (candidate > from) return candidate;
			}
			return undefined;
		}
		case "daily": {
			const tod = parseTimeOfDay(schedule.time);
			if (tod === undefined) return undefined;
			return nextLocalTime(from, tod.hours, tod.minutes, from);
		}
		case "workdays": {
			const tod = parseTimeOfDay(schedule.time);
			if (tod === undefined) return undefined;
			return nextLocalTime(from, tod.hours, tod.minutes, from, (d) => {
				const wd = d.getDay();
				return wd === 0 || wd === 6;
			});
		}
		case "weekly": {
			const tod = parseTimeOfDay(schedule.time);
			if (tod === undefined) return undefined;
			if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return undefined;
			const wanted = new Set(schedule.weekdays.map((d) => WEEKDAY_INDEX[d]));
			if (wanted.has(undefined)) return undefined;
			return nextLocalTime(from, tod.hours, tod.minutes, from, (d) => !wanted.has(d.getDay()));
		}
		case "monthly": {
			const tod = parseTimeOfDay(schedule.time);
			if (tod === undefined) return undefined;
			if (!isBoundedInteger(schedule.day, 32)) return undefined;
			// cron 的语义：这个月没有 31 号就直接跳到有 31 号的月份，不夹到月末。
			return nextLocalTime(from, tod.hours, tod.minutes, from, (d) => d.getDate() !== schedule.day);
		}
		default:
			return undefined;
	}
}

/** 校验计划描述对象 */
export function validateSchedule(schedule) {
	if (!schedule || typeof schedule !== "object") return false;
	switch (schedule.kind) {
		case "once":
			return isInstant(schedule.at);
		case "hourly":
			return isMinuteValue(schedule.minute);
		case "interval":
			return (
				isBoundedNumber(schedule.everyMinutes, MAX_EVERY_MINUTES + 1) &&
				(schedule.anchor === undefined || schedule.anchor === null || isInstant(schedule.anchor))
			);
		case "custom":
			return isBoundedInteger(schedule.everyDays, MAX_EVERY_DAYS + 1) && isInstant(schedule.anchor) && isTimeValue(schedule.time);
		case "daily":
		case "workdays":
			return isTimeValue(schedule.time);
		case "monthly":
			return isBoundedInteger(schedule.day, 32) && isTimeValue(schedule.time);
		case "weekly":
			return (
				isTimeValue(schedule.time) &&
				Array.isArray(schedule.weekdays) &&
				schedule.weekdays.length > 0 &&
				schedule.weekdays.every((d) => WEEKDAYS.includes(d))
			);
		default:
			return false;
	}
}

/**
 * 回读某个会话当前被钉上的沙箱档位。
 *
 * 两条路，任一成功即可 —— 不想把「事件在不在日志里」赌成单点：
 *   1. 会话日志里的 `sandbox/mode` 事件（`setSandboxMode` 的实现就是追加这一条）。
 *      文档说它是 log-only、不进模型 transcript，但**在日志里**（可 replay）。
 *   2. `ctx.sandboxPolicy.overrideOf(session)` —— dsh 官方给的读法。
 *      它不在 `REQUIRED_SERVICES` 里，所以只能碰运气拿（拿不到就算了）。
 *
 * 两条都读不到返回 undefined，由调用方判失败 —— fail-closed。
 */
function readPinnedMode(scope, agent) {
	const fromLog = lastSandboxMode(agent?.session);
	if (fromLog !== undefined) return fromLog;
	try {
		// 没在 inject 里声明的服务读一下就抛，所以必须包住。
		// `sandboxPolicy` 不在 REQUIRED_SERVICES 里，所以这条路可能是死的 ——
		// 它只是保险，主路径是上面那条事件。
		return scope?.sandboxPolicy?.overrideOf?.(agent.session);
	} catch {
		return undefined;
	}
}

/** 审批策略的回读。主路径同样是事件；服务那条路 `userApproval` 我们自己 inject */
function readPinnedApproval(scope, agent) {
	const fromLog = lastApprovalPolicy(agent?.session);
	if (fromLog !== undefined) return fromLog;
	try {
		return scope?.userApproval?.policyOf?.(agent.session);
	} catch {
		return undefined;
	}
}

/**
 * 读会话日志里最后一条某种事件的某个字段。
 *
 * 两条边界的写入都是「往会话日志追一条事件」（已对着源码核过）：
 *   - `setSandboxMode(session, mode)`  → `session.append("sandbox/mode", { mode })`
 *     `dsh-sandbox-policy/lib/index.js:41`
 *   - `setApprovalPolicy(session, policy)` → `session.append("approval/policy", { policy })`
 *     `dsh-user-approval/lib/index.js:63-65`
 * `append` 是同步的，所以 setter 返回时事件一定已经在日志里，可以立刻回读。
 *
 * 读不到就是读不到（undefined），由调用方判失败 —— fail-closed。
 */
export function lastSessionField(session, eventType, field) {
	try {
		const events = session?.snapshotEvents?.();
		if (!Array.isArray(events)) return undefined;
		for (let i = events.length - 1; i >= 0; i -= 1) {
			if (events[i]?.type === eventType) return events[i]?.data?.[field];
		}
	} catch {
		/* 读不到就是读不到 */
	}
	return undefined;
}

/**
 * 收掉一个 handle，不管它的 `dispose()` 是同步还是异步、抛还是拒。
 *
 * `dispose()` 在 dsh 里返回 Promise，测试假宿主里可能返回 undefined。裸调用
 * （或在它返回的 undefined 后面挂 `.catch`）会在同步返回时直接炸，而逃出去的
 * rejection 会变成 unhandled rejection —— 无人值守的进程最怕的就是这个。
 */
async function disposeHandle(handle) {
	try {
		await handle?.dispose?.();
	} catch {
		/* 收不掉也得继续收尾 */
	}
}

/** 读会话日志里最后一条 `sandbox/mode` 事件里的档位 */
export function lastSandboxMode(session) {
	return lastSessionField(session, "sandbox/mode", "mode");
}

/** 读会话日志里最后一条 `approval/policy` 事件里的策略 */
export function lastApprovalPolicy(session) {
	return lastSessionField(session, "approval/policy", "policy");
}

/**
 * 说清 schedule 到底哪儿不对。
 *
 * 原来只有一句「schedule 不合法（kind 或对应字段缺失/越界）」，面板上把「第几分」
 * 清空时用户看到的就是这句话 —— 指不出是哪个字段，也不知道该填什么。
 * @returns {string|undefined} 有问题的字段说明；没问题返回 undefined
 */
export function explainScheduleProblem(schedule) {
	if (!schedule || typeof schedule !== "object") return "schedule 必须是对象";
	if (!SCHEDULE_KINDS.includes(schedule.kind)) {
		return `schedule.kind 必须是 ${SCHEDULE_KINDS.join(" / ")} 之一，收到 ${JSON.stringify(schedule.kind)}`;
	}
	switch (schedule.kind) {
		case "once":
			if (!isInstant(schedule.at)) return "once 需要 at（ISO 时间戳，且必须是合法时刻）";
			return undefined;
		case "hourly":
			if (!isMinuteValue(schedule.minute)) return "hourly 需要 minute（0-59 的整数）";
			return undefined;
		case "interval":
			if (!isBoundedNumber(schedule.everyMinutes, MAX_EVERY_MINUTES + 1)) {
				return `interval 需要 everyMinutes（1-${MAX_EVERY_MINUTES} 的数字）`;
			}
			if (schedule.anchor !== undefined && schedule.anchor !== null && !isInstant(schedule.anchor)) {
				return "interval 的 anchor 必须是合法的 ISO 时间戳";
			}
			return undefined;
		case "custom":
			if (!isBoundedInteger(schedule.everyDays, MAX_EVERY_DAYS + 1)) {
				return `custom 需要 everyDays（1-${MAX_EVERY_DAYS} 的整数）`;
			}
			if (!isInstant(schedule.anchor)) return "custom 需要 anchor（合法的 ISO 时间戳）";
			if (!isTimeValue(schedule.time)) return 'custom 需要 time（"HH:MM"）';
			return undefined;
		case "daily":
		case "workdays":
			if (!isTimeValue(schedule.time)) return `${schedule.kind} 需要 time（"HH:MM"）`;
			return undefined;
		case "monthly":
			if (!isBoundedInteger(schedule.day, 32)) return "monthly 需要 day（1-31 的整数）";
			if (!isTimeValue(schedule.time)) return 'monthly 需要 time（"HH:MM"）';
			return undefined;
		case "weekly":
			if (!isTimeValue(schedule.time)) return 'weekly 需要 time（"HH:MM"）';
			if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return "weekly 需要 weekdays（至少一天）";
			if (!schedule.weekdays.every((d) => WEEKDAYS.includes(d))) {
				return `weekly 的 weekdays 只能是 ${WEEKDAYS.join(" / ")}`;
			}
			return undefined;
		default:
			return "schedule.kind 不认识";
	}
}

/** 计划描述对象 → 人话（工具输出 + 面板共用） */
export function describeSchedule(schedule) {
	if (!validateSchedule(schedule)) return "（计划无效）";
	const tod = parseTimeOfDay(schedule.time);
	const at = tod === undefined ? "" : ` ${schedule.time}`;
	switch (schedule.kind) {
		case "once":
			return `一次性 ${new Date(schedule.at).toLocaleString("zh-CN")}`;
		case "hourly":
			return `每小时的第 ${schedule.minute} 分`;
		case "interval":
			return schedule.anchor ? `每 ${schedule.everyMinutes} 分钟（锚点 ${schedule.anchor}）` : `每 ${schedule.everyMinutes} 分钟`;
		case "custom":
			return `每 ${schedule.everyDays} 天${at}`;
		case "daily":
			return `每天${at}`;
		case "workdays":
			return `工作日${at}`;
		case "weekly": {
			const names = schedule.weekdays.map((d) => `周${WEEKDAY_LABELS[d] ?? d}`).join("、");
			return `每周 ${names}${at}`;
		}
		case "monthly":
			return `每月 ${schedule.day} 号${at}`;
		default:
			return "（未知计划）";
	}
}

/** 本地时区名，只用于显示 */
export function localTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/* ═══════════════════════════ 4. 存储 ═══════════════════════════ */

/**
 * 一个目录、两条 JSON、一条全局写队列。
 *
 * 为什么全局一条队列而不是每文件一条：任务和执行记录是耦合的（跑完要同时
 * 推进 `nextRunAt` 和追加一条 run），两条队列反而要处理交叉顺序。
 * 单进程单队列够用，代价可以忽略。
 */
export function createStore(dir, { historyLimit = SCHEDULER_DEFAULTS.historyLimit, log = () => {} } = {}) {
	const tasksFile = path.join(dir, "tasks.json");
	const runsFile = path.join(dir, "runs.json");
	let queue = Promise.resolve();

	/** 把坏文件改名留证 —— 否则下一次写入会把它永久清成空数组 */
	function quarantine(file) {
		const backup = `${file}.corrupt-${Date.now()}`;
		try {
			fs.renameSync(file, backup);
			return backup;
		} catch {
			return "(改名也失败了)";
		}
	}

	/**
	 * 读一份 JSON 数组。
	 *
	 * `strict: true` 是**写路径**用的：文件坏了就抛，绝不「按空处理」再整体覆写 ——
	 * 那是静默清库（用户的任务全没了，而且没有任何痕迹）。抛之前先把坏文件改名留证。
	 * 读路径（`readTasks`/`readRuns`）保持降级：面板还能打开，日志里有原始报错。
	 */
	function readFile(file, key, { strict = false } = {}) {
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (err) {
			if (err?.code === "ENOENT") return [];
			if (strict) throw err;
			log(`读取 ${file} 失败，按空处理：${err?.message ?? err}`);
			return [];
		}
		let raw;
		try {
			raw = JSON.parse(text);
		} catch (err) {
			if (strict) {
				const backup = quarantine(file);
				throw new Error(`${file} 不是合法 JSON，已备份到 ${backup}，拒绝在它之上写入：${err?.message ?? err}`);
			}
			log(`读取 ${file} 失败，按空处理：${err?.message ?? err}`);
			return [];
		}
		if (!Array.isArray(raw?.[key])) {
			if (strict) throw new Error(`${file} 里没有 ${key} 数组，拒绝覆盖`);
			return [];
		}
		return raw[key];
	}

	function writeFile(file, key, list) {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, [key]: list }, null, "\t"), "utf8");
		fs.renameSync(tmp, file);
	}

	/** 串行化一次读-改-写。fn 的返回值原样透出。 */
	function serialize(fn) {
		const next = queue.then(fn, fn);
		queue = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	return {
		dir,
		tasksFile,
		runsFile,
		readTasks: () => readFile(tasksFile, "tasks"),
		readRuns: () => readFile(runsFile, "runs"),

		/** 串行地读-改-写任务表 */
		mutateTasks(fn) {
			return serialize(() => {
				const tasks = readFile(tasksFile, "tasks", { strict: true });
				const result = fn(tasks);
				writeFile(tasksFile, "tasks", tasks);
				return result;
			});
		},

		/** 串行地读-改-写执行记录（自动裁剪到 historyLimit，保留最近的） */
		mutateRuns(fn) {
			return serialize(() => {
				let runs = readFile(runsFile, "runs", { strict: true });
				const result = fn(runs);
				if (runs.length > historyLimit) runs = runs.slice(runs.length - historyLimit);
				writeFile(runsFile, "runs", runs);
				return result;
			});
		},
	};
}

/* ═══════════════════════════ 5. 任务 CRUD ═══════════════════════════ */

const TASK_TEXT_MAX = 20_000;

function cleanText(value, { max = TASK_TEXT_MAX } = {}) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 从工具/HTTP 的入参造一条任务记录。校验不过返回 `{ ok:false, error }`。
 * 这是唯一的写入口 —— 工具和路由都走它，免得两处校验漂移。
 */
export function buildTask(input, { now = Date.now(), id = randomUUID() } = {}) {
	const name = cleanText(input?.name, { max: 200 });
	if (name === undefined) return { ok: false, error: "name 不能为空" };
	const prompt = cleanText(input?.prompt);
	if (prompt === undefined) return { ok: false, error: "prompt 不能为空" };
	const schedule = input?.schedule;
	if (!validateSchedule(schedule)) return { ok: false, error: explainScheduleProblem(schedule) ?? "schedule 不合法" };

	const provider = cleanText(input?.provider, { max: 200 });
	const model = cleanText(input?.model, { max: 200 });
	if ((provider === undefined) !== (model === undefined)) return { ok: false, error: "provider 与 model 必须成对给出" };

	let permission = SCHEDULER_DEFAULTS.permission;
	if (input?.permission !== undefined && input?.permission !== null && input?.permission !== "") {
		if (!PERMISSION_PRESETS.includes(input.permission)) {
			return { ok: false, error: `permission 只能是 ${PERMISSION_PRESETS.join(" / ")}` };
		}
		permission = input.permission;
	}

	const task = {
		id,
		name,
		prompt,
		schedule,
		enabled: input?.enabled === undefined ? true : input.enabled === true,
		createdAt: now,
		updatedAt: now,
		lastRunAt: null,
		nextRunAt: nextOccurrence(schedule, now) ?? null,
		// 永远落库：跑的时候直接拿它 setSandboxMode，不能是 undefined
		permission,
	};
	if (input?.workspaceId !== undefined && input?.workspaceId !== null && input?.workspaceId !== "") {
		task.workspaceId = String(input.workspaceId);
	}
	if (provider !== undefined) task.provider = provider;
	if (model !== undefined) task.model = model;
	const effort = cleanText(input?.reasoningEffort, { max: 100 });
	if (effort !== undefined) task.reasoningEffort = effort;
	return { ok: true, task };
}

/** 把一条已有任务按补丁更新（`undefined` 的字段不动）。返回 `{ok,task}` 或 `{ok:false,error}` */
export function applyTaskPatch(task, patch, { now = Date.now() } = {}) {
	const merged = {
		name: patch?.name === undefined ? task.name : patch.name,
		prompt: patch?.prompt === undefined ? task.prompt : patch.prompt,
		schedule: patch?.schedule === undefined ? task.schedule : patch.schedule,
		workspaceId: patch?.workspaceId === undefined ? task.workspaceId : patch.workspaceId,
		permission: patch?.permission === undefined ? task.permission : patch.permission,
		provider: patch?.provider === undefined ? task.provider : patch.provider,
		model: patch?.model === undefined ? task.model : patch.model,
		reasoningEffort: patch?.reasoningEffort === undefined ? task.reasoningEffort : patch.reasoningEffort,
		enabled: patch?.enabled === undefined ? task.enabled : patch.enabled,
	};
	const built = buildTask(merged, { now, id: task.id });
	if (!built.ok) return built;
	const next = { ...built.task, createdAt: task.createdAt, lastRunAt: task.lastRunAt ?? null };
	// 计划没变就别重算 nextRunAt —— 否则「改个名字」会把下次运行时间往后推。
	const scheduleChanged = JSON.stringify(next.schedule) !== JSON.stringify(task.schedule);
	if (!scheduleChanged && typeof task.nextRunAt === "number" && task.nextRunAt > now) {
		next.nextRunAt = task.nextRunAt;
	}
	return { ok: true, task: next };
}

/* ═══════════════════════════ 6. 结果摘要 ═══════════════════════════ */

/**
 * 从会话事件里折出「最后一条非空 assistant 消息」和本轮结束原因。
 *
 * 规则照抄 `@deepseek-ai/dsh-subagent/assistant-output` 的 `AssistantOutputFold`：
 * 非空 assistant 消息成为候选答案；`assistant/message` 与 `assistant/attempt`
 * 里的流式文本累加作为兜底。**用全量快照，不用增量流**（见文件头注释）。
 */
export function summarizeEvents(events) {
	let message;
	const partial = [];
	let turnEnd;
	for (const event of events ?? []) {
		const type = event?.type;
		if (type === "assistant/message") {
			const content = event?.data?.message?.content;
			// 必须是「有可读文本」才当候选：末条 assistant 消息常常只含 tool-call 块，
			// 只判 content.length > 0 的话，它会把前面那条真答案覆盖成空摘要。
			if (Array.isArray(content) && content.some(hasReadableText)) message = content;
		}
		if (type === "assistant/message" || type === "assistant/attempt") {
			const stream = event?.data?.stream;
			if (stream !== undefined && stream !== null) {
				const text = joinStreamText(stream);
				if (text !== "") partial.push(text);
			}
		}
		if (type === "turn/end") turnEnd = event?.data;
	}
	const content = message ?? (partial.length > 0 ? [{ type: "text", text: partial.join("") }] : undefined);
	const text = (content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
	const reason = turnEnd?.reason;
	const reasonKind = typeof reason === "string" ? reason : reason?.kind;
	return { text, reason: reasonKind ?? undefined, hasTurnEnd: turnEnd !== undefined };
}

/** 这一块里有没有模型真说出来的话（纯 tool-call 块不算） */
function hasReadableText(block) {
	return block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "";
}

/** 流式文本块 → 字符串。认字符串本身、`{text}`、以及数组。 */
function joinStreamText(stream) {
	if (typeof stream === "string") return stream;
	if (Array.isArray(stream)) return stream.map(joinStreamText).join("");
	if (stream && typeof stream === "object") {
		if (typeof stream.text === "string") return stream.text;
		if (stream.delta !== undefined) return joinStreamText(stream.delta);
	}
	return "";
}

/** 启动窗口：排队的 followup 被 driver 取走前的等待上限（跟源头同一个值）。 */
export const TURN_START_TIMEOUT_MS = 30_000;
const TURN_START_POLL_MS = 10;
/** `session.seq` 不可观测时的退让等待：够让 driver 起来，又不至于白等一整个窗口。 */
const TURN_START_BLIND_WAIT_MS = 50;

/**
 * 等这一轮**真正开始**（`session.seq` 增长即视为已启动）。
 *
 * 这一步不能省。`whenIdle()` 表示「当前没有 driver」，排队的 followup 被取走之前
 * 它就会立刻兑现 —— 于是 followup 之后直接等空闲会读到**空事件集**，把跑得好好的
 * 任务判成「没产生 turn」。源头 `executor.utils.ts:20` 的 `waitForTurnStart` 就是
 * 为这个存在的。
 *
 * 返回 `false` 只代表「在窗口内没观察到启动」，不代表「一定没启动」。所以
 * `session.seq` 读不到时（宿主结构漂移）**返回 true 而不是 false**：观测不到不等于
 * 没发生，凭观测不到的信号判死正是在制造假失败。那点退让等待只是让 driver 有机会起来。
 */
export async function waitForTurnStart(session, firstSeq, timeoutMs = TURN_START_TIMEOUT_MS) {
	if (typeof session?.seq !== "number") {
		await new Promise((resolve) => setTimeout(resolve, TURN_START_BLIND_WAIT_MS));
		return true;
	}
	const deadlineAt = Date.now() + timeoutMs;
	while (session.seq <= firstSeq) {
		if (Date.now() >= deadlineAt) return false;
		await new Promise((resolve) => setTimeout(resolve, TURN_START_POLL_MS));
	}
	return true;
}

/**
 * 事件摘要 + 是否超时 → 运行结论。
 *
 * 「有没有真的跑起来」由 `started` 单独表达（见 `waitForTurnStart`），**不能靠
 * `turn/end` 缺席来推**：
 *
 *   - `reason === undefined`（快照里压根没有 `turn/end`）算**成功**，跟源头
 *     `decideRunOutcome` 一致。核心在异常收尾（取消 / 中断 / 崩溃修复）时可能不补写
 *     这条事件，与 `agent/status → idle` 的兜底语义一致；拿它判失败会制造假失败。
 *   - 真正要防的是「**拿一个已知的失败当成功**」：所以只有`reason` 明确是
 *     `completed` 以外的东西才判失败，`aborted` 判取消。这里用的是全量快照
 *     （不是增量流），不存在源头那条「增量丢了收尾原因要回退快照」的顾虑。
 */
export function decideRunOutcome(summary, { timedOut = false, cancelled = false, started = true } = {}) {
	if (timedOut) return { status: "failed", error: "运行超时，已取消", summary: summary?.text ?? "" };
	if (cancelled) return { status: "cancelled", error: "运行被取消", summary: summary?.text ?? "" };
	if (started === false) {
		return {
			status: "failed",
			error: `等不到这一轮启动（${TURN_START_TIMEOUT_MS}ms 内 session.seq 没有增长）`,
			summary: summary?.text ?? "",
		};
	}
	if (!summary?.hasTurnEnd) return { status: "succeeded", summary: summary?.text ?? "" };
	if (summary.reason === "completed") return { status: "succeeded", summary: summary.text };
	if (summary.reason === "aborted") return { status: "cancelled", error: "本轮被中断", summary: summary.text };
	return { status: "failed", error: `本轮结束原因：${summary.reason ?? "未知"}`, summary: summary.text };
}

/* ═══════════════════════════ 7. 执行器 ═══════════════════════════ */

/**
 * 在全新会话里跑一段 prompt。
 *
 * 依赖 `scope` 上已注入的：agents / sessions / agentPresets / agentDefaultModel /
 * workspaceRegistry。`ctx.loader` 不声明也能读（它不是 cordis Service，是 app 挂上去的普通属性）。
 */
export function createExecutor({ scope, config, log = () => {}, turnStartTimeoutMs = TURN_START_TIMEOUT_MS }) {
	/** 懒加载的动态模块：`@deepseek-ai/*` 从本包解析不到，只能走 loader（从 profile 解析） */
	let runtime;

	async function modules() {
		if (runtime !== undefined) return runtime;
		const loader = scope.loader;
		if (!loader || typeof loader.import !== "function") throw new Error("ctx.loader 不可用，无法加载 dsh 运行时模块");
		const unwrap = (m) => (typeof loader.unwrapExports === "function" ? (loader.unwrapExports(m) ?? m) : m);
		const [llmRaw, approvalRaw, sandboxRaw] = await Promise.all([
			loader.import("@deepseek-ai/dsh-llm"),
			loader.import("@deepseek-ai/dsh-user-approval"),
			loader.import("@deepseek-ai/dsh-sandbox-policy"),
		]);
		const llm = unwrap(llmRaw);
		const approval = unwrap(approvalRaw);
		const sandbox = unwrap(sandboxRaw);
		const createUserMessage = llm?.createUserMessage;
		const setApprovalPolicy = approval?.setApprovalPolicy;
		const setSandboxMode = sandbox?.setSandboxMode;
		if (typeof createUserMessage !== "function") throw new Error("SCHEDULER_RUNTIME_EXPORT_MISSING: createUserMessage");
		if (typeof setApprovalPolicy !== "function") throw new Error("SCHEDULER_RUNTIME_EXPORT_MISSING: setApprovalPolicy");
		if (typeof setSandboxMode !== "function") throw new Error("SCHEDULER_RUNTIME_EXPORT_MISSING: setSandboxMode");
		runtime = { createUserMessage, setApprovalPolicy, setSandboxMode };
		return runtime;
	}

	/** 任务的工作目录：指定了 workspaceId 就用它，否则兜底到 <DSH_HOME>/<workspaceFallback> */
	async function resolveWorkspace(task) {
		if (task.workspaceId !== undefined) {
			const ws = scope.workspaceRegistry.get(task.workspaceId);
			if (ws === undefined) throw new Error(`工作区不存在：${task.workspaceId}`);
			return { cwd: ws.path, workspace: ws };
		}
		// 兜底目录必须在 <DSH_HOME> 下。`SCHEDULER_FIELDS` 已经拦了绝对路径和 `..`，
		// 这里再核一遍解析后的结果 —— 配置是唯一来源，但「唯一来源」不等于「不必检查」。
		// 两边都 resolve：`dshHome()` 带尾分隔符、或 Windows 上大小写不一致时，
		// 直接拿原始串比 `startsWith(home + sep)` 会把合法配置误判成越界。
		const home = path.resolve(dshHome());
		const dir = path.resolve(home, config.workspaceFallback);
		if (dir !== home && !dir.startsWith(home + path.sep)) {
			throw new Error(`兜底工作目录必须落在 ${home} 下，实际解析成 ${dir}`);
		}
		fs.mkdirSync(dir, { recursive: true });
		return { cwd: dir, workspace: undefined };
	}

	/** 模型选择：任务钉了 provider/model 就用它，否则跟随 agentDefaultModel */
	function resolveSelection(task) {
		if (task.provider !== undefined && task.model !== undefined) {
			const pinned = { provider: task.provider, model: task.model };
			if (task.reasoningEffort !== undefined) pinned.reasoningEffort = task.reasoningEffort;
			return pinned;
		}
		const current = scope.agentDefaultModel?.currentSelection?.();
		if (!current || current.provider === undefined || current.model === undefined) return undefined;
		return { provider: current.provider, model: current.model };
	}

	/**
	 * 跑一次。返回 `{ status, summary, error, sessionId }`。
	 * 自己不抛 —— 调用方（调度器）只关心结论。
	 */
	async function run(task, { runId }) {
		const sessionId = `task-${runId}`;
		// 入库存的时候查过天花板，但**执行时还要再查一遍**：调低 maxPermission 之后
		// 库里那些旧任务、手工改过的 tasks.json、旧版本留下的记录，都还能被
		// run_now / toggle / 定时触发重新跑起来。只在写口拦 = 只拦新增不拦存量。
		const overCeiling = checkPermissionCeiling(task, config.maxPermission);
		if (overCeiling !== undefined) {
			return { status: "failed", error: `任务权限档位超过当前上限，本轮不执行：${overCeiling}`, sessionId };
		}
		const { createUserMessage, setApprovalPolicy, setSandboxMode } = await modules();
		const presetId = config.agentPreset;
		const { cwd, workspace } = await resolveWorkspace(task);
		const selection = resolveSelection(task);

		let handle;
		/** setup 里出的错：`agents.create` 不一定透传 setup 的异常，所以自己留一份 */
		let setupError;
		/**
		 * 沙箱**确实**钉上了。
		 *
		 * 单看 `setupError === undefined` 放行是不够的：宿主漂移让 `agents.create`
		 * 根本不调 `setup`（选项改名、被忽略、被自己的包装吃掉）时，`setupError`
		 * 也还是 `undefined` —— 那就等于在没钉沙箱的会话里发 prompt。
		 * 所以改成**正向确认**：只有真的回读到档位一致才算数。
		 */
		let pinned = false;
		const setup = async (agentCtx, created) => {
			const agent = created ?? agentCtx?.agent;
			// preset 挂不上不致命（可能就是没装 standard），但要说一声
			try {
				await scope.agentPresets.mount(agentCtx, presetId);
			} catch (err) {
				log(`任务 ${task.id} 挂 preset「${presetId}」失败，按默认继续：${err?.message ?? err}`);
			}
			// ① 先钉沙箱档位 —— 这是无人值守唯一的边界，必须在跑之前生效。
			//    用 setSandboxMode 而不是 permissionPresets.set：预设表是部署配置的
			//    （出厂只有 workspace-write / danger-full-access），
			//    set() 遇到表里没有的名字直接抛，而 read-only 恰恰不在出厂表里。
			//    沙箱模式本身是 dsh 的固定三值，与预设表无关。
			//    钉不上就让整轮失败 —— 绝不能「没设成就按默认跑」，
			//    那等于把 danger-full-access 当成 read-only 用。
			//
			//    `agents.create` 会 await setup 并把异常重抛（`dsh-agent-loop/lib/index.js:1889`
			//    的 `await raceAbort(setup?.(...))`，异常经 `initializeAgent` 的 catch
			//    dispose 后由 `setupAndPublish` 重抛），所以正常路径上 setup 抛 = create 拒。
			//    但**不能只依赖那个**：真正要防的是 setter **不抛却不生效**（宿主静默漂移）、
			//    以及 `setup` 压根没被调用。所以每条边界都**写进去再读回来**核对，读对了才
			//    置 `pinned`。`setupError` 只是给失败文案留的备份。
			try {
				// ③ 顺手提高自我繁殖的成本：调度器工具是全局注册的，无人值守会话也看得见。
				//    **注意这不是安全边界** —— `restrict` 只管本会话的工具表，管不到子代理，
				//    更管不到 shell 里的 curl（一个 read-only 会话若有 bash，就能 curl 本机
				//    路由建任务）。真正的边界是服务端的 maxPermission 天花板，见 §6.6 ④。
				//    留着 scheduler_list（只读，模型看一眼「还有什么在排」是有用的）。
				//    `restrict` 只接受**全局**工具名，遇到不存在的名字会抛。
				agentCtx.tools.restrict({ deny: SCHEDULER_SELF_TOOLS });
				// ① 先钉沙箱档位 —— 这是无人值守唯一的边界，必须在跑之前生效。
				setSandboxMode(agent.session, task.permission);
				const appliedMode = readPinnedMode(scope, agent);
				if (appliedMode !== task.permission) {
					throw new Error(
						`沙箱档位回读不一致：应为 ${task.permission}，实际 ${appliedMode ?? "（会话日志里没有 sandbox/mode 事件，宿主 API 可能已漂移）"}`,
					);
				}
				// ② 再强制无人值守审批：never。
				//    必须在 ① 之后 —— 顺序反了会被沙箱档位连带写入的 approval 覆盖回去。
				//    never = 从不问人（没人可问）；能做什么由 ① 的沙箱模式决定。
				//    approval 静默不生效同样是致命的：它会让工具调用**永远卡着**等人点，
				//    而没有人会来点。所以一样回读核对。
				setApprovalPolicy(agent.session, "never");
				const appliedApproval = readPinnedApproval(scope, agent);
				if (appliedApproval !== "never") {
					throw new Error(
						`审批策略回读不一致：应为 never，实际 ${appliedApproval ?? "（会话日志里没有 approval/policy 事件）"}`,
					);
				}
				pinned = true;
			} catch (err) {
				setupError = `准备无人值守会话失败（沙箱档位「${task.permission}」/ 工具限制），本轮不执行：${err?.message ?? err}`;
				throw err;
			}
		};

		try {
			const createOptions = { sessionId, meta: { cwd, agentPreset: presetId }, setup };
			if (selection !== undefined) createOptions.agentOptions = selection;
			handle = await scope.agents.withoutInitiator(() => scope.agents.create(createOptions));
		} catch (err) {
			if (setupError !== undefined) return { status: "failed", error: setupError, sessionId };
			return { status: "failed", error: `创建会话失败：${err?.message ?? err}`, sessionId };
		}
		// 沙箱档位没钉上就不许往下跑：宁可这一轮失败，也不能按会话默认权限
		// （可能是 danger-full-access）无人值守地跑。
		// 判据是**正向**的 `pinned`，不是「没记下错」。
		if (!pinned) {
			const reason = setupError ?? "setup 没有被调用（宿主 API 可能已漂移），沙箱档位未确认";
			// `dispose()` 可能返回 Promise（下面 finally 里就是 await 的），所以这里也
			// 必须 await + catch —— 裸调用会让它的 rejection 逃成 unhandled rejection，
			// 而无人值守的进程最怕的就是这个。
			await disposeHandle(handle);
			return { status: "failed", error: reason, sessionId };
		}
		if (setupError !== undefined) {
			await disposeHandle(handle);
			return { status: "failed", error: setupError, sessionId };
		}

		const agent = handle.agent;
		let timedOut = false;
		let cancelled = false;
		let cancelConverged = true;
		/** 是否真的观察到了这一轮启动。默认 true：观测不到不判死。 */
		let started = true;
		try {
			await agent.whenIdle();

			// 钉标题（纯装饰，失败不管）
			try {
				const titleService = scope.get?.("sessionTitle");
				if (titleService && typeof titleService.rename === "function") {
					await titleService.rename(sessionId, `[定时] ${task.name}`);
				}
			} catch {
				/* 忽略 */
			}
			// 把会话挂到工作区，这样在 GUI 里能找到它
			try {
				await workspace?.attachSession(sessionId);
			} catch {
				/* 忽略 */
			}

			// 记下起点：followup 之后再等 idle 才有意义。`whenIdle()` 说的是
			// 「当前没有 driver」，排队的 followup 被取走前它就会立刻兑现 ——
			// 不等 seq 增长的话会读到空事件集，把跑成功的一轮判成没跑起来。
			const firstSeq = typeof agent.session?.seq === "number" ? agent.session.seq : undefined;

			agent.followup(
				createUserMessage({
					content: [{ type: "text", text: task.prompt }],
					source: { kind: "scheduler", taskId: task.id, runId },
				}),
			);

			// 先等这一轮真的起来，再等它结束。顺序反了就会读到空事件集。
			started = await waitForTurnStart(agent.session, firstSeq ?? 0, turnStartTimeoutMs);
			if (!started) log(`任务 ${task.id} 在 ${TURN_START_TIMEOUT_MS}ms 内没观察到这一轮启动`);

			const timeoutMs = config.runTimeoutMinutes * MINUTE_MS;
			let timer;
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
				timer.unref?.();
			});
			const settled = await Promise.race([agent.whenIdle().then(() => "idle"), deadline]);
			clearTimeout(timer);

			if (settled === "timeout") {
				timedOut = true;
				log(`任务 ${task.id} 超过 ${config.runTimeoutMinutes} 分钟，取消本轮`);
				try {
					agent.cancel({ kind: "hook", reason: "scheduler run timeout" });
				} catch (err) {
					log(`任务 ${task.id} 取消失败：${err?.message ?? err}`);
				}
				// 给收敛留点时间；收不回来也照样往下走（事件里已经能看出没 turn/end）。
				// 但「收不回来」本身要留痕：它是「取消没生效」的独有信号，
				// 混进「运行超时」里就再也查不出来了。
				let cancelTimer;
				const cancelDeadline = new Promise((resolve) => {
					cancelTimer = setTimeout(() => resolve("stuck"), config.cancelTimeoutMs);
					cancelTimer.unref?.();
				});
				const cancelSettled = await Promise.race([
					agent.whenIdle().then(() => "idle"),
					cancelDeadline,
				]);
				clearTimeout(cancelTimer);
				cancelConverged = cancelSettled === "idle";
				if (!cancelConverged) {
					log(`任务 ${task.id} 取消后 ${config.cancelTimeoutMs}ms 未收敛（cancel_convergence_timeout）`);
				}
			}

			// 全量快照：会话是全新的，所有事件都属于本次运行
			const events = agent.session.snapshotEvents();
			const summary = summarizeEvents(events);
			const outcome = decideRunOutcome(summary, { timedOut, cancelled, started });
			if (timedOut && !cancelConverged) {
				return {
					...outcome,
					error: `${outcome.error}；取消后 ${config.cancelTimeoutMs}ms 未收敛（cancel_convergence_timeout）`,
					sessionId,
				};
			}
			return { ...outcome, sessionId };
		} catch (err) {
			cancelled = true;
			const message = err?.message ?? String(err);
			return { status: "failed", error: `运行异常：${message}`, sessionId };
		} finally {
			// flush 把会话落盘，之后 GUI 里才看得到
			try {
				await scope.sessions.flush(agent.session);
			} catch (err) {
				log(`任务 ${task.id} flush 会话失败：${err?.message ?? err}`);
			}
			try {
				await handle.dispose();
			} catch {
				/* 忽略 */
			}
		}
	}

	return { run, resolveWorkspace, resolveSelection };
}

/* ═══════════════════════════ 8. 调度引擎 ═══════════════════════════ */

/**
 * 每秒醒一次，把到期的任务丢给执行器。
 *
 * 语义（跟源头一致）：
 *   - 错过多个周期只补跑一次，没有补偿队列
 *   - 同一任务不并发；全局并发上限 maxConcurrent
 *   - 一次性任务跑完就自动 enabled=false
 */
export function createEngine({ store, executor, config, log = () => {} }) {
	const running = new Set();
	/** 已经就「算不出下一次」告警过的任务 —— tick 每秒一次，不记着会刷屏。 */
	const noNextWarned = new Set();
	let timer;
	let stopped = false;

	/** 推进 nextRunAt / lastRunAt；一次性任务跑完就关掉 */
	async function advance(taskId, { ran = true } = {}) {
		await store.mutateTasks((tasks) => {
			const task = tasks.find((t) => t.id === taskId);
			if (task === undefined) return;
			const now = Date.now();
			if (ran) task.lastRunAt = now;
			task.updatedAt = now;
			if (task.schedule?.kind === "once") {
				task.enabled = false;
				task.nextRunAt = null;
				return;
			}
			task.nextRunAt = nextOccurrence(task.schedule, now) ?? null;
		});
	}

	async function execute(task, trigger) {
		// 整个函数体（含 running.add）都在 try/finally 里：`running.delete` 必须**一定**
		// 执行。否则任一次写盘失败（mutateRuns 抛）都会把任务永久留在 running 集合里 ——
		// 它会一直占着 maxConcurrent 的名额，而且再也不会被 tick 捞起来。
		let outcome = { status: "failed", error: "未执行" };
		try {
			running.add(task.id);
			const runId = randomUUID();
			const startedAt = Date.now();
			await store.mutateRuns((runs) => {
				runs.push({
					id: runId,
					taskId: task.id,
					taskName: task.name,
					trigger,
					status: "running",
					startedAt,
					scheduledFor: task.nextRunAt ?? null,
					// 留 pid：多开 dsh 时「谁在跑」要靠它区分（见 recoverInterruptedRuns）
					pid: process.pid,
				});
			});
			// 先把 nextRunAt 推走，免得下一 tick 又把同一个任务捞起来
			await advance(task.id);

			try {
				outcome = await executor.run(task, { runId });
			} catch (err) {
				outcome = { status: "failed", error: `执行器异常：${err?.message ?? err}` };
			}
			const finishedAt = Date.now();
			await store.mutateRuns((runs) => {
				const record = runs.find((r) => r.id === runId);
				if (record === undefined) return;
				record.status = outcome.status;
				record.finishedAt = finishedAt;
				record.durationMs = finishedAt - startedAt;
				if (outcome.summary) record.summary = String(outcome.summary).slice(0, 4000);
				if (outcome.error) record.error = String(outcome.error).slice(0, 2000);
				if (outcome.sessionId) record.sessionId = outcome.sessionId;
			});
			log(`任务「${task.name}」${outcome.status}${outcome.error ? `：${outcome.error}` : ""}`);
		} catch (err) {
			// 写盘失败等：说出来，但别让异常逃出去把宿主打挂
			log(`任务「${task.name}」记录运行结果失败：${err?.message ?? err}`);
		} finally {
			running.delete(task.id);
		}
	}

	/** 后台起一轮。`void execute()` 必须带 catch —— 未处理的拒绝在 Node 里默认打挂进程。 */
	function fireAndForget(task, trigger) {
		void execute(task, trigger).catch((err) => {
			log(`任务「${task.name}」执行异常：${err?.message ?? err}`);
		});
	}

	/**
	 * 一次 tick。导出是为了测试能手动推。
	 *
	 * 补算 `nextRunAt` 必须在 `mutateTasks` 的**回调里**做：`readTasks()` 每次都是从
	 * 盘上新解析一份数组，在外面改那份数组、再 `mutateTasks(() => {})`，等于把改动
	 * 丢掉、只把盘上原样重写一遍（曾经的 bug：`nextRunAt` 为 null 的任务永不触发，
	 * 而且每秒全量写盘一次）。
	 */
	async function tick() {
		if (stopped) return;
		const now = Date.now();
		let tasks = store.readTasks();

		// 先看有没有要补的 —— 有才进写队列，避免每秒无意义写盘
		if (tasks.some((t) => t.enabled === true && typeof t.nextRunAt !== "number")) {
			// 先只读地算一遍，算得出才进写队列。算不出（once 已过期 / schedule
			// 不合法）的任务**保持 enabled**，跟源头 tick 一致 —— 源头那里
			// `occurrence === undefined` 时什么都不做，既不改 `enabled` 也不写盘。
			//
			// 为什么不顺手停用它：那是一次内部计算去改用户的数据，而且**不说一声**。
			// 算不出下一次不等于这条任务该消失 —— 计划被改坏了、时钟边界，都会走到
			// 这里。用户下次打开面板只看到「已停用」，不知道是谁关的。代价是它会保持
			// 启用却不再触发，所以必须留下信号（下面那句 log）。
			const plan = new Map();
			for (const task of tasks) {
				if (task.enabled !== true) continue;
				if (typeof task.nextRunAt === "number") continue;
				const next = nextOccurrence(task.schedule, now);
				if (next !== undefined) {
					plan.set(task.id, next);
					noNextWarned.delete(task.id);
					continue;
				}
				// 每秒都会走到这里，所以只告警一次，别刷屏
				if (!noNextWarned.has(task.id)) {
					noNextWarned.add(task.id);
					log(`任务「${task.name}」算不出下一次运行时间（计划：${describeSchedule(task.schedule)}）—— 保持启用但不会再触发，请改计划或停用它`);
				}
			}
			if (plan.size > 0) {
				await store.mutateTasks((list) => {
					for (const task of list) {
						const next = plan.get(task.id);
						if (next !== undefined) task.nextRunAt = next;
					}
				});
				tasks = store.readTasks();
			}
		}

		for (const task of tasks) {
			if (running.size >= config.maxConcurrent) break;
			if (task.enabled !== true) continue;
			if (typeof task.nextRunAt !== "number" || task.nextRunAt > now) continue;
			if (running.has(task.id)) continue;
			fireAndForget(task, "schedule");
		}
	}

	return {
		tick,
		running,
		isRunning: (taskId) => running.has(taskId),
		get runningCount() {
			return running.size;
		},
		start() {
			if (timer !== undefined) return;
			stopped = false;
			timer = setInterval(() => {
				void tick().catch((err) => log(`tick 失败：${err?.message ?? err}`));
			}, config.tickMs);
			timer.unref?.();
		},
		stop() {
			stopped = true;
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		},
		/** 手动触发一次（不管 nextRunAt），跑在后台 */
		trigger(taskId) {
			const task = store.readTasks().find((t) => t.id === taskId);
			if (task === undefined) return { ok: false, error: `任务不存在：${taskId}` };
			if (running.has(taskId)) return { ok: false, error: "该任务正在运行" };
			// 手动触发也要受并发上限约束：不然 maxTasks=200 时能同时起 200 个真会话
			if (running.size >= config.maxConcurrent) {
				return { ok: false, error: `并发已达上限 ${config.maxConcurrent}，等一会儿再试` };
			}
			fireAndForget(task, "manual");
			return { ok: true };
		},
	};
}

/** 把上次没跑完的 running 记录标成 interrupted（进程被杀留下的） */
/** 这个 pid 还活着吗。`kill(pid, 0)` 只做存在性/权限检查，不发信号。 */
function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = 进程存在但不属于我 —— 那也是活着
		return err?.code === "EPERM";
	}
}

/**
 * 把上次没跑完的 `running` 记录标成 interrupted。
 *
 * 必须区分「谁留下的」：多开 dsh 时另一个进程正在跑的任务，记录同样是 `running`，
 * 无差别全改会把人家那一轮历史污染成「被中断」。
 * 只动两种：本进程留下的（重启前的自己），和 pid 已经不在的。
 */
export function recoverInterruptedRuns(store, { pid = process.pid, staleAfterMs = DEFAULT_STALE_RUN_MS, now = Date.now() } = {}) {
	return store.mutateRuns((runs) => {
		let count = 0;
		for (const run of runs) {
			if (run.status !== "running") continue;
			const owner = run.pid;
			const ours = owner === pid || owner === undefined;
			// pid 会被复用：另一个 dsh 崩在任务里、它的 pid 后来被系统分给了别人，
			// `isProcessAlive` 就永远返回 true，那条记录永远留在 running。
			// 所以加一条时间兜底 —— 超过单次运行上限的很多倍还没结束的，无论 pid
			// 活不活都算中断。宁可错标一条长生不死的记录，也不能让它烂在库里。
			// 阈值取 `max(12h, runTimeoutMinutes × 2)`：`runTimeoutMinutes` 没有上界，
			// 固定 12 小时的话，一个配成 24 小时上限的任务会被自己的恢复逻辑误标。
			const stale = typeof run.startedAt === "number" && now - run.startedAt > staleAfterMs;
			if (!ours && !stale && isProcessAlive(owner)) continue;
			run.status = "interrupted";
			run.finishedAt = Date.now();
			run.error = "host_interrupted";
			count += 1;
		}
		return count;
	});
}

/**
 * 建任务并落盘。**上限检查放在写队列里**：先读再判再写的话，两个并发请求
 * 会同时通过检查。每个任务到点都会起一个真会话，无上限 = 无界建会话。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function insertTask(store, task, { maxTasks, maxPermission }) {
	const over = checkPermissionCeiling(task, maxPermission);
	if (over !== undefined) return { ok: false, error: over };
	let error;
	await store.mutateTasks((tasks) => {
		if (Number.isFinite(maxTasks) && tasks.length >= maxTasks) {
			error = `任务数已达上限 ${maxTasks}，先删掉一些再建`;
			return;
		}
		tasks.push(task);
	});
	return error === undefined ? { ok: true } : { ok: false, error };
}

/* ═══════════════════════════ 9. 工具 ═══════════════════════════ */

const NULLABLE_TEXT = { oneOf: [{ type: "string" }, { type: "null" }] };

/** 无人值守会话里要禁掉的调度器工具（见 executor 的 setup） */
const SCHEDULER_SELF_TOOLS = ["scheduler_create", "scheduler_update", "scheduler_delete"];

const SCHEDULE_PARAMETERS = {
	type: "object",
	description: "计划描述：once/hourly/daily/interval/workdays/weekly/monthly/custom。",
	properties: {
		kind: { type: "string", enum: [...SCHEDULE_KINDS], description: "计划类型" },
		time: { type: "string", description: '"HH:MM"，daily/workdays/weekly/monthly/custom 用' },
		everyMinutes: { type: "number", description: "kind=interval 时的间隔分钟数" },
		everyDays: { type: "number", description: "kind=custom 时的间隔天数" },
		anchor: { type: "string", description: "ISO 锚点，interval/custom 用它对齐" },
		at: { type: "string", description: "ISO 时间戳，kind=once 用" },
		minute: { type: "number", description: "kind=hourly 时的第几分（0-59）" },
		day: { type: "number", description: "kind=monthly 时的几号（1-31）" },
		weekdays: { type: "array", items: { type: "string", enum: [...WEEKDAYS] }, description: 'kind=weekly 时用，如 ["MO","TU"]' },
	},
	required: ["kind"],
	additionalProperties: false,
};

const text = (t) => [{ type: "text", text: t }];

/** 注册 4 个调度器工具。返回注册器数组（dispose 用）。 */
export function registerSchedulerTools(scope, { engine, store, config = SCHEDULER_DEFAULTS, log = () => {} }) {
	const disposers = [];

	disposers.push(
		scope.tools.register({
			name: "scheduler_create",
			description:
				"创建一个定时任务：到点在**全新会话**里自动跑一段 prompt。用户说「每天/每周/工作日/每隔多久自动做某事」时用（例如「每个工作日早上 9 点写日报」）。" +
				"计划类型：once（一次性）/ hourly（每小时第几分）/ daily（每天 HH:MM）/ interval（每 N 分钟）/ workdays（工作日）/ weekly（每周某几天）/ monthly（每月几号）/ custom（每 N 天的某个时刻）。",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "任务名，如「写日报」" },
					prompt: { type: "string", description: "到点在会话里执行的指令全文" },
					schedule: SCHEDULE_PARAMETERS,
					workspaceId: { type: "string", description: "可选，目标工作区 id（决定 cwd）" },
					permission: { type: "string", enum: [...PERMISSION_PRESETS], description: "可选，权限档位，默认 read-only" },
					provider: { type: "string", description: "可选，钉死的模型 provider（与 model 成对）" },
					model: { type: "string", description: "可选，钉死的模型 id（与 provider 成对）" },
					reasoningEffort: { type: "string", description: "可选，钉死的推理档位" },
				},
				required: ["name", "prompt", "schedule"],
				additionalProperties: false,
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { type: "boolean" }, taskId: { type: "string" }, nextRunAt: NULLABLE_TEXT, error: { type: "string" } },
				},
				render: (_args, value) => {
					if (!value.ok) return text(`❌ 创建定时任务失败：${value.error}`);
					const next = value.nextRunAt ? new Date(value.nextRunAt).toLocaleString("zh-CN") : "（无）";
					return text(`✅ 定时任务已创建：${value.taskId}\n下次运行：${next}`);
				},
			},
			async execute(args) {
				const built = buildTask(args);
				if (!built.ok) return { ok: false, error: built.error };
				const inserted = await insertTask(store, built.task, { maxTasks: config.maxTasks, maxPermission: config.maxPermission });
				if (!inserted.ok) return { ok: false, error: inserted.error };
				log(`已创建任务「${built.task.name}」（${built.task.id}）`);
				return { ok: true, taskId: built.task.id, nextRunAt: built.task.nextRunAt };
			},
		}),
	);

	disposers.push(
		scope.tools.register({
			name: "scheduler_list",
			description: "列出所有定时任务：名称、计划、下次运行时间、上次运行时间、是否启用。想知道「现在有哪些定时任务」时用。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			output: {
				schema: { type: "object", additionalProperties: false, properties: { report: { type: "string" } } },
				render: (_args, value) => text(value.report),
			},
			async execute() {
				const tasks = store.readTasks();
				if (tasks.length === 0) return { report: "当前没有任何定时任务。" };
				const lines = tasks.map((t) => {
					const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("zh-CN") : "（无）";
					const last = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString("zh-CN") : "从未";
					const flag = t.enabled === true ? "启用" : "停用";
					const running = engine.isRunning(t.id) ? "（正在运行）" : "";
					return `- ${t.name} [${flag}]${running}\n  id: ${t.id}\n  计划: ${describeSchedule(t.schedule)}\n  下次: ${next}　上次: ${last}`;
				});
				return { report: `共 ${tasks.length} 个定时任务：\n${lines.join("\n")}` };
			},
		}),
	);

	disposers.push(
		scope.tools.register({
			name: "scheduler_update",
			description:
				"修改一个定时任务（只传要改的字段）。传 enabled=false 可以停用。加 run_now=true 会在改完之后立刻跑一次。",
			parameters: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "任务 id" },
					name: { type: "string" },
					prompt: { type: "string" },
					schedule: SCHEDULE_PARAMETERS,
					enabled: { type: "boolean" },
					workspaceId: { type: "string" },
					permission: { type: "string", enum: [...PERMISSION_PRESETS] },
					provider: { type: "string" },
					model: { type: "string" },
					reasoningEffort: { type: "string" },
					run_now: { type: "boolean", description: "true = 改完之后立刻跑一次（只影响本次触发，不改下次运行时间；可以只传它）" },
				},
				required: ["task_id"],
				additionalProperties: false,
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { type: "boolean" }, taskId: { type: "string" }, nextRunAt: NULLABLE_TEXT, ran: { type: "boolean" }, updated: { type: "boolean" }, error: { type: "string" } },
				},
				render: (_args, value) => {
					if (!value.ok) return text(`❌ 更新失败：${value.error}`);
					const next = value.nextRunAt ? new Date(value.nextRunAt).toLocaleString("zh-CN") : "（无）";
					if (value.updated === true && value.ran === true) return text(`✅ 已更新并立刻触发「${value.taskId}」（后台跑）。\n下次运行：${next}`);
					if (value.ran === true) return text(`✅ 已触发「${value.taskId}」立刻运行一次（后台跑）。`);
					return text(`✅ 已更新：${value.taskId}\n下次运行：${next}`);
				},
			},
			async execute(args) {
				const taskId = String(args?.task_id ?? "");
				if (taskId === "") return { ok: false, error: "task_id 不能为空" };
				const existing = store.readTasks().find((t) => t.id === taskId);
				if (existing === undefined) return { ok: false, error: `任务不存在：${taskId}` };

				const patch = {};
				for (const key of [
					"name",
					"prompt",
					"schedule",
					"enabled",
					"workspaceId",
					"permission",
					"provider",
					"model",
					"reasoningEffort",
				]) {
					if (args?.[key] !== undefined) patch[key] = args[key];
				}
				// 只传 run_now 是合法的（「立刻跑一次，别的都不改」）；但和别的字段一起传时
				// **补丁必须先落地**。早先这里在 run_now 分支直接 trigger + return，
				// `{task_id, prompt, run_now:true}` 的 prompt 会被静默丢掉、跑的还是旧指令，
				// 而工具回的是 ✅ —— 用户以为改了。
				const hasPatch = Object.keys(patch).length > 0;
				if (!hasPatch && args?.run_now !== true) return { ok: false, error: "没有要改的字段" };

				let updated = existing;
				if (hasPatch) {
					const patched = applyTaskPatch(existing, patch);
					if (!patched.ok) return { ok: false, error: patched.error };
					// 改也不能越过天花板：否则「建的时候拦住、改的时候放开」等于没拦
					const over = checkPermissionCeiling(patched.task, config.maxPermission);
					if (over !== undefined) return { ok: false, error: over };
					await store.mutateTasks((tasks) => {
						const index = tasks.findIndex((t) => t.id === taskId);
						if (index >= 0) tasks[index] = patched.task;
					});
					updated = patched.task;
				}

				if (args?.run_now !== true) return { ok: true, taskId, updated: hasPatch, nextRunAt: updated.nextRunAt };
				const triggered = engine.trigger(taskId);
				// 补丁已经写盘了，这里不能报成「更新失败」—— 说清楚是「存了但没跑起来」，
				// 否则用户会重试，重试要么重复改要么以为没生效。
				if (!triggered.ok) return { ok: false, error: `更新已保存，但立即运行失败：${triggered.error}` };
				return { ok: true, taskId, updated: hasPatch, ran: true, nextRunAt: updated.nextRunAt ?? null };
			},
		}),
	);

	disposers.push(
		scope.tools.register({
			name: "scheduler_delete",
			description: "删除一个定时任务。**不会**删它的运行历史（历史留在面板里可查）。",
			parameters: {
				type: "object",
				properties: { task_id: { type: "string", description: "任务 id" } },
				required: ["task_id"],
				additionalProperties: false,
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, error: { type: "string" } } },
				render: (_args, value) => (value.ok ? text("✅ 已删除该定时任务（运行历史保留）。") : text(`❌ 删除失败：${value.error}`)),
			},
			async execute(args) {
				const taskId = String(args?.task_id ?? "");
				if (taskId === "") return { ok: false, error: "task_id 不能为空" };
				let found = false;
				await store.mutateTasks((tasks) => {
					const index = tasks.findIndex((t) => t.id === taskId);
					if (index >= 0) {
						tasks.splice(index, 1);
						found = true;
					}
				});
				if (!found) return { ok: false, error: `任务不存在：${taskId}` };
				return { ok: true };
			},
		}),
	);

	return disposers;
}

/* ═══════════════════════════ 10. HTTP 路由 ═══════════════════════════ */

const ROUTE_PREFIX = "/api/team/scheduler";

/**
 * 请求信任栅栏。**dsh 的 web server 自己不鉴权**（`dsh-host-webserver` 直接
 * `listen`，全包没有 Authorization / CSRF），所以挂上去的路由默认对「本机任何
 * 进程 + 用户浏览器里的任何页面」都是开的。
 *
 * 不设这道栅栏的话，最坏情况是：用户打开一个恶意网页，那个页面用
 * `fetch(url, {mode:'no-cors', headers:{'content-type':'text/plain'}, body:...})`
 * 就能 POST 建任务 —— `text/plain` 不触发预检，而 body 照样能解析成 JSON。
 * 更糟的是 DNS rebinding：攻击者把域名解析到 127.0.0.1，就能**读走**全部任务
 * 的 prompt 与运行历史。
 *
 * 判据照抄本机同 profile 的第三方插件 `@linxin666/dsh-client-ui-git-graph`
 * （`lib/index.js:1315-1333`）—— 它已经在生产里跑着同一套：
 *   1. socket 的 remoteAddress 必须是回环（这一条是权威，不看 X-Forwarded-For）
 *   2. Host 头必须也是回环（挡 DNS rebinding）
 *   3. `sec-fetch-site: cross-site` 直接拒（挡跨站发起的请求）
 *   4. 有 Origin 时它必须与 Host 同源
 *
 * 只放行回环，不接 paired-device 那条路：本包的调度器面板只在 web profile 用，
 * 就是本机 127.0.0.1 上的那个 GUI。
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
	const parts = normalized.split(".");
	if (parts.length !== 4) return false;
	return parts[0] === "127";
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isLoopbackAddress(hostname);
}

/** @returns {boolean} 这个请求能不能进调度器的路由 */
export function isTrustedRequest(req) {
	if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
	const host = req?.headers?.host;
	if (typeof host !== "string" || host === "") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

/** 输入不合法（回 400）。其它异常一律 500 —— 别把内部故障说成用户的错 */
class BadRequest extends Error {}

function readJsonBody(req, res, { limit = 1024 * 1024 } = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
	let overLimit = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				fail(new BadRequest("请求体过大"));
				// 不能在这里 `req.destroy()`：socket 一没，外层 catch 里那个 400 还没
				// 发出去就丢了，客户端只看到 ECONNRESET，不知道是自己超限。
				// 排空剩下的（不再累积）让响应能正常写回去；但排空本身无上限，
				// 本地进程可以一直灌数据占住连接。响应写完就把连接断掉。
				// 这两件事**只做一次**：`settled` 挡的是重复 reject，挡不住重复注册 ——
				// 每个后续 chunk 都重注册一次 `res.once("finish")` 的话，长流会堆出
				// 成百上千个监听器（还会触发 MaxListenersExceededWarning）。
				if (!overLimit) {
					overLimit = true;
					req.resume();
					res?.once?.("finish", () => {
						try {
							req.destroy();
						} catch {
							/* 忽略 */
						}
					});
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (raw === "") return resolve({});
			try {
				const parsed = JSON.parse(raw);
				resolve(parsed && typeof parsed === "object" ? parsed : {});
			} catch {
				fail(new BadRequest("请求体不是合法 JSON"));
			}
		});
		req.on("error", fail);
		// 客户端中途断连：没有 close/aborted 的话这个 promise 永不 settle，
		// handler 就一直挂在那里（每次断连漏一个）
		req.on("close", () => fail(new BadRequest("连接已关闭")));
		req.on("aborted", () => fail(new BadRequest("连接已中断")));
	});
}

/** 注册 `/api/team/scheduler` 下的全部路由。返回 disposer。 */
export function registerSchedulerRoutes(scope, { engine, store, config, log = () => {} }) {
	const listOptions = () => {
		let workspaces = [];
		try {
			workspaces = scope.workspaceRegistry.list().map((ws) => ({ id: ws.id, path: ws.path, title: ws.title }));
		} catch (err) {
			log(`列工作区失败：${err?.message ?? err}`);
		}
		const current = scope.agentDefaultModel?.currentSelection?.();
		return {
			ok: true,
			workspaces,
			// 只给到天花板为止 —— 面板上就不该出现一个选了必然被拒的档位。
			// 用 checkPermissionCeiling 而不是自己比 rank：天花板非法时那个函数会
			// 收紧到默认值，这里自己比就会列出服务端一定会拒的档位。
			permissions: PERMISSION_PRESETS.filter((p) => checkPermissionCeiling({ permission: p }, config.maxPermission) === undefined),
			maxPermission: config.maxPermission,
			scheduleKinds: [...SCHEDULE_KINDS],
			weekdays: [...WEEKDAYS],
			timeZone: localTimeZone(),
			maxConcurrent: config.maxConcurrent,
			runningCount: engine.runningCount,
			defaultModel: current ? { provider: current.provider, model: current.model } : null,
		};
	};

	const handler = async (req, res) => {
		// 栅栏必须在最前面：包括 /options 探活 —— 别让探测本身变成信息泄露。
		// 客户端探活拿到 403 也照样不注册面板，行为与「没启用」一致。
		if (!isTrustedRequest(req)) {
			log(`拒绝非本机来源的调度器请求：${req?.socket?.remoteAddress ?? "?"}`);
			return sendJson(res, 403, { ok: false, error: "只接受本机请求" });
		}
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			const sub = url.pathname.slice(ROUTE_PREFIX.length) || "/";
			const method = (req.method ?? "GET").toUpperCase();

			if (sub === "/tasks" && method === "GET") {
				const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
				let tasks = store.readTasks();
				if (search !== "") {
					tasks = tasks.filter((t) => `${t.name} ${t.prompt}`.toLowerCase().includes(search));
				}
				const decorated = tasks.map((t) => ({ ...t, scheduleText: describeSchedule(t.schedule), running: engine.isRunning(t.id) }));
				return sendJson(res, 200, { ok: true, tasks: decorated });
			}

			if (sub === "/tasks" && method === "POST") {
				const body = await readJsonBody(req, res);
				const built = buildTask(body);
				if (!built.ok) return sendJson(res, 400, { ok: false, error: built.error });
				const inserted = await insertTask(store, built.task, { maxTasks: config.maxTasks, maxPermission: config.maxPermission });
				if (!inserted.ok) return sendJson(res, 409, { ok: false, error: inserted.error });
				return sendJson(res, 200, { ok: true, task: { ...built.task, scheduleText: describeSchedule(built.task.schedule) } });
			}

			if (sub === "/tasks" && method === "PUT") {
				const body = await readJsonBody(req, res);
				const taskId = String(body?.id ?? "");
				if (taskId === "") return sendJson(res, 400, { ok: false, error: "缺 id" });
				const existing = store.readTasks().find((t) => t.id === taskId);
				if (existing === undefined) return sendJson(res, 404, { ok: false, error: `任务不存在：${taskId}` });
				const patched = applyTaskPatch(existing, body);
				if (!patched.ok) return sendJson(res, 400, { ok: false, error: patched.error });
				// 改也不能越过天花板：否则「建的时候拦住、改的时候放开」等于没拦
				const over = checkPermissionCeiling(patched.task, config.maxPermission);
				if (over !== undefined) return sendJson(res, 409, { ok: false, error: over });
				await store.mutateTasks((tasks) => {
					const index = tasks.findIndex((t) => t.id === taskId);
					if (index >= 0) tasks[index] = patched.task;
				});
				return sendJson(res, 200, { ok: true, task: { ...patched.task, scheduleText: describeSchedule(patched.task.schedule) } });
			}

			if (sub === "/tasks" && method === "DELETE") {
				const body = await readJsonBody(req, res);
				const taskId = String(body?.id ?? url.searchParams.get("id") ?? "");
				if (taskId === "") return sendJson(res, 400, { ok: false, error: "缺 id" });
				let found = false;
				await store.mutateTasks((tasks) => {
					const index = tasks.findIndex((t) => t.id === taskId);
					if (index >= 0) {
						tasks.splice(index, 1);
						found = true;
					}
				});
				if (!found) return sendJson(res, 404, { ok: false, error: `任务不存在：${taskId}` });
				return sendJson(res, 200, { ok: true });
			}

			if (sub === "/tasks/toggle" && method === "POST") {
				const body = await readJsonBody(req, res);
				const taskId = String(body?.id ?? "");
				if (taskId === "") return sendJson(res, 400, { ok: false, error: "缺 id" });
				let updated;
				await store.mutateTasks((tasks) => {
					const task = tasks.find((t) => t.id === taskId);
					if (task === undefined) return;
					task.enabled = task.enabled !== true;
					task.updatedAt = Date.now();
					if (task.enabled === true && typeof task.nextRunAt !== "number") {
						task.nextRunAt = nextOccurrence(task.schedule, Date.now()) ?? null;
					}
					updated = task;
				});
				if (updated === undefined) return sendJson(res, 404, { ok: false, error: `任务不存在：${taskId}` });
				return sendJson(res, 200, { ok: true, task: { ...updated, scheduleText: describeSchedule(updated.schedule) } });
			}

			if (sub === "/tasks/run" && method === "POST") {
				const body = await readJsonBody(req, res);
				const taskId = String(body?.id ?? "");
				if (taskId === "") return sendJson(res, 400, { ok: false, error: "缺 id" });
				const triggered = engine.trigger(taskId);
				if (!triggered.ok) {
					const status = triggered.error?.startsWith("任务不存在") ? 404 : 409;
					return sendJson(res, status, triggered);
				}
				return sendJson(res, 200, { ok: true });
			}

			if (sub === "/history" && method === "GET") {
				const taskId = url.searchParams.get("taskId");
				let runs = store.readRuns();
				if (taskId !== null && taskId !== "") runs = runs.filter((r) => r.taskId === taskId);
				const recent = [];
				for (let i = runs.length - 1; i >= 0 && recent.length < 200; i -= 1) recent.push(runs[i]);
				runs = recent;
				return sendJson(res, 200, { ok: true, runs });
			}

			if (sub === "/history" && method === "DELETE") {
				const body = await readJsonBody(req, res);
				const runId = String(body?.id ?? url.searchParams.get("id") ?? "");
				if (runId === "") return sendJson(res, 400, { ok: false, error: "缺 id" });
				await store.mutateRuns((runs) => {
					const index = runs.findIndex((r) => r.id === runId);
					if (index >= 0) runs.splice(index, 1);
				});
				return sendJson(res, 200, { ok: true });
			}

			if (sub === "/options" && method === "GET") {
				return sendJson(res, 200, listOptions());
			}

			if (sub === "/runs/recover" && method === "POST") {
				const count = await recoverInterruptedRuns(store, { staleAfterMs: staleRunMs(config) });
				return sendJson(res, 200, { ok: true, recovered: count });
			}

			return sendJson(res, 404, { ok: false, error: `未知路由：${method} ${sub}` });
		} catch (err) {
			// 只有输入不合法才是 400；写盘失败之类的内部故障必须回 500 ——
			// 全回 400 会让「存储坏了」看起来像「你参数填错了」，排查方向直接跑偏。
			const bad = err instanceof BadRequest;
			if (!bad) log(`路由处理失败：${err?.stack ?? err?.message ?? err}`);
			return sendJson(res, bad ? 400 : 500, { ok: false, error: err?.message ?? String(err) });
		}
	};

	return scope.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler });
}

/* ═══════════════════════════ 11. 装配 ═══════════════════════════ */

/** 调度器依赖的宿主服务。缺任何一个都只是调度器不激活，不影响本包其余模块。 */
const REQUIRED_SERVICES = ["tools", "agents", "sessions", "agentPresets", "agentDefaultModel", "workspaceRegistry"];

/**
 * 装调度器。
 *
 * 返回的对象是**活**的：`status` 会在异步激活后更新，`describe()` 读的就是它。
 * 之所以异步：`ctx.inject` 要等依赖服务齐了才回调。
 *
 * `enabled !== true` 时**立刻返回，什么都不注册** —— 这是「可选安装」的落点（REQ-007 §6.4）。
 */
export function installScheduler(ctx, { config } = {}) {
	const cfg = { ...SCHEDULER_DEFAULTS };
	if (config !== undefined && config !== null) Object.assign(cfg, config);
	const state = { status: "已关闭", activated: false, tools: 0, routes: 0 };

	// store 在开关判断**之前**建：建对象不碰磁盘，而关着的时候
	// `/team-scheduler` 命令照样要能读历史（关了不等于历史消失）。
	const store = createStore(path.join(dshHome(), "team-workflow", "scheduler"), { historyLimit: cfg.historyLimit });

	if (cfg.enabled !== true) {
		return {
			enabled: false,
			config: cfg,
			store,
			reason: "team/extensions/scheduler.json 的 enabled=false（默认）",
			get status() {
				return "已关闭";
			},
			describe: () => "已关闭（默认；用 dsh-team scheduler enable 开启）",
			dispose() {},
		};
	}

	const disposers = [];
	const log = (m) => ctx.logger?.info?.(`[team:scheduler] ${m}`);

	ctx.inject(REQUIRED_SERVICES, (scope) => {
		state.status = "已启用";
		state.activated = true;
		const executor = createExecutor({ scope, config: cfg, log, turnStartTimeoutMs: cfg.turnStartTimeoutMs ?? TURN_START_TIMEOUT_MS });
		const engine = createEngine({ store, executor, config: cfg, log });

		const toolDisposers = registerSchedulerTools(scope, { engine, store, config: cfg, log });
		for (const dispose of toolDisposers) disposers.push(dispose);
		state.tools = toolDisposers.length;

		// webServer 只在 web profile 有（dsh-web-app），headless 下静默跳过 —— 面板没有，工具照常
		scope.inject(["webServer"], (webScope) => {
			disposers.push(registerSchedulerRoutes(webScope, { engine, store, config: cfg, log }));
			state.routes = 1;
			log(`HTTP 路由已挂载：${ROUTE_PREFIX}`);
		});

		// 先恢复上次没跑完的记录，再起循环
		ctx.effect(
			() => {
				void recoverInterruptedRuns(store, { staleAfterMs: staleRunMs(cfg) })
					.then((count) => {
						if (count > 0) log(`把 ${count} 条上次未完成的运行标为 interrupted`);
					})
					.catch((err) => log(`恢复中断记录失败：${err?.message ?? err}`));
			},
			"team:scheduler-recover",
		);
		ctx.effect(() => {
			engine.start();
			return () => engine.stop();
		}, "team:scheduler-tick");

		log(`已启动：每 ${cfg.tickMs}ms 一跳，并发上限 ${cfg.maxConcurrent}，存储 ${store.dir}`);
	});

	return {
		enabled: true,
		config: cfg,
		store,
		get status() {
			// 开了开关但依赖不齐时，`ctx.inject` 的回调根本不会跑。
			// 那时报「已关闭」是误导 —— 配置文件明明是开的，人排查时会被带偏。
			return state.activated ? state.status : "未激活";
		},
		get tools() {
			return state.tools;
		},
		get routes() {
			return state.routes;
		},
		describe() {
			if (!state.activated) {
				return `已开启但**未激活**：缺少依赖服务，需要 ${REQUIRED_SERVICES.join(", ")}`;
			}
			const routes = state.routes > 0 ? "已挂" : "未挂";
			return `${state.status}（工具 ${state.tools} 个，路由 ${routes}，存储 ${store.dir}）`;
		},
		dispose() {
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {
					/* 忽略 */
				}
			}
		},
	};
}
