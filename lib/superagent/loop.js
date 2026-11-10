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
	const { store, source, policy: policyModule, execute, reply, publish } = deps ?? {};
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
		// ── Thread 订阅（REQ-038）─────────────────────────────────────────
		//
		// 上游的语义：Ticket 订阅 Thread 之后，那条 Thread 上的**后续讨论直接抵达它的
		// Executor，不用再 @ 一次**。这是「一次讨论能接着聊」的关键 ——
		// 没有它，讨论一多就得每条都重写一遍触发词。
		//
		// 这里放在 Eval 之前判断：Thread 上已经有活着的 Ticket 时，这条消息
		// **不走 Eval**（不再问「该不该干」），直接当输入喂给它 —— 上游 001-domain 原文是
		// "a person's message that reaches a Ticket this way takes no Eval"。
		//
		// 例外：issue 正文（`kind: "issue-body"`）不参与 fan-out。它是 Thread 的**开头**，
		// 而走到这里说明 Thread 已经有 Ticket 了 —— 拿开头的正文去续一个进行中的任务
		// 只会把旧需求再执行一遍。
		const thread = `${event.repo}#${event.issueNumber}`;
		if (event.kind !== "issue-body") {
			const live = await store.liveTicketOf(thread);
			if (live !== null && live !== event.commentId) {
				log(`续跑 ${live}：${thread} 上有活着的 Ticket，这条消息不走 Eval（${event.commentId}）`);
				// 走 resume：复用同一个 ticket id，让面板上是一条连续的记录
				let resumed;
				try {
					resumed = await execute({
						commentId: live,
						repo: event.repo,
						issueNumber: event.issueNumber,
						instruction: String(event.body ?? ""),
						resume: true,
						messageId: event.commentId,
						reason: `Thread ${thread} 上的后续讨论（${event.commentId}）`,
					});
				} catch (error) {
					result.errors.push(`${event.commentId} 续跑异常：${String(error?.message ?? error)}`);
					continue;
				}
				if (resumed?.status === "done") result.executed += 1;
				else result.errors.push(`续跑 ${live}：${resumed?.status ?? "未知"} ${resumed?.reason ?? ""}`);
				// 续跑失败不阻断：Thread 上的人还会继续说，下一轮再试
				if (resumed?.status === "done" && typeof reply === "function" && resumed.text) {
					try {
						const posted = await reply({
							commentId: live,
							repo: event.repo,
							issueNumber: event.issueNumber,
							body: resumed.text,
							status: resumed.status,
							sessionId: resumed.sessionId,
						});
						if (posted?.ok === true) result.replied += 1;
					} catch (error) {
						result.errors.push(`${event.commentId} 续跑回评论异常：${String(error?.message ?? error)}`);
					}
				}
				continue;
			}
		}

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
			// 人说停就**退订**这条 Thread —— 这是唯一会让 Thread 断掉的方式。
			// 上游：`stopped` 是唯一「后续讨论不再抵达」的终态。
			await store.unsubscribe(`${event.repo}#${event.issueNumber}`);
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

		// ── PR 作为 Channel（REQ-038 第二批）──────────────────────────────
		//
		// 上游 001-domain 把 PR 和评论列在同一层："Acknowledgements, replies, pull
		// requests and resolved reviews are all writes"。所以这里不是「回评论之后再开 PR」，
		// 而是**先看这次改动能不能形成 PR**：
		//   - 能（worktree 里有改动/提交）→ 开 PR，评论里带链接
		//   - 不能（没改动）→ 只回评论
		//
		// `publish` 是注入的（不传就完全不开 PR，行为与之前一致）。
		let prLine = "";
		if (typeof publish === "function" && typeof outcome.worktree === "string" && outcome.worktree !== "") {
			try {
				const published = await publish({
					worktree: outcome.worktree,
					repo: event.repo,
					issueNumber: event.issueNumber,
					commentId: event.commentId,
					title: `superagent: ${String(event.body ?? "").slice(0, 60).replace(/\s+/g, " ").trim() || `issue #${event.issueNumber}`}`,
					body: [String(outcome.text ?? "").trim(), "", `---`, "", `来自评论 ${event.commentId}（issue #${event.issueNumber}）。`].join("\n"),
				});
				if (published?.ok === true && typeof published.prUrl === "string") {
					prLine = `\n\nPR：${published.prUrl}`;
					result.published = (result.published ?? 0) + 1;
				} else if (published?.ok !== true) {
					result.errors.push(`${event.commentId} 开 PR 失败：${published?.error ?? "未知"}`);
				}
			} catch (error) {
				result.errors.push(`${event.commentId} 开 PR 异常：${String(error?.message ?? error)}`);
			}
		}

		try {
			const posted = await reply({
				commentId: event.commentId,
				repo: event.repo,
				issueNumber: event.issueNumber,
				body: `${outcome.text}${prLine}`,
				status: outcome.status,
				sessionId: outcome.sessionId,
			});
			if (posted?.ok === true) result.replied += 1;
			else result.errors.push(`${event.commentId} 回评论失败：${posted?.error ?? "未知"}`);
		} catch (error) {
			result.errors.push(`${event.commentId} 回评论异常：${String(error?.message ?? error)}`);
		}
	}

	// —— 自动重试：上一轮失败、次数没到顶、退避到了的，重跑一遍 ——
	//
	// 为什么放在轮询里而不是「失败后立刻重试」：立刻重试会在一分钟内把同样的错误刷三遍
	// （网络抖动没恢复、repo 没权限之类的问题一分钟内不会变）。按退避来，给环境一点时间。
	//
	// 为什么要有上限：真出问题（比如 agent 一启动就崩）时，无限重试会烧掉整天的额度还刷满日志。
	const retryNow = typeof deps.now === "function" ? deps.now() : Date.now();
	const retries = typeof deps.retry === "object" && deps.retry !== null ? deps.retry : null;
	if (retries !== null) {
		const state = await store.read();
		for (const [commentId, ticket] of Object.entries(state.tickets ?? {})) {
			if (ticket?.status !== "failed") continue;
			const attempts = Number(ticket.attempts ?? 0);
			if (attempts >= retries.maxAttempts) continue;
			// 退避：第 n 次失败后等 delays[n-1]（第 1 次失败等 delays[0]）
			const waited = retryNow - (Date.parse(ticket.endedAt ?? "") || 0);
			const backoff = Number(retries.delaysMs?.[Math.min(attempts - 1, (retries.delaysMs?.length ?? 1) - 1)] ?? 0);
			if (waited < backoff) continue;
			log(`重试 ${commentId}（第 ${attempts + 1} 次，上次失败：${ticket.reason ?? "未知"}）`);
			// 先撤掉 claim 才能重跑 —— 否则 execute 会被幂等挡掉
			await store.unclaim(commentId);
			try {
				const again = await execute({
					commentId,
					repo: ticket.repo ?? repo,
					issueNumber: Number(ticket.issueNumber ?? 0),
					instruction: String(ticket.instruction ?? ""),
				});
				result.errors.push(`[${ticket.repo ?? repo}] 重试 ${commentId}：${again?.status ?? "未知"}`);
			} catch (error) {
				result.errors.push(`[${ticket.repo ?? repo}] 重试 ${commentId} 异常：${String(error?.message ?? error)}`);
			}
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
