#!/usr/bin/env node
/**
 * 自检：子代理 worktree 隔离（REQ-001）。
 *
 * 三段：
 *   1. 纯函数（slugOf / parseTopLevel / parseWorktreeList / classifyMerge / admitMerge / guarded …）
 *   2. **真 git 沙箱**：临时建一个仓库，真的建 worktree、真的在里面提交、真的合回主分支，
 *      并真跑三条危险路径：冲突自动回退 / 删除被拒（有未提交改动）/ 脏主仓库拒绝合并。
 *   3. 工具注册与降级。
 *
 * 为什么必须真跑 git：这个功能的全部风险都在 git 交互上（冲突卡住主仓库、
 * 覆盖未提交改动、worktree 目录把主仓库弄脏），纯函数一条都测不出。
 *
 *   node scripts/selftest-worktree.mjs
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const {
	admitMerge,
	branchFor,
	classifyMerge,
	conflictDetail,
	ensureExcluded,
	guarded,
	installWorktree,
	isDirty,
	msysToNative,
	parseTopLevel,
	parseWorktreeList,
	renderList,
	slugOf,
	WORKTREE_DEFAULTS,
	WORKTREE_DIR,
	worktreeDrop,
	worktreeList,
	worktreeMerge,
	worktreeNew,
	worktreePathFor,
} = await import(new URL("lib/worktree.js", ROOT).href);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

check("slugOf：普通名字直接过", () => {
	assert.equal(slugOf("fix-login"), "fix-login");
	assert.equal(slugOf("Task A"), "task-a", "空格→连字符、小写");
	assert.equal(slugOf("a_b.c"), "a-b-c");
});

check("slugOf 防目录穿越（handoff.js 踩过的同一个坑）", () => {
	// 关键：`..` 和 `/` 都必须被消灭，否则 slug 会写到仓库外。
	assert.equal(slugOf("../../etc/passwd"), "etc-passwd");
	assert.equal(slugOf(".."), undefined, "纯点点消毒后为空");
	assert.equal(slugOf("a/../../b"), "a-b");
	assert.ok(!slugOf("../../x").includes(".."), "结果里不能残留 ..");
	assert.ok(!slugOf("a/b").includes("/"), "结果里不能残留 /");
	assert.ok(!slugOf("a\\b").includes("\\"), "结果里不能残留 \\");
});

check("slugOf 空输入返回 undefined（宁可拒绝，不要无名 worktree）", () => {
	assert.equal(slugOf(""), undefined);
	assert.equal(slugOf("   "), undefined);
	assert.equal(slugOf("!!!"), undefined);
	assert.equal(slugOf(undefined), undefined);
	assert.equal(slugOf(null), undefined);
	assert.equal(slugOf(42), "42", "数字也接受");
});

check("slugOf 限长 40（分支名/路径不能无限长）", () => {
	assert.equal(slugOf("a".repeat(100)).length, 40);
});

check("msysToNative：MSYS 路径转原生（bash-linux.js 踩过的坑）", () => {
	assert.equal(msysToNative("/c/Users/x"), "C:/Users/x");
	assert.equal(msysToNative("/d/work/a"), "D:/work/a");
	assert.equal(msysToNative("C:/already/native"), "C:/already/native", "已经是原生就原样");
	assert.equal(msysToNative("/usr/local"), "/usr/local", "不像盘符就不动");
});

check("parseTopLevel：取第一行、转原生、空则 undefined", () => {
	assert.equal(parseTopLevel("C:/repo\n"), "C:/repo");
	assert.equal(parseTopLevel("/c/repo\n"), "C:/repo");
	assert.equal(parseTopLevel("\n\nC:/repo\n\n"), "C:/repo");
	assert.equal(parseTopLevel(""), undefined);
	assert.equal(parseTopLevel("   \n  "), undefined);
});

check("parseWorktreeList：解析 porcelain（含 detached、bare、分支短名）", () => {
	const out = parseWorktreeList(
		[
			"worktree C:/repo",
			"HEAD abc123",
			"branch refs/heads/main",
			"",
			"worktree C:/repo/.dsh-worktrees/W1",
			"HEAD def456",
			"branch refs/heads/dsh-wt/w1",
			"",
			"worktree C:/tmp/detached",
			"HEAD 999aaa",
			"detached",
			"",
		].join("\n"),
	);
	assert.equal(out.length, 3);
	assert.equal(out[0].branch, "main", "refs/heads/ 要去掉");
	assert.equal(out[0].head, "abc123");
	assert.equal(out[1].branch, "dsh-wt/w1");
	assert.equal(out[2].detached, true);
	assert.equal(out[2].branch, undefined, "detached 没有分支");
});

check("parseWorktreeList：Windows 路径归一化后可比（path.resolve）", () => {
	const out = parseWorktreeList("worktree /c/repo\nHEAD a\nbranch refs/heads/main\n");
	assert.equal(out[0].path, path.resolve("C:/repo"), "要和 path.resolve 的结果一致才能比较");
});

check("parseWorktreeList：重复行要去重（不然 total 偏大）", () => {
	const dup = parseWorktreeList(
		[
			"worktree C:/repo",
			"HEAD aaa",
			"branch refs/heads/main",
			"",
			"worktree C:/repo",
			"HEAD aaa",
			"branch refs/heads/main",
			"",
		].join("\n"),
	);
	assert.equal(dup.length, 1, "同一路径只能算一棵");
	// 重复记录后面的 HEAD/branch 行不能污染前一条
	assert.equal(dup[0].branch, "main");
});

check("isDirty：空=净，有内容=脏", () => {
	assert.equal(isDirty(""), false);
	assert.equal(isDirty("   \n  "), false);
	assert.equal(isDirty("?? new.txt\n"), true);
	assert.equal(isDirty(" M a.js\n"), true);
});

check("classifyMerge：成功 / 冲突 / 别的失败 —— 三者不能混", () => {
	assert.equal(classifyMerge({ ok: true, stdout: "Merge made by..." }).kind, "ok");
	// 关键：冲突与「不可快进」退出码都是 1，靠关键词区分，否则排查方向全错。
	assert.equal(classifyMerge({ ok: false, message: "CONFLICT (content): Merge conflict in a.js" }).kind, "conflict");
	assert.equal(
		classifyMerge({ ok: false, message: "hint: Diverging branches can't be fast-forwarded" }).kind,
		"failed",
		"不可快进不是冲突",
	);
	assert.equal(classifyMerge({ ok: false, message: "fatal: not a git repository" }).kind, "failed");
});

check("classifyMerge：中文环境的「冲突」也认", () => {
	assert.equal(classifyMerge({ ok: false, message: "自动合并失败；冲突（内容）：a.js 中出现合并冲突" }).kind, "conflict");
});

check("admitMerge：脏 / 半合并都拒，且理由不同", () => {
	assert.equal(admitMerge({ dirty: false, merging: false }).ok, true);
	const merging = admitMerge({ dirty: false, merging: true });
	assert.equal(merging.ok, false);
	assert.equal(merging.reason, "merging", "半合并要单独报，不能混成「脏」");
	const dirty = admitMerge({ dirty: true, merging: false });
	assert.equal(dirty.ok, false);
	assert.equal(dirty.reason, "dirty");
	// 两者同时成立时，先说更严重的（卡住的仓库）
	assert.equal(admitMerge({ dirty: true, merging: true }).reason, "merging");
});

check("conflictDetail：abort 成功才能说「已回退」", () => {
	const ok = conflictDetail({ abortedOk: true, files: ["a.js", "b.js"] });
	assert.match(ok, /已自动回退/);
	assert.match(ok, /a\.js、b\.js/, "要列出冲突文件");
});

check("conflictDetail：abort 失败时**不能说**「已回退」（P1 回归）", () => {
	// 这是审查抓的：abort 自己失败时主仓库仍卡在半合并态，
	// 若还说「回到干净状态」，模型会信了然后接着干活。
	const bad = conflictDetail({ abortedOk: false, abortError: "error: could not abort", files: ["x.js"] });
	assert.ok(!/已自动回退|回到合并前的干净状态/.test(bad), `失败时不能说「已回退」，实际：${bad}`);
	assert.match(bad, /回退也失败/, "要明说回退失败");
	assert.match(bad, /可能卡在半合并状态/, "要说清后果");
	assert.match(bad, /could not abort/, "要带上真实报错，方便排查");
	assert.match(bad, /git merge --abort/, "要给出下一步");
	// 没报错信息也不能崩
	const bare = conflictDetail({ abortedOk: false, files: [] });
	assert.match(bare, /回退也失败/);
	assert.match(bare, /未知/);
	assert.match(bare, /没报具体文件/);
});

check("admitMerge：读不出状态时必须拒绝（不能当成干净 —— 危险方向）", () => {
	// git status 失败时如果当成「干净」，就会去合并 —— 而脏的保证是「不拉」。
	// 与 lib/auto-update.js 的同类处理一致（上一轮审查在那里抓过同一个错）。
	const unknown = admitMerge({ dirty: false, merging: false, dirtyUnknown: true });
	assert.equal(unknown.ok, false, "读不出状态必须拒绝");
	assert.equal(unknown.reason, "dirty");
	assert.match(unknown.detail, /读工作树状态失败/, "文案要与「真有改动」区分");
	// 卡住的仓库仍然优先报
	assert.equal(admitMerge({ dirty: false, merging: true, dirtyUnknown: true }).reason, "merging");
});

check("guarded：每个改工作区的 git 调用都必须带 core.hooksPath 抑制", () => {
	const g = guarded(["merge", "--no-ff", "-m", "x", "dsh-wt/a"]);
	assert.deepEqual(g.slice(0, 2), ["-c", "core.hooksPath="]);
	assert.ok(g.includes("merge"));
});

check("worktreePathFor / branchFor：位置与命名约定", () => {
	assert.equal(worktreePathFor("C:/repo", "fix"), path.join("C:/repo", WORKTREE_DIR, "fix"));
	assert.equal(branchFor("fix"), "dsh-wt/fix");
});

check("真实仓库根下，worktree 路径必须在仓库内部（沙箱 workspaceRoot 要求）", () => {
	const p = worktreePathFor("C:/repo", "fix");
	assert.ok(p.startsWith(path.join("C:/repo", WORKTREE_DIR)), "必须在仓库内，否则沙箱拒写");
});

check("renderList：列表渲染（含脏标记与空列表）", () => {
	const empty = renderList({ ok: true, items: [], total: 1 });
	assert.match(empty, /没有本工具建的 worktree/);
	const some = renderList({
		ok: true,
		total: 3,
		items: [
			{ slug: "a", path: "C:/r/.dsh-worktrees/a", branch: "dsh-wt/a", dirty: true },
			{ slug: "b", path: "C:/r/.dsh-worktrees/b", branch: "dsh-wt/b", dirty: false },
		],
	});
	assert.match(some, /a/);
	assert.match(some, /有未提交改动/, "脏的要标出来");
	assert.match(some, /干净/);
	const failed = renderList({ ok: false, detail: "不是 git 仓库" });
	assert.match(failed, /\[失败\]/);
});

// ── 2. 真 git 沙箱 ──────────────────────────────────────────────────────────

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** 只关心成败、不关心输出（也不抛）的小助手。 */
const runGitQuiet = async (cwd, args) => {
	const { runGit } = await import(new URL("lib/auto-update.js", ROOT).href);
	const r = await runGit(cwd, args, WORKTREE_DEFAULTS.timeoutMs);
	return r.ok;
};
const commit = (dir, message) => {
	git(dir, ["add", "-A"]);
	git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message, "--no-gpg-sign"]);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wt-selftest-"));
