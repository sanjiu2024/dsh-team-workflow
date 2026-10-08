/**
 * 小队成员的工具 —— **我们自己实现**（REQ-011 §6.3）。
 *
 * ── 为什么不用 dsh 的工具 ──────────────────────────────────────────────────
 * 成员的 loop 由小队自己驱动（不建 agent、不建会话），而 `ctx.tools.execute` 缺 `agent`
 * 时会**五处降级**：cwd 退回 dsh 启动目录、沙箱回落部署默认（丢掉会话 cwd 这个写边界）、
 * 需审批的工具**硬拒绝**、按 agent 的工具可见面失效、输出截断静默失效（REQ-011 §5）。
 * 所以工具这一层只能自己实现 —— 这就是「成员独立于 subagent」的代价本体。
 *
 * ── 边界（这个文件是安全相关的，改动要慎重） ────────────────────────────────
 *  · **fs 工具**：路径必须落在**该成员自己的 worktree** 内（`resolveInside`），越界直接拒绝 ——
 *    不给「先写到外面、回头再解释」的机会。
 *  · **bash**：走 dsh 的公开 shell 服务（`ctx.shell.resolve/execute`），并**显式传**
 *    `sandboxPolicy`（`workspaceRoot` = worktree）—— 这样 confine 照常生效。
 *    ⚠ `danger-full-access` 下 dsh 自己会跳过 confine，此时等于裸 spawn（REQ-011 §6.4）。
 *  · **没有审批**：dsh 的审批服务硬依赖真实 Session 的开着的 turn，C 下拿不到（REQ-011 §5）。
 *    替代品就是上面两条 —— 沙箱 + 路径钉死，不是审批。
 *  · **取服务一律用 `ctx.get(name)`**：cordis 的 ctx 是访问器代理，没声明 inject 的属性
 *    直接读会抛 `cannot get property "…" without inject`（本包 `lib/mc-adapter.js:240` 有同样注释）。
 */

