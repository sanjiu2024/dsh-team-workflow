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
 * JSON 里转录压到 100 条 × 1000 字符（重启后能看到摘要级转录）；**完整原文另落一份
 * `.transcripts/<成员>.log`**（B1）—— JSON 是安全网，`.log` 是全文。
 *
 * ── 落盘形状的版本（改形状必须同时改它 + 写迁移） ─────────────────────────────
 * v1：转录只在 JSON 里，`inbox` / `history` 不落盘。
 * v2（REQ-016 B1/B2）：转录另落 `.log` 全文；`inbox`（待投消息）与 `history`（续聊历史）
 *   落盘 —— 重启后还能把话投出去、还能接着上次的历史聊，而不是退化成「原任务 + 上次结论」。
 *   读 v1 照常（缺的字段就是空），**不 quarantine** —— 老文件必须能读，这是迁移的全部意义。
 *
 * ── 两个进程同时写（B5） ────────────────────────────────────────────────────
 * 整体重写 + rename 保证「不会写坏」，但挡不住**丢更新**：两个 dsh 各自持一份内存状态，
 * 后写的把先写的覆盖掉。所以写之前先抢 `<cwd>.lock`（`wx` 独占创建），
 * 判据是 **pid 活着 + mtime 新鲜**（只看 pid 会被 pid 复用骗，只看 mtime 会抢活着的进程）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { userMessage } from "./squad-loop.js";

/** 当前落盘形状版本。读的时候 `1` 与 `2` 都认（见文件头）。 */
export const SQUAD_STORE_VERSION = 2;

/** 认得的旧版本（读了照常迁移，不 quarantine）。 */
export const SQUAD_STORE_KNOWN = [1, 2];

/** 落盘时每个成员留多少条转录 / 单条多少字符。 */
export const PERSIST_TRANSCRIPT_LIMIT = 100;
export const PERSIST_TRANSCRIPT_TEXT_MAX = 1000;

/** `.log` 里最多留多少条转录（完整原文，比 JSON 里那份宽）。 */
export const LOG_TRANSCRIPT_LIMIT = 2000;

/** 落盘的待投消息上限 / 单条上限；续聊历史的条数上限。 */
export const PERSIST_INBOX_LIMIT = 20;
export const PERSIST_INBOX_TEXT_MAX = 4000;
export const PERSIST_HISTORY_LIMIT = 60;

/** 锁多久算过期（毫秒）。持有者进程还活着时，即使超时也要再看 pid。 */
export const LOCK_STALE_MS = 60_000;

/** 抢不到锁时最多重排几次写（每次间隔 = 防抖窗口）。 */
export const LOCK_RETRY_LIMIT = 10;

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

/**
 * 成员名 → 文件名（纯函数）。成员名是用户给的，可能带 `/`、`..`、空格 ——
 * 直接当文件名就是路径穿越。非法字符一律换成 `_`，并且**不许**出现 `.` / `..`。
 */
export function safeMemberFileName(label) {
	const raw = typeof label === "string" ? label.trim() : "";
	const cleaned = raw
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		// 连续的点一并收掉：`..` 出现在文件名里没危险（没有分隔符），但没必要留着让人误读
		.replace(/\.{2,}/g, "_")
		.replace(/^\.+/, "_")
		.slice(0, 60);
	return cleaned === "" || cleaned === "." || cleaned === ".." ? "member" : cleaned;
}

/** 进程还活着吗（纯判据，可单测）。pid 非法 → 当作不活。 */
export function processAlive(pid, self = process.pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === self) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = 活着但不是我的；ESRCH = 没了
		return err?.code === "EPERM";
	}
}

/**
 * 锁该不该被抢（**pid 与 mtime 双判据**）。
 *
 * 只看 mtime：一个卡住但活着的进程会被反复抢，两个进程同时写。
 * 只看 pid：pid 会被系统复用，拿到别人的号就以为「它活着」，锁永远抢不过来。
 * 所以：**持有者不活 或 锁太老** 才抢。
 */
