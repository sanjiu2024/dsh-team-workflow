/**
 * 启动时自动更新：比对远端与本地的版本，不一致就拉。
 *
 * 为什么是 git 而不是 npm：本包**不是** npm 安装的，而是软链指向开发目录
 * （`~/.dsh/profiles/tauri/node_modules/dsh-team-workflow -> Desktop/deepseek harness cj`），
 * 而且没发布到 registry（`npm view` 404）。所以「电脑上装的版本」就是**这个工作目录**
 * 里 package.json 的 version，「最新版本」只能从 git 远端取，「更新」实质是 `git pull`。
 * 写成 npm 安装路径会永远空转。
 *
 * 三条安全约束（都不是可选项）：
 *   1. **只 `--ff-only`**。不合并、不rebase、不问密码。拉不动就报一句，绝不替你决定
 *      用哪种合并方式 —— 自动更新把开发者的分支搅了是最恶劣的失败。
 *   2. **工作树脏就不动**。你有未提交改动时只提示、不 stash、不 pull。
 *      启动时静默 stash 用户的活是最不能接受的。
 *   3. **不阻塞启动**。网络慢时 `git fetch` 可以拖很久，所以整个检查在后台跑、
 *      带超时，失败只影响自己那一行状态。
 *
 * 生效时机：**下次启动**。实测 dsh 的 HMR 只监听 `cordis.patch.yml` 一个配置文件
 * （`dsh-app-boot` 的 `watchUserPatches` 是 `hmr.registerConfig(filename, …)`，只重装
 * patch 层），不监听插件源码 —— 所以 pull 下来的 JS 不会半途热加载，没有「一半新一半旧」
 * 的中间态。本进程跑的仍是拉之前已加载的代码。
 *
 * 零依赖：用 node 内置 child_process 调 git。
 */
import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import * as pathModule from "node:path";

/** 配置默认值。无 Config schema —— 手写叠层（与包内其他模块一致）。 */
export const AUTO_UPDATE_DEFAULTS = {
	enabled: true,
	/** 远端名 */
	remote: "origin",
	/** 分支名；留空则用当前分支 */
	branch: "",
	/** git 命令超时（毫秒）。超时按「检查失败」处理，不影响启动。 */
	timeoutMs: 20000,
	/** 拉完之后是否提示需要重启（本包无法自己重启 dsh） */
	notifyRestart: true,
};
export const AUTO_UPDATE_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	remote: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	branch: (v) => (typeof v === "string" ? v.trim() : undefined),
	timeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	notifyRestart: (v) => (typeof v === "boolean" ? v : undefined),
};

// ── 纯函数（可单测） ────────────────────────────────────────────────────────

/**
 * 解析 `a.b.c` 形式的版本号成数字数组。不认识的部分当 0。
 * 不引 semver 依赖：本项目的版本号规则就是三段数字（见 CHANGELOG 头部）。
 *
 * @param {string} version
 * @returns {number[]}
 */
export function parseVersion(version) {
	return String(version ?? "")
		.split("-")[0]
		.split(".")
		.map((part) => {
			const n = Number.parseInt(part, 10);
			return Number.isFinite(n) ? n : 0;
		});
}

/**
 * 比对版本：a > b 返回正数，a < b 返回负数，相等 0。
 * 段数不同时短的一边补 0（`0.6` 等于 `0.6.0`）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	const len = Math.max(left.length, right.length);
	for (let i = 0; i < len; i++) {
		const x = left[i] ?? 0;
		const y = right[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

/**
 * 决定要不要拉。**纯函数**，所有 git 事实都由调用方查好传进来。
 *
 * 判定顺序是有讲究的（每一条都对应一个真会出事的场景）：
 *   1. 不是 git 仓库 → 跳过（用户可能是解压安装的，没有远端可拉）
 *   2. 工作树脏 → 跳过（有未提交改动；不 stash、不覆盖）
 *   3. 本地领先远端 → 跳过（有未推送的本地提交；`--ff-only` 也拉不动，
 *      但提前判定能给出更有用的提示）
 *   4. 本地落后远端 → **拉**
 *   5. commit 相同但有 tag/版本差异 → 只提示（不 pull，因为没东西可拉）
 *
 * @param {object} facts
 * @param {boolean} facts.isRepo 是不是 git 仓库
 * @param {boolean} facts.dirty 工作树有没有未提交改动
 * @param {boolean} [facts.dirtyUnknown] `dirty` 是因为读不出来而保守置真的（不是真查到了改动）
 * @param {string} facts.localHead
 * @param {string} facts.remoteHead
 * @param {string} facts.localVersion 本地 package.json 的 version
 * @param {string} facts.remoteVersion 远端 package.json 的 version
 * @param {number} facts.behind 本地落后几个提交
 * @param {number} facts.ahead 本地领先几个提交
 * @returns {{action: "skip"|"pull"|"up-to-date", reason: string, detail: string}}
 */
