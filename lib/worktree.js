/**
 * 子代理的 worktree 隔离。
 *
 * 要解决的问题：并发写代码的子代理互相踩。现在（`team/RULES.md` 旧写法）只能靠
 * 「派之前记得别重叠」+ 人工 `git diff` 审核 —— 漏一次就是静默交叉覆盖，
 * `git diff` 只看得到结果、看不到谁盖了谁。
 *
 * ── 为什么是「包外补足」而不是 dsh 原生隔离 ────────────────────────────────
 * dsh 做不到，三层证据（详见 docs/requirements/REQ-001-worktree隔离.md §5）：
 *   1. 子代理会话 cwd 写死继承父会话：`dsh-subagent/lib/index.js:505`
 *      `childSessionMeta()` 里 `cwd: parentHeader.cwd`，而 `SubagentStartRequest`
 *      根本没有 cwd 字段 → 无法让子代理的 cwd 落在 worktree。
 *   2. `SubagentCapabilities`（`dsh-subagent/lib/types/types.d.ts:122`）里没有
 *      worktree 这一项，dsh 原生就不提供。
 *   3. 本包 import 不了 `@deepseek-ai/*`（插件是软链，ESM 走 realpath → MODULE_NOT_FOUND），
 *      所以也不能注册自定义 `SubagentProvider` 去接管子会话创建。
 * 结论：只用 `ctx.tools.register` + git CLI，做成**手动闸门**。子代理的会话 cwd 仍是
 * 主仓库 —— 所以必须把 worktree 的**绝对路径**写进它的 task（见 §7 天花板）。
 *
 * ── 三个安全属性（都实测过，见 REQ-001 §5） ────────────────────────────────
 *   · worktree 放**仓库内部**（`.dsh-worktrees/`）：沙箱把写权限限制在
 *     `sandboxPolicy.workspaceRoot`（= `process.cwd()`），放仓库外会被拒写。
 *   · 用 `.git/info/exclude` 忽略它，**不碰 `.gitignore`**（那是 tracked 文件）。
 *     不忽略的话主仓库变脏，而自动更新（lib/auto-update.js）看到脏树就跳过 ——
 *     一建 worktree 就永久停掉自动更新。
 *   · 合并冲突**自动 abort**：实测冲突会让主仓库卡在 `.git/MERGE_HEAD` 状态，
 *     不 abort 的话下次会话面对一个半合并的仓库。
 * 另外所有 git 调用都用 `-c core.hooksPath=` 抑制用户仓库的 hook（同 auto-update 的
 * 理由：自动跑用户的 post-checkout 等属于越权），且**默认不加 `--force`**
 * （git 会自己拒绝删除有未提交改动的 worktree，实测退出码 128）。
 *
 * 依赖关系：复用 `auto-update.js` 已导出的 `runGit`（同一个数组传参、同一个
 * 关凭据提示的实现），不重复造。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { runGit } from "./auto-update.js";
import { toParameterSchema } from "./util.js";

/** worktree 的根目录名（放仓库内部，沙箱要求，见文件头）。 */
export const WORKTREE_DIR = ".dsh-worktrees";

/** 分支前缀：避免撞用户已有分支。 */
export const BRANCH_PREFIX = "dsh-wt/";

export const WORKTREE_DEFAULTS = {
	enabled: true,
	timeoutMs: 30000,
	/** 合并冲突时自动回退（关掉的话主仓库会卡在 MERGING 态，不建议关）。 */
	abortOnConflict: true,
};

export const WORKTREE_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	timeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	abortOnConflict: (v) => (typeof v === "boolean" ? v : undefined),
};

// ── 纯函数部分（可单测，不依赖进程） ─────────────────────────────────────────

/**
 * 把任意字符串消毒成一个安全的 slug（只留 `[a-z0-9-]`）。
 *
 * 为什么必须消毒：slug 直接进文件路径（`.dsh-worktrees/<slug>`）和分支名
 * （`dsh-wt/<slug>`）。`../../x` 之类会写到仓库外，`a b` 会让 git 参数变味。
 * 教训来自 `lib/handoff.js` 的 `safeName`（同一个坑）。
 *
 * 冲洗后为空（输入全是特殊字符）时返回 undefined —— 宁可拒绝，不要生成一个
 * 叫 `` 的 worktree。
 *
 * @param {unknown} input
 * @returns {string|undefined}
 */