const repo = path.join(scratch, "repo");

try {
	// —— 建一个真仓库 ——
	fs.mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-b", "main"]);
	// 合并会产生提交，需要身份。用仓库级配置（不碰全局）。
	git(repo, ["config", "user.email", "t@t"]);
	git(repo, ["config", "user.name", "t"]);
	fs.writeFileSync(path.join(repo, "app.js"), "export const v = 1;\n", "utf8");
	commit(repo, "init");

	const timeoutMs = WORKTREE_DEFAULTS.timeoutMs;

	await checkAsync("真跑 ①：建 worktree，且主仓库保持干净（关键：不能把自动更新弄停摆）", async () => {
		const r = await worktreeNew({ cwd: repo, name: "Task A", timeoutMs });
		assert.equal(r.ok, true, `建失败：${r.detail}`);
		assert.equal(r.slug, "task-a");
		assert.equal(r.branch, "dsh-wt/task-a");
		assert.ok(fs.existsSync(r.path), "目录要真存在");
		assert.ok(r.path.startsWith(repo), "必须建在仓库内（沙箱要求）");
		// 关键断言：不忽略的话主仓库变脏 → auto-update 一建 worktree 就永久跳过。
		assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "主仓库必须保持干净");
		assert.ok(!fs.existsSync(path.join(repo, ".gitignore")), "不能碰 .gitignore（那是 tracked 文件）");
	});

	await checkAsync("真跑 ②：worktree 里真能提交，主分支看不到（隔离成立）", async () => {
		const listed = await worktreeList({ cwd: repo, timeoutMs });
		assert.equal(listed.ok, true);
		assert.equal(listed.items.length, 1, `应只见本工具的 1 棵，实际 ${JSON.stringify(listed.items)}`);
		const wt = listed.items[0].path;
		fs.writeFileSync(path.join(wt, "feature.js"), "export const feature = true;\n", "utf8");
		commit(wt, "add feature");
		assert.ok(fs.existsSync(path.join(wt, "feature.js")));
		// 主分支还没有这个文件 —— 这就是隔离。
		assert.equal(fs.existsSync(path.join(repo, "feature.js")), false, "主仓库不该看到 worktree 的改动");
		// worktree 的分支应该还没进主分支（本地隔离 = 没合并）
		const ancestor = await runGitQuiet(repo, ["merge-base", "--is-ancestor", "dsh-wt/task-a", "HEAD"]);
		assert.equal(ancestor, false, "还没合并，不该是主分支的祖先");
	});

	await checkAsync("真跑 ③：合回主分支，主分支真的拿到改动", async () => {
		const before = git(repo, ["rev-parse", "HEAD"]).trim();
		const r = await worktreeMerge({ cwd: repo, name: "task-a", abortOnConflict: true, timeoutMs });
		assert.equal(r.ok, true, `合并失败：${r.detail}`);
		assert.notEqual(git(repo, ["rev-parse", "HEAD"]).trim(), before, "HEAD 应该前进了");
		assert.ok(fs.existsSync(path.join(repo, "feature.js")), "主分支应拿到 worktree 的文件");
		// 合并后主仓库仍要干净
		assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "合并后主仓库要干净");
	});

	await checkAsync("真跑 ④：主分支动过之后仍能合并（--ff-only 会在这里失败）", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "second", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		fs.writeFileSync(path.join(r1.path, "from-wt.js"), "wt\n", "utf8");
		commit(r1.path, "wt work");
		// 主分支自己也提交 —— 这会让 --ff-only 失败（实测过）。
		fs.writeFileSync(path.join(repo, "main-own.js"), "main\n", "utf8");
		commit(repo, "main own work");
		const r2 = await worktreeMerge({ cwd: repo, name: "second", abortOnConflict: true, timeoutMs });
		assert.equal(r2.ok, true, `主分支动过后合并应仍成功（用了 --no-ff）：${r2.detail}`);
		assert.ok(fs.existsSync(path.join(repo, "from-wt.js")), "worktree 的文件要进来");
		assert.ok(fs.existsSync(path.join(repo, "main-own.js")), "主分支自己的提交不能丢");
	});

	await checkAsync("真跑 ⑤（危险路径）：冲突必须自动回退，不留半合并状态", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "conflict", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		// 两边改同一行 → 必定冲突
		fs.writeFileSync(path.join(r1.path, "app.js"), "export const v = 'from-worktree';\n", "utf8");
		commit(r1.path, "wt changes app.js");
		fs.writeFileSync(path.join(repo, "app.js"), "export const v = 'from-main';\n", "utf8");
		commit(repo, "main changes app.js");

		const r2 = await worktreeMerge({ cwd: repo, name: "conflict", abortOnConflict: true, timeoutMs });
		assert.equal(r2.ok, false);
		assert.equal(r2.reason, "conflict", `应报冲突，实际 ${r2.reason} / ${r2.detail}`);
		assert.equal(r2.aborted, true, "必须自动 abort");
		assert.ok(r2.files.includes("app.js"), `要列出冲突文件，实际 ${JSON.stringify(r2.files)}`);
		// 关键：主仓库不能卡在 MERGE_HEAD，也不能留冲突标记。
		assert.equal(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")), false, "不能卡在合并中");
		assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "必须回到干净状态");
		assert.ok(!fs.readFileSync(path.join(repo, "app.js"), "utf8").includes("<<<<<<<"), "不能留冲突标记");
		assert.match(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /from-main/, "主分支内容要原样");
	});

	await checkAsync("真跑 ⑥（危险路径）：worktree 有未提交改动时删除被拒，不能静默丢工作", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "keepme", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		fs.writeFileSync(path.join(r1.path, "uncommitted.js"), "not committed\n", "utf8");
		const r2 = await worktreeDrop({ cwd: repo, name: "keepme", force: false, keepBranch: false, timeoutMs });
		assert.equal(r2.ok, false, "有未提交改动必须拒绝");
		assert.equal(r2.reason, "dirty", `应报 dirty，实际 ${r2.reason}`);
		assert.ok(fs.existsSync(r1.path), "目录不能被删掉");
		assert.ok(fs.existsSync(path.join(r1.path, "uncommitted.js")), "未提交的文件必须还在");
		// 确认 force 才删得掉（这条路要留着，但不是默认）
		const r3 = await worktreeDrop({ cwd: repo, name: "keepme", force: true, keepBranch: true, timeoutMs });
		assert.equal(r3.ok, true, `force 应能删：${r3.detail}`);
		assert.equal(fs.existsSync(r1.path), false);
	});

	await checkAsync("真跑 ⑦（危险路径）：主仓库脏时拒绝合并（不 stash、不覆盖）", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "blocked", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		fs.writeFileSync(path.join(r1.path, "blocked.js"), "x\n", "utf8");
		commit(r1.path, "blocked work");
		// 主仓库留一个未提交文件
		fs.writeFileSync(path.join(repo, "my-precious.txt"), "user work\n", "utf8");
		const r2 = await worktreeMerge({ cwd: repo, name: "blocked", abortOnConflict: true, timeoutMs });
		assert.equal(r2.ok, false, "脏主仓库必须拒绝合并");
		assert.equal(r2.reason, "dirty", `应报 dirty，实际 ${r2.reason}`);
		assert.ok(fs.existsSync(path.join(repo, "my-precious.txt")), "用户的未提交文件必须原样还在");
		assert.equal(fs.readFileSync(path.join(repo, "my-precious.txt"), "utf8"), "user work\n", "内容不能变");
		assert.equal(fs.existsSync(path.join(repo, "blocked.js")), false, "改动不能半途进来");
		fs.rmSync(path.join(repo, "my-precious.txt"));
	});

	await checkAsync("真跑 ⑧：删 worktree 后空目录被清掉，主仓库仍干净", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "temp", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		const r2 = await worktreeDrop({ cwd: repo, name: "temp", force: false, keepBranch: false, timeoutMs });
		assert.equal(r2.ok, true, r2.detail);
		assert.equal(r2.removedPath, true);
		assert.equal(r2.removedBranch, true, "没提交过的分支应能删掉");
		assert.equal(fs.existsSync(r1.path), false);
		assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "主仓库要干净");
	});

	await checkAsync("真跑 ⑨：重名拒绝（不覆盖既有分支）", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "dup", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		const r2 = await worktreeNew({ cwd: repo, name: "dup", timeoutMs });
		assert.equal(r2.ok, false, "重名必须拒绝");
		assert.equal(r2.reason, "branch-exists", `实际 ${r2.reason}`);
		// 原 worktree 不受影响
		assert.ok(fs.existsSync(r1.path));
		await worktreeDrop({ cwd: repo, name: "dup", force: false, keepBranch: false, timeoutMs });
	});

	await checkAsync("真跑 ⑩：坏名字被拒（目录穿越防线在真实调用路径上也生效）", async () => {
		const r = await worktreeNew({ cwd: repo, name: "../../evil", timeoutMs });
		if (r.ok) {
			// 允许它消毒后成功（变成 evil），但**绝不允许**写到仓库外。
			assert.ok(r.path.startsWith(repo), "无论怎么消毒，都不能写到仓库外");
			assert.ok(!r.path.includes(".."), "路径里不能有 ..");
			await worktreeDrop({ cwd: repo, name: "../../evil", force: false, keepBranch: false, timeoutMs });
		} else {
			assert.equal(r.reason, "bad-name");
		}
		const empty = await worktreeNew({ cwd: repo, name: "!!!", timeoutMs });
		assert.equal(empty.ok, false);
		assert.equal(empty.reason, "bad-name");
	});

	await checkAsync("真跑 ⑪：非 git 目录给出明确拒绝，不抛", async () => {
		const outside = path.join(scratch, "not-a-repo");
		fs.mkdirSync(outside, { recursive: true });
		const r = await worktreeNew({ cwd: outside, name: "x", timeoutMs });
		assert.equal(r.ok, false);
		assert.equal(r.reason, "not-a-repo");
		const l = await worktreeList({ cwd: outside, timeoutMs });
		assert.equal(l.ok, false);
		assert.equal(l.reason, "not-a-repo");
	});

	await checkAsync("真跑 ⑫：ensureExcluded 幂等（重复调用不重复写）", async () => {
		const first = ensureExcluded(repo);
		// 已经加过了（① 里就加了），所以这次应 changed=false
		assert.equal(first.changed, false, "应已存在，不该重复写");
		const text = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
		const count = text.split("\n").filter((l) => l.trim() === `${WORKTREE_DIR}/` || l.trim() === WORKTREE_DIR).length;
		assert.equal(count, 1, `忽略条目不该重复，实际出现 ${count} 次`);
	});
	await checkAsync("真跑 ⑬（P1 回归）：git status 自己失败时，合并必须拒绝而不是当成干净", async () => {
		// 这是上轮 auto-update 审查抓到的同一类错：
		// 「读不出状态」当成「干净」是危险方向 —— 脏的保证是「不拉/不合」，
		// 读不出当成干净就会去合。用损坏的 .git/index 真的让 git status 失败（退出码 128）。
		const r1 = await worktreeNew({ cwd: repo, name: "badindex", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		fs.writeFileSync(path.join(r1.path, "bad.js"), "x\n", "utf8");
		commit(r1.path, "badindex work");

		const indexPath = path.join(repo, ".git", "index");
		const backup = fs.readFileSync(indexPath);
		try {
			fs.writeFileSync(indexPath, "garbage-not-an-index", "utf8");
			// 前提：git status 真的要失败，否则这个测试测不出东西
			const probe = await runGitQuiet(repo, ["status", "--porcelain"]);
			assert.equal(probe, false, "前提：损坏 index 后 git status 必须失败");

			const r2 = await worktreeMerge({ cwd: repo, name: "badindex", abortOnConflict: true, timeoutMs });
			assert.equal(r2.ok, false, "读不出状态时必须拒绝合并");
			assert.equal(r2.reason, "dirty", `应保守报 dirty，实际 ${r2.reason} / ${r2.detail}`);
			assert.match(r2.detail, /读工作树状态失败/, "文案要区分「真脏」与「读不出」");
			assert.equal(fs.existsSync(path.join(repo, "bad.js")), false, "不能合进来");
		} finally {
			fs.writeFileSync(indexPath, backup);
		}
		// 恢复后应该能正常合（证明前面拒绝的是「读不出」而不是别的）
		const r3 = await worktreeMerge({ cwd: repo, name: "badindex", abortOnConflict: true, timeoutMs });
		assert.equal(r3.ok, true, `恢复后应能合并：${r3.detail}`);
		await worktreeDrop({ cwd: repo, name: "badindex", force: false, keepBranch: false, timeoutMs });
	});

	await checkAsync("真跑 ⑭（P1 回归）：worktree_list 读不出状态时要带上 error，不能只说「未知」", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "listbad", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		const indexPath = path.join(r1.path, ".git");
		// worktree 的 git 目录是个文件（指向主仓库的 worktrees/<name>）
		assert.ok(fs.existsSync(indexPath), "worktree 里应有 .git");
		// 直接在 worktree 里弄坏 index（各 worktree 有各自的 index）
		const wtIndex = path.join(repo, ".git", "worktrees", "listbad", "index");
		const hasIndex = fs.existsSync(wtIndex);
		if (hasIndex) {
			const backup = fs.readFileSync(wtIndex);
			try {
				fs.writeFileSync(wtIndex, "garbage", "utf8");
				const listed = await worktreeList({ cwd: repo, timeoutMs });
				assert.equal(listed.ok, true);
				const item = listed.items.find((i) => i.slug === "listbad");
				assert.ok(item, "应能列出这棵 worktree");
				assert.equal(item.dirty, undefined, "读不出时 dirty 应为 undefined");
				assert.ok(item.error, "同时必须带上 error，否则调用方分不清「干净」和「没读到」");
			} finally {
				fs.writeFileSync(wtIndex, backup);
			}
		}
		await worktreeDrop({ cwd: repo, name: "listbad", force: true, keepBranch: false, timeoutMs });
	});

	await checkAsync("真跑 ⑯（P2 回归）：base 校验 —— `-` 开头拒绝、不存在的提交报错", async () => {
		// 纵深防御：base 直进 git 参数，`--xxx` 形态会被 git 当选项解析。
		const dash = await worktreeNew({ cwd: repo, name: "baddash", base: "--upload-pack=/bin/sh", timeoutMs });
		assert.equal(dash.ok, false, "`-` 开头的 base 必须拒绝");
		assert.equal(dash.reason, "bad-base", `实际 ${dash.reason}`);
		// 不存在的提交要早报，而不是等 git 报一句看不懂的
		const nope = await worktreeNew({ cwd: repo, name: "badref", base: "no-such-rev-xyz", timeoutMs });
		assert.equal(nope.ok, false, "不存在的 base 必须拒绝");
		assert.equal(nope.reason, "bad-base", `实际 ${nope.reason}`);
		// 合法的 base（提交号）应该能用
		const head = git(repo, ["rev-parse", "HEAD"]).trim();
		const good = await worktreeNew({ cwd: repo, name: "goodbase", base: head, timeoutMs });
		assert.equal(good.ok, true, `合法提交号应该能用：${good.detail}`);
		assert.ok(fs.existsSync(good.path));
		await worktreeDrop({ cwd: repo, name: "goodbase", force: false, keepBranch: false, timeoutMs });
	});

	await checkAsync("真跑 ⑰（P2 回归）：force 删除的文案要明说不可逆", async () => {
		const r1 = await worktreeNew({ cwd: repo, name: "forcedrop", timeoutMs });
		assert.equal(r1.ok, true, r1.detail);
		fs.writeFileSync(path.join(r1.path, "pending.js"), "uncommitted\n", "utf8");
		const r2 = await worktreeDrop({ cwd: repo, name: "forcedrop", force: true, keepBranch: false, timeoutMs });
		assert.equal(r2.ok, true, r2.detail);
		assert.match(r2.detail, /不可恢复/, "force 路径必须说清后果不可逆");
	});

	await checkAsync("真跑 ⑮（P2 回归）：超长 slug 截断后不能留尾横线", async () => {
		// 顺序错的话（先修尾再截断）会留下尾 `-`
		const longName = `${"a".repeat(39)}-xxxx`;
		const r = await worktreeNew({ cwd: repo, name: longName, timeoutMs });
		assert.equal(r.ok, true, r.detail);
		assert.ok(!r.slug.endsWith("-"), `slug 不能以横线结尾，实际 ${r.slug}`);
		assert.ok(!r.branch.endsWith("-"), `分支名不能以横线结尾，实际 ${r.branch}`);
		await worktreeDrop({ cwd: repo, name: longName, force: false, keepBranch: false, timeoutMs });
	});
} finally {
	try {
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* Windows 上偶尔有句柄没放，留在 temp 里无所谓 */
	}
}