export function decideUpdate(facts) {
	if (facts?.isRepo !== true) {
		return { action: "skip", reason: "not-a-repo", detail: "当前目录不是 git 仓库，没有远端可拉。" };
	}
	if (facts.dirty === true) {
		// 区分「确实有改动」与「读不出来，保守当成有改动」—— 后者的建议不同
		// （该去看 git 为何读不出，而不是去处理不存在的改动）。
		const detail =
			facts.dirtyUnknown === true
				? "读工作树状态失败，已按「有改动」保守跳过（不会动你的仓库）。"
				: "工作目录有未提交改动，已跳过自动更新（不会 stash 或覆盖你的改动）。";
		return { action: "skip", reason: "dirty", detail };
	}
	if ((facts.ahead ?? 0) > 0) {
		// 分叉（ahead 与 behind 同时 > 0）时 behind 也很大，但 ff 不可能快进 ——
		// 列出 behind 只是让用户知道「不是简单落后」。
		const alsoBehind = (facts.behind ?? 0) > 0 ? `，另外落后 ${facts.behind} 个提交（已分叉）` : "";
		return {
			action: "skip",
			reason: "ahead",
			detail: `本地领先远端 ${facts.ahead} 个提交${alsoBehind}，已跳过（只做快进，不会合并你的分支）。`,
		};
	}
	if ((facts.behind ?? 0) > 0) {
		const from = facts.localVersion ?? "?";
		const to = facts.remoteVersion ?? "?";
		return {
			action: "pull",
			reason: "behind",
			detail: `落后 ${facts.behind} 个提交：${from} → ${to}`,
		};
	}
	// commit 一样但版本号不同：不该发生（版本号随提交变），但真发生时只提示
	if (facts.localVersion !== undefined && facts.remoteVersion !== undefined && compareVersions(facts.localVersion, facts.remoteVersion) !== 0) {
		return {
			action: "skip",
			reason: "version-mismatch",
			detail: `提交一致但版本号不同（本地 ${facts.localVersion} / 远端 ${facts.remoteVersion}），不自动处理，请手动看看。`,
		};
	}
	return { action: "up-to-date", reason: "same", detail: `已是最新（${facts.localVersion ?? "?"}）。` };
}

/**
 * 把一次检查的结果渲染成一行状态（给 `/team-baseline` 用）。
 *
 * @param {{status: string, detail?: string, from?: string, to?: string}} state
 * @returns {string}
 */
export function describeUpdate(state) {
	const detail = state?.detail ?? "";
	return `自动更新：${state?.status ?? "未知"}${detail ? `  ${detail}` : ""}`;
}

// ── git ─────────────────────────────────────────────────────────────────────

/**
 * 跑一条 git 命令，收集 stdout。**不抛**：失败变成 `{ok:false, message}`。
 *
 * 用 `execFile` 而不是 `exec`：参数按数组传，不经过 shell，所以分支名/远端名
 * 里带引号或分号也不会被解释成别的命令。
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, stdout: string, code: number|null, message?: string}>}
 */