export function slugOf(input) {
	const raw = String(input ?? "").toLowerCase().trim();
	// 非 ASCII（中文等）直接丢掉 —— 保留会让分支名在某些 git/终端下出乱码。
	const cleaned = raw
		.replace(/[^a-z0-9]+/g, "-")
		// 先截断再修尾：反过来的话，超长输入截断后会留一个尾 `-`
		// （`"a"*39 + "-xxxx"` → 截断成 `"a"*39 + "-"`），而分支名尾带 `-` 很脏。
		.slice(0, 40)
		.replace(/^-+|-+$/g, "");
	return cleaned === "" ? undefined : cleaned;
}

/**
 * 从 `git rev-parse --show-toplevel` 的输出解析仓库根。
 *
 * 只做「取第一行、去空白、非空」，路径存在性由调用方查 —— 保持纯函数好单测。
 * Windows 下 git 会回 `/c/Users/...` 这种 MSYS 路径，而 Node 的文件 API 要
 * `C:/Users/...`，所以要转（`lib/bash-linux.js` 踩过同一个坑）。
 *
 * @param {string} stdout
 * @returns {string|undefined}
 */
export function parseTopLevel(stdout) {
	const first = String(stdout ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	if (first === undefined) return undefined;
	return msysToNative(first);
}

/**
 * MSYS 路径 → 原生路径（`/c/Users/x` → `C:/Users/x`）。非 MSYS 形态原样返回。
 * @param {string} p
 * @returns {string}
 */
export function msysToNative(p) {
	const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
	return m === null ? p : `${m[1].toUpperCase()}:/${m[2]}`;
}

/**
 * 解析 `git worktree list --porcelain`。
 *
 * porcelain 格式是「空行分隔的记录，每行 `key value`」，其中 `worktree <路径>`
 * 开一条新记录，`branch refs/heads/<名>` 是可选的（detached 就没有）。
 * 用 `path.resolve` 归一化，好让「这个 cwd 是不是某棵 worktree」这种比较可靠
 * （git 在 Windows 上给的路径分隔符和 Node 的不一定一致）。
 *
 * @param {string} stdout
 * @returns {Array<{path: string, branch?: string, head?: string, bare: boolean, detached: boolean}>}
 */
export function parseWorktreeList(stdout) {
	const out = [];
	let cur;
	// 去重：porcelain 正常不会重复，但畸形/并发输出可能给出重复行，
	// 而 `total` 偏大会让「仓库里一共几棵」这句误导人。
	const seen = new Set();
	for (const rawLine of String(stdout ?? "").split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") {
			cur = undefined;
			continue;
		}
		if (line.startsWith("worktree ")) {
			const resolved = path.resolve(msysToNative(line.slice("worktree ".length).trim()));
			if (seen.has(resolved)) {
				// 重复记录：忽略整条（包括它后面的 HEAD/branch 行）
				cur = undefined;
				continue;
			}
			seen.add(resolved);
			cur = { path: resolved, bare: false, detached: false };
			out.push(cur);
			continue;
		}
		if (cur === undefined) continue;
		if (line === "bare") cur.bare = true;
		else if (line === "detached") cur.detached = true;
		else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
		else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		}
	}
	return out;
}

/**
 * 从 `git status --porcelain` 的输出判断脏不脏。
 * @param {string} stdout
 * @returns {boolean}
 */
export function isDirty(stdout) {
	return String(stdout ?? "").trim() !== "";
}

/**
 * 解析 `git merge` 的结果。
 *
 * 三种结局：
 *   · `ok`       —— 合并成功，已提交
 *   · `conflict` —— 有冲突，需要 abort（调用方决定要不要真 abort）
 *   · `failed`   —— 别的失败（脏树挡住、不是 fast-forward 且没给策略等）
 *
 * 判据用**退出码 + stdout/stderr 关键词**，因为 git 冲突时退出码是 1，而别的失败
 * 也常常是 1（`--ff-only` 不能快进就是 1）。只看退出码会把「不可快进」说成「冲突」，
 * 排查方向就完全错了。冲突时 git 固定打印 `CONFLICT`（还有中文版「冲突」），
 * 而且**退出码非 0**。
 *
 * @param {{ok: boolean, stdout?: string, message?: string}} result
 * @returns {{kind: 'ok'|'conflict'|'failed', detail: string}}
 */