// ── 3. 工具注册与降级 ───────────────────────────────────────────────────────

check("工具注册：4 个工具名与参数齐备，且 dispose 可重入", () => {
	const registered = [];
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		tools: {
			register(tool) {
				registered.push(tool);
				return () => {};
			},
		},
	};
	const result = installWorktree(ctx, { config: { ...WORKTREE_DEFAULTS } });
	assert.equal(result.enabled, true);
	const names = registered.map((t) => t.name).sort();
	assert.deepEqual(names, ["worktree_drop", "worktree_list", "worktree_merge", "worktree_new"]);
	for (const tool of registered) {
		assert.equal(typeof tool.description, "string");
		assert.ok(tool.description.length > 10, `${tool.name} 要有像样的 description`);
		assert.equal(typeof tool.execute, "function");
	}
	const del = registered.find((t) => t.name === "worktree_drop");
	// 注：parameters 已经是**编译后的 JSON Schema**（见 lib/util.js 的 toParameterSchema），
	// 所以必填看顶层 `required` 数组，不再看属性上的 DSL 布尔值。
	assert.equal(del.parameters.type, "object", "顶层必须是 type:object");
	assert.ok(del.parameters.properties.name, "drop 必须有 name 参数");
	assert.deepEqual(del.parameters.required, ["name"], "只应 name 必填");
	// 关键：force 不能是必填（默认必须是「安全的那条路」）
	assert.ok(!del.parameters.required.includes("force"), "force 不能是必填");
	assert.ok(!del.parameters.required.includes("keepBranch"), "keepBranch 不能是必填");
	result.dispose();
	result.dispose();
});

