/**
 * 小队的落盘（REQ-015 §6.2）。
 *
 * ── 为什么按「工作目录」分文件，而不是按会话 id ──────────────────────────────
 * 会话 id 每次 dsh 重启都会变。要「重启后还能捡起来」，键就必须是**跨重启稳定**的东西 ——
 * 那是工作目录（cwd）。所以：一个 cwd 一份文件，读回来时由**当前会话接管**（`owner` 改写、
 * `adoptedFrom` 留个记录），接管之后授权规则一个字都不用改（仍是「所有者才能写」）。
 *
 * ── 写法照抄 lib/scheduler.js 的 createStore ──────────────────────────────
 * 整体重写（tmp + rename）、串行 mutate、坏文件 quarantine 而不是抛错。差别只有两处：
 *  1. 一域**多文件**（每个 cwd 一份），所以每个 cwd 各有一条写队列；
 *  2. 写有 **750ms 防抖** —— 黑板与转录写得频繁，成员在跑时每秒都可能变，不防抖会反复
 *     重写几 MB。防抖期间的状态在内存里，`flush()`（dispose / 会话销毁）保证落盘。
 *
 * ── 落盘会裁剪（这是刻意的） ───────────────────────────────────────────────
 * 内存里转录是 200 条 × 8000 字符（`TRANSCRIPT_LIMIT` / `TRANSCRIPT_TEXT_MAX`），
 * 落盘压到 100 条 × 1000 字符：重启后能看到摘要级转录，不是完整原文。运行时字段
 * （`running` / `promise` / `inbox` / `history`）一律不落盘。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const SQUAD_STORE_VERSION = 1;

/** 落盘时每个成员留多少条转录 / 单条多少字符。 */
export const PERSIST_TRANSCRIPT_LIMIT = 100;
export const PERSIST_TRANSCRIPT_TEXT_MAX = 1000;

/** 防抖窗口（毫秒）。 */
export const SAVE_DEBOUNCE_MS = 750;

/**
 * cwd → 文件名。纯函数（可单测）。
 *
 * 人可读的目录名 + 8 位 hash：只有 hash 的话找文件要算，只有名字的话两个不同路径
 * （`/a/b` 与 `/a-b`）会撞。空 cwd 归到 `unknown`。
 */
export function workspaceKey(cwd) {
	const raw = typeof cwd === "string" ? cwd.trim() : "";
	if (raw === "") return "unknown";
	const base = (path.basename(raw).replace(/[^A-Za-z0-9._-]+/g, "-") || "ws").slice(0, 40);
	const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
	return `${base}-${hash}`;
}

/** 转录落盘前的压缩（纯函数）。 */
export function compactTranscript(transcript) {
	if (!Array.isArray(transcript)) return [];
	return transcript.slice(-PERSIST_TRANSCRIPT_LIMIT).map((event) => {
		const text = typeof event?.text === "string" && event.text.length > PERSIST_TRANSCRIPT_TEXT_MAX
			? `${event.text.slice(0, PERSIST_TRANSCRIPT_TEXT_MAX)}…（落盘截断）`
			: event?.text;
		return { ...event, text };
	});
}

/** 小队 → 可落盘的对象（纯函数）。运行时字段全部剔除。 */
export function compactSquad(squad) {
	return {
		name: squad.name,
		objective: squad.objective,
		note: squad.note ?? null,
		owner: squad.owner ?? null,
		adoptedFrom: squad.adoptedFrom ?? null,
		cwd: squad.cwd ?? null,
		createdAt: squad.createdAt ?? null,
		closed: squad.closed ? { at: squad.closed.at, reason: squad.closed.reason ?? null } : null,
		board: (squad.board ?? []).map((e) => ({ at: e.at, from: e.from, text: e.text })),
		members: [...(squad.members?.values?.() ?? [])].map((m) => ({
			label: m.label,
			role: m.role,
			task: m.task,
			worktree: m.worktree ?? null,
			status: m.status,
			note: m.note ?? null,
			// REQ-016 D3：档位要跨重启活着（续聊沿用）
			model: typeof m.model === "string" ? m.model : null,
			provider: typeof m.provider === "string" ? m.provider : null,
			updatedAt: m.updatedAt ?? null,
			usage: m.usage ?? null,
			attempts: m.attempts ?? 0,
			startedAt: m.startedAt ?? null,
			endedAt: m.endedAt ?? null,
			durationMs: m.durationMs ?? 0,
			transcript: compactTranscript(m.transcript),
		})),
	};
}

