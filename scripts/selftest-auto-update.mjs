#!/usr/bin/env node
/**
 * 自检：启动时自动更新（git 版）。
 *
 * 两段：
 *   1. 纯函数（parseVersion / compareVersions / decideUpdate / describeUpdate）
 *   2. **真 git 沙箱**：临时建一个「远端」仓库 + 一个 clone 当「本地」，真跑
 *      fetch/pull，验证六种情形：已最新 / 落后→拉 / 有未提交改动→跳过 /
 *      本地领先→跳过 / 非 git 目录→跳过 / 远端不可达→报检查失败不抛。
 *
 * 为什么必须真跑 git：这个功能的全部风险都在 git 交互上（ff-only、脏树、网络失败），
 * 纯函数测不出这些。
 *
 *   node scripts/selftest-auto-update.mjs
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const { AUTO_UPDATE_DEFAULTS, checkAndUpdate, compareVersions, decideUpdate, describeUpdate, installAutoUpdate, parseVersion } = await import(
	new URL("lib/auto-update.js", ROOT).href
);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

check("parseVersion 解析三段数字", () => {
	assert.deepEqual(parseVersion("0.6.0"), [0, 6, 0]);
	assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
	assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
});
check("parseVersion 容错：空、垃圾、带后缀", () => {
	assert.deepEqual(parseVersion(undefined), [0]);
	assert.deepEqual(parseVersion(""), [0]);
	assert.deepEqual(parseVersion("0.6.0-beta.1"), [0, 6, 0], "去掉 - 之后的部分");
	assert.deepEqual(parseVersion("x.y.z"), [0, 0, 0], "不认识的段当 0，不能是 NaN");
	assert.ok(parseVersion("0.6.0").every((n) => Number.isFinite(n)), "不能出现 NaN");
});
check("compareVersions 数字比较而不是字符串比较", () => {
	// 字符串比较会说 "0.10.0" < "0.9.0"（因为 '1' < '9'），这是经典坑
	assert.ok(compareVersions("0.10.0", "0.9.1") > 0, "0.10.0 应大于 0.9.1");
	assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
	assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
	assert.equal(compareVersions("0.6", "0.6.0"), 0, "段数不同时短边补 0");
	assert.ok(compareVersions("0.6.0", "0.6.1") < 0);
});

check("decideUpdate：不是 git 仓库 → 跳过", () => {
	const d = decideUpdate({ isRepo: false });
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "not-a-repo");
});
check("decideUpdate：工作树脏 → 跳过（不 stash 不覆盖）", () => {
	const d = decideUpdate({ isRepo: true, dirty: true, ahead: 0, behind: 3, localVersion: "0.6.0", remoteVersion: "0.7.0" });
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "dirty");
	assert.match(d.detail, /未提交/);
});
check("decideUpdate：本地领先 → 跳过（不合并用户的分支）", () => {
	const d = decideUpdate({ isRepo: true, dirty: false, ahead: 2, behind: 0 });
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "ahead");
});
check("decideUpdate：分叉（ahead+behind 都 >0）时也报出 behind", () => {
	const d = decideUpdate({ isRepo: true, dirty: false, ahead: 3, behind: 5 });
	assert.equal(d.reason, "ahead", "分叉按 ahead 处理（ff 不可能）");
	assert.match(d.detail, /落后 5/, `应并列报出 behind，实际：${d.detail}`);
});
check("decideUpdate：读不出工作树状态时文案与「真有改动」不同", () => {
	const unknown = decideUpdate({ isRepo: true, dirty: true, dirtyUnknown: true });
	const real = decideUpdate({ isRepo: true, dirty: true });
	assert.equal(unknown.reason, "dirty", "仍然跳过（保守方向）");
	assert.notEqual(unknown.detail, real.detail, "两种情况建议不同，文案不能一样");
	assert.match(unknown.detail, /读工作树状态失败/, `实际：${unknown.detail}`);
});
check("decideUpdate：落后 → 拉", () => {
	const d = decideUpdate({ isRepo: true, dirty: false, ahead: 0, behind: 3, localVersion: "0.6.0", remoteVersion: "0.7.0" });
	assert.equal(d.action, "pull");
	assert.ok(d.detail.includes("0.6.0") && d.detail.includes("0.7.0"), `应含版本变化：${d.detail}`);
});
check("decideUpdate：一致 → 已最新", () => {
	const d = decideUpdate({ isRepo: true, dirty: false, ahead: 0, behind: 0, localVersion: "0.6.0", remoteVersion: "0.6.0" });
	assert.equal(d.action, "up-to-date");
});
check("decideUpdate：commit 一致但版本号不同 → 只提示不自动处理", () => {
	const d = decideUpdate({ isRepo: true, dirty: false, ahead: 0, behind: 0, localVersion: "0.6.0", remoteVersion: "0.7.0" });
	assert.equal(d.action, "skip");
	assert.equal(d.reason, "version-mismatch");
});
check("decideUpdate：脏树优先于落后（顺序不能反）", () => {
	// 脏 + 落后时必须报 dirty，否则会拿脏树去 pull
	const d = decideUpdate({ isRepo: true, dirty: true, ahead: 0, behind: 9, localVersion: "0.6.0", remoteVersion: "0.9.0" });
	assert.equal(d.reason, "dirty");
});
check("describeUpdate 渲染成一行", () => {
	assert.match(describeUpdate({ status: "已更新", detail: "0.6.0 → 0.7.0" }), /已更新.*0\.6\.0 → 0\.7\.0/);
	assert.match(describeUpdate({}), /未知/);
});

// ── 2. 真 git 沙箱 ─────────────────────────────────────────────────────────
// 不碰用户真实仓库：临时目录里建「远端」+ clone 当「本地」。

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore", timeout: 10000 });
		return true;
	} catch {
		return false;
	}
})();

if (!hasGit) {
	console.log("⚠ 跳过「真 git」段：PATH 里没有 git。");
	console.log(`\n${failures === 0 ? "✓ 自检通过（纯函数部分）" : `✗ ${failures} 项失败`}`);
	process.exit(failures === 0 ? 0 : 1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "autoupdate-selftest-"));
const originDir = path.join(scratch, "origin");
const localDir = path.join(scratch, "local");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** 写 package.json（版本号是真被读的东西）。 */
const writePkg = (dir, version) => {
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "probe", version }, null, 2)}\n`, "utf8");
};
const commit = (dir, message) => {
	git(dir, ["add", "-A"]);
	git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message, "--no-gpg-sign"]);
};

try {
	// —— 建「远端」——
	fs.mkdirSync(originDir, { recursive: true });
	git(originDir, ["init", "-b", "main"]);
	writePkg(originDir, "0.6.0");
	fs.writeFileSync(path.join(originDir, "lib.js"), "export const v = 1;\n");
	commit(originDir, "v0.6.0");

	// —— clone 当「本地」——
	execFileSync("git", ["clone", originDir, localDir], { encoding: "utf8", stdio: "ignore" });
	git(localDir, ["config", "user.email", "t@t"]);
	git(localDir, ["config", "user.name", "t"]);

	const cfg = { ...AUTO_UPDATE_DEFAULTS, remote: "origin", branch: "main" };

	// ① 一致 → 已最新
	{
		const r = await checkAndUpdate({ cwd: localDir, config: cfg });
		check("真 git：一致时报告已最新且不动", () => {
			assert.equal(r.changed, false);
			assert.equal(r.status, "已是最新", `实际 ${r.status} / ${r.detail}`);
			assert.match(r.detail, /0\.6\.0/);
		});
	}

	// ② 远端前进 → 拉下来
	{
		writePkg(originDir, "0.7.0");
		fs.writeFileSync(path.join(originDir, "lib.js"), "export const v = 2;\n");
		commit(originDir, "v0.7.0");

		const r = await checkAndUpdate({ cwd: localDir, config: cfg });
		check("真 git：落后时拉下来", () => {
			assert.equal(r.changed, true, `应拉取，实际 ${r.status} / ${r.detail}`);
			assert.equal(r.status, "已更新");
			assert.match(r.detail, /0\.6\.0 → 0\.7\.0/);
		});
		check("真 git：拉完后工作区真的是新版本", () => {
			assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, "package.json"), "utf8")).version, "0.7.0");
			assert.match(fs.readFileSync(path.join(localDir, "lib.js"), "utf8"), /v = 2/, "代码也应更新");
		});
	}
	{
		const r = await checkAndUpdate({ cwd: localDir, config: cfg });
		check("真 git：拉完再查 = 已最新（幂等，不会反复拉）", () => {
			assert.equal(r.status, "已是最新", `实际 ${r.status} / ${r.detail}`);
			assert.equal(r.changed, false);
		});
	}

	// ③ 有未提交改动 → 跳过且不覆盖
	{
		writePkg(originDir, "0.8.0");
		commit(originDir, "v0.8.0");
		// 本地制造未提交改动
		fs.writeFileSync(path.join(localDir, "lib.js"), "// 我自己的活，不能被覆盖\n");

		const r = await checkAndUpdate({ cwd: localDir, config: cfg });
		check("真 git：有未提交改动时跳过", () => {
			assert.equal(r.changed, false, "不该拉");
			assert.equal(r.reason, "dirty", `实际 reason=${r.reason} / ${r.detail}`);
		});
		check("真 git：未提交改动没被覆盖（这是最关键的一条）", () => {
			assert.match(fs.readFileSync(path.join(localDir, "lib.js"), "utf8"), /不能被覆盖/);
			assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, "package.json"), "utf8")).version, "0.7.0", "版本也不该变");
		});
		// 清掉改动，恢复干净
		git(localDir, ["checkout", "--", "lib.js"]);
	}

	// ④ 本地领先 → 跳过（不合并）
	{
		fs.writeFileSync(path.join(localDir, "mine.js"), "// 我推不上去的提交\n");
		commit(localDir, "local ahead");
		const r = await checkAndUpdate({ cwd: localDir, config: cfg });
		check("真 git：本地领先时跳过", () => {
			assert.equal(r.changed, false);
			assert.equal(r.reason, "ahead", `实际 reason=${r.reason} / ${r.detail}`);
		});
		check("真 git：本地提交还在（没被合并/重置）", () => {
			assert.ok(fs.existsSync(path.join(localDir, "mine.js")));
		});
		// 回退这个本地提交，方便后面的场景
		git(localDir, ["reset", "--hard", "origin/main"]);
	}

	// ⑤ 不是 git 目录 → 跳过
	{
		const plain = path.join(scratch, "plain");
		fs.mkdirSync(plain, { recursive: true });
		writePkg(plain, "0.6.0");
		const r = await checkAndUpdate({ cwd: plain, config: cfg });
		check("真 git：非 git 目录跳过（不是报错）", () => {
			assert.equal(r.changed, false);
			assert.equal(r.reason, "not-a-repo", `实际 reason=${r.reason} / ${r.detail}`);
		});
	}

	// ⑥ 远端不可达 → 报检查失败，且**不抛**
	{
		const r = await checkAndUpdate({ cwd: localDir, config: { ...cfg, remote: "no-such-remote-xyz" } });
		check("真 git：远端不可达时报检查失败而不是抛", () => {
			assert.equal(r.changed, false);
			assert.equal(r.reason, "fetch-failed", `实际 reason=${r.reason} / ${r.detail}`);
			assert.ok((r.detail ?? "").length > 0, "要给一句可读的原因");
		});
	}

	// ⑧ 并发：多个 dsh 实例同时跑检查，不能互相踩着报错。
	//
	// 真事故：并发的 `fetch` 会因 git 的 ref 锁失败
	//（`cannot lock ref 'refs/remotes/origin/main': is at X but expected Y`）——
	// 实测 5 个并发里 4 个失败；`pull --ff-only` 并发也会报
	// `Cannot fast-forward to multiple branches`。两者都会让多实例启动时误报「检查失败」。
	//
	// 注意「远端真的前进了」是前提：不前进时 ref 不变，碰撞不出来（试过，会假绿）。
	{
		writePkg(originDir, "0.9.0");
		fs.writeFileSync(path.join(originDir, "lib.js"), "export const v = 9;\n");
		commit(originDir, "v0.9.0");
		const results = await Promise.all([
			checkAndUpdate({ cwd: localDir, config: cfg }),
			checkAndUpdate({ cwd: localDir, config: cfg }),
			checkAndUpdate({ cwd: localDir, config: cfg }),
			checkAndUpdate({ cwd: localDir, config: cfg }),
			checkAndUpdate({ cwd: localDir, config: cfg }),
		]);
		check("真 git：并发检查不会互相踩（真 bug 回归）", () => {
			const failed = results.filter((r) => r.status === "更新失败" || r.status === "检查失败");
			assert.equal(failed.length, 0, `并发下不该有失败（fetch 锁重试 + merge --ff-only）：${JSON.stringify(results.map((r) => `${r.status}/${r.reason}`))}`);
			// 至少有一个把新版本拉下来了
			assert.ok(
				results.some((r) => r.status === "已更新"),
				`应有一个报已更新，实际 ${JSON.stringify(results.map((r) => r.status))}`,
			);
		});
		check("真 git：并发后工作区确实是新版（没被搞坏）", () => {
			assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, "package.json"), "utf8")).version, "0.9.0");
			assert.match(fs.readFileSync(path.join(localDir, "lib.js"), "utf8"), /v = 9/, "代码也要到位");
		});
	}

	// ⑨ 包目录在**外层仓库内部**时必须跳过。
	//
	// 真风险：`--is-inside-work-tree` 对「包含本目录的外层仓库」也返回 true。若本包被
	// 拷贝（而非软链）进某个 git 项目里，不查仓库根就会去 fetch/merge **外层仓库**，
	// 而 `merge --ff-only` 会改写用户自己的项目文件 —— 独立审查抓出来的。
	{
		const outer = path.join(scratch, "outer");
		const inner = path.join(outer, "packages", "tool");
		fs.mkdirSync(inner, { recursive: true });
		git(outer, ["init", "-b", "main"]);
		writePkg(outer, "9.9.9");
		commit(outer, "outer repo");
		// 内层目录**不是**自己的仓库，只是被外层包着
		writePkg(inner, "0.6.0");

		const r = await checkAndUpdate({ cwd: inner, config: cfg });
		check("真 git：包目录在外层仓库内时跳过（不动别人的仓库）", () => {
			assert.equal(r.changed, false, "绝不能去动外层仓库");
			assert.equal(r.reason, "not-repo-root", `实际 reason=${r.reason} / ${r.detail}`);
			assert.match(r.detail, /仓库根/, `应说清原因：${r.detail}`);
		});
		check("真 git：外层仓库的版本没被动过", () => {
			assert.equal(JSON.parse(fs.readFileSync(path.join(outer, "package.json"), "utf8")).version, "9.9.9");
		});
	}

	// ⑩ 配置的分支在远端不存在 → 给可读原因，不拖到 merge 才报。
	{
		const r = await checkAndUpdate({ cwd: localDir, config: { ...cfg, branch: "no-such-branch-xyz" } });
		check("真 git：远端无该分支时给可读原因", () => {
			assert.equal(r.changed, false);
			assert.ok(r.status === "检查失败" || r.status === "跳过", `实际 ${r.status}`);
			assert.match(r.detail ?? "", /no-such-branch-xyz|分支/, `应提到分支名：${r.detail}`);
		});
	}

	// ⑪ 安全加固（第 3 层审查指出）：
	// (a) 配置的 remote/branch 不能以 `-` 开头（execFile 不过 shell，但 git 会把
	//     `--upload-pack=…` 这类值当选项）——纵深防御，零成本。
	{
		const byRemote = await checkAndUpdate({ cwd: localDir, config: { ...cfg, remote: "--upload-pack=/bin/sh" } });
		check("安全：拒绝 `-` 开头的 remote", () => {
			assert.equal(byRemote.changed, false, "不能去执行它");
			assert.equal(byRemote.reason, "bad-config", `实际 ${byRemote.reason}`);
		});
		const byBranch = await checkAndUpdate({ cwd: localDir, config: { ...cfg, branch: "-x" } });
		check("安全：拒绝 `-` 开头的 branch", () => {
			assert.equal(byBranch.reason, "bad-config", `实际 ${byBranch.reason}`);
		});
	}

	// (b) 不触发用户仓库自己的 post-merge hook：那些 hook 是用户为手动 git 操作配的，
	// 自动更新在不告知的情况下跑它们属于越权（可能做部署、跑迁移）。
	// 这条必须带对照：不抑制时 hook 确实会跑，否则测不出抑制是否生效。
	{
		const hookMarker = path.join(scratch, "HOOK_RAN");
		const hookPath = path.join(localDir, ".git", "hooks", "post-merge");
		fs.mkdirSync(path.dirname(hookPath), { recursive: true });
		fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${hookMarker.replace(/\\/g, "/")}"\n`, "utf8");
		try {
			fs.chmodSync(hookPath, 0o755);
		} catch {
			/* Windows 上 chmod 可能无效，git 仍按可执行读 */
		}

		// 对照：手动 merge（不抑制）应该跑 hook
		writePkg(originDir, "1.1.0");
		commit(originDir, "v1.1.0");
		git(localDir, ["fetch", "-q", "origin", "main"]);
		fs.rmSync(hookMarker, { force: true });
		try {
			git(localDir, ["merge", "--ff-only", "origin/main"]);
		} catch {
			/* 已经最新时没有 merge 可做 */
		}
		const controlRan = fs.existsSync(hookMarker);
		check("对照：不抑制时 post-merge hook 确实会跑（否则下面的断言测不出东西）", () => {
			assert.equal(controlRan, true, "对照没跑起来 —— 这个 hook 测试不成立");
		});

		// 实测：自动更新应该抑制它
		writePkg(originDir, "1.2.0");
		commit(originDir, "v1.2.0");
		fs.rmSync(hookMarker, { force: true });
		const r = await checkAndUpdate({ cwd: localDir, config: cfg });
		check("安全：自动更新不触发用户的 post-merge hook", () => {
			assert.equal(r.status, "已更新", `前提：这次应该真的拉了，实际 ${r.status} / ${r.detail}`);
			assert.equal(fs.existsSync(hookMarker), false, "自动更新不该跑用户的 hook");
		});
		fs.rmSync(hookPath, { force: true });
	}

	// ⑦ installAutoUpdate 不阻塞、状态可读、绝不抛
	{
		const logs = [];
		const ctx = { logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]), error: () => {} } };
		const started = Date.now();
		const handle = installAutoUpdate(ctx, { config: { ...cfg, remote: "no-such-remote-xyz" }, cwd: localDir });
		const elapsed = Date.now() - started;
		check("installAutoUpdate 立即返回（不阻塞启动）", () => {
			assert.ok(elapsed < 500, `应立即返回，实际 ${elapsed}ms`);
			assert.equal(handle.enabled, true);
			assert.equal(typeof handle.describe(), "string");
		});
		await handle.done;
		check("installAutoUpdate 的 done 结算后状态可读", () => {
			assert.equal(handle.state.status, "检查失败", `实际 ${handle.state.status}`);
			// 失败要留一条 warn（只看状态字段容易被忽略）—— 不断言具体文案，
			// 只要求「有一条 warn 且提到了失败原因」
			assert.ok(
				logs.some(([lvl, m]) => lvl === "warn" && /失败|远端/.test(m)),
				`应有一条说明失败的 warn，实际日志：${JSON.stringify(logs)}`,
			);
		});
		// 关掉时
		const off = installAutoUpdate(ctx, { config: { ...AUTO_UPDATE_DEFAULTS, enabled: false }, cwd: localDir });
		check("关掉时 status=关 且不检查", () => {
			assert.equal(off.enabled, false);
			assert.match(off.describe(), /关/);
		});
	}
} finally {
	try {
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* Windows 上偶尔有句柄没放，留在 temp 里无所谓 */
	}
}

console.log(failures === 0 ? "\n✓ 自检通过：版本比较 / 六种 git 情形 / 不阻塞启动 / 失败不抛" : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