check("降级：配置关掉时不注册工具，状态说「关」", () => {
	const registered = [];
	const ctx = { logger: { info: () => {} }, tools: { register: (t) => (registered.push(t), () => {}) } };
	const result = installWorktree(ctx, { config: { ...WORKTREE_DEFAULTS, enabled: false } });
	assert.equal(result.enabled, false);
	assert.equal(registered.length, 0, "关掉就不该注册");
	assert.match(result.describe(), /关/);
});

check("工具 execute 对空 name 友好拒绝（不抛）", async () => {
	const registered = [];
	const ctx = { logger: { info: () => {} }, tools: { register: (t) => (registered.push(t), () => {}) } };
	installWorktree(ctx, { config: { ...WORKTREE_DEFAULTS } });
	for (const name of ["worktree_new", "worktree_merge", "worktree_drop"]) {
		const tool = registered.find((t) => t.name === name);
		const out = await tool.execute({}, { agent: { session: { header: { cwd: process.cwd() } } } });
		assert.match(out.text, /请给出 name/, `${name} 空 name 应友好拒绝`);
	}
});

console.log(failures === 0 ? "\n✓ 自检通过：纯函数 / 真 git 沙箱（建-隔-合-冲突回退-拒删-拒并）/ 工具注册与降级" : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
