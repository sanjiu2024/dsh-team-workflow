/**
 * GitHub 轮询：把「新的、可能是一条指令的评论」捞出来。
 *
 * ## 增量只用 comment id 高水位
 *
 * 2026-11-08 计划审查点名：`since` 与 ETag 是两套不同的增量，混用会漏 ——
 * `since` 不含 issue 正文与关闭状态的变化，304 又不给游标。所以这里**只用一个游标**：
 * 已处理过的最大 `comment.id`。比它小的全部跳过，即使漏跑也能靠「重放旧 id」补回来。
 *
 * ## 跳过自己发的评论
 *
 * 我们自己回的评论带 `<!-- dsh-superagent -->` 标记（见 `reply-github.js`）。
 * 不跳过的话，一次成功的回复会变成下一轮的触发源 —— 自己叫自己干活，无限循环。
 *
 * ## 不做的事
 *
 * - 不判断「该不该执行」（那是 Policy 的事）
 * - 不发评论（那是 reply-github 的事）
 * - 不写状态（游标由调用方在**确实处理完**之后推进）
 *
 * ## 一条 GitHub 的坑（2026-11-08 真仓库实测）
 *
 * `/issues?state=open&sort=updated` 有**索引延迟**：刚建的 issue 单查是 `state=open`，
 * 但列表里查不到（等几十秒才出现）。所以「新建 issue 立刻轮询能看到」这个假设是**错的**。
 * 对轮询没有影响（下一轮自然捞到），但写测试/写文档时别拿它当同步断言 ——
 * 那会得到一个有时绿有时红的测试。
 *
 * @module dsh-team-workflow/superagent/source-github
 */

/** 我们自己的评论标记。 */
export const SELF_MARKER = "<!-- dsh-superagent -->";

/** `gh` 单次最多拉多少条评论（GitHub 上限 100）。 */
const PER_PAGE = 100;

/** 一次轮询最多看多少个 issue（按 updated 倒序取，新动静优先）。 */
const MAX_ISSUES = 30;

/**
 * 比较两个 comment id（GitHub 的 id 是数字字符串，可能超 `Number.MAX_SAFE_INTEGER`）。
 *
 * 用 BigInt 而不是 `Number()`：`Number("9007199254740993")` 会静默丢精度，
 * 两条相邻的 id 会判成相等 —— 那种 bug 一年也遇不到一次，遇到就是「某条评论永远不处理」。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 / 0 / 1
 */