export function runGit(cwd, args, timeoutMs) {
	return new Promise((resolve) => {
		execFile(
			"git",
			// 关掉交互式凭据提示：否则远端要密码时会挂到超时（启动路径上不能挂）
			["-c", "credential.helper=", "-c", "core.askPass=", ...args],
			{
				cwd,
				timeout: timeoutMs,
				windowsHide: true,
				env: {
					...process.env,
					// 不弹凭据窗口、不读交互输入
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "",
					SSH_ASKPASS: "",
				},
				maxBuffer: 4 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					const timedOut = error.killed === true || error.signal === "SIGTERM";
					resolve({
						ok: false,
						stdout: String(stdout ?? ""),
						code: typeof error.code === "number" ? error.code : null,
						message: timedOut ? `git ${args[0]} 超时（${timeoutMs}ms）` : String(stderr || error.message || "").trim().split("\n")[0],
					});
					return;
				}
				resolve({ ok: true, stdout: String(stdout ?? ""), code: 0 });
			},
		);
	});
}

/** 读一个仓库某次提交里的 package.json version；读不到返回 undefined。 */
async function versionAt(cwd, rev, timeoutMs) {
	const r = await runGit(cwd, ["show", `${rev}:package.json`], timeoutMs);
	if (!r.ok) return undefined;
	try {
		const parsed = JSON.parse(r.stdout);
		return typeof parsed?.version === "string" ? parsed.version : undefined;
	} catch {
		// 该提交里没有 package.json 或不是合法 JSON
		return undefined;
	}
}

/**
 * 判断「锁类失败」是不是另一个**活着的**实例造成的。
 *
 * 为什么要分：进程被杀会留下 stale `index.lock`，之后每次启动都命中同一类错误。
 * 一律报「另一实例正在更新」会让自动更新静默停摆、而且排查方向完全错。
 *
 * 判据用锁文件的**年龄**而不是「锁存在」—— 锁本来是瞬时持有的，几秒前建的锁说明
 * 真有人在干活；几分钟前的锁几乎肯定是残留（git 自己不会把 index.lock 留那么久）。
 * 不去检测 PID（Windows 上没有可靠的「这个 pid 是不是 git」办法，而猜错的代价是
 * 把真失败说成 concurrent 或反之，还不如用年龄这个粗但方向正确的判据）。
 *
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true = 很像有活着的实例在干活
 */
async function hasLiveLockHolder(cwd, timeoutMs) {
	const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
	if (!top.ok) return true; // 拿不到位置就不敢断言是残留，保守当「有人在干活」
	const lock = pathModule.join(top.stdout.trim(), ".git", "index.lock");
	try {
		const age = Date.now() - fsSync.statSync(lock).mtimeMs;
		// 15 秒内建的锁：当成有活着的实例（正常情况下一次 merge 远不到 15 秒）
		return age < 15_000;
	} catch {
		// 锁已经没了：说明刚才那次是瞬时的，另一个实例已经收尾 —— 当下再试一次多半能成。
		// 这里返回 true（说成 concurrent）是保守选择：它只是个状态描述，不会造成损失，
		// 而说成「失败」会误报。
		return true;
	}
}

/**
 * 查清所有事实、决定、必要时拉。
 *
 * @param {object} options
 * @param {string} options.cwd 包目录（含 .git）
 * @param {object} options.config 已叠好的配置
 * @param {(m: string) => void} [options.log] 信息日志
 * @param {(m: string) => void} [options.warn] 告警日志
 * @returns {Promise<{status: string, detail: string, changed: boolean, reason?: string}>}
 */
