/**
 * superagent 的状态存储：游标、已处理的评论、Ticket 记录。
 *
 * ## 为什么不是 SQLite
 *
 * 上游用 `node:sqlite`。本仓库的取舍：状态文件要**人能直接看** —— 出问题时用编辑器打开
 * 就能查「这条评论到底有没有被处理」，而 SQLite 得另装工具。代价是自己管并发，见下。
 *
 * ## 三条硬约束（全部来自 2026-11-08 的计划审查）
 *
 * 1. **单写者**：轮询、面板、命令三处都会读改写同一个文件，不串行化必丢更新。
 *    所以所有操作排进一条 Promise 链，读也走同一条 —— 读到的永远是写完的。
 * 2. **原子写**：先写 `.tmp` 再 `rename`。崩在中间最多丢最后一次写，不会留下半个 JSON
 *    让下次解析直接炸。
 * 3. **幂等**：`claim(commentId)` 是「先占坑再干活」—— 崩在「跑完」与「存游标」之间时，
 *    重跑不会重复开 worktree、重复推送、重复评论。
 *
 * ## Windows 的 rename 会 EPERM
 *
 * 文件被杀软或编辑器占用时 `rename` 报 EPERM（不是 ENOENT）。这里重试几次再放弃 ——
 * 不重试的话，一次临时占用就会让状态写不进去，而调用方往往不检查返回值。
 *
 * @module dsh-team-workflow/superagent/store
 */

import fs from "node:fs";
import path from "node:path";

/** 状态文件版本。结构变了就 +1，读取时做迁移。 */
const STATE_VERSION = 1;

/** `seen` 最多保留多少条评论 id。太长的历史没人看，还会让文件无限长大。 */
const MAX_SEEN = 1000;

/** rename 重试：次数与间隔（毫秒）。 */
const RENAME_RETRIES = 5;
const RENAME_DELAY_MS = 40;

/** @returns {object} 一份可改的空状态（每次新建，天然不共享） */
function emptyState() {
	// 游标按仓库分：多仓库共用一个的话，A 仓库推进一次就把 B 仓库的旧评论全跳过了。
	// lastCommentId 留着只为读老文件（单仓库时代写的），新写入一律进 byRepo。
	return { version: STATE_VERSION, cursor: { lastCommentId: null, byRepo: {} }, seen: [], tickets: {} };
}