export function classifyMerge(result) {
	const text = `${result.stdout ?? ""}\n${result.message ?? ""}`;
	if (result.ok) return { kind: "ok", detail: "合并成功" };
	if (/CONFLICT|冲突/i.test(text)) {
		return { kind: "conflict", detail: firstLine(text) };
	}
	return { kind: "failed", detail: firstLine(text) };
}

/** 取第一行非空文本，给状态行/错误用。 */
function firstLine(text) {
	return (
		String(text ?? "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l !== "") ?? ""
	);
}

/**
 * 冲突之后的文案。**拿不准就不说「已回退」**（P1：审查指出）。
 *
 * 为什么要单独抽出来：abort 自己也可能失败，那时主仓库**仍卡在半合并态**。
 * 如果还报「已自动回退（回到干净状态）」，模型会信了然后接着干活 ——
 * 而它面对的是一个半合并的仓库，后续操作全在错的前提上。
 * 真跑里很难让 `git merge --abort` 失败，所以这层判断做成纯函数来测。
 *
 * @param {{abortedOk: boolean, abortError?: string, files: string[]}} facts
 * @returns {string}
 */
export function conflictDetail({ abortedOk, abortError, files }) {
	const list = files.length === 0 ? "（git 没报具体文件）" : files.join("、");
	if (abortedOk) {
		return `合并冲突，已自动回退（主仓库回到合并前的干净状态）。冲突文件：${list}`;
	}
	return (
		`合并冲突，而且**自动回退也失败了** —— 主仓库现在可能卡在半合并状态，` +
		`请手动 \`git status\` 检查、必要时 \`git merge --abort\`。` +
		`回退报错：${abortError ?? "未知"}。冲突文件：${list}`
	);
}

/**
 * 合并前的准入判断：主仓库脏就拒绝。
 *
 * 为什么不 stash：stash 会把用户未提交的工作暂时搬走，出意外（冲突、进程被杀）
 * 就变成「我的改动去哪了」。宁可拒绝，让用户自己决定。同 `lib/auto-update.js`。
 *
 * `dirtyUnknown` 是「读不出工作树状态」（在 `git status` 自己失败时）。
 * **它也归入拒绝**：读不出来时「当成干净」是危险方向（脏的保证是「不拉」，
 * 「读不出」当成干净就会去合并）。与 `lib/auto-update.js` 的同类处理保持一致
 * —— 上一轮的审查就在那里抓过同一个错。
 *
 * @param {{dirty: boolean, merging: boolean, dirtyUnknown?: boolean}} facts
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}}
 */
export function admitMerge(facts) {
	if (facts.merging) {
		return {
			ok: false,
			reason: "merging",
			detail: "主仓库正处于一次未完成的合并中（有 MERGE_HEAD）。先 `git merge --abort` 或完成它，再合 worktree。",
		};
	}
	if (facts.dirtyUnknown === true) {
		return {
			ok: false,
			reason: "dirty",
			detail: "读工作树状态失败，已按「有改动」保守拒绝（不会动你的仓库）。请手动 `git status` 看看出了什么事。",
		};
	}
	if (facts.dirty) {
		return {
			ok: false,
			reason: "dirty",
			detail: "主仓库有未提交改动，拒绝合并（不会 stash、不会覆盖你的改动）。先提交或清理，再合。",
		};
	}
	return { ok: true };
}

// ── 组装 git 命令（纯函数，好断言「参数里有没有 core.hooksPath」） ──────────

/**
 * 所有会改变工作区的 git 调用都过这里，统一带两个开关：
 *   · `-c core.hooksPath=` —— 不触发用户仓库自己的 hook（越权，同 auto-update）
 *   · `-c credential.helper=` 等由 `runGit` 统一加（关凭据提示）
 * @param {string[]} args
 * @returns {string[]}
 */
export function guarded(args) {
	return ["-c", "core.hooksPath=", ...args];
}

/**
 * worktree 的绝对路径。
 * @param {string} topLevel 仓库根（原生路径）
 * @param {string} slug
 */
export function worktreePathFor(topLevel, slug) {
	return path.join(topLevel, WORKTREE_DIR, slug);
}

/** worktree 对应的分支名。 */
export function branchFor(slug) {
	return `${BRANCH_PREFIX}${slug}`;
}

// ── 真跑 git 的部分 ─────────────────────────────────────────────────────────

/** 找仓库根；拿不到就返回 undefined（调用方报「不是 git 仓库」）。 */
async function topLevelOf(cwd, timeoutMs) {
	const r = await runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
	if (!r.ok) return undefined;
	return parseTopLevel(r.stdout);
}

/**
 * 确保 `.git/info/exclude` 里有 worktree 目录条目。
 *
 * 用 `info/exclude` 而不是 `.gitignore`：后者是 tracked 文件，改它就是仓库变更
 * （会进 diff、会和别人的改动冲突）；前者是每个 clone 本地的忽略表，
 * 正好是「不该进版本库的本机产物」该待的地方。实测单独用它主仓库就干净，
 * 且 `.gitignore` 不会被创建。
 *
 * 幂等：已有该行就不重复写。
 *
 * @param {string} topLevel
 * @returns {{changed: boolean, error?: string}}
 */
export function ensureExcluded(topLevel) {
	const file = path.join(topLevel, ".git", "info", "exclude");
	const entry = `${WORKTREE_DIR}/`;
	try {
		const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const has = existing
			.split("\n")
			.map((l) => l.trim())
			.some((l) => l === entry || l === WORKTREE_DIR);
		if (has) return { changed: false };
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
		fs.appendFileSync(file, `${sep}${entry}\n`, "utf8");
		return { changed: true };
	} catch (error) {
		// 不致命：忽略失败只会让主仓库变脏，用户看得见、也能自己加。
		return { changed: false, error: String(error?.message ?? error) };
	}
}

/**
 * 建一棵 worktree。
 *
 * 步骤与顺序都是有意为之：
 *   1. 找仓库根（不在 git 仓库里直接拒）
 *   2. 消毒 slug（防目录穿越）
 *   3. 查分支是否已存在（存在就拒，不覆盖别人的分支）
 *   4. 忽略目录（**在建之前**，否则中间窗口里主仓库是脏的）
 *   5. `git worktree add <abs> -b <branch>`（不带 `<commit-ish>`，即从 HEAD 起）
 *
 * @param {{cwd: string, name: unknown, base?: unknown, timeoutMs: number}} options
 */
export async function worktreeNew({ cwd, name, base, timeoutMs }) {
	const topLevel = await topLevelOf(cwd, timeoutMs);
	if (topLevel === undefined) {
		return { ok: false, reason: "not-a-repo", detail: "当前目录不在 git 仓库里，建不了 worktree。" };
	}
	const slug = slugOf(name);
	if (slug === undefined) {
		return { ok: false, reason: "bad-name", detail: "name 消毒后为空（只允许字母、数字、连字符），请换一个。" };
	}
	const branch = branchFor(slug);
	const wtPath = worktreePathFor(topLevel, slug);

	const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs);
	if (exists.ok) {
		return { ok: false, reason: "branch-exists", detail: `分支 ${branch} 已存在。换一个 name，或先用 worktree_list 看它是不是已经建过了。` };
	}
	if (fs.existsSync(wtPath)) {
		return { ok: false, reason: "path-exists", detail: `${wtPath} 已存在但不是 git worktree，请手动清理后再试。` };
	}

	const excluded = ensureExcluded(topLevel);
	const baseArg = typeof base === "string" && base.trim() !== "" ? base.trim() : undefined;
	// `base` 直接进 git 参数。execFile 不过 shell，但 `--xxx` 形态会被 git 当选项解析
	// （纵深防御，同 auto-update 对 remote/branch 的处理：拒绝它零成本）。
	if (baseArg !== undefined && baseArg.startsWith("-")) {
		return { ok: false, reason: "bad-base", detail: "base 不能以 `-` 开头（git 会当选项解析）。给提交号、分支名或 tag。" };
	}
	if (baseArg !== undefined) {
		// 不合法就早点报，而不是等 worktree add 报一句看不懂的错。
		const known = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${baseArg}^{commit}`], timeoutMs);
		if (!known.ok) {
			return { ok: false, reason: "bad-base", detail: `找不到提交 ${baseArg}（用提交号、分支名或 tag）。` };
		}
	}
	const args = guarded(["worktree", "add", wtPath, "-b", branch, ...(baseArg === undefined ? [] : [baseArg])]);
	const added = await runGit(cwd, args, timeoutMs);
	if (!added.ok) {
		return { ok: false, reason: "git-failed", detail: added.message ?? "git worktree add 失败" };
	}
	return {
		ok: true,
		slug,
		branch,
		path: wtPath,
		topLevel,
		// 写进子代理 task 的关键信息就是 absolute path —— 见 REQ-001 §7。
		hint: `派子代理时把绝对路径 ${wtPath} 写进 task，并明确要求它对文件用绝对路径（子代理的会话 cwd 仍是主仓库）。`,
		excluded: excluded.changed,
		excludedError: excluded.error,
	};
}

/**
 * 列出所有 worktree，并标出每棵的脏/净。
 *
 * 脏/净要**逐个进各自的目录查** `git status` —— 在仓库根查只能看到主仓库的状态。
 *
 * @param {{cwd: string, timeoutMs: number}} options
 */
export async function worktreeList({ cwd, timeoutMs }) {
	const topLevel = await topLevelOf(cwd, timeoutMs);
	if (topLevel === undefined) {
		return { ok: false, reason: "not-a-repo", detail: "当前目录不在 git 仓库里。" };
	}
	const listed = await runGit(cwd, ["worktree", "list", "--porcelain"], timeoutMs);
	if (!listed.ok) {
		return { ok: false, reason: "git-failed", detail: listed.message ?? "git worktree list 失败" };
	}
	const trees = parseWorktreeList(listed.stdout);
	// 只查本工具建的（前缀过滤），免得对用户自己建的 worktree 逐个大扫。
	const mine = trees.filter((t) => t.branch !== undefined && t.branch.startsWith(BRANCH_PREFIX));
	const items = [];
	for (const t of mine) {
		const status = await runGit(t.path, ["status", "--porcelain"], timeoutMs);
		items.push({
			slug: t.branch.slice(BRANCH_PREFIX.length),
			branch: t.branch,
			path: t.path,
			head: t.head,
			dirty: status.ok ? isDirty(status.stdout) : undefined,
			// 读不出来要把错误也带上 —— 只给 `dirty: undefined` 等于让调用方
			// 分不清「干净」和「没读到」（P1）。
			...status.ok ? {} : { error: status.message ?? "git status 失败" },
		});
	}
	return { ok: true, topLevel, items, total: trees.length };
}

/**
 * 把一棵 worktree 的分支合回主仓库当前分支。
 *
 * 关键决策：
 *   · **`--no-ff` 而不是 `--ff-only`** —— 实测主分支只要动过（比如你自己的提交），
 *     `--ff-only` 就报 `Diverging branches can't be fast-forwarded` 退出码 1。
 *     它只在「主分支没动过」时成立，不能当默认。
 *   · **冲突自动 abort** —— 不 abort 主仓库卡在 MERGE_HEAD，下次会话面对半合并仓库。
 *     实测 `merge --abort` 能干净回退（残留 index.lock 都没有）。
 *   · **合并前查脏 + 查 MERGE_HEAD** —— 见 `admitMerge` 的理由。
 *
 * @param {{cwd: string, name: unknown, message?: unknown, abortOnConflict: boolean, timeoutMs: number}} options
 */
export async function worktreeMerge({ cwd, name, message, abortOnConflict, timeoutMs }) {
	const topLevel = await topLevelOf(cwd, timeoutMs);
	if (topLevel === undefined) {
		return { ok: false, reason: "not-a-repo", detail: "当前目录不在 git 仓库里。" };
	}
	const slug = slugOf(name);
	if (slug === undefined) {
		return { ok: false, reason: "bad-name", detail: "name 消毒后为空，请换一个。" };
	}
	const branch = branchFor(slug);

	const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs);
	if (!exists.ok) {
		return { ok: false, reason: "no-branch", detail: `找不到分支 ${branch}（用 worktree_list 看看现在有什么）。` };
	}

	// 准入：脏 / 半合并都拒。
	const status = await runGit(cwd, ["status", "--porcelain"], timeoutMs);
	const merging = fs.existsSync(path.join(topLevel, ".git", "MERGE_HEAD"));
	const admitted = admitMerge({
		// `git status` 自己失败时不能当成干净 —— 那是危险方向（同 auto-update 的教训）。
		dirty: status.ok ? isDirty(status.stdout) : false,
		dirtyUnknown: !status.ok,
		merging,
	});
	if (!admitted.ok) {
		return { ok: false, reason: admitted.reason, detail: admitted.detail };
	}

	const msg =
		typeof message === "string" && message.trim() !== "" ? message.trim() : `merge ${branch}`;
	const merged = await runGit(cwd, guarded(["merge", "--no-ff", "-m", msg, branch]), timeoutMs);
	const verdict = classifyMerge(merged);

	if (verdict.kind === "ok") {
		const head = await runGit(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs);
		return { ok: true, slug, branch, head: head.ok ? head.stdout.trim() : undefined, detail: verdict.detail };
	}

	if (verdict.kind === "conflict") {
		const conflicted = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"], timeoutMs);
		const files = conflicted.ok
			? conflicted.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l !== "")
			: [];
		if (abortOnConflict) {
			const aborted = await runGit(cwd, guarded(["merge", "--abort"]), timeoutMs);
			return {
				ok: false,
				reason: "conflict",
				detail: conflictDetail({ abortedOk: aborted.ok, abortError: aborted.message, files }),
				files,
				aborted: aborted.ok,
				abortError: aborted.ok ? undefined : aborted.message,
			};
		}
		return {
			ok: false,
			reason: "conflict",
			detail: `合并冲突，**主仓库正卡在合并中**（abortOnConflict 关掉了）。冲突文件：${files.join("、")}。请手动处理或 \`git merge --abort\`。`,
			files,
			aborted: false,
		};
	}

	return { ok: false, reason: "git-failed", detail: verdict.detail };
}