import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { constants as FS, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * 打开文件时**不跟随最后一段符号链接**（POSIX 才有；Windows 上退化成 0 = 没有这层）。
 *
 * 为什么要有：`resolveInside` 是「先校验、后使用」，中间隔着一次系统调用 —— 成员用后台
 * bash 把路径换成符号链接，写就会落到工作区外（TOCTOU）。`O_NOFOLLOW` 把「最后一段不能
 * 是符号链接」交给内核，在**同一时刻**判定。
 *
 * **这不是完整隔离**，残留写在这里以免被当成已解决：
 *   · **中间目录**被换掉仍有可能（Node 没有 `openat`）；
 *   · Windows 上 `O_NOFOLLOW` 不存在（退化成 0）；
 *   · 所以硬链接另外单独查（`nlink > 1` 就拒 —— `O_NOFOLLOW` 管不了硬链接）；
 *     这个检查本身也**不是原子的**：查完 nlink 到真正写之间，别人还能给同一个 inode 加硬链接
 *     （第 3 层审查指出）。要彻底解决得靠内核级隔离（挂载命名空间 / ACL），不是 Node 能做到的；
 *     在 `danger-full-access` 下它本来也没有边际意义 —— 那种权限用 bash 直接就写外面了。
 * 真正在意隔离就别用 `danger-full-access`（那一档 dsh 本来就跳过 confine，bash 可以直接
 * 写到外面，这层只是少给 fs 工具留一个洞），或者干脆把 `bash` 关掉。
 */
const NOFOLLOW = FS.O_NOFOLLOW ?? 0;

/** 输出上限（内存护栏，不是限流 —— 但成员循环里没有别的护栏，所以必须有）。 */
export const TOOL_LIMITS = {
	readBytes: 200_000,
	readLines: 2000,
	grepMatches: 80,
	globEntries: 200,
	walkFiles: 20_000,
	bashOutputChars: 8000,
	bashTimeoutMs: 120_000,
	bashTimeoutMaxMs: 600_000,
};

/** 遍历时跳过的目录：不是成员的活，而且会把遍历拖死。 */
const SKIP_DIRS = new Set([".git", "node_modules", ".dsh-worktrees"]);

// ── 小工具 ────────────────────────────────────────────────────────────────

function str(v) {
	return typeof v === "string" ? v : "";
}

function clip(text, max = TOOL_LIMITS.bashOutputChars) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}\n…（截断，共 ${s.length} 字符）` : s;
}

function fail(text) {
	return { text: `[失败] ${text}`, isError: true };
}

/**
 * 尽量把路径解析成真身（realpath）；还不存在就往上找最近的已存在祖先，
 * 再把剩下那截拼回去 —— 这样**符号链接**不能变成越界的后门。
 *
 * 为什么两边（根与目标）都要过一遍：根自己也可能在软链下面（比如 macOS 的 `/tmp`）。
 */
function realish(p) {
	let head = p;
	const tail = [];
	for (;;) {
		try {
			const real = realpathSync(head);
			return tail.length === 0 ? real : path.join(real, ...tail);
		} catch {
			// 路径**本身存在**却解析不了（悬空链接 / EACCES / ELOOP）：绝不能退化成字面路径 ——
			// 顺着一个悬空链接写出去就绕过了边界（`root/broken -> outside/new.txt` 实测能写出去）。
			let missing = false;
			try {
				lstatSync(head);
			} catch (err) {
				// 只有「真不存在」才继续往上找。ENOTDIR（路径里某一段是文件）也算「不存在」，
				// 让它按普通的路径错误报出去；EACCES / EPERM / ELOOP 属于「在、但解析不了」。
				const code = err?.code;
				missing = code === "ENOENT" || code === "ENOTDIR";
			}
			if (!missing) throw new Error(`路径解析不了（悬空链接或权限不足）：${head}`);
			const parent = path.dirname(head);
			if (parent === head) return p; // 一路到根都不存在，原样返回
			tail.unshift(path.basename(head));
			head = parent;
		}
	}
}

/**
 * 把成员给的路径解析成 worktree 内的绝对路径；越界就抛。
 * @param {string} root 成员自己的工作区（绝对路径）
 * @param {unknown} input 成员给的路径（相对或绝对都接受）
 */
export function resolveInside(root, input) {
	const raw = str(input).trim();
	if (raw === "") throw new Error("路径不能为空");
	const abs = path.resolve(root, raw);
	const rel = path.relative(realish(root), realish(abs));
	// 仓库元数据一律不碰：`.git/hooks/*` 是**持久后门**（成员种一个 pre-commit，
	// 用户之后每次提交都跑它）。`grep`/`glob` 早就跳过 `.git`，这里把写口也堵上。
	if (rel.split(path.sep).includes(".git")) throw new Error(`不碰 .git（仓库元数据）：${raw}`);
	if (rel === "") return abs;
	// 只认「上一级」与「以 .. 开头的目录段」：`..foo` 是工作区里一个合法文件名，不能误伤
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`路径越出工作区：${raw}`);
	return abs;
}

/** 相对路径（给模型看的，别把绝对路径灌进上下文）。 */
function relPath(root, abs) {
	return path.relative(root, abs) || ".";
}

/** `*` / `**` / `?` 的最小 glob（不引依赖）。 */
export function globToRegExp(pattern) {
	// **一次替换到底**：分几次 `.replace` 的话，前一次塞进去的 `*` / `?` 会被后一次
	// 再加工一遍（`(?:.*/)?` 会变成 `([^/]:.[^/]*/)`），整条规则就错了 —— 这个坑
	// 被 `scripts/selftest-squad.mjs` 的 glob 语义单测逮住过一次。
	const body = String(pattern)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\/|\*\*|\*|\?/g, (token) => {
			if (token === "**/") return "(?:.*/)?";
			if (token === "**") return ".*";
			if (token === "*") return "[^/]*";
			return "[^/]";
		});
	return new RegExp(`^${body}$`);
}