/** 把读到的原始 JSON 规范化：未知字段丢弃，缺字段补默认。 */
function normalizeState(raw) {
	const state = emptyState();
	if (raw === null || typeof raw !== "object") return state;
	if (typeof raw.cursor?.lastCommentId === "string") state.cursor.lastCommentId = raw.cursor.lastCommentId;
	// 按仓库分的游标。老文件没有这一层，读进来是空的 —— 调用方那边有兜底
	// （`cursorFor` 在 byRepo 缺项时回落到 lastCommentId，见 `readCursor`）。
	if (raw.cursor?.byRepo !== null && typeof raw.cursor?.byRepo === "object") {
		for (const [repo, id] of Object.entries(raw.cursor.byRepo)) {
			if (typeof id === "string" && id !== "") state.cursor.byRepo[repo] = id;
		}
	}
	if (Array.isArray(raw.seen)) state.seen = raw.seen.filter((id) => typeof id === "string").slice(-MAX_SEEN);
	if (raw.tickets !== null && typeof raw.tickets === "object" && !Array.isArray(raw.tickets)) {
		for (const [key, value] of Object.entries(raw.tickets)) {
			if (value !== null && typeof value === "object") state.tickets[key] = { ...value };
		}
	}
	return state;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 单写者 + 原子落盘的状态存储。
 *
 * 一个实例对应一个目录下的 `state.json`。同一个进程里应当只有一个实例（多实例会各排各的
 * 队列，互相覆盖）—— 这是本类的使用契约，不是它能自己保证的事。
 */
export class SuperagentStore {
	/** @param {{ dir: string, fileName?: string }} options */
	constructor({ dir, fileName = "state.json" } = {}) {
		if (typeof dir !== "string" || dir === "") throw new Error("SuperagentStore: 需要 dir");
		this.dir = dir;
		this.file = path.join(dir, fileName);
		/** 写队列的尾巴。所有读改写都挂在它后面。 */
		this.tail = Promise.resolve();
	}

	/** 把一次操作排进队列。前一个失败不影响后一个（否则一次写失败会永久卡死）。 */
	#enqueue(operation) {
		const run = this.tail.then(operation, operation);
		// 尾巴吞掉异常：队列本身不关心成败，调用方拿 `run` 的结果
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** 读文件；不存在或解析失败都当作空状态（坏文件不该让整个子系统起不来）。 */
	#readState() {
		let text;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return emptyState();
			throw error;
		}
		try {
			return normalizeState(JSON.parse(text));
		} catch {
			// 解析失败只可能是上一次非原子写留下的残骸；重命名留档后从空开始
			try {
				fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
			} catch {
				/* 留档失败就算了，别让它盖住真正的原因 */
			}
			return emptyState();
		}
	}

	/** 原子写：tmp → rename，EPERM/EBUSY 重试。 */
	async #writeState(state) {
		await fs.promises.mkdir(this.dir, { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await fs.promises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		for (let attempt = 0; ; attempt += 1) {
			try {
				await fs.promises.rename(tmp, this.file);
				return;
			} catch (error) {
				// Windows：文件被杀软/编辑器占着时 rename 报 EPERM；EBUSY 同理
				const retriable = error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
				if (!retriable || attempt >= RENAME_RETRIES - 1) {
					try {
						await fs.promises.rm(tmp, { force: true });
					} catch {
						/* 清理失败不改变主错误 */
					}
					throw error;
				}
				await sleep(RENAME_DELAY_MS * (attempt + 1));
			}
		}
	}

	/** 读一份快照（走队列，拿到的是「写完的」状态）。 */
	async read() {
		return this.#enqueue(async () => this.#readState());
	}

	/**
	 * 读改写：`mutator(state)` 收到可改状态，返回值原样透传给调用方。
	 * 改完一定落盘（即使 mutator 抛错则不写）。
	 *
	 * @template T
	 * @param {(state: object) => T | Promise<T>} mutator
	 * @returns {Promise<T>}
	 */
	async update(mutator) {
		return this.#enqueue(async () => {
			const state = this.#readState();
			const result = await mutator(state);
			await this.#writeState(state);
			return result;
		});
	}

	/**
	 * 幂等占坑：这条评论第一次见返回 `true` 并记进 `seen`，见过返回 `false`。
	 *
	 * **必须先 claim 再干活** —— 顺序反了（先跑再记）就会在崩溃后重跑同一件事。
	 *
	 * @param {string} commentId
	 * @returns {Promise<boolean>}
	 */
	async claim(commentId) {
		if (typeof commentId !== "string" || commentId === "") throw new Error("claim: 需要 commentId");
		return this.update((state) => {
			if (state.seen.includes(commentId)) return false;
			state.seen.push(commentId);
			// 截断到上限：留最近的，老的没人会回头查
			if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
			return true;
		});
	}

	/**
	 * 撤掉一条 claim —— 重试专用。
	 *
	 * `claim` 把 commentId 记进 `seen` 之后，同一个 id 再来都会被判「处理过了」。
	 * 重试要的正是「忽略这个判断，再跑一次」，所以得先把它从 `seen` 里拿掉。
	 *
	 * **为什么不做成 `claim(force)`**：那样调用点看不出「这一次绕过了幂等」，
	 * 而绕过幂等是危险动作（可能重复开 worktree、重复发评论）—— 它值得单独一个动词。
	 *
	 * @param {string} commentId
	 * @returns {Promise<boolean>} 原来在不在 `seen` 里
	 */
	async unclaim(commentId) {
		if (typeof commentId !== "string" || commentId === "") throw new Error("unclaim: 需要 commentId");
		return this.update((state) => {
			const index = state.seen.indexOf(commentId);
			if (index < 0) return false;
			state.seen.splice(index, 1);
			return true;
		});
	}

	/**
	 * 推进游标（只在**确实处理完**一条之后调）。
	 *
	 * `repo` 给了就写进 `byRepo[repo]`，同时仍更新 `lastCommentId` ——
	 * 后者是单仓库时代的字段，留着让老版本读得懂，也让「还没迁移的文件」继续能跑。
	 *
	 * @param {string} commentId
	 * @param {string} [repo] 哪个仓库的游标
	 */
	async advanceCursor(commentId, repo) {
		return this.update((state) => {
			state.cursor.lastCommentId = commentId;
			if (typeof repo === "string" && repo !== "") state.cursor.byRepo[repo] = commentId;
		});
	}

	/**
	 * 读某个仓库的游标。
	 *
	 * 单仓库时代写的文件里只有 `lastCommentId`，没有 `byRepo` —— 那种情况下回落到它，
	 * 否则升级后第一次轮询会把历史评论全重放一遍（每条都 claim 一次，很廉价但很吵）。
	 *
	 * @param {string} repo
	 * @returns {string | null}
	 */
	async readCursor(repo) {
		const state = await this.read();
		const scoped = typeof repo === "string" ? state.cursor.byRepo?.[repo] : undefined;
		if (scoped !== undefined) return scoped;
		// **只有 byRepo 整个是空的时候才回落** —— 那是单仓库时代的文件。
		// 一旦有了任何一个仓库的游标，未知仓库就必须从 null 开始：
		// 借别人的游标会让这个仓库的旧评论被当成「已处理」永久跳过（2026-11-10 自检逮到）。
		const hasAnyScoped = Object.keys(state.cursor.byRepo ?? {}).length > 0;
		if (hasAnyScoped) return null;
		return state.cursor.lastCommentId ?? null;
	}

	/** 写一条 Ticket 记录（覆盖式）。 */
	async saveTicket(commentId, ticket) {
		return this.update((state) => {
			state.tickets[commentId] = { ...ticket };
		});
	}

	/** 读出全部 Ticket，按开始时间倒序（新的在前）。 */
	async listTickets() {
		const state = await this.read();
		return Object.entries(state.tickets)
			.map(([commentId, ticket]) => ({ commentId, ...ticket }))
			.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
	}
}
