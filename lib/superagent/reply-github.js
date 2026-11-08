/**
 * 把执行结果回贴到 GitHub 的原始 issue / PR 上。
 *
 * ## 为什么这一步必须在编排层，不能交给 agent
 *
 * 2026-11-08 计划审查点名的硬点：**凭据不进 agent**。
 * 触发这次执行的正文来自 issue —— 不可信输入；而 agent 的会话固定 `danger-full-access`。
 * 如果让 agent 自己 `gh pr comment`，一句精心构造的提示词就能让它用我们的 token 去改别的仓库。
 *
 * 所以分工是：**agent 只许写 worktree**，推送与发评论由编排层做，用的是编排层自己的凭据。
 *
 * ## 幂等
 *
 * 同一条评论只回一次。`deliverReply` 先查 store 里的 `replied` 标记，发成功才写 ——
 * 崩在「发出去」与「记下来」之间会重复发一次，这个窗口没法消除（GitHub 没有幂等键），
 * 但比「每次重试都发一遍」好得多。
 *
 * @module dsh-team-workflow/superagent/reply-github
 */

/** GitHub 单条评论的正文上限（含 markdown）。超了会被 API 拒，所以先截。 */
export const MAX_COMMENT_CHARS = 60_000;

/**
 * 给回复加上可识别的标记，同时压掉过长内容。
 *
 * 标记的用处：面板和后续轮询能一眼认出「这条是我们发的」，不会把 agent 自己的回复
 * 当成新的触发源（那会自己触发自己）。
 *
 * @param {string} body
 * @param {{ status?: string, sessionId?: string, branch?: string }} [meta]
 * @returns {string}
 */
export function composeComment(body, meta = {}) {
	const lines = [];
	const text = String(body ?? "").trim();
	if (text.length > MAX_COMMENT_CHARS - 500) {
		// 留 500 字符给标记与说明；截断处明说被截了，别让人以为全文就这些
		lines.push(`${text.slice(0, MAX_COMMENT_CHARS - 500)}`, "", "…（内容过长，已截断）");
	} else if (text !== "") {
		lines.push(text);
	} else {
		lines.push("（本次执行没有产出文本）");
	}

	const facts = [];
	if (meta.status) facts.push(`状态：${meta.status}`);
	if (meta.branch) facts.push(`分支：\`${meta.branch}\``);
	if (meta.sessionId) facts.push(`会话：\`${meta.sessionId}\``);
	if (facts.length > 0) lines.push("", `---`, "", facts.join(" · "));

	lines.push("", "<!-- dsh-superagent -->");
	return lines.join("\n");
}

/**
 * 发一条评论到 issue / PR。
 *
 * `run` 是注入的 gh 执行器（测试里换假的），签名：
 * `(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>`
 *
 * @param {{ run: (argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }> }} deps
 * @param {{ repo: string, issueNumber: number, body: string }} request
 * @returns {Promise<{ ok: boolean, url?: string, error?: string }>}
 */
export async function postComment(deps, request) {
	if (typeof deps?.run !== "function") throw new Error("postComment: 需要 run（gh 执行器）");
	const repo = String(request?.repo ?? "");
	const issueNumber = Number(request?.issueNumber ?? 0);
	const body = String(request?.body ?? "");
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: `仓库名不合法：${repo}` };
	if (!Number.isInteger(issueNumber) || issueNumber <= 0) return { ok: false, error: `issue 号不合法：${issueNumber}` };
	if (body.trim() === "") return { ok: false, error: "评论正文为空" };

	const argv = ["api", "-X", "POST", `/repos/${repo}/issues/${issueNumber}/comments`, "-f", `body=${body}`];
	let result;
	try {
		result = await deps.run(argv);
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error ?? "gh 调用失败") };
	}
	if (result?.code !== 0) {
		const detail = String(result?.stderr ?? "").trim().slice(0, 400);
		return { ok: false, error: `gh 退出码 ${result?.code}${detail === "" ? "" : `：${detail}`}` };
	}
	// gh api 返回 JSON；拿不到 url 不算失败（评论已经发出去了，只是没解析出链接）
	let url;
	try {
		const parsed = JSON.parse(String(result?.stdout ?? ""));
		if (typeof parsed?.html_url === "string") url = parsed.html_url;
	} catch {
		/* 解析不出就不带链接 */
	}
	return { ok: true, ...(url === undefined ? {} : { url }) };
}

/**
 * 发回复并记下「已回」，同一条评论不重复发。
 *
 * @param {{ run: Function, store: import("./store.js").SuperagentStore }} deps
 * @param {{ commentId: string, repo: string, issueNumber: number, body: string,
 *   status?: string, sessionId?: string, branch?: string }} request
 * @returns {Promise<{ ok: boolean, skipped?: boolean, url?: string, error?: string }>}
 */
export async function deliverReply(deps, request) {
	const commentId = String(request?.commentId ?? "");
	if (commentId === "") throw new Error("deliverReply: 需要 commentId");

	// 已经回过就不再发 —— 重试、重跑、崩溃恢复都走这条
	const state = await deps.store.read();
	const existing = state.tickets[commentId];
	if (existing?.replied === true) {
		return { ok: true, skipped: true };
	}

	const body = composeComment(request?.body, {
		status: request?.status,
		sessionId: request?.sessionId,
		branch: request?.branch,
	});
	const posted = await postComment(deps, {
		repo: request?.repo,
		issueNumber: request?.issueNumber,
		body,
	});
	if (!posted.ok) return posted;

	await deps.store.update((next) => {
		const ticket = next.tickets[commentId] ?? {};
		ticket.replied = true;
		if (posted.url !== undefined) ticket.replyUrl = posted.url;
		next.tickets[commentId] = ticket;
	});
	return posted;
}