/**
 * 删掉一棵 worktree（可连带删分支）。
 *
 * **默认不加 `--force`**：实测有未提交改动时 git 会拒绝（`fatal: contains modified
 * or untracked files, use --force to delete it`，退出码 128），这正是我们要的 ——
 * 宁可报错，不要静默丢掉还没合并的工作。想强删由调用方显式传 `force`。
 *
 * 顺序：先删 worktree 再删分支（分支被 worktree 占着时 git 不让删）。
 *
 * @param {{cwd: string, name: unknown, force: boolean, keepBranch: boolean, timeoutMs: number}} options
 */
export async function worktreeDrop({ cwd, name, force, keepBranch, timeoutMs }) {
	const topLevel = await topLevelOf(cwd, timeoutMs);
	if (topLevel === undefined) {
		return { ok: false, reason: "not-a-repo", detail: "当前目录不在 git 仓库里。" };
	}
	const slug = slugOf(name);
	if (slug === undefined) {
		return { ok: false, reason: "bad-name", detail: "name 消毒后为空，请换一个。" };
	}
	const branch = branchFor(slug);
	const wtPath = worktreePathFor(topLevel, slug);

	// 只在目录真的存在时才删（分支可能还在、worktree 已经没了）。
	let removedPath = false;
	if (fs.existsSync(wtPath)) {
		const removed = await runGit(cwd, guarded(["worktree", "remove", ...(force ? ["--force"] : []), wtPath]), timeoutMs);
		if (!removed.ok) {
			const dirty = /modified or untracked|contains modified/i.test(removed.message ?? "");
			return {
				ok: false,
				reason: dirty ? "dirty" : "git-failed",
				detail: dirty
					? `${wtPath} 里有未提交改动，git 拒绝了。先合并或提交，或确认真要丢弃时用 force=true。`
					: (removed.message ?? "git worktree remove 失败"),
			};
		}
		removedPath = true;
		// 清掉残留的空目录（git 正常会删干净，保险起见）。
		try {
			fs.rmSync(path.join(topLevel, WORKTREE_DIR, slug), { recursive: true, force: true });
		} catch {
			/* 无所谓 */
		}
	}

	let removedBranch = false;
	if (!keepBranch) {
		const exists = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs);
		if (exists.ok) {
			// 分支上有没有未合并的提交？有就默认不删（-d 会拒绝，报给模型）。
			const del = await runGit(cwd, ["branch", ...(force ? ["-D"] : ["-d"]), branch], timeoutMs);
			if (!del.ok) {
				const unmerged = /not fully merged|未完全合并/i.test(del.message ?? "");
				return {
					ok: removedPath,
					reason: unmerged ? "unmerged" : "branch-failed",
					// 文案要跟着 `removedPath` 走 —— worktree 本来就不存在时
					// 说「worktree 已删」是假的（P2）。
					detail: unmerged
						? `${removedPath ? "worktree 已删，但" : ""}分支 ${branch} 上有未合并的提交，git 拒绝删除（避免丢工作）。确认不要了就 force=true。`
						: (del.message ?? `git branch -d ${branch} 失败`),
					removedPath,
					removedBranch: false,
				};
			}
			removedBranch = true;
		}
	}

	// 顺手清掉空的 .dsh-worktrees/ 目录（不是错误）。
	const root = path.join(topLevel, WORKTREE_DIR);
	try {
		if (fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
	} catch {
		/* 无所谓 */
	}

			// force 会同时丢掉「未提交改动」和「未合并的提交」—— 都不可逆，
			// 所以文案必须把这一点明说，不能让模型以为只是「清理一下」（P2）。
			const detail = force
				? `已强删 worktree${removedBranch ? " 和分支 " + branch : ""}。**未提交的改动和未合并的提交已不可恢复地丢弃**（你没走默认的安全路径）。`
				: `已删除 worktree${removedBranch ? " 和分支" : ""}。`;
			return { ok: true, slug, branch, removedPath, removedBranch, detail };
}