/** 在 worktree 内递归收文件（相对路径），跳过 SKIP_DIRS 与太大的目录。 */
async function walkFiles(root, onFile) {
	let seen = 0;
	const stack = [""];
	while (stack.length > 0) {
		const relDir = stack.pop();
		const absDir = relDir === "" ? root : path.join(root, relDir);
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				stack.push(rel);
				continue;
			}
			if (!entry.isFile()) continue;
			seen += 1;
			if (seen > TOOL_LIMITS.walkFiles) return seen;
			const stop = await onFile(rel);
			if (stop === true) return seen;
		}
	}
	return seen;
}

// ── 工具实现 ──────────────────────────────────────────────────────────────

async function toolRead(args, env) {
	let abs;
	try {
		abs = resolveInside(env.worktree, args?.path);
	} catch (err) {
		return fail(err.message);
	}
	let info;
	try {
		info = await stat(abs);
	} catch {
		return fail(`文件不存在：${relPath(env.worktree, abs)}`);
	}
	if (info.isDirectory()) return fail(`${relPath(env.worktree, abs)} 是目录，不是文件`);
	if (info.size > TOOL_LIMITS.readBytes) return fail(`文件太大（${info.size} 字节 > ${TOOL_LIMITS.readBytes}），请用 grep 定位后再读`);
	const raw = await readFile(abs, "utf8");
	const lines = raw.split("\n");
	const offset = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 1;
	const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, TOOL_LIMITS.readLines) : TOOL_LIMITS.readLines;
	const slice = lines.slice(offset - 1, offset - 1 + limit);
	const numbered = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
	const more = offset - 1 + slice.length < lines.length ? `\n…（还有 ${lines.length - (offset - 1 + slice.length)} 行，用 offset 继续）` : "";
	return { text: numbered + more };
}

async function toolWrite(args, env) {
	let abs;
	try {
		abs = resolveInside(env.worktree, args?.path);
	} catch (err) {
		return fail(err.message);
	}
	const content = str(args?.content);
	if (content === "") return fail("content 不能为空（要删内容请用 edit）");
	await mkdir(path.dirname(abs), { recursive: true });
	try {
		// **不能带 `O_TRUNC`**：截断发生在 open 的那一刻 —— 等查完 nlink 再拒就已经把
		// 工作区外那个 inode 清空了。改成 open 之后先查、再自己 truncate。
		const handle = await open(abs, FS.O_WRONLY | FS.O_CREAT | NOFOLLOW);
		try {
			// `O_NOFOLLOW` 只管符号链接：**硬链接**照样能指到工作区外的 inode。
			// 工作区里的正常文件 nlink 是 1。
			const info = await handle.stat();
			if (info.nlink > 1) return fail(`这个文件有 ${info.nlink} 个硬链接（可能从工作区外链进来），拒绝改：${relPath(env.worktree, abs)}`);
			await handle.truncate(0);
			await handle.write(content, 0, "utf8");
		} finally {
			await handle.close();
		}
	} catch (err) {
		return fail(err?.code === "ELOOP" ? `这是符号链接，不跟着它写：${relPath(env.worktree, abs)}` : `写不进去：${err?.message ?? err}`);
	}
	return { text: `已写入 ${relPath(env.worktree, abs)}（${content.length} 字符）` };
}

