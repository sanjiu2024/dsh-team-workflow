/**
 * 跑一条 Ticket。
 *
 * ## 这一层的职责边界
 *
 * 只做**编排**：claim → 建目录 → 调 `runAgent` → 读结果 → 落状态。
 * **不碰**宿主 API（`agents.create`、`worktree`）—— 那些通过 `deps` 注入。
 *
 * 为什么这么切：真跑一个 agent 要完整的宿主上下文（11 个服务 + 一个 danger-full-access
 * 会话），CI 里起不来。而「claim 做了没」「失败记成什么状态」「结果为空怎么办」这些
 * **最容易写错**的判断，全在这一层，用假 `runAgent` 就能测。
 *
 * ## 状态流转
 *
 * ```text
 *            claim 失败 → 直接返回（这条评论处理过了）
 *   claim 成功 → running
 *        runAgent 抛错 → failed
 *        结果为空串    → needs-human（没内容可回，要人看）
 *        结果非空      → done
 * ```
 *
 * 「结果为空」**不能记 done**：`done` 在面板上意味着「可以合并了」，
 * 而一个没说话的执行大概率是中途被打断 —— 让人看一眼比装作成功强。
 *
 * @module dsh-team-workflow/superagent/executor
 */

import { reportInstruction } from "./report-file.js";

/** Ticket 的合法状态。`needs-human` 是终止态，等人处理。 */
export const TICKET_STATUS = Object.freeze(["running", "done", "failed", "needs-human"]);

const nowIso = (now) => new Date(now?.() ?? Date.now()).toISOString();

/**
 * 执行一条请求。
 *
 * @param {object} deps
 * @param {import("./store.js").SuperagentStore} deps.store
 * @param {(request: { commentId: string, repo: string, issueNumber: number, instruction: string, branch: string }) =>
 *   Promise<{ ok: boolean, sessionId?: string, text?: string, worktree?: string, error?: string }>} deps.runAgent
 *   真跑 agent 的适配层。测试时换成假的。
 * @param {() => number} [deps.now] 注入时钟，测试里固定时间用
 * @param {(message: string) => void} [deps.log] 记录日志（默认丢弃）
 *
 * @param {{ commentId: string, repo: string, issueNumber: number, instruction: string, branch?: string }} request
 * @returns {Promise<{ status: string, reason: string, text?: string, sessionId?: string, worktree?: string }>}
 */
