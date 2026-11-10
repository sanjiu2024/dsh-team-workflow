/**
 * 跑一轮：拉新评论 → 判定 → 执行 → 回评论 → 推进游标。
 *
 * ## 为什么单独一层
 *
 * `source` / `policy` / `executor` / `reply` 各自都能单测，但「一轮里谁先谁后、某条失败
 * 要不要挡住后面的、游标什么时候推进」只有把它们串起来才看得出来 —— 而那几条正是
 * 计划审查里说「最可能返工」的地方。所以串的这一层也用全注入写，用假件就能测整轮。
 *
 * ## 三条顺序上的硬约束
 *
 * 1. **游标在本轮开始前固定**（`source` 内部已经这么做），处理完再推进 ——
 *    否则本轮中途推进会让还没处理的旧评论变成「低于游标」被永久跳过。
 * 2. **单条失败不挡后续**：一条 issue 挂了不能让整轮停摆。失败记进 tickets，
 *    靠 `/superagent retry` 手动重来 —— 自动重试会在真出问题时刷成风暴。
 * 3. **`observe` 只记账不执行**：那是「先把策略调对再开闸」用的模式，不能真去跑。
 *
 * @module dsh-team-workflow/superagent/loop
 */

/** 一轮的结果。`errors` 里是给人看的原因，面板会原样显示。 */
const emptyResult = () => ({
	scanned: 0,
	accepted: 0,
	executed: 0,
	replied: 0,
	skipped: 0,
	errors: [],
});

/**
 * 跑一轮。
 *
 * @param {object} deps
 * @param {import("./store.js").SuperagentStore} deps.store
 * @param {{ fetchNewComments: Function }} deps.source
 * @param {{ decide: Function, normalizePolicy?: Function }} deps.policy
 * @param {(request: object) => Promise<object>} deps.execute  通常是 `executeTicket` 的偏应用
 * @param {(request: object) => Promise<object>} deps.reply     通常是 `deliverReply` 的偏应用
 * @param {(message: string) => void} [deps.log]
 * @param {object} [deps.now]
 *
 * @param {{ repo: string, policy: object }} options
 * @returns {Promise<ReturnType<typeof emptyResult>>}
 */
export async function runRound(deps, { repo, policy } = {}) {
	const { store, source, policy: policyModule, execute, reply } = deps ?? {};
	if (!store) throw new Error("runRound: 需要 store");
	if (typeof source?.fetchNewComments !== "function") throw new Error("runRound: 需要 source.fetchNewComments");
	if (typeof policyModule?.decide !== "function") throw new Error("runRound: 需要 policy.decide");
	if (typeof execute !== "function") throw new Error("runRound: 需要 execute");
	if (typeof reply !== "function") throw new Error("runRound: 需要 reply");
	const log = typeof deps.log === "function" ? deps.log : () => {};

	const result = emptyResult();
	// 只读本仓库的游标（readCursor 内部会读盘）。以前这里是直接拿 state.cursor.lastCommentId，
	// 多仓库下会把别的仓库的进度当成自己的。
	const cursor = await store.readCursor(repo);
	const normalized = typeof policyModule.normalizePolicy === "function" ? policyModule.normalizePolicy(policy) : policy;

	let fetched;
	try {
		fetched = await source.fetchNewComments({ repo, cursor });
	} catch (error) {
		result.errors.push(`拉取失败：${String(error?.message ?? error)}`);
		return result;
	}

	result.scanned = Number(fetched?.scanned ?? 0);
	for (const message of fetched?.errors ?? []) result.errors.push(message);
	const comments = Array.isArray(fetched?.comments) ? fetched.comments : [];

	for (const event of comments) {
		const decision = policyModule.decide(event, normalized);
		if (decision.kind === "ignore" || decision.kind === "unavailable") {
			result.skipped += 1;
			log(`跳过 ${event.commentId}：${decision.reason}`);
			continue;
		}
		if (decision.kind === "stop") {
			// 停机不执行，但要留痕 —— 面板上要能看见「有人要求停」
			await store.saveTicket(event.commentId, {
				status: "stopped",
				reason: decision.reason,
				repo: event.repo,
				issueNumber: event.issueNumber,
				endedAt: new Date().toISOString(),
			});
			result.skipped += 1;
			continue;
		}

		result.accepted += 1;

		// observe：只记账，不跑 —— 这是「先把策略调对再开闸」的模式
		if (normalized.acceptMode === "observe") {
			await store.saveTicket(event.commentId, {
				status: "observed",
				reason: `observe 模式：判定放行但未执行（${decision.reason}）`,
				repo: event.repo,
				issueNumber: event.issueNumber,
				startedAt: new Date().toISOString(),
			});
			log(`observe ${event.commentId}：${decision.reason}`);
			continue;
		}

		const instruction = typeof policyModule.extractInstruction === "function"
			? policyModule.extractInstruction(event.body, normalized.trigger)
			: event.body;

		let outcome;
		try {
			outcome = await execute({
				commentId: event.commentId,
				repo: event.repo,
				issueNumber: event.issueNumber,
				instruction,
			});
		} catch (error) {
			// 执行层自己会兜错，走到这里说明是意外；记下来但不挡后续
			result.errors.push(`${event.commentId} 执行异常：${String(error?.message ?? error)}`);
			continue;
		}
		if (outcome?.status === "skipped") {
			result.skipped += 1;
			continue;
		}
		if (outcome?.status !== "done") {
			result.errors.push(`${event.commentId} 未完成（${outcome?.status ?? "未知"}）：${outcome?.reason ?? ""}`);
			continue;
		}

		result.executed += 1;
		try {
			const posted = await reply({
				commentId: event.commentId,
				repo: event.repo,
				issueNumber: event.issueNumber,
				body: outcome.text,
				status: outcome.status,
				sessionId: outcome.sessionId,
			});
			if (posted?.ok === true) result.replied += 1;
			else result.errors.push(`${event.commentId} 回评论失败：${posted?.error ?? "未知"}`);
		} catch (error) {
			result.errors.push(`${event.commentId} 回评论异常：${String(error?.message ?? error)}`);
		}
	}

	// 游标推进到「本轮见过的最小值」：source 已按 id 升序返回，
	// 用最后一条（最大 id）作为新一轮起点。整轮拉取失败时不动游标。
	const next = fetched?.nextCursor;
	if (typeof next === "string" && next !== "" && comments.length > 0) {
		await store.advanceCursor(next, repo);
	}
	return result;
}