/**
 * 落盘对象 → 运行时小队（纯函数）。
 *
 * 缺字段一律补默认值：文件可能是旧版本写的、也可能被人手改过。**不认识的 version
 * 由调用方负责 quarantine**，这里只管形状。
 */
export function reviveSquad(record, { statuses } = {}) {
	// 允许的状态由调用方给（`squad.js` 传 `MEMBER_STATUS`，避免这里再抄一份）。
	// 不给就不校验 —— 但 `squad.js` 一定给。
	const allowed = Array.isArray(statuses) && statuses.length > 0 ? new Set(statuses) : undefined;
	const members = new Map();
	for (const m of Array.isArray(record?.members) ? record.members : []) {
		if (typeof m?.label !== "string" || m.label === "") continue;
		members.set(m.label, {
			label: m.label,
			role: m.role ?? "",
			task: m.task ?? "",
			worktree: m.worktree ?? undefined,
			// 两件事：①「在跑」是**进程内**状态 —— 落盘时正好在跑的话，读回来它一定已经不在跑了，
			// 原样带回来会让那个成员永远显示「在跑」（std 测实测到）；② 不认识的状态落「卡住」。
			status: (() => {
				const raw = typeof m.status === "string" ? m.status : "卡住";
				if (raw === "在跑") return "卡住";
				return allowed && !allowed.has(raw) ? "卡住" : raw;
			})(),
			note: m.note ?? (m.status === "在跑" ? "（重启时它正在跑，已判卡住）" : undefined),
			// REQ-016 D3：档位跟着成员活 —— 重启后续聊仍用它原来那一档
			model: typeof m.model === "string" && m.model !== "" ? m.model : undefined,
			provider: typeof m.provider === "string" && m.provider !== "" ? m.provider : undefined,
			updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : Date.now(),
			usage: m.usage && typeof m.usage === "object" ? m.usage : {},
			attempts: Number.isInteger(m.attempts) ? m.attempts : 0,
			startedAt: typeof m.startedAt === "number" ? m.startedAt : undefined,
			endedAt: typeof m.endedAt === "number" ? m.endedAt : undefined,
			durationMs: typeof m.durationMs === "number" ? m.durationMs : 0,
			transcript: Array.isArray(m.transcript) ? m.transcript.filter((e) => e && typeof e === "object") : [],
			// 运行时字段：重启后一定没有，显式给回默认值（别留 undefined 之外的怪值）
			running: undefined,
			promise: undefined,
			inbox: [],
			history: undefined,
		});
	}
	return {
		name: record?.name ?? "",
		objective: record?.objective ?? "",
		note: record?.note ?? undefined,
		owner: record?.owner ?? undefined,
		adoptedFrom: record?.adoptedFrom ?? undefined,
		cwd: record?.cwd ?? undefined,
		createdAt: typeof record?.createdAt === "number" ? record.createdAt : Date.now(),
		closed: record?.closed && typeof record.closed === "object"
			? { at: record.closed.at, reason: record.closed.reason ?? undefined }
			: undefined,
		members,
		// 黑板条目必须有字符串 text：缺了它 `renderSnapshot` 会在 `.replace` 上抛 TypeError
		// （std 测实测到 —— 文件是可以被人手改、也可以被旧版本写坏的）。
		board: Array.isArray(record?.board)
			? record.board.filter((e) => e && typeof e === "object" && typeof e.text === "string" && typeof e.from === "string")
			: [],
	};
}

/**
 * 建一个存储。`dir` 是目录（通常是 `<DSH_HOME>/team-workflow/squads`）。
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.debounceMs]
 */