async function toolEdit(args, env) {
	let abs;
	try {
		abs = resolveInside(env.worktree, args?.path);
	} catch (err) {
		return fail(err.message);
	}
	const oldString = str(args?.old_string);
	if (oldString === "") return fail("old_string 不能为空");
	const next = str(args?.new_string);
	// **同一个句柄**读-改-写：先关掉再重开会留一个替换窗口（校验过的那条路径可能在两次
	// open 之间被换掉 —— 换成硬链接就能把旧内容写到工作区外的 inode 上）。
	let handle;
	try {
		handle = await open(abs, FS.O_RDWR | NOFOLLOW);
	} catch (err) {
		if (err?.code === "ELOOP") return fail(`这是符号链接，不跟着它改：${relPath(env.worktree, abs)}（直接改它指向的真实路径）`);
		return fail(`文件不存在：${relPath(env.worktree, abs)}`);
	}
	try {
		const raw = await handle.readFile("utf8");
		const hits = raw.split(oldString).length - 1;
		if (hits === 0) return fail("old_string 在文件里找不到（要一字不差，含缩进）");
		if (hits > 1) return fail(`old_string 出现了 ${hits} 次，不唯一 —— 多带几行上下文让它唯一`);
		const info = await handle.stat();
		if (info.nlink > 1) return fail(`这个文件有 ${info.nlink} 个硬链接（可能从工作区外链进来），拒绝改：${relPath(env.worktree, abs)}`);
		// 用函数形式：字符串形式会把 `new_string` 里的 `$&` / `` $` `` / `$'` / `$1` 当替换模板展开，
		// 静默改坏内容（成员写正则替换的代码时很容易碰到）。
		await handle.truncate(0);
		await handle.write(raw.replace(oldString, () => next), 0, "utf8");
	} finally {
		await handle.close();
	}
	return { text: `已改 ${relPath(env.worktree, abs)}` };
}

async function toolGrep(args, env) {
	const pattern = str(args?.pattern);
	if (pattern === "") return fail("pattern 不能为空");
	let re;
	try {
		re = new RegExp(pattern);
	} catch (err) {
		return fail(`正则不合法：${err.message}`);
	}
	let root;
	try {
		root = args?.path ? resolveInside(env.worktree, args.path) : env.worktree;
	} catch (err) {
		return fail(err.message);
	}
	const hits = [];
	/** 被跳过的文件数（太大 / 二进制 / 读不了）——「没有匹配」时要说清有多少没搜成。 */
	let skipped = 0;
	/**
	 * 搜一个文件。`rel` 一律相对 **worktree**（模型照它去 read）。
	 * @returns `true` 够了（调用方要停）/ `false` 正常搜过 / `string` **没搜成**的原因
	 */
	const scan = async (abs, rel) => {
		let info;
		try {
			info = await stat(abs);
		} catch {
			return "读不到";
		}
		if (info.size > TOOL_LIMITS.readBytes) return `文件太大（${info.size} 字节 > ${TOOL_LIMITS.readBytes}），先用别的方式定位`;
		let raw;
		try {
			raw = await readFile(abs, "utf8");
		} catch {
			return "读不到";
		}
		if (raw.includes("\u0000")) return "二进制文件";
		const lines = raw.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (!re.test(lines[i])) continue;
			const shown = lines[i].length > 200 ? `${lines[i].slice(0, 200)}…` : lines[i];
			hits.push(`${rel}:${i + 1}: ${shown}`);
			if (hits.length >= TOOL_LIMITS.grepMatches) return true;
		}
		return false;
	};

	let info;
	try {
		info = await stat(root);
	} catch {
		return fail(`路径不存在：${relPath(env.worktree, root)}`);
	}
	// `path` 可以是文件（参数说明就是这么写的）——`walkFiles` 只认目录，
	// 对文件 readdir 会抛 ENOTDIR，被它自己的 catch 吞掉，于是永远「没有匹配」。
	if (info.isFile()) {
		// 明确指到一个文件时，「搜不了」必须说出来 —— 回「没有匹配。」会让模型
		// 得出「这个文件里没有」的错误结论（文件太大 / 二进制 / 读不了都是这种情况）。
		const rel = relPath(env.worktree, root);
		const why = await scan(root, rel);
		if (typeof why === "string" && hits.length === 0) return fail(`${rel} 搜不了：${why}`);
	} else {
		// 注意要 async + await：`scan(...) === true` 比的是 Promise，永远 false（会静默变成「没有匹配」）
		await walkFiles(root, async (rel) => {
			const why = await scan(path.join(root, rel), relPath(env.worktree, path.join(root, rel)));
			if (typeof why === "string") skipped += 1;
			return why === true;
		});
	}
	const notes = [];
	if (skipped > 0) notes.push(`另有 ${skipped} 个文件搜不了（太大 / 二进制 / 读不了）`);
	if (hits.length === 0) return { text: `没有匹配。${notes.length > 0 ? `（${notes.join("；")}）` : ""}` };
	// 措辞留余地：正好等于上限时也可能真的只有这么多，不能断言「还有更多」
	if (hits.length >= TOOL_LIMITS.grepMatches) notes.push(`已到上限 ${TOOL_LIMITS.grepMatches} 条，可能还有更多 —— 把 pattern 写窄一点`);
	const more = notes.length > 0 ? `\n…（${notes.join("；")}）` : "";
	return { text: hits.join("\n") + more };
}