export function compareCommentId(a, b) {
	const toBig = (value) => {
		try {
			return BigInt(String(value ?? "0").trim() || "0");
		} catch {
			return 0n;
		}
	};
	const left = toBig(a);
	const right = toBig(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

/** 这条评论是不是我们自己发的。 */
export function isSelfComment(body) {
	return typeof body === "string" && body.includes(SELF_MARKER);
}

/**
 * 把一个 GitHub 评论对象收成 Policy 能吃的形状。
 *
 * 字段名保留 GitHub 的 `author_association` / `issue_url` 等原样，
 * 少做一层映射就少一处「名字对不上」的可能 —— 只把 Policy 要用的几个提上来。
 *
 * @param {object} raw GitHub 评论对象
 * @param {number} issueNumber
 * @param {string} repo
 * @returns {object|null} 缺关键字段时返回 null（坏记录不该让整轮轮询失败）
 */
export function toCommentEvent(raw, issueNumber, repo) {
	if (raw === null || typeof raw !== "object") return null;
	const commentId = raw.id === undefined || raw.id === null ? "" : String(raw.id);
	const author = String(raw.user?.login ?? "");
	if (commentId === "" || author === "") return null;
	return {
		source: "github",
		repo,
		issueNumber,
		commentId,
		author,
		authorAssociation: String(raw.author_association ?? "NONE"),
		body: typeof raw.body === "string" ? raw.body : "",
		url: typeof raw.html_url === "string" ? raw.html_url : "",
		createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
	};
}

/**
 * 把 issue **正文**收成一个事件。
 *
 * 为什么正文也要算：2026-11-08 在真仓库上冒烟时发现的缺口 —— 触发词写在 issue 正文里
 * （「我要这个改动，/agent 去做」是最自然的写法），而 `/issues/{n}/comments` 不含正文，
 * 于是那条需求永远触发不了。单测全绿是因为假数据里只造了评论。
 *
 * 虚拟 id 用 `issue-<号>`：它没有 comment id，所以**不参与游标比较**，
 * 去重靠 `store.claim` 的幂等（处理过就 skipped）。代价是每轮都会尝试 claim 一次，很廉价。
 *
 * @param {object} issue GitHub issue 对象
 * @param {string} repo
 * @returns {object|null}
 */
export function toIssueBodyEvent(issue, repo) {
	if (issue === null || typeof issue !== "object") return null;
	const issueNumber = Number(issue.number);
	const author = String(issue.user?.login ?? "");
	const body = typeof issue.body === "string" ? issue.body : "";
	// 空正文不该占一个事件位；PR 的正文除外不了，但 PR 正文里写触发词同样合理
	if (!Number.isInteger(issueNumber) || issueNumber <= 0 || author === "" || body.trim() === "") return null;
	return {
		source: "github",
		repo,
		issueNumber,
		commentId: `issue-${issueNumber}`,
		author,
		authorAssociation: String(issue.author_association ?? "NONE"),
		body,
		url: typeof issue.html_url === "string" ? issue.html_url : "",
		createdAt: typeof issue.created_at === "string" ? issue.created_at : "",
		kind: "issue-body",
	};
}

/**
 * 拉一轮新评论。
 *
 * @param {{ run: (argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }> }} deps
 * @param {{ repo: string, cursor?: string | null, maxIssues?: number }} options
 *   `cursor` 是上一次处理到的 comment id；缺省表示第一次跑（只取最近一页，不回溯历史）。
 * @returns {Promise<{ comments: object[], nextCursor: string | null, scanned: number, errors: string[] }>}
 */
export async function fetchNewComments(deps, { repo, cursor = null, maxIssues = MAX_ISSUES } = {}) {
	if (typeof deps?.run !== "function") throw new Error("fetchNewComments: 需要 run（gh 执行器）");
	if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ""))) throw new Error(`仓库名不合法：${repo}`);

	const errors = [];
	const comments = [];
	let scanned = 0;
	// 基准游标必须在**本轮开始前**固定：遍历中不断更新 highest 当过滤条件的话，
	// 同轮里排在后面的小 id 会被误判成「低于游标」—— 2026-11-08 自检逮到过（105 先出现，104 就丢了）。
	const base = cursor === null || cursor === undefined ? null : String(cursor);
	let highest = base;

	/** 跑一次 gh api 并解析 JSON；失败记进 errors 并返回 null（一轮里个别 issue 挂了不该毁掉整轮）。 */
	const api = async (path) => {
		let result;
		try {
			result = await deps.run(["api", path]);
		} catch (error) {
			errors.push(`${path}: ${String(error?.message ?? error)}`);
			return null;
		}
		if (result?.code !== 0) {
			errors.push(`${path}: gh 退出码 ${result?.code} ${String(result?.stderr ?? "").trim().slice(0, 160)}`);
			return null;
		}
		try {
			return JSON.parse(String(result?.stdout ?? ""));
		} catch {
			errors.push(`${path}: 返回不是 JSON`);
			return null;
		}
	};

	// ① 拉 open 的 issue / PR（GitHub 把 PR 也算 issue），按最近更新排
	const issues = await api(`/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${maxIssues}`);
	if (!Array.isArray(issues)) {
		return { comments, nextCursor: highest, scanned, errors: errors.length > 0 ? errors : ["拉 issue 列表失败"] };
	}

	for (const issue of issues) {
		if (issue === null || typeof issue !== "object") continue;
		const issueNumber = Number(issue.number);
		if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;

		// ① issue 正文：不看游标（虚拟 id 没法比），去重交给 claim。
		//    自己发的跳过 —— 迭代时我们自己的回复在**评论**里，正文不会，但标记检查顺手保留。
		const bodyEvent = toIssueBodyEvent(issue, repo);
		if (bodyEvent !== null && !isSelfComment(bodyEvent.body)) comments.push(bodyEvent);

		// ② 评论：PR 的评论也在 issues/{n}/comments 下，一并拉 —— 「在 PR 上让它改」是必需的
		const list = await api(`/repos/${repo}/issues/${issueNumber}/comments?per_page=${PER_PAGE}`);
		if (!Array.isArray(list)) continue;
		scanned += list.length;
		for (const raw of list) {
			const event = toCommentEvent(raw, issueNumber, repo);
			if (event === null) continue;
			if (isSelfComment(event.body)) continue; // 自己发的不能当触发源
			if (base !== null && compareCommentId(event.commentId, base) <= 0) continue;
			comments.push(event);
			if (highest === null || compareCommentId(event.commentId, highest) > 0) highest = event.commentId;
		}
	}

	// 按 id 升序返回：调用方顺序处理，游标才单调
	comments.sort((a, b) => compareCommentId(a.commentId, b.commentId));
	return { comments, nextCursor: highest, scanned, errors };
}
