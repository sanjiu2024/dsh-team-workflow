/**
 * Git 通道：把执行结果变成一个 Pull Request（REQ-038 第二批）。
 *
 * ## 为什么这一步在编排层，不在 agent 里
 *
 * 和发评论同一个理由（`reply-github.js` 头注释）：**凭据不进 agent**。
 * issue 正文是不可信输入，而 push 要凭据；让 agent 自己 push 等于把推送权交给一段
 * 可能被注入的对话。所以分工是：**agent 只许写 worktree**，commit / push / 开 PR 由这里做，
 * 用的是编排层自己的凭据（`gh` 的 keychain）。
 *
 * ## 上游的语义
 *
 * `001-domain` 里 Channel 的定义是「Thread 的写回路径」，并明确列出
 * "**Acknowledgements, replies, pull requests and resolved reviews are all writes**"。
 * 也就是说 PR 和评论是**同一层的两种写**，不是「回评论」的补充功能。
 *
 * ## 三种结局
 *
 * ```text
 * worktree 里有未提交改动 → 我们替它 commit（作者信息用 agent 的名义）→ push → 开 PR
 * worktree 里已有新提交   → 直接 push → 开 PR
 * 都没有                  → 不开 PR（回评论就够了）
 * ```
 *
 * 为什么不替 agent 处理「它已经 commit 过但没 push」之外的更多情况：
 * 那会开始猜它的意图。有改动就提交、有提交就推、都没有就不动 —— 三个判断都只看
 * git 自己的事实。
 *
 * @module dsh-team-workflow/superagent/git-channel
 */

/** 一个 worktree 里能不能形成一次 PR。 */
export const NO_CHANGE = "no-change";

/**
 * 读 worktree 的状态：有没有未提交改动、有没有新提交。
 *
 * @param {(argv: string[], cwd?: string) => Promise<{ code: number, stdout: string, stderr: string }>} run
 *   git 执行器（注入，测试里换假的）
 * @param {string} worktree worktree 的绝对路径
 * @param {string} base 对比的基准分支（通常是 master / main）
 * @returns {Promise<{ dirty: boolean, ahead: number, branch: string, files: string[] }>}
 */
export async function readWorktreeState(run, worktree, base) {
	const status = await run(["status", "--porcelain"], worktree);
	const dirty = status.code === 0 && String(status.stdout ?? "").trim() !== "";
	const files = dirty
		? String(status.stdout)
				.split("\n")
				.map((line) => line.slice(3).trim())
				.filter((name) => name !== "")
		: [];

	// 当前分支：worktree 建时就定了（`dsh-wt/<slug>`），但读一次比记住更可靠
	const head = await run(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
	const branch = head.code === 0 ? String(head.stdout ?? "").trim() : "";

	// 领先基准多少个提交。`base` 不存在时 git 会报错，这时按「不知道」处理（ahead = 0）
	const count = await run(["rev-list", "--count", `${base}..HEAD`], worktree);
	const ahead = count.code === 0 ? Number.parseInt(String(count.stdout ?? "").trim(), 10) || 0 : 0;

	return { dirty, ahead, branch, files };
}

/**
 * 把 worktree 的改动做成一个 PR。
 *
 * @param {object} deps
 * @param {(argv: string[], cwd?: string) => Promise<{ code: number, stdout: string, stderr: string }>} deps.git
 * @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} deps.gh
 * @param {string} deps.worktree
 * @param {string} deps.base 目标分支
 * @param {string} deps.repo `owner/name`
 * @param {{ title: string, body: string, commentId: string }} deps.pr
 * @param {(message: string) => void} [deps.log]
 * @returns {Promise<{ ok: boolean, prUrl?: string, branch?: string, reason?: string, error?: string }>}
 */
export async function openPullRequest(deps, { worktree, base, repo, pr }) {
	const { git, gh } = deps ?? {};
	if (typeof git !== "function") throw new Error("openPullRequest: 需要 git 执行器");
	if (typeof gh !== "function") throw new Error("openPullRequest: 需要 gh 执行器");

	const state = await readWorktreeState(git, worktree, base);
	if (state.branch === "") {
		return { ok: false, reason: "no-branch", error: "读不到 worktree 的当前分支" };
	}

	// 都没有改动 → 不是失败，是「这次不需要 PR」
	if (!state.dirty && state.ahead === 0) return { ok: true, reason: NO_CHANGE };

	// ① 有未提交改动就替它提交。作者信息用 agent 的名义 —— 人要能一眼看出这是谁改的。
	if (state.dirty) {
		const added = await git(["add", "-A"], worktree);
		if (added.code !== 0) return { ok: false, error: `git add 失败：${String(added.stderr ?? "").trim().slice(0, 200)}` };
		const message = [
			`superagent: ${pr.title}`,
			"",
			`来自评论 ${pr.commentId}。`,
			"",
			"由 dsh-team-workflow 的 superagent 通道代提交 —— 执行者只写 worktree，",
			"commit / push / 开 PR 都在编排层做（凭据不下放给会话）。",
		].join("\n");
		const committed = await git(["commit", "-m", message], worktree);
		// 「没有可提交的东西」不是错（可能刚被别人提交了），其余都算错
		if (committed.code !== 0 && !/nothing to commit/i.test(String(committed.stdout ?? ""))) {
			return { ok: false, error: `git commit 失败：${String(committed.stderr ?? "").trim().slice(0, 200)}` };
		}
	}

	// ② 推分支。`-u` 让后续能直接 push
	const pushed = await git(["push", "-u", "origin", state.branch], worktree);
	if (pushed.code !== 0) {
		return { ok: false, error: `git push 失败：${String(pushed.stderr ?? "").trim().slice(0, 300)}` };
	}

	// ③ 开 PR。用 `gh pr create`，它自己处理「已存在同名 PR」的情况（会报错，我们透传）
	const created = await gh([
		"pr",
		"create",
		"--repo",
		repo,
		"--head",
		state.branch,
		"--base",
		base,
		"--title",
		pr.title,
		"--body",
		pr.body,
	]);
	if (created.code !== 0) {
		const detail = String(created.stderr ?? "").trim().slice(0, 400);
		// 已经有 PR 了：不算失败 —— 分支推上去了，PR 也在，回评论时带上链接就行
		if (/already exists/i.test(detail)) {
			const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(detail)?.[0];
			return { ok: true, reason: "existing", ...(url === undefined ? {} : { prUrl: url }), branch: state.branch };
		}
		return { ok: false, error: `gh pr create 失败：${detail}` };
	}
	const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(String(created.stdout ?? ""))?.[0];
	return { ok: true, ...(url === undefined ? {} : { prUrl: url }), branch: state.branch };
}