export function lockIsStale(lock, now = Date.now(), staleMs = LOCK_STALE_MS) {
	if (!lock || typeof lock !== "object") return true;
	const tooOld = typeof lock.at !== "number" || now - lock.at > staleMs;
	return tooOld || !processAlive(lock.pid);
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

/** 从一条消息里抠出文本（只用于落盘压缩；消息可能是我们造的，也可能是宿主给的）。 */
function messageTextOf(msg) {
	if (typeof msg?.text === "string") return msg.text;
	const parts = Array.isArray(msg?.content) ? msg.content : [];
	return parts
		.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter((t) => t !== "")
		.join("\n");
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
		// A10：验收清单要跨重启活着（勾过的不该因为重启重来）
		acceptance: (squad.acceptance ?? []).map((e) => ({
			text: e.text,
			done: e.done === true,
			by: e.by ?? null,
			at: e.at ?? null,
			note: e.note ?? null,
		})),
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
			modelFromRole: m.modelFromRole === true,
			// REQ-025：成员会话 id 也要跨重启活着 —— 会话本身是**落盘的**，
			// 记下 id 之后 `squad_send` 能 resume 回那个会话（真历史，不是拼出来的）。
			sessionId: typeof m.sessionId === "string" && m.sessionId !== "" ? m.sessionId : null,
			updatedAt: m.updatedAt ?? null,
			usage: m.usage ?? null,
			attempts: m.attempts ?? 0,
			startedAt: m.startedAt ?? null,
			endedAt: m.endedAt ?? null,
			durationMs: m.durationMs ?? 0,
			// B2：待投消息与续聊历史都要跨重启活着 —— 否则重启后「投出去的话」与
			// 「接着上次聊」都会退化成空
			inbox: (Array.isArray(m.inbox) ? m.inbox : [])
				.slice(-PERSIST_INBOX_LIMIT)
				.map((msg) => ({ text: String(messageTextOf(msg)).slice(0, PERSIST_INBOX_TEXT_MAX), at: typeof msg?.at === "number" ? msg.at : undefined })),
			history: Array.isArray(m.history) ? m.history.slice(-PERSIST_HISTORY_LIMIT) : null,
			// A8：收工回报（四段）跨重启活着 —— 主 agent 重启后还想看它交付了什么
			report: m.report && typeof m.report === "object" ? m.report : null,
			// A7：谁在审谁、谁被审过（都要跨重启活着，不然「审过了」重启就没了）
			reviews: typeof m.reviews === "string" ? m.reviews : null,
			review: m.review && typeof m.review === "object" ? m.review : null,
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
				// 「在跑」「排队」「等待」都是**进程内**状态：重启后没有循环在跑、
				// 没人来补位、也没人来叫醒等待的人
				if (raw === "在跑" || raw === "排队" || raw === "等待") return "卡住";
				return allowed && !allowed.has(raw) ? "卡住" : raw;
			})(),
			note:
				m.note ??
				(m.status === "在跑"
					? "（重启时它正在跑，已判卡住）"
					: m.status === "排队"
						? "（重启时它在排队，重启后不会自动补位 —— 再 squad_spawn 一次）"
						: m.status === "等待"
							? "（重启时它在等别人收工，重启后没人叫醒它 —— 再 squad_spawn / squad_send 一次）"
							: undefined),
			// REQ-016 D3：档位跟着成员活 —— 重启后续聊仍用它原来那一档
			model: typeof m.model === "string" && m.model !== "" ? m.model : undefined,
			provider: typeof m.provider === "string" && m.provider !== "" ? m.provider : undefined,
			modelFromRole: m.modelFromRole === true,
			// REQ-025：成员会话 id（会话在盘上，id 在就能 resume 回来）
			sessionId: typeof m.sessionId === "string" && m.sessionId !== "" ? m.sessionId : undefined,
			updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : Date.now(),
			usage: m.usage && typeof m.usage === "object" ? m.usage : {},
			attempts: Number.isInteger(m.attempts) ? m.attempts : 0,
			startedAt: typeof m.startedAt === "number" ? m.startedAt : undefined,
			endedAt: typeof m.endedAt === "number" ? m.endedAt : undefined,
			durationMs: typeof m.durationMs === "number" ? m.durationMs : 0,
			// A8：回报是**成员自己说的**，读回来照旧原样带着（`parsed:false` 的也留着原文）
			report: m.report && typeof m.report === "object" ? m.report : undefined,
			// A7：审查关系跨重启活着
			reviews: typeof m.reviews === "string" && m.reviews !== "" ? m.reviews : undefined,
			review: m.review && typeof m.review === "object" ? m.review : undefined,
			transcript: Array.isArray(m.transcript) ? m.transcript.filter((e) => e && typeof e === "object") : [],
			// B2：待投消息还原成**真消息**（循环认得那个形状）；续聊历史原样带回
			inbox: (Array.isArray(m.inbox) ? m.inbox : [])
				.filter((e) => e && typeof e === "object" && typeof e.text === "string" && e.text !== "")
				.map((e) => userMessage(e.text)),
			history: Array.isArray(m.history) && m.history.length > 0 ? m.history.filter((e) => e && typeof e === "object") : undefined,
			// 运行时字段：重启后一定没有，显式给回默认值（别留 undefined 之外的怪值）
			running: undefined,
			promise: undefined,
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
		// A10：缺了就空清单（旧文件没有这个字段）
		acceptance: (Array.isArray(record?.acceptance) ? record.acceptance : [])
			.filter((e) => e && typeof e === "object" && typeof e.text === "string" && e.text !== "")
			.map((e) => ({
				text: e.text,
				done: e.done === true,
				by: typeof e.by === "string" ? e.by : undefined,
				at: typeof e.at === "number" ? e.at : undefined,
				note: typeof e.note === "string" ? e.note : undefined,
			})),
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
		// 认得的版本照常读（v1 缺的字段 revive 会补默认值）；不认识的才 quarantine
		if (!SQUAD_STORE_KNOWN.includes(parsed.version)) {
			quarantine(file, `版本不认识（${JSON.stringify(parsed.version)} ∉ ${JSON.stringify(SQUAD_STORE_KNOWN)}）`);
			return [];
		}
		if (parsed.version !== SQUAD_STORE_VERSION) log(`小队状态文件是老版本（v${parsed.version}），照常读：缺的字段用默认值（${file}）`);
		const squads = parsed.squads.filter((s) => s && typeof s === "object");
		// **不认 2.0.1 那种不带队名的老 `.log`**（试过一版兜底，两轮独立测各逮到一类串队：
		// 两队同名成员共用一份；`查_A`/`查 A` 消毒后同名；老文件的主人已经不在 JSON 里）。
		// 根因是那个文件**没有归属信息**，怎么判都可能把别人的转录读进来，而且 `revive`+`save`
		// 会把它写进新路径**永久覆盖**。所以宁可让老会话退回 JSON 里那 100 条摘要（丢的是全文，
		// 不会串队），也不赌。
		// B1：`.log` 是**全文**，JSON 里那份是摘要 —— 有全文就用全文（重启后转录不掉字）
		for (const squad of squads) {
			for (const member of Array.isArray(squad?.members) ? squad.members : []) {
				if (!member || typeof member.label !== "string") continue;
				const full = readTranscript(cwd, squad?.name ?? "", member.label);
				// 只在 `.log` **不比** JSON 里那份少时才用它：写转录失败（或用户手改过）时
				// `.log` 可能反而是旧的，那样「优先全文」就变成了「丢最新几条」。
				if (full.length > 0 && full.length >= (Array.isArray(member.transcript) ? member.transcript.length : 0)) {
					member.transcript = full;
				}
			}
		}
		return squads;
	}

	/**
	 * 真正写一次。**同步**（tmp + rename）—— 与 `lib/scheduler.js` 的 store 同一档。
	 *
	 * 为什么不用异步写队列（我第一版是队列，被 std 测逮到）：会话结束 → `flush()` → 同一个
	 * 工作目录里**马上**开新会话 → `load()`，如果写还排在 promise 队列里，读到的就是旧文件
	 * （或根本没文件），新会话一个队都捡不回来。同步写让「flush 完就一定读得到」成为结构上的
	 * 事实，而不是时序上的运气。代价是一次 `writeFileSync`（有 750ms 防抖兜着，写不频繁）。
	 */
	/** 转录旁挂目录 / 成员转录文件（B1）。 */
	const transcriptsDir = (cwd) => path.join(dir, `${workspaceKey(cwd)}.transcripts`);
	// **路径里必须有队名**：同工作目录两个队各有一个「查-A」是常事，只按成员名落文件
	// 会让两队共用一个 `.log`，`load` 时读回对方的转录。
	const transcriptFile = (cwd, squadName, label) =>
		path.join(transcriptsDir(cwd), safeMemberFileName(squadName), `${safeMemberFileName(label)}.log`);

	/**
	 * 把一个成员的转录写成 `.log`（B1）。JSONL：一行一条，机器能解析、人也看得懂。
	 * **原子替换**（tmp + rename）—— 照 `lib/scheduler.js` 的 store 同一套：读到半截文件
	 * 比读到旧文件糟得多。
	 */
	function writeTranscript(cwd, squadName, member) {
		const events = Array.isArray(member?.transcript) ? member.transcript.slice(-LOG_TRANSCRIPT_LIMIT) : [];
		const file = transcriptFile(cwd, squadName, member?.label ?? "");
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		try {
			// 建到**文件所在的那一层**：路径里现在还有队名子目录，只建到 `.transcripts` 会 ENOENT
			mkdirSync(path.dirname(file), { recursive: true });
			const body = events
				.map((e) => JSON.stringify({ at: e?.at ?? null, role: e?.role ?? "?", text: typeof e?.text === "string" ? e.text : "" }))
				.join("\n");
			writeFileSync(tmp, body === "" ? "" : `${body}\n`, "utf8");
			renameSync(tmp, file);
		} catch (err) {
			log(`转录写盘失败（${file}）：${err?.message ?? err}`);
		}
	}

	/** 读一个成员的 `.log` 全文（B1）。文件不在 / 读不动 → 空数组（调用方回落 JSON 里那份）。 */
	function readTranscript(cwd, squadName, label) {
		const file = transcriptFile(cwd, squadName, label);
		if (!existsSync(file)) return [];
		try {
			return readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return undefined;
					}
				})
				.filter((e) => e && typeof e === "object");
		} catch (err) {
			log(`转录读不动（${file}）：${err?.message ?? err}`);
			return [];
		}
	}

	/** 抢锁（B5）。拿到返回 `{ok:true, file}`；拿不到返回 `{ok:false, reason}`。 */
	function acquireLock(cwd) {
		const file = `${fileFor(cwd)}.lock`;
		const body = JSON.stringify({ pid: process.pid, at: Date.now() });
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, body, { flag: "wx" });
			return { ok: true, file };
		} catch (err) {
			if (err?.code !== "EEXIST") return { ok: false, reason: `拿锁失败：${err?.message ?? err}` };
		}
		// 已经有人持着：它是不是还活着 / 锁是不是太老
		let held;
		try {
			held = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			held = undefined; // 读不动 = 坏锁，当过期
		}
		if (!lockIsStale(held)) return { ok: false, reason: `另一个进程（pid ${held?.pid ?? "?"}）正在写` };
		// 过期：删掉再抢一次。**只重试一次**，抢不到就让这次写让路（外层会重排）
		try {
			rmSync(file, { force: true });
			writeFileSync(file, body, { flag: "wx" });
			return { ok: true, file };
		} catch (err) {
			return { ok: false, reason: `抢过期锁失败：${err?.message ?? err}` };
		}
	}

	function releaseLock(file) {
		try {
			rmSync(file, { force: true });
		} catch {
			// 释放失败只影响下一次写（锁会因超时被判过期），不值得把整个 flush 拖挂
		}
	}

	/**
	 * 真正写一次。**同步**（tmp + rename）—— 与 `lib/scheduler.js` 的 store 同一档。
	 *
	 * 为什么不用异步写队列（我第一版是队列，被 std 测逮到）：会话结束 → `flush()` → 同一个
	 * 工作目录里**马上**开新会话 → `load()`，如果写还排在 promise 队列里，读到的就是旧文件
	 * （或根本没文件），新会话一个队都捡不回来。同步写让「flush 完就一定读得到」成为结构上的
	 * 事实，而不是时序上的运气。代价是一次 `writeFileSync`（有 750ms 防抖兜着，写不频繁）。
	 *
	 * @returns {boolean} 写成功了吗（false = 没抢到锁，外层重排）
	 */
	function writeNow(cwd, squads) {
		const file = fileFor(cwd);
		const lock = acquireLock(cwd);
		if (!lock.ok) {
			log(`这次先不写（${file}）：${lock.reason}`);
			return false;
		}
		try {
			const records = (Array.isArray(squads) ? squads : []).map(compactSquad);
			const payload = { version: SQUAD_STORE_VERSION, cwd, savedAt: Date.now(), squads: records };
			const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(tmp, JSON.stringify(payload), "utf8");
				renameSync(tmp, file);
			} catch (err) {
				log(`小队状态写盘失败（${file}）：${err?.message ?? err}`);
				return false;
			}
			// B1：转录另落全文（JSON 里那份是摘要，是安全网）
			for (const record of Array.isArray(squads) ? squads : []) {
				for (const member of record?.members?.values?.() ?? []) writeTranscript(cwd, record?.name ?? "", member);
			}
			return true;
		} finally {
			releaseLock(lock.file);
		}
	}

	/** 每个 cwd 抢锁失败了几次（B5）。写成功就清零。 */
	const lockMisses = new Map();

	/** 把一个 cwd 的待写立刻落盘（同步）。取 thunk 的时机就是现在 —— 状态是最新的。 */
	function flushOne(cwd) {
		const thunk = pending.get(cwd);
		if (!thunk) return;
		pending.delete(cwd);
		if (writeNow(cwd, thunk())) {
			lockMisses.delete(cwd);
			return;
		}
		// 没写成功（多半是另一个进程持着锁）：**重排**，别把这次改动吞掉。
		// 但也不能无限重排 —— 超过上限就说清楚这次没写（比默默丢好）。
		const misses = (lockMisses.get(cwd) ?? 0) + 1;
		lockMisses.set(cwd, misses);
		if (misses > LOCK_RETRY_LIMIT) {
			log(`小队状态连续 ${misses} 次没写成功（${fileFor(cwd)}）—— 这次改动只在内存里，下次落盘再试`);
			lockMisses.delete(cwd);
			return;
		}
		save(cwd, thunk);
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

	return { dir, fileFor, load, save, flush, dispose, workspaceKey, transcriptFile, readTranscript, acquireLock, releaseLock };
}