async function toolGlob(args, env) {
	const pattern = str(args?.pattern);
	if (pattern === "") return fail("pattern 不能为空");
	const re = globToRegExp(pattern);
	const found = [];
	await walkFiles(env.worktree, async (rel) => {
		if (!re.test(rel)) return false;
		found.push(rel);
		return found.length >= TOOL_LIMITS.globEntries;
	});
	if (found.length === 0) return { text: "没有匹配的文件。" };
	const more = found.length >= TOOL_LIMITS.globEntries ? `\n…（已到上限 ${TOOL_LIMITS.globEntries} 个，可能还有更多 —— 把模式写窄一点）` : "";
	return { text: found.sort().join("\n") + more };
}

async function toolBash(args, env) {
	const command = str(args?.command).trim();
	if (command === "") return fail("command 不能为空");
	const shell = env.ctx?.get?.("shell");
	if (!shell || typeof shell.resolve !== "function" || typeof shell.execute !== "function") {
		return fail("宿主没提供 shell 服务，执行不了命令");
	}
	const asked = Number.isInteger(args?.timeoutMs) ? args.timeoutMs : TOOL_LIMITS.bashTimeoutMs;
	const timeoutMs = Math.max(1000, Math.min(asked, TOOL_LIMITS.bashTimeoutMaxMs));
	const request = {
		command,
		workdir: env.worktree,
		timeoutMs,
		stdoutMaxBytes: TOOL_LIMITS.bashOutputChars * 4,
	};
	if (env.signal) request.signal = env.signal;
	// 显式传策略：workspaceRoot 钉在这个成员的 worktree 上（否则会回落部署根）。
	if (env.bashPolicy) request.sandboxPolicy = env.bashPolicy;
	let result;
	try {
		const execution = await shell.execute(shell.resolve(request));
		result = execution.result();
	} catch (err) {
		return fail(`命令没能执行：${err?.message ?? String(err)}`);
	}
	const head = [`$ ${command}`, `退出码 ${result.exitCode}${result.timedOut ? "（超时被 kill）" : ""}${result.aborted ? "（被中止）" : ""}`];
	if (result.sandbox?.denied) head.push(`[沙箱拦下] 模式 ${result.sandbox.mode ?? "?"}：这条命令被 confine 拒了`);
	const out = result.stdout?.text ?? "";
	const err = result.stderr?.text ?? "";
	const parts = [...head];
	if (out !== "") parts.push(`--- stdout ---\n${clip(out)}`);
	if (err !== "") parts.push(`--- stderr ---\n${clip(err)}`);
	if (out === "" && err === "") parts.push("（没有输出）");
	return { text: parts.join("\n"), isError: result.exitCode !== 0 };
}

async function toolBoard(args, env) {
	const text = str(args?.text).trim();
	if (text === "") return fail("text 不能为空");
	if (typeof env.board !== "function") return fail("这个成员没有黑板可写");
	const r = env.board(text);
	if (r && r.ok === false) return fail(r.detail ?? "写黑板失败");
	return { text: "已记到小队黑板。" };
}

// ── 对模型公开的工具表（JSON Schema，直接喂 GenerateOptions.tools） ──────────

const schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });

/** 7 个工具：够成员干活，不多给。 */
export const MEMBER_TOOLS = [
	{
		name: "read",
		description: "读工作区里的文件（带行号）。用 offset/limit 读大文件的一段。",
		parameters: schema(
			{
				path: { type: "string", description: "相对工作区的路径。" },
				offset: { type: "integer", description: "从第几行开始（1 起，默认 1）。" },
				limit: { type: "integer", description: "读多少行（默认 2000）。" },
			},
			["path"],
		),
		run: toolRead,
	},
	{
		name: "write",
		description: "整份写入文件（覆盖）。改已有的文件请用 edit。父目录不存在会自动建。",
		parameters: schema(
			{ path: { type: "string", description: "相对工作区的路径。" }, content: { type: "string", description: "完整内容。" } },
			["path", "content"],
		),
		run: toolWrite,
	},
	{
		name: "edit",
		description: "把文件里**唯一**的一处 old_string 换成 new_string。找不到或出现多次都会失败（那就多带几行上下文）。",
		parameters: schema(
			{
				path: { type: "string", description: "相对工作区的路径。" },
				old_string: { type: "string", description: "要替换的原文，一字不差（含缩进）。" },
				new_string: { type: "string", description: "换成什么。" },
			},
			["path", "old_string", "new_string"],
		),
		run: toolEdit,
	},
	{
		name: "grep",
		description: "在工作区里按正则搜内容，返回 `文件:行号: 内容`。",
		parameters: schema(
			{ pattern: { type: "string", description: "正则。" }, path: { type: "string", description: "只在某个子目录/文件里搜（可选）。" } },
			["pattern"],
		),
		run: toolGrep,
	},
	{
		name: "glob",
		description: "按路径模式列文件，支持 `*` / `**` / `?`，如 `src/**/*.js`。",
		parameters: schema({ pattern: { type: "string", description: "路径模式。" } }, ["pattern"]),
		run: toolGlob,
	},
	{
		name: "bash",
		description: "在工作区里跑一条 shell 命令。命令在 dsh 的沙箱策略下执行（工作区根 = 你的工作区）。",
		parameters: schema(
			{ command: { type: "string", description: "要跑的命令。" }, timeoutMs: { type: "integer", description: "超时毫秒（默认 120000）。" } },
			["command"],
		),
		run: toolBash,
	},
	{
		name: "board",
		description: "往小队黑板上写一条（队里其他人看得见）。结论、发现、卡点都写这里。",
		parameters: schema({ text: { type: "string", description: "要记的内容。" } }, ["text"]),
		run: toolBoard,
	},
];

const BY_NAME = new Map(MEMBER_TOOLS.map((t) => [t.name, t]));

/**
 * 喂给模型的那一份工具表：**只有线上字段**。
 *
 * `run` 是我们自己的执行器（函数），不该出现在发给 provider 的 `tools` 里 ——
 * 那份数据要序列化成请求体，多带一个函数既没用也可能让某些适配器不高兴。
 */
export const MEMBER_TOOL_SCHEMAS = MEMBER_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

/**
 * 按配置挑出这个成员能用哪些工具。
 *
 * 唯一的开关是 `bash`：**在 `danger-full-access` 的机器上，bash 等于宿主权限、且没有审批**
 * （REQ-011 §6.4/§7），那是唯一能「弄没东西」的工具。关掉它，成员就只剩钉在工作区里的
 * fs 工具 —— 这是本包能提供的**唯一真隔离**（提示词不算隔离）。
 */
export function memberToolsFor({ bash = true } = {}) {
	const tools = bash ? MEMBER_TOOLS : MEMBER_TOOLS.filter((tool) => tool.name !== "bash");
	return {
		tools,
		schemas: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
	};
}

/**
 * 执行一个成员工具调用。
 * @param {string} name 工具名
 * @param {unknown} args 已解析的参数（解析失败由调用方负责）
 * @param {object} env `{worktree, ctx, signal, bashPolicy, board}`
 * @returns {Promise<{text: string, isError?: boolean}>}
 */
export async function runMemberTool(name, args, env) {
	const tool = BY_NAME.get(name);
	if (!tool) return fail(`没有这个工具：${name}（可用：${[...BY_NAME.keys()].join(" / ")}）`);
	try {
		return await tool.run(args ?? {}, env);
	} catch (err) {
		return fail(`${name} 出错：${err?.message ?? String(err)}`);
	}
}