export async function checkAndUpdate({ cwd, config, log, warn }) {
	const timeoutMs = config?.timeoutMs ?? AUTO_UPDATE_DEFAULTS.timeoutMs;
	const remote = config?.remote ?? AUTO_UPDATE_DEFAULTS.remote;

	// 配置里的 remote/branch 直接进 git 参数。execFile 数组传参不会过 shell，
	// 但**以 `-` 开头的值会被 git 当成选项**（例如 `--upload-pack=...`）——
	// 这是纵深防御：配置是本地可信文件，但拒绝它零成本（审查指出）。
	const branchCfg = config?.branch ?? AUTO_UPDATE_DEFAULTS.branch;
	if (/^-/.test(remote) || /^-/.test(branchCfg)) {
		return { status: "跳过", detail: "配置的 remote/branch 不能以 `-` 开头", changed: false, reason: "bad-config" };
	}

	// 1. 是不是 git 仓库（不是就直接收工）
	const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], timeoutMs);
	if (!inside.ok || inside.stdout.trim() !== "true") {
		return { status: "跳过", detail: "不是 git 仓库（可能是解压安装的）", changed: false, reason: "not-a-repo" };
	}

	// 1b. 仓库根必须**就是**包目录。
	//
	// `--is-inside-work-tree` 对「包含本目录的**外层**仓库」也返回 true。若本包被拷贝
	// （而非软链）进某个 git 项目里，不查这一步就会去 fetch/merge **外层仓库**，
	// 而 `merge --ff-only origin/<branch>` 会改写用户自己的项目文件 —— 正是这个功能
	// 最不该干的事（独立审查抓出来的）。
	const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
	// 拿不到仓库根就不能继续 —— 不能「静默跳过 1b 继续往下走」：
	// 那样守卫就形同虚设（审查指出）。这个命令本来不该失败，失败说明仓库状态异常。
	if (!top.ok) {
		return { status: "跳过", detail: `读不到仓库根（${top.message ?? "git rev-parse --show-toplevel 失败"}），已跳过`, changed: false, reason: "no-toplevel" };
	}
	const topLevel = top.stdout.trim();
	{
		// 两边都归一化成绝对路径再比（Windows 上斜杠/盘符大小写会有差异）
		const same = pathModule.resolve(topLevel).toLowerCase() === pathModule.resolve(cwd).toLowerCase();
		if (!same) {
			return {
				status: "跳过",
				detail: `包目录不在仓库根（外层仓库根：${topLevel}），已跳过以避免动到别人的仓库`,
				changed: false,
				reason: "not-repo-root",
			};
		}
	}

	// 2. 当前分支（配置给了就用配置的）
	let branch = config?.branch;
	if (branch === undefined || branch === "") {
		const b = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
		branch = b.ok ? b.stdout.trim() : "";
	}
	if (branch === "" || branch === "HEAD") {
		return { status: "跳过", detail: "处于 detached HEAD，无分支可比较", changed: false, reason: "no-branch" };
	}

	// 3. 工作树脏不脏（含未跟踪文件：未跟踪文件不影响 ff 合并，但说明你在干活，
	//    这时不管更好 —— 用户明确选了「跳过，只告知」）
	const status = await runGit(cwd, ["status", "--porcelain"], timeoutMs);
	// 查不出来时**不能当成干净** —— 那是危险方向：脏树保证是「不拉」，
	// 而「查不出」当成干净就会去拉。所以失败时按脏处理并说明。
	const statusUnknown = !status.ok;
	const dirty = statusUnknown || status.stdout.trim() !== "";
	if (statusUnknown) {
		warn?.(`[team:update] 读工作树状态失败，按「有改动」保守跳过：${status.message ?? "git status 失败"}`);
	}

	// 4. 取远端（唯一有网络的一步；失败就报出来，不影响启动）
	//
	// 并发重试：多个 dsh 实例同时启动时，并发的 `fetch` 会因 git 的 ref 锁而失败
	//（`cannot lock ref 'refs/remotes/origin/main': is at X but expected Y`）——
	// 实测 5 个并发里 4 个失败。这种失败是**瞬时的**（另一个实例刚把 ref 推过去了），
	// 但重试一次不够：并发实例越多、时序越乱，一次重试仍可能撞上。所以退避重试三次。
	// `Permission denied`：Windows 上两个 git 进程同时写同一个 object 文件会报
	//   `unable to write file .git/objects/…: Permission denied`（实测必现，不是概率）。
	const RETRYABLE = /cannot lock ref|unable to update local ref|cannot fast-forward to multiple branches|unable to write file|permission denied|index\.lock|another git process/i;
	let fetched = await runGit(cwd, ["fetch", remote, branch], timeoutMs);
	for (let attempt = 0; !fetched.ok && RETRYABLE.test(fetched.message ?? "") && attempt < 6; attempt++) {
		// 15/30/60/120/240/480ms：给其他实例一点时间把 ref/object 写完
		await new Promise((resolve) => setTimeout(resolve, 15 << Math.min(attempt, 4)));
		fetched = await runGit(cwd, ["fetch", remote, branch], timeoutMs);
	}
	if (!fetched.ok) {
		// 也 warn 一句：网络问题属于用户会想知道的那类降级，只放在状态字段里
		// 容易被忽略（/team-baseline 不常看）。
		warn?.(`[team:update] 拉取远端失败（不影响启动）：${fetched.message ?? "git fetch 失败"}`);
		return { status: "检查失败", detail: fetched.message ?? "git fetch 失败", changed: false, reason: "fetch-failed" };
	}

	const localHead = (await runGit(cwd, ["rev-parse", "HEAD"], timeoutMs)).stdout.trim();
	const remoteRef = `${remote}/${branch}`;
	const remoteHeadResult = await runGit(cwd, ["rev-parse", remoteRef], timeoutMs);
	// 远端没这个分支时提前报出来。否则会一路走到 merge 才失败，而错误指向 merge，
	// 用户看不出真实原因（"远端没有这个分支"）。
	if (!remoteHeadResult.ok) {
		return { status: "跳过", detail: `远端没有分支 ${remoteRef}（检查 remote/branch 配置）`, changed: false, reason: "no-remote-branch" };
	}
	const remoteHead = remoteHeadResult.stdout.trim();

	// 5. ahead/behind：`--left-right --count local...remote` → "ahead\tbehind"
	let ahead = 0;
	let behind = 0;
	const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`], timeoutMs);
	if (counts.ok) {
		const [a, b] = counts.stdout.trim().split(/\s+/);
		ahead = Number.parseInt(a, 10) || 0;
		behind = Number.parseInt(b, 10) || 0;
	} else if (localHead !== remoteHead) {
		// 数不出来又确实不同：保守按「落后」处理。
		// （不能指望后面 decideUpdate 拦住 —— 它只在 dirty 时才拦，而这里 dirty 可能为 false。
		//   真拉到不该拉的东西的代价比「报一次多余的更新」大得多。）
		behind = 1;
	}

	// 6. 版本号：本地读工作区，远端读那次提交（不能读工作区 —— 那还是旧的）
	const localVersion = await versionAt(cwd, "HEAD", timeoutMs);
	const remoteVersion = await versionAt(cwd, remoteHead, timeoutMs);

	const decision = decideUpdate({ isRepo: true, dirty, dirtyUnknown: statusUnknown, localHead, remoteHead, localVersion, remoteVersion, ahead, behind });

	if (decision.action !== "pull") {
		if (decision.action === "up-to-date") {
			log?.(`[team:update] 已是最新（${localVersion ?? "?"}）。`);
		} else {
			log?.(`[team:update] ${decision.detail}`);
		}
		return { status: decision.action === "up-to-date" ? "已是最新" : "跳过", detail: decision.detail, changed: false, reason: decision.reason };
	}

	// 7. 快进到远端。用 `merge --ff-only` 而不是 `pull --ff-only`：
	//
	// 因为 `pull` = `fetch` + `merge`，而**多个 dsh 实例同时拉同一个仓库时**，
	// 并发的 `fetch` 会让 git 报 `fatal: Cannot fast-forward to multiple branches`
	//（实测 3 个并发全部退出码 128）。这里已经单独 fetch 过了（上面第 4 步，
	// 且已退避重试），所以只需对已取得的远端引用做一次快进。
	//
	// `--ff-only` 仍然是硬要求：快进不了就是失败，绝不替用户决定合并策略。
	// 也重试：并发下另一个实例可能正持有 index.lock。
	//
	// `-c core.hooksPath=`：不让自动更新触发用户仓库自己的 post-merge / post-checkout
	// hook。那些 hook 是用户为自己手动 git 操作配的，自动更新在不告知的情况下跑它们
	// 属于越权（审查指出）——钩子内容可能做部署、跑迁移等意想不到的事。
	let merged = await runGit(cwd, ["-c", "core.hooksPath=", "merge", "--ff-only", remoteRef], timeoutMs);
	// 并发时另一个实例可能**正在** merge（拿不到 index.lock）或刚把版本拉下来。
	// 这两种都不是真失败，而是「另一个实例已经在做同一件事」——下一条报告就变了。
	// 所以最后一次仍失败时，只报「跳过」而不叫「失败」，免得用户看到吓人的红色。
	for (let attempt = 0; !merged.ok && RETRYABLE.test(merged.message ?? "") && attempt < 6; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 15 << Math.min(attempt, 4)));
		merged = await runGit(cwd, ["-c", "core.hooksPath=", "merge", "--ff-only", remoteRef], timeoutMs);
	}
	if (!merged.ok) {
		if (RETRYABLE.test(merged.message ?? "")) {
			// 重试耗尽仍失败：**不能一律当成「另一实例正在更新」**——
			// 进程被杀留下的 stale index.lock 会永远命中这一类，于是自动更新静默停摆，
			// 而报的话又指向一个并不存在的「另一实例」，排查方向完全错（审查指出）。
			// 只有在另一个实例**正在干活**（锁是新的）时才报 concurrent，
			// 否则让它以真失败的面目出现，并把清理办法写在 detail 里。
			const heldByLiveInstance = await hasLiveLockHolder(cwd, timeoutMs);
			if (heldByLiveInstance) {
				log?.("[team:update] 另一实例正在更新，本次跳过（不影响启动）。");
				return { status: "跳过", detail: "另一实例正在更新", changed: false, reason: "concurrent" };
			}
			warn?.(`[team:update] 自动更新失败：${merged.message ?? "git merge --ff-only 失败"}`);
			return {
				status: "更新失败",
				detail: `${merged.message ?? "git merge --ff-only 失败"}（若反复出现，检查并删除 .git/index.lock）`,
				changed: false,
				reason: "merge-failed",
			};
		}
		warn?.(`[team:update] 自动更新失败：${merged.message ?? "git merge --ff-only 失败"}`);
		return { status: "更新失败", detail: merged.message ?? "git merge --ff-only 失败", changed: false, reason: "merge-failed" };
	}

	const detail = `${localVersion ?? "?"} → ${remoteVersion ?? "?"}（落后 ${behind} 个提交）`;
	log?.(`[team:update] 已更新：${detail}。改动在下次启动 dsh 时生效。`);
	return { status: "已更新", detail, changed: true, reason: "pulled" };
}

/**
 * 装自动更新。
 *
 * **不返回 await 的 Promise** —— 调用方 fire-and-forget，启动不被网络拖慢。
 * 状态对象是活的引用，`/team-baseline` 随时读它拿到当前进度。
 *
 * @param {object} ctx
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.cwd 包目录
 * @returns {{enabled: boolean, state: object, describe: () => string, done: Promise<void>}}
 */
export function installAutoUpdate(ctx, { config = AUTO_UPDATE_DEFAULTS, cwd }) {
	const state = { status: config.enabled === true ? "检查中…" : "关", detail: "", changed: false, from: undefined, to: undefined };

	if (config.enabled !== true) {
		return { enabled: false, state, describe: () => describeUpdate(state), done: Promise.resolve() };
	}

	const done = (async () => {
		try {
			const result = await checkAndUpdate({
				cwd,
				config,
				log: (m) => ctx.logger.info(m),
				warn: (m) => ctx.logger.warn(m),
			});
			state.status = result.status;
			state.detail = result.detail;
			state.changed = result.changed;
			if (result.changed && config.notifyRestart === true) {
				ctx.logger.info("[team:update] 拉到了新代码；本进程仍跑旧代码，重启 dsh 后生效。");
			}
		} catch (error) {
			// 自动更新绝不能因为自己的问题影响启动
			state.status = "检查失败";
			state.detail = String(error?.message ?? error);
			ctx.logger.warn(`[team:update] 检查异常（已忽略）：${state.detail}`);
		}
	})();

	// 不让这个 Promise 的未处理拒绝冒到进程级（上面已经兜了，这里是双保险）
	done.catch(() => {});

	return { enabled: true, state, describe: () => describeUpdate(state), done };
}