export function createSquadStore({ dir, log = () => {}, debounceMs = SAVE_DEBOUNCE_MS, quarantine: mayQuarantine = true }) {
	/** cwd 键 → 待写的取数函数（存 thunk：写的时候要的是**最新**状态，不是入队那一刻的） */
	const pending = new Map();
	/** cwd 键 → 防抖定时器 */
	const timers = new Map();
	let disposed = false;

	const fileFor = (cwd) => path.join(dir, `${workspaceKey(cwd)}.json`);

	function quarantine(file, why) {
		// 只读调用方（`dsh-team squad ls`）传 `quarantine: false`：看一眼不该改用户的盘。
		if (!mayQuarantine) {
			log(`小队状态文件读不了（${why}）：${file}`);
			return;
		}
		const target = `${file}.broken-${Date.now()}`;
		try {
			renameSync(file, target);
			log(`小队状态文件读不了（${why}），已改名保留：${target}`);
		} catch (err) {
			log(`小队状态文件读不了（${why}），而且改名也失败了：${err?.message ?? err}`);
		}
	}

	/** 读一个 cwd 的记录。坏文件 → quarantine + 返回空（不抛错：小队起不来不该拖垮插件）。 */
	function load(cwd) {
		const file = fileFor(cwd);
		if (!existsSync(file)) return [];
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			quarantine(file, `读失败：${err?.message ?? err}`);
			return [];
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			quarantine(file, `不是合法 JSON：${err?.message ?? err}`);
			return [];
		}
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.squads)) {
			quarantine(file, "形状不对（没有 squads 数组）");
			return [];
		}
		if (parsed.version !== SQUAD_STORE_VERSION) {
			quarantine(file, `版本不认识（${JSON.stringify(parsed.version)} ≠ ${SQUAD_STORE_VERSION}）`);
			return [];
		}
		return parsed.squads.filter((s) => s && typeof s === "object");
	}

	/**
	 * 真正写一次。**同步**（tmp + rename）—— 与 `lib/scheduler.js` 的 store 同一档。
	 *
	 * 为什么不用异步写队列（我第一版是队列，被 std 测逮到）：会话结束 → `flush()` → 同一个
	 * 工作目录里**马上**开新会话 → `load()`，如果写还排在 promise 队列里，读到的就是旧文件
	 * （或根本没文件），新会话一个队都捡不回来。同步写让「flush 完就一定读得到」成为结构上的
	 * 事实，而不是时序上的运气。代价是一次 `writeFileSync`（有 750ms 防抖兜着，写不频繁）。
	 */
	function writeNow(cwd, squads) {
		const file = fileFor(cwd);
		const records = (Array.isArray(squads) ? squads : []).map(compactSquad);
		const payload = { version: SQUAD_STORE_VERSION, cwd, savedAt: Date.now(), squads: records };
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(tmp, JSON.stringify(payload), "utf8");
			renameSync(tmp, file);
		} catch (err) {
			log(`小队状态写盘失败（${file}）：${err?.message ?? err}`);
		}
	}

	/** 把一个 cwd 的待写立刻落盘（同步）。取 thunk 的时机就是现在 —— 状态是最新的。 */
	function flushOne(cwd) {
		const thunk = pending.get(cwd);
		if (!thunk) return;
		pending.delete(cwd);
		writeNow(cwd, thunk());
	}

	/** 安排一次写（防抖）。`squads` 是 **thunk**：写的时候再取，免得把过期快照写进文件。 */
	function save(cwd, squads) {
		if (disposed) return;
		pending.set(cwd, squads);
		if (timers.has(cwd)) return;
		// **不 unref**：unref 之后事件循环一空这次写就被跳过（dispose 的 flush 兜不住进程直接退出）
		timers.set(
			cwd,
			setTimeout(() => {
				timers.delete(cwd);
				flushOne(cwd);
			}, debounceMs),
		);
	}

	/** 立刻把所有待写的落盘（dispose / 会话销毁时用）。同步 —— 返回之后读盘一定读得到。 */
	function flush() {
		for (const [cwd, timer] of timers) {
			clearTimeout(timer);
			timers.delete(cwd);
		}
		for (const cwd of [...pending.keys()]) flushOne(cwd);
	}

	function dispose() {
		flush();
		disposed = true;
	}

	return { dir, fileFor, load, save, flush, dispose, workspaceKey };
}