export async function executeTicket(deps, request) {
	const { store, runAgent } = deps ?? {};
	if (!store || typeof store.claim !== "function") throw new Error("executeTicket: 需要 store");
	if (typeof runAgent !== "function") throw new Error("executeTicket: 需要 runAgent");
	const log = typeof deps.log === "function" ? deps.log : () => {};

	const commentId = String(request?.commentId ?? "");
	const instruction = String(request?.instruction ?? "").trim();
	if (commentId === "") throw new Error("executeTicket: 需要 commentId");
	// 空指令意味着「触发词后面什么都没有」——不该起会话，但也不该静默吞掉
	if (instruction === "") {
		await store.saveTicket(commentId, {
			status: "needs-human",
			reason: "触发词后面没有任务描述",
			repo: request?.repo ?? "",
			issueNumber: request?.issueNumber ?? 0,
			startedAt: nowIso(deps.now),
			endedAt: nowIso(deps.now),
		});
		return { status: "needs-human", reason: "触发词后面没有任务描述" };
	}

	// ① 先占坑再干活：崩在「跑完」与「记下来」之间时，重跑不会重复开 worktree/推送/评论
	//
	// **续跑（resume）例外**：Thread 上有活着的 Ticket 时，后续讨论要复用它，不能被幂等挡掉。
	// 那条消息本身（`messageId`）仍然要记进 `seen` —— 否则轮询每轮都会把同一条当新消息再续一次。
	const resuming = request?.resume === true;
	if (resuming) {
		const messageId = String(request?.messageId ?? "");
		if (messageId !== "") {
			const fresh = await store.claim(messageId);
			if (!fresh) {
				log(`跳过 ${messageId}：这条消息已经续跑过了`);
				return { status: "skipped", reason: "这条消息已经处理过（幂等）" };
			}
		}
	} else {
		const claimed = await store.claim(commentId);
		if (!claimed) {
			log(`跳过 ${commentId}：已经处理过`);
			return { status: "skipped", reason: "这条评论已经处理过（幂等）" };
		}
	}

	const startedAt = nowIso(deps.now);
	// 第几次尝试。重试要靠它算退避、也要靠它封顶 —— 不记的话「重试」就等于无限重试。
	const previous = (await store.read()).tickets?.[commentId] ?? {};
	const attempts = Number(previous.attempts ?? 0) + 1;
	await store.saveTicket(commentId, {
		status: "running",
		repo: String(request?.repo ?? ""),
		issueNumber: Number(request?.issueNumber ?? 0),
		instruction,
		branch: String(request?.branch ?? ""),
		attempts,
		startedAt,
		// Mandate（REQ-038 第五批）：这条 Ticket 是在什么授权下被接受的。
		// 上游说它只能被 accept 创建 / 人说停撤回 / 重新校验失败撤销 —— 所以这里只在
		// **第一次**进来时写，重试和续跑沿用原来那份（）。
		mandate: previous.mandate ?? request?.mandate,
	});

	// ①b 订阅这个 Thread：之后同一条 Thread 上的讨论直接续给它，不用再 @ 一次。
	//
	// 上游把 Subscription 当成一等概念（001-domain），因为「讨论能接着聊」是它最值钱的性质。
	// 订阅放在**跑之前**：跑到一半崩了，Thread 上的人继续说也应该能接住。
	const thread = `${String(request?.repo ?? "")}#${Number(request?.issueNumber ?? 0)}`;
	if (request?.repo && Number(request?.issueNumber ?? 0) > 0) await store.subscribe(thread, commentId);

	// ② 跑
	let outcome;
	try {
		outcome = await runAgent({
			commentId,
			repo: String(request?.repo ?? ""),
			issueNumber: Number(request?.issueNumber ?? 0),
			// 拼上「干完写个结论文件」那段（REQ-038 第四批）。
			// 为什么拼在这里而不是写进 issue 正文：正文是人写的、不可控；这段是固定的协议说明。
			instruction: instruction + reportInstruction(),
			branch: String(request?.branch ?? ""),
		});
	} catch (error) {
		const reason = String(error?.message ?? error ?? "未知错误");
		await store.saveTicket(commentId, {
			status: "failed",
			reason,
			repo: String(request?.repo ?? ""),
			issueNumber: Number(request?.issueNumber ?? 0),
			instruction,
			branch: String(request?.branch ?? ""),
			startedAt,
			endedAt: nowIso(deps.now),
		});
		return { status: "failed", reason };
	}

	// ③ 判定结局
	const text = typeof outcome?.text === "string" ? outcome.text.trim() : "";
	const endedAt = nowIso(deps.now);
	const common = {
		repo: String(request?.repo ?? ""),
		issueNumber: Number(request?.issueNumber ?? 0),
		instruction,
		branch: String(request?.branch ?? ""),
		sessionId: typeof outcome?.sessionId === "string" ? outcome.sessionId : "",
		worktree: typeof outcome?.worktree === "string" ? outcome.worktree : "",
		attempts,
		startedAt,
		endedAt,
	};

	if (outcome?.ok !== true) {
		const reason = String(outcome?.error ?? "执行层报告失败");
		// 失败时也把结论卡带进去：超时那条会带 （不是 failed），面板据此显示
		// 「卡住了」而不是「失败了」。status 仍是 failed（执行确实没成功），但 stage 走 report。
		await store.saveTicket(commentId, {
			...common,
			status: "failed",
			reason,
			...(outcome?.report === undefined ? {} : { report: outcome.report }),
		});
		return { status: "failed", reason, sessionId: common.sessionId, worktree: common.worktree };
	}
	if (text === "") {
		// 跑完了但一句话没说：不能记 done（面板上 done 意味着「可以合并了」）
		const reason = "执行完成但没有输出，可能是中途被打断";
		await store.saveTicket(commentId, { ...common, status: "needs-human", reason });
		return { status: "needs-human", reason, sessionId: common.sessionId, worktree: common.worktree };
	}

	await store.saveTicket(commentId, {
		...common,
		status: "done",
		text,
		// 执行者自己写的结论（REQ-038 第四批）。没写就没有这个键 —— stage 会退回事实推断。
		...(outcome.report === undefined ? {} : { report: outcome.report }),
		// 后台还有活（REQ-038 第六批）。有它的时候 stage 判 working ——
		// 「我说完了」和「我起的东西也说完了」是两件事。
		...(Array.isArray(outcome.backgroundJobs) && outcome.backgroundJobs.length > 0
			? { backgroundJobs: outcome.backgroundJobs }
			: {}),
	});
	return { status: "done", reason: "执行完成", text, sessionId: common.sessionId, worktree: common.worktree };
}
