#!/usr/bin/env node
/**
 * 集成冒烟：**真 GitHub + 真 `gh`**，把 superagent 的两条网络路径跑一遍。
 *
 * 为什么不能只靠单测：`source-github` 与 `reply-github` 的 argv 形状、JSON 解析、
 * 错误分类，全是对着文档写的。文档说 `gh api -X POST /repos/{o}/{r}/issues/{n}/comments -f body=…`，
 * 但「文档对」和「这台机器上真能发出去」是两件事 —— 2026-11-08 实测本机就有两处不一样：
 *
 *   1. `gh` 的 keyring token 是坏的（`gh auth status` 报 `token in keyring is invalid`），
 *      所以**所有** `gh api` 都会 401。修法：`printf '%s' "$TOKEN" | gh auth login --with-token`。
 *   2. 本机直连 `api.github.com` 超时，必须走代理。而**宿主会剥掉凭证形状的 env**
 *      （`dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN`），`GH_TOKEN` 传不进子进程 ——
 *      所以 dsh 里跑 gh 只能靠 keyring（已修）+ 宿主进程启动时带着 `HTTPS_PROXY`。
 *
 * 它做四件事，全在**自己的可控仓库**上（默认 `GregTech-Star-Navigation/GTSNLib`）：
 *   1. 建一个带触发词的测试 issue；
 *   2. 真跑 `fetchNewComments`，断言能捞到它；
 *   3. 真跑 `deliverReply` 发一条评论，再跑一次断言 skipped（幂等）；
 *   4. close 掉 issue（**不删** —— GitHub 没有删 issue 的 API，留个 closed 的可查）。
 *
 * 不进 `npm test`（要网络 + 认证 + 写权限）。用法：
 *
 *   HTTPS_PROXY=http://127.0.0.1:7897 node scripts/smoke-superagent-github.mjs [owner/repo]
 *
 * 前置：`gh auth status` 要是绿的。没绿先 `printf '%s' "$TOKEN" | gh auth login --with-token`。
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { deliverReply, postComment } from "../lib/superagent/reply-github.js";
import { fetchNewComments } from "../lib/superagent/source-github.js";
import { SuperagentStore } from "../lib/superagent/store.js";

const run0 = promisify(execFile);

/** 真的 gh 执行器：与宿主里的 `makeGhRunner` 同样形状，但在这里继承完整 env（绕过宿主的凭证剥离）。 */
async function run(argv) {
	try {
		const { stdout, stderr } = await run0("gh", argv, {
			env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		return {
			code: typeof error?.code === "number" ? error.code : 1,
			stdout: String(error?.stdout ?? ""),
			stderr: String(error?.stderr ?? error?.message ?? ""),
		};
	}
}

const REPO = process.argv[2] ?? "GregTech-Star-Navigation/GTSNLib";
const MARK = `<!-- dsh-superagent-smoke ${Date.now()} -->`;

let failed = 0;
const check = (cond, what, detail = "") => {
	if (cond) {
		console.log(`✓ ${what}`);
		return true;
	}
	failed += 1;
	console.log(`✗ ${what}${detail === "" ? "" : `\n    ${detail}`}`);
	return false;
};

/** 前置：gh 能认证、能连上。连不上就直接停 —— 后面的每一步都会以同样的方式失败。 */
async function preflight() {
	const auth = await run(["auth", "status"]);
	const ok = check(auth.code === 0, "gh 已认证", `${auth.stderr.trim().slice(0, 300)}`);
	if (!ok) return false;
	const who = await run(["api", "/user", "--jq", ".login"]);
	return check(who.code === 0, "GitHub API 可达", `${who.stderr.trim().slice(0, 300)}\n    本机直连不通时要带 HTTPS_PROXY=http://127.0.0.1:7897`);
}

/** 建一个测试 issue，返回它的号。 */
async function createIssue() {
	const body = [
		"这是一个自动化冒烟测试建的 issue，跑完会自动关闭。",
		"",
		"/agent 这条不会被执行 —— 冒烟脚本只验「能不能捞到、能不能回评论」。",
		"",
		MARK,
	].join("\n");
	const created = await run([
		"api",
		"-X",
		"POST",
		`/repos/${REPO}/issues`,
		"-f",
		`title=[superagent-smoke] ${new Date().toISOString()}`,
		"-f",
		`body=${body}`,
	]);
	if (created.code !== 0) {
		check(false, "建测试 issue", created.stderr.trim().slice(0, 400));
		return null;
	}
	let number;
	try {
		number = JSON.parse(created.stdout).number;
	} catch {
		check(false, "解析新建 issue 的号", created.stdout.slice(0, 200));
		return null;
	}
	check(Number.isInteger(number), `建测试 issue（#${number}）`);
	return number;
}

async function main() {
	console.log(`仓库：${REPO}\n`);
	if (!(await preflight())) {
		console.log("\n前置没过，后面的测试全都会以同样方式失败 —— 停。");
		process.exitCode = 1;
		return;
	}

	const dir = mkdtempSync(path.join(tmpdir(), "sa-smoke-"));
	const number = await createIssue();
	if (number === null) {
		rmSync(dir, { recursive: true, force: true });
		process.exitCode = 1;
		return;
	}

	try {
		// ① 真跑 fetchNewComments：用仓库里**长期 open 的**那条 issue 验「正文能被捞到」。
		//
		//    为什么不用刚建的那条：2026-11-08 实测 `/issues?state=open&sort=updated` 有索引延迟 ——
		//    刚建的 issue 单查是 `state=open`，但列表里查不到（等几十秒才出现）。
		//    那是 GitHub 的行为，不是我们的 bug（下一轮轮询自然会捞到），
		//    但拿它当断言会得到一个「有时绿有时红」的测试。
		const fetched = await fetchNewComments({ run }, { repo: REPO, cursor: null, maxIssues: 10 });
		check(fetched.errors.length === 0, "轮询无错误", fetched.errors.join("\n    "));
		const bodies = fetched.comments.filter((c) => c.kind === "issue-body");
		check(bodies.length > 0, "issue 正文被当成事件捞到（真环境）", `扫了 ${fetched.scanned} 条评论，正文事件 ${bodies.length} 条`);
		if (bodies.length > 0) {
			const sample = bodies[0];
			check(
				typeof sample.commentId === "string" && sample.commentId.startsWith("issue-"),
				"正文用虚拟 id issue-<号>",
				sample.commentId,
			);
			check(sample.author !== "" && sample.authorAssociation !== "", "正文的作者与关系解析正确", JSON.stringify({ a: sample.author, r: sample.authorAssociation }));
			check(sample.body.length > 0, "正文内容非空");
		}
		// 刚建的那条**可能**因索引延迟不在列表里 —— 单独记一句，不算失败
		const fresh = fetched.comments.find((c) => c.issueNumber === number);
		console.log(
			fresh
				? `  · 刚建的 #${number} 已在列表里`
				: `  · 刚建的 #${number} 还没进 open 列表（GitHub 索引延迟，属正常）`,
		);

		// ② 真跑 postComment：发得出去吗
		const posted = await postComment({ run }, {
			repo: REPO,
			issueNumber: number,
			body: `冒烟测试的回复。\n\n${MARK}`,
		});
		check(posted.ok === true, "发评论成功", posted.error ?? "");
		check(typeof posted.url === "string" && posted.url.includes("/issues/"), "拿到评论链接", posted.url ?? "(无)");

		// ③ 真跑 deliverReply：第一次发、第二次跳
		const store = new SuperagentStore({ dir });
		let sends = 0;
		const countingRun = async (argv) => {
			if (argv.includes("POST")) sends += 1;
			return run(argv);
		};
		const first = await deliverReply({ store, run: countingRun }, {
			commentId: `smoke-${number}`,
			repo: REPO,
			issueNumber: number,
			body: "第一条回复",
			status: "done",
			branch: "sa/smoke",
		});
		check(first.ok === true, "deliverReply 第一次成功", first.error ?? "");
		const second = await deliverReply({ store, run: countingRun }, {
			commentId: `smoke-${number}`,
			repo: REPO,
			issueNumber: number,
			body: "第二条回复",
			status: "done",
		});
		check(second.skipped === true, "deliverReply 第二次跳过（幂等）");
		check(sends === 1, "真的只发出去一条", `实际发了 ${sends} 条`);

		// ④ 错误路径：不存在的仓库要明确失败，不能静默成功
		const bad = await postComment({ run }, { repo: "deepseek-ai/definitely-not-a-repo-xyz", issueNumber: 1, body: "x" });
		check(bad.ok === false, "不存在的仓库 → 明确失败", `返回 ${JSON.stringify(bad).slice(0, 200)}`);
	} finally {
		// 收尾：close 掉（GitHub 没有删 issue 的 API）
		const closed = await run(["api", "-X", "PATCH", `/repos/${REPO}/issues/${number}`, "-f", "state=closed"]);
		check(closed.code === 0, `关掉测试 issue #${number}`);
		rmSync(dir, { recursive: true, force: true });
	}

	console.log(`\n${failed === 0 ? "全部通过 ✓" : `${failed} 项失败 ✗`}`);
	process.exitCode = failed === 0 ? 0 : 1;
}

await main();