// ── 渲染给模型看的文本 ───────────────────────────────────────────────────────

/** 把 worktree_list 的结果渲染成一段紧凑文本。 */
export function renderList(result) {
	if (!result.ok) return `[失败] ${result.detail}`;
	if (result.items.length === 0) {
		return `没有本工具建的 worktree（仓库里一共 ${result.total} 棵）。用 worktree_new 建一棵。`;
	}
	const lines = result.items.map((item) => {
		const state = item.dirty === undefined ? "状态未知" : item.dirty ? "★有未提交改动" : "干净";
		return `- ${item.slug} → ${item.path}（${item.branch}，${state}）`;
	});
	return `worktree（${result.items.length} 棵，仓库里一共 ${result.total} 棵）：\n${lines.join("\n")}`;
}

/**
 * 装 4 个工具。
 *
 * `tools` 是 dsh 的必需服务；不需要别的注入 —— 本模块只用 git CLI，
 * 不碰 dsh 内部 API（这正是能绕开「import 不了 @deepseek-ai/*」的原因）。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} options
 * @param {object} options.config 已叠好的配置
 * @returns {{enabled: boolean, reason?: string, describe: () => string, dispose: () => void}}
 */
export function installWorktree(ctx, { config }) {
	if (config.enabled !== true) {
		return {
			enabled: false,
			reason: "配置里关掉了",
			describe: () => "worktree 隔离：关  （配置里关掉了）",
			dispose: () => {},
		};
	}

	const timeoutMs = config.timeoutMs;
	/** 取会话 cwd（工具调用的默认工作目录）。 */
	const baseCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

	const disposers = [];
	// 输出形状（4 个工具都是「一段文本」），写成工厂避免重复 4 遍。
	const text = () => ({
		schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
		render: (_args, value) => [{ type: "text", text: value.text }],
	});

	disposers.push(
		ctx.tools.register({
			name: "worktree_new",
			description:
				"给一个子任务建一棵独立 git worktree（放仓库内 `.dsh-worktrees/<name>`，新分支 `dsh-wt/<name>`），用于**隔离并发写代码的子代理**。" +
				"返回的绝对路径必须写进子代理的 task，并要求它对文件用绝对路径 —— 子代理的会话 cwd 仍是主仓库，不会自动切到 worktree。" +
				"做完用 `worktree_merge` 合回主分支、`worktree_drop` 丢弃。",
			parameters: toParameterSchema({
				name: { type: "string", required: true, description: "短名字（只用字母数字连字符），如 `fix-login`。" },
				base: { type: "string", description: "从哪个提交起（默认当前 HEAD）。" },
				description: { type: "string", description: "这棵 worktree 干什么，5-10 个词。" },
			}),
			output: text(),
			async execute(args, exec) {
				const name = String(args?.name ?? "");
				if (name.trim() === "") return { text: "请给出 name。" };
				const r = await worktreeNew({ cwd: baseCwd(exec), name, base: args?.base, timeoutMs });
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				const warn = r.excludedError === undefined ? "" : `\n（注意：忽略目录失败 ${r.excludedError}，主仓库可能会显示 .dsh-worktrees 未跟踪）`;
				return {
					text: `已建 worktree：${r.path}\n分支：${r.branch}\n起始提交：${r.topLevel ? "当前 HEAD" : "?"}${warn}\n\n派子代理时把「${r.path}」写进 task，并写明：对文件用绝对路径（会话 cwd 不会自动切过去）。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "worktree_list",
			description: "列出本工具建的 worktree 及各自有没有未提交改动。合并/丢弃前先看这个。",
			parameters: toParameterSchema({ description: { type: "string", description: "5-10 个词说明。" } }),
			output: text(),
			async execute(_args, exec) {
				const r = await worktreeList({ cwd: baseCwd(exec), timeoutMs });
				return { text: renderList(r) };
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "worktree_merge",
			description:
				"把一棵 worktree 的分支合回主仓库当前分支（`merge --no-ff`）。" +
				"主仓库有未提交改动、或正卡在合并中时会拒绝（不 stash、不覆盖）。" +
				"冲突时自动回退主仓库并列出冲突文件，不会留半合并状态。不推送。",
			parameters: toParameterSchema({
				name: { type: "string", required: true, description: "worktree 的短名字。" },
				message: { type: "string", description: "合并提交信息，默认 `merge dsh-wt/<name>`。" },
				description: { type: "string", description: "5-10 个词说明。" },
			}),
			output: text(),
			async execute(args, exec) {
				const name = String(args?.name ?? "");
				if (name.trim() === "") return { text: "请给出 name。" };
				const r = await worktreeMerge({
					cwd: baseCwd(exec),
					name,
					message: args?.message,
					abortOnConflict: config.abortOnConflict,
					timeoutMs,
				});
				if (r.ok) return { text: `已合并 ${r.branch} 到当前分支（${r.head ?? "?"}）。未推送 —— 要推由你决定。` };
				return { text: `[失败] ${r.detail}` };
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "worktree_drop",
			description:
				"删掉一棵 worktree（默认连带删分支）。有未提交改动时 git 会拒绝，**不会静默丢工作**；确认真要丢弃才传 force=true。" +
				"分支上有未合并的提交同样会被拒。",
			parameters: toParameterSchema({
				name: { type: "string", required: true, description: "worktree 的短名字。" },
				force: { type: "boolean", description: "强删（丢弃未提交改动 / 未合并提交）。默认 false。" },
				keepBranch: { type: "boolean", description: "只删 worktree，保留分支。默认 false。" },
				description: { type: "string", description: "5-10 个词说明。" },
			}),
			output: text(),
			async execute(args, exec) {
				const name = String(args?.name ?? "");
				if (name.trim() === "") return { text: "请给出 name。" };
				const r = await worktreeDrop({
					cwd: baseCwd(exec),
					name,
					force: args?.force === true,
					keepBranch: args?.keepBranch === true,
					timeoutMs,
				});
				if (r.ok) return { text: r.detail };
				// 部分成功（worktree 删了、分支没删）也要如实说。
				return { text: `[${r.reason === "unmerged" ? "部分完成" : "失败"}] ${r.detail}` };
			},
		}),
	);

	return {
		enabled: true,
		describe: () => "worktree 隔离：开  （4 个工具：new / list / merge / drop）",
		dispose: () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 已经没了 */
				}
			}
		},
	};
}
