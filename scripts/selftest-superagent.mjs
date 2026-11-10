#!/usr/bin/env node
/**
 * 自检：superagent 的 Policy 判定。
 *
 * 盯的是三件会让它「默默干错事」的地方：
 *   1. **fail-closed**：空策略必须全拒。写反了（默认放行）就是「任何人往 issue 里
 *      写一句话就能让 agent 在 danger-full-access 会话里跑」。
 *   2. **双闸**：login 白名单 **且** author_association 是仓库成员。少一道，
 *      要么「被移出组织的人还能触发」，要么「任何一个 MEMBER 都能触发」。
 *   3. **触发词按词边界**：`/agent` 不能命中 `/agentic` —— 否则一句
 *      「这个 /agentic workflow 怎么样」就起一个会话。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";

import {
	DEFAULT_TRIGGER,
	TRUSTED_ASSOCIATIONS,
	decide,
	extractInstruction,
	normalizePolicy,
} from "../lib/superagent/policy.js";

let passed = 0;
const ok = (name) => {
	passed += 1;
	console.log(`✓ ${name}`);
};

/** 一条合法的事件底稿，各用例只改自己关心的字段。 */
const baseEvent = () => ({
	repo: "deepseek-ai/dsh-team-workflow",
	issueNumber: 7,
	commentId: "1001",
	author: "YG",
	authorAssociation: "OWNER",
	body: "/agent 把 README 里的安装步骤补全",
});

/** 一条放行的策略底稿。 */
const basePolicy = () => ({
	repos: ["deepseek-ai/dsh-team-workflow"],
	actors: ["YG"],
	acceptMode: "auto",
	trigger: DEFAULT_TRIGGER,
});

// —— 1. fail-closed ——

assert.deepEqual(
	normalizePolicy(undefined),
	{ repos: [], actors: [], trigger: DEFAULT_TRIGGER, acceptMode: "off" },
	"缺配置时必须是「全拒 + 关」的形态，不能有任何一个字段默认放行",
);
assert.equal(decide(baseEvent(), undefined).kind, "unavailable", "没有策略时不能执行（acceptMode 默认 off）");
assert.equal(decide(baseEvent(), { acceptMode: "auto" }).kind, "ignore", "acceptMode=auto 但白名单空 → 仍然拒");
assert.equal(
	decide(baseEvent(), { acceptMode: "auto", actors: ["YG"] }).kind,
	"ignore",
	"只有 actors 没有 repos → 仍然拒（仓库维度必须显式列出）",
);
ok("fail-closed：缺策略 / 空白名单一律拒");

// —— 2. acceptMode 三态 ——

assert.equal(decide(baseEvent(), basePolicy()).kind, "accept", "底稿策略应当放行");
assert.equal(
	decide(baseEvent(), { ...basePolicy(), acceptMode: "observe" }).kind,
	"accept",
	"observe 也要判成 accept（只是执行层不真跑），判定层不能替它决定",
);
assert.equal(
	decide(baseEvent(), { ...basePolicy(), acceptMode: "off" }).kind,
	"unavailable",
	"off 必须停机",
);
ok("acceptMode：off 停机，observe/auto 都进候选");

// —— 3. 仓库与作者两道闸 ——

assert.equal(decide({ ...baseEvent(), repo: "someone/else" }, basePolicy()).kind, "ignore", "别人的仓库不能触发");
assert.equal(decide({ ...baseEvent(), author: "stranger" }, basePolicy()).kind, "ignore", "名单外的人不能触发");
assert.equal(
	decide({ ...baseEvent(), authorAssociation: "CONTRIBUTOR" }, basePolicy()).kind,
	"ignore",
	"login 在名单里但 association 不是成员 → 仍拒（防「被移出组织后仍能触发」）",
);
assert.equal(
	decide({ ...baseEvent(), authorAssociation: "NONE" }, basePolicy()).kind,
	"ignore",
	"外部人 association=NONE → 拒",
);
for (const assoc of TRUSTED_ASSOCIATIONS) {
	assert.equal(
		decide({ ...baseEvent(), authorAssociation: assoc }, basePolicy()).kind,
		"accept",
		`${assoc} 是受信 association，应当放行`,
	);
}
ok("仓库 + 作者双闸：login 与 association 都要过");

// —— 4. 触发词按词边界 ——

assert.equal(decide({ ...baseEvent(), body: "LGTM，辛苦了" }, basePolicy()).kind, "ignore", "没有触发词的普通评论不能起任务");
assert.equal(
	decide({ ...baseEvent(), body: "这个 /agentic workflow 看着不错" }, basePolicy()).kind,
	"ignore",
	"《/agentic》不能被 /agent 命中 —— 否则一句闲聊就起会话",
);
assert.equal(
	decide({ ...baseEvent(), body: "先说结论\n\n/agent 跑一下 lint" }, basePolicy()).kind,
	"accept",
	"触发词在正文中间（非首行）也应命中",
);
assert.equal(
	decide({ ...baseEvent(), body: "/run 跑一下" }, { ...basePolicy(), trigger: "/run" }).kind,
	"accept",
	"触发词可配置",
);
ok("触发词：词边界、可配置、普通评论被拒");

// —— 5. 停机词优先于接受 ——

assert.equal(
	decide({ ...baseEvent(), body: "/agent stop" }, basePolicy()).kind,
	"stop",
	"停机词必须判成 stop，不能当成新任务",
);
assert.equal(
	decide({ ...baseEvent(), body: "/agent stop 先别动" }, basePolicy()).kind,
	"stop",
	"停机词后面跟解释也算停机",
);
ok("停机词：/agent stop 判成 stop");

// —— 6. 任务描述提取 ——

assert.equal(
	extractInstruction("/agent 把 README 里的安装步骤补全"),
	"把 README 里的安装步骤补全",
	"触发词要被剥掉",
);
assert.equal(
	extractInstruction("背景：这个 /agentic 方案不错\n/agent 真的跑一下"),
	"真的跑一下",
	"只取**第一次真正命中**的触发词之后 —— 引用的 /agentic 不算",
);
assert.equal(extractInstruction("没有触发词"), "", "没有触发词返回空串");
assert.equal(extractInstruction("/agent"), "", "只有触发词时任务为空（调用方要拒）");
ok("任务描述提取：剥触发词、只取第一次命中");

// —— 7. 判定必须给出可读理由 ——

for (const decision of [
	decide(baseEvent(), undefined),
	decide({ ...baseEvent(), repo: "x/y" }, basePolicy()),
	decide({ ...baseEvent(), body: "LGTM" }, basePolicy()),
	decide(baseEvent(), basePolicy()),
]) {
	assert.ok(
		typeof decision.reason === "string" && decision.reason.length > 0,
		`判定必须带可读理由（面板上要回答「为什么这条没跑」）：${JSON.stringify(decision)}`,
	);
}
ok("每条判定都带可读理由");

// —— 8. 结果捕获：从会话事件流里取最后一条助手文本 ——
//
// 盯的是「回评论会不会发出空内容」与「畸形事件会不会毁掉整次读取」。
// 假替身按真实形态造：`sessionPersistence.open(id,'read')` → handle 有
// `read(offset, limit) → { events }` 与 `close()`（dsh-session-persistence-jsonl）。
{
	const { extractText, lastAssistantText, readFinalOutput } = await import("../lib/superagent/result.js");

	// extractText：只取 text 块，图片/工具块丢掉
	assert.equal(
		extractText([{ type: "text", text: "第一段" }, { type: "image", source: {} }, { type: "text", text: "第二段" }]),
		"第一段\n第二段",
		"多段文本要用换行拼起来，图片块要丢掉",
	);
	assert.equal(extractText([{ type: "image", source: {} }]), "", "只有图片时返回空串");
	assert.equal(extractText(null), "", "畸形 content 返回空串而不是抛");
	assert.equal(extractText([{ type: "text", text: "  " }]), "", "纯空白要 trim 成空串");

	// lastAssistantText：多条取最后一条**非空**
	const msg = (text) => ({ type: "assistant/message", data: { content: [{ type: "text", text }] } });
	assert.equal(lastAssistantText([]), "", "空事件流返回空串");
	assert.equal(lastAssistantText([msg("结论 A")]), "结论 A", "单条直接返回");
	assert.equal(lastAssistantText([msg("结论 A"), msg("结论 B")]), "结论 B", "多条取最后一条");
	assert.equal(
		lastAssistantText([msg("结论 A"), { type: "assistant/message", data: { content: [{ type: "tool" }] } }]),
		"结论 A",
		"末尾只有工具调用的轮次不能把结论覆盖成空 —— 否则会往 issue 里发空评论",
	);
	assert.equal(
		lastAssistantText([msg("结论 A"), null, { garbage: true }, { type: "user/message", data: {} }]),
		"结论 A",
		"畸形事件与非助手事件一律跳过，不抛",
	);
	assert.equal(
		lastAssistantText([{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "包了一层" }] } } }]),
		"包了一层",
		"data.message.content 形态也要认",
	);
	ok("结果捕获：取最后一条非空助手文本，畸形事件跳过");

	// readFinalOutput：分页读 + 一定要 close
	{
		const pages = [[msg("第一页")], [msg("第二页")], []];
		let calls = 0;
		let closed = false;
		const fakeCtx = {
			get: (name) =>
				name !== "sessionPersistence"
					? undefined
					: {
							open: async (id, access) => {
								assert.equal(id, "s-1", "要按传进来的 sessionId 打开");
								assert.equal(access, "read", "必须是只读打开 —— 不能碰正在跑的会话");
								return {
									read: async (offset, limit) => {
										assert.equal(limit, 512, "默认每页 512");
										const chunk = pages[calls++] ?? [];
										return { events: chunk };
									},
									close: async () => {
										closed = true;
									},
								};
							},
						},
		};
		assert.equal(await readFinalOutput(fakeCtx, "s-1"), "第二页", "跨页时要取最后一页里的最后一条");
		assert.equal(closed, true, "读完必须 close 句柄，否则会话文件一直占着");
		let threw = false;
		try {
			await readFinalOutput({ get: () => undefined }, "s-1");
		} catch {
			threw = true;
		}
		assert.equal(threw, true, "没有 sessionPersistence 服务时要显式抛，不能静默返回空串");
		ok("readFinalOutput：分页读取、只读打开、必 close、缺服务显式抛");
	}
}

// —— 9. 状态存储：幂等占坑、单写者、原子写、坏文件恢复 ——
//
// 盯的是「跑完但没记下来 → 重跑」这条连锁：claim 必须先占坑再干活。
// 全部用真目录真文件跑（fs 的原子性是它的一半职责，假替身测不出来）。
{
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-store-"));
	try {
		// 并发 claim：同一个 id 只能有一个 true
		{
			const store = new SuperagentStore({ dir: path.join(dir, "concurrent") });
			const results = await Promise.all([
				store.claim("c-1"),
				store.claim("c-1"),
				store.claim("c-1"),
				store.claim("c-2"),
			]);
			assert.deepEqual(
				results,
				[true, false, false, true],
				"并发 claim 同一个 id 只能成功一次 —— 否则会重复开 worktree、重复推送、重复评论",
			);
		}

		// 落盘与读回
		{
			const sub = path.join(dir, "persist");
			const a = new SuperagentStore({ dir: sub });
			await a.saveTicket("c-1", { status: "running", startedAt: "2026-11-08T01:00:00Z" });
			await a.advanceCursor("c-1");
			const b = new SuperagentStore({ dir: sub });
			const tickets = await b.listTickets();
			assert.equal(tickets.length, 1, "新实例要能读到上一条写进去的记录");
			assert.equal(tickets[0].commentId, "c-1", "listTickets 要把 commentId 带出来");
			assert.equal(tickets[0].status, "running", "Ticket 字段要原样保留");
			const snapshot = await b.read();
			assert.equal(snapshot.cursor.lastCommentId, "c-1", "游标要落盘");
			assert.ok(
				fs.existsSync(path.join(sub, "state.json")),
				"状态文件应当在约定路径上，别写到别处",
			);
			const leftovers = fs.readdirSync(sub).filter((f) => f.endsWith(".tmp"));
			assert.deepEqual(leftovers, [], "写完不能留下 .tmp —— 那是崩在中间才会有的残骸");
		}

		// 坏文件：留档 + 从空开始，不抛
		{
			const sub = path.join(dir, "corrupt");
			fs.mkdirSync(sub, { recursive: true });
			fs.writeFileSync(path.join(sub, "state.json"), "{ 这不是 JSON", "utf8");
			const store = new SuperagentStore({ dir: sub });
			const state = await store.read();
			assert.deepEqual(state.seen, [], "坏文件要当作空状态，不能让整个子系统起不来");
			assert.ok(
				fs.readdirSync(sub).some((f) => f.includes(".corrupt-")),
				"坏文件要留档（改名而不是删掉），否则现场就没了",
			);
		}

		// update 抛错时不落盘
		{
			const sub = path.join(dir, "reject");
			const store = new SuperagentStore({ dir: sub });
			await store.claim("keep-me");
			let threw = false;
			try {
				await store.update((s) => {
					s.seen.push("should-not-persist");
					throw new Error("mutator 故意失败");
				});
			} catch {
				threw = true;
			}
			assert.equal(threw, true, "mutator 抛错要透传给调用方");
			const state = await store.read();
			assert.ok(!state.seen.includes("should-not-persist"), "抛错的那次改动不能落盘");
			assert.ok(state.seen.includes("keep-me"), "之前写进去的不能被后来的失败抹掉");
		}

		// seen 上限：不能无限长
		{
			const sub = path.join(dir, "cap");
			const store = new SuperagentStore({ dir: sub });
			for (let i = 0; i < 1010; i += 1) await store.claim(`cap-${i}`);
			const state = await store.read();
			assert.equal(state.seen.length, 1000, "seen 要截断到上限，否则状态文件无限长大");
			assert.equal(state.seen.at(-1), "cap-1009", "截断要留最近的，不能把新的截掉");
		}
		ok("状态存储：并发 claim 幂等、原子写、坏文件留档恢复、抛错不落盘、seen 有上限");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// —— 10. 执行编排：claim 先行、失败可查、空结果不装成功 ——
//
// 真跑 agent 要完整宿主上下文（11 个服务 + danger-full-access 会话），CI 里起不来。
// 但「claim 做了没」「失败记成什么」「空结果算不算完成」这些最容易写错的判断全在
// 编排层，用假 runAgent 就能测 —— 这也是把它切成依赖注入的原因。
{
	const { executeTicket, TICKET_STATUS } = await import("../lib/superagent/executor.js");
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	assert.deepEqual(
		[...TICKET_STATUS].sort(),
		["done", "failed", "needs-human", "running"],
		"Ticket 状态集合变了就要同步面板与文档",
	);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-exec-"));
	const baseReq = () => ({
		commentId: "c-100",
		repo: "deepseek-ai/dsh-team-workflow",
		issueNumber: 7,
		instruction: "把 README 补全",
		branch: "sa/issue-7",
	});
	try {
		// 成功路径
		{
			const store = new SuperagentStore({ dir: path.join(dir, "ok") });
			const result = await executeTicket(
				{ store, runAgent: async () => ({ ok: true, sessionId: "s1", text: "改好了", worktree: "/wt" }) },
				baseReq(),
			);
			assert.equal(result.status, "done", "正常跑完记 done");
			assert.equal(result.text, "改好了", "结果文本要透传出去（回评论要用）");
			const [ticket] = await store.listTickets();
			assert.equal(ticket.status, "done", "落盘状态要跟着");
			assert.equal(ticket.sessionId, "s1", "sessionId 要落盘 —— 事后要能打开那个会话查");
			assert.ok(ticket.startedAt && ticket.endedAt, "起止时间都要有，否则算不出耗时");
		}

		// 幂等：同一条评论第二次直接跳过，不调 runAgent
		{
			const store = new SuperagentStore({ dir: path.join(dir, "idem") });
			let calls = 0;
			const runAgent = async () => {
				calls += 1;
				return { ok: true, text: "第一次" };
			};
			await executeTicket({ store, runAgent }, baseReq());
			const second = await executeTicket({ store, runAgent }, baseReq());
			assert.equal(calls, 1, "同一条评论不能被跑两次 —— 否则重复开 worktree、重复推送、重复评论");
			assert.equal(second.status, "skipped", "第二次要明确返回 skipped，不能装作跑了");
		}

		// runAgent 抛错 → failed，错误原因要落盘
		{
			const store = new SuperagentStore({ dir: path.join(dir, "throw") });
			const result = await executeTicket(
				{
					store,
					runAgent: async () => {
						throw new Error("worktree 目录被占用");
					},
				},
				baseReq(),
			);
			assert.equal(result.status, "failed", "抛错记 failed");
			assert.match(result.reason, /worktree 目录被占用/, "原因要原样带出来，别吞成「未知错误」");
			const [ticket] = await store.listTickets();
			assert.equal(ticket.status, "failed", "失败也要落盘 —— 面板上要能看见");
		}

		// 跑完但没输出 → needs-human，**不是** done
		{
			const store = new SuperagentStore({ dir: path.join(dir, "empty") });
			const result = await executeTicket({ store, runAgent: async () => ({ ok: true, text: "   " }) }, baseReq());
			assert.equal(
				result.status,
				"needs-human",
				"空输出不能记 done —— done 在面板上意味着「可以合并了」",
			);
		}

		// 执行层报 ok:false → failed
		{
			const store = new SuperagentStore({ dir: path.join(dir, "notok") });
			const result = await executeTicket(
				{ store, runAgent: async () => ({ ok: false, error: "agent 被中止" }) },
				baseReq(),
			);
			assert.equal(result.status, "failed", "ok:false 要记 failed");
			assert.match(result.reason, /agent 被中止/, "错误文本要带出来");
		}

		// 空指令：不起会话，但也不静默吞
		{
			const store = new SuperagentStore({ dir: path.join(dir, "noinstr") });
			let calls = 0;
			const result = await executeTicket(
				{ store, runAgent: async () => ((calls += 1), { ok: true, text: "x" }) },
				{ ...baseReq(), commentId: "c-empty", instruction: "   " },
			);
			assert.equal(calls, 0, "触发词后面没内容时不该起会话");
			assert.equal(result.status, "needs-human", "要记成需要人看，不能静默丢弃");
		}
		ok("执行编排：claim 先行、幂等、失败可查、空结果记 needs-human");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// —— 11. 回评论：凭据在编排层、同一条不重复发 ——
//
// 审查点名的硬点：agent 只许写 worktree，发评论由编排层用自己的凭据做。
// 这里用假 gh 执行器验三件事：argv 对不对、失败原因透不透、重复调用会不会发两遍。
{
	const { composeComment, postComment, deliverReply, MAX_COMMENT_CHARS } = await import(
		"../lib/superagent/reply-github.js"
	);
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	// composeComment：截断 + 标记
	const long = "x".repeat(MAX_COMMENT_CHARS + 1000);
	const composed = composeComment(long, { status: "done", branch: "sa/1" });
	assert.ok(composed.length <= MAX_COMMENT_CHARS, "超长正文必须截到上限内，否则 GitHub 直接拒");
	assert.match(composed, /已截断/, "截断要明说，别让人以为全文就这些");
	assert.match(composed, /<!-- dsh-superagent -->/, "要带可识别标记 —— 否则轮询会把自己的回复当成新触发源");
	assert.match(composed, /状态：done/, "要带状态");
	assert.match(composeComment("  "), /没有产出文本/, "空正文不能发一条空评论");

	// postComment：argv 与错误透传
	{
		let seen = null;
		const ok = await postComment(
			{ run: async (argv) => ((seen = argv), { code: 0, stdout: '{"html_url":"https://x/1"}', stderr: "" }) },
			{ repo: "a/b", issueNumber: 3, body: "hi" },
		);
		assert.equal(ok.ok, true, "正常情况应当成功");
		assert.equal(ok.url, "https://x/1", "要带出评论链接");
		assert.deepEqual(
			seen,
			["api", "-X", "POST", "/repos/a/b/issues/3/comments", "-f", "body=hi"],
			"argv 形状要对 —— gh api 的参数写错会静默 404",
		);
		const bad = await postComment(
			{ run: async () => ({ code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" }) },
			{ repo: "a/b", issueNumber: 3, body: "hi" },
		);
		assert.equal(bad.ok, false, "非零退出码要判失败");
		assert.match(bad.error, /403/, "要把 gh 的真实原因带出来，别吞成「失败」");
		assert.equal((await postComment({ run: async () => ({ code: 0 }) }, { repo: "bad", issueNumber: 3, body: "x" })).ok, false, "非法仓库名要本地就拦");
		assert.equal((await postComment({ run: async () => ({ code: 0 }) }, { repo: "a/b", issueNumber: 0, body: "x" })).ok, false, "非法 issue 号要本地就拦");
	}

	// deliverReply：幂等
	{
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-reply-"));
		try {
			const store = new SuperagentStore({ dir });
			let calls = 0;
			const deps = {
				store,
				run: async () => {
					calls += 1;
					return { code: 0, stdout: '{"html_url":"https://x/9"}', stderr: "" };
				},
			};
			const first = await deliverReply(deps, { commentId: "c-9", repo: "a/b", issueNumber: 9, body: "结果" });
			assert.equal(first.ok, true, "第一次要发出去");
			const second = await deliverReply(deps, { commentId: "c-9", repo: "a/b", issueNumber: 9, body: "结果" });
			assert.equal(second.skipped, true, "第二次要跳过 —— 重试/重跑/崩溃恢复都会走到这条");
			assert.equal(calls, 1, "同一条评论只能真的发一次");
			const state = await store.read();
			assert.equal(state.tickets["c-9"].replied, true, "已回标记要落盘");
			assert.equal(state.tickets["c-9"].replyUrl, "https://x/9", "评论链接也要记下来");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	ok("回评论：截断有提示、带可识别标记、失败透传原因、同一条只发一次");
}

// —— 12. GitHub 轮询：高水位增量、不自触发、单点失败不毁整轮 ——
{
	const { fetchNewComments, compareCommentId, isSelfComment, SELF_MARKER } = await import(
		"../lib/superagent/source-github.js"
	);

	// 大数精度：Number() 会在 2^53 之后静默判等
	assert.equal(compareCommentId("9007199254740993", "9007199254740992"), 1, "超过 2^53 的 id 也必须分得出大小（用 BigInt，别用 Number）");
	assert.equal(compareCommentId("100", "100"), 0, "相等要返回 0");
	assert.equal(compareCommentId("99", "100"), -1, "小数在前");
	assert.equal(compareCommentId("abc", "100"), -1, "坏 id 当 0 处理，不抛");

	assert.equal(isSelfComment(`结果\n${SELF_MARKER}`), true, "带标记的要认出来");
	assert.equal(isSelfComment("普通评论"), false, "没标记的不算自己发的");

	// 假 gh：按 path 返回预置 JSON
	const makeRun = (table) => async (argv) => {
		const path = argv[argv.length - 1];
		for (const [needle, value] of Object.entries(table)) {
			if (!path.includes(needle)) continue;
			if (value instanceof Error) throw value;
			if (typeof value === "object" && "code" in value) return value;
			return { code: 0, stdout: JSON.stringify(value), stderr: "" };
		}
		return { code: 0, stdout: "[]", stderr: "" };
	};

	const comment = (id, login, body, assoc = "MEMBER") => ({
		id: Number(id),
		user: { login },
		body,
		author_association: assoc,
		html_url: `https://github.com/x/y/issues/1#issuecomment-${id}`,
		created_at: "2026-11-08T00:00:00Z",
	});

	// 高水位过滤 + 跳过自己 + 顺序
	{
		const run = makeRun({
			"/issues?state=open": [{ number: 1 }],
			"/issues/1/comments": [
				comment(105, "YG", "/agent 干活"),
				comment(101, "YG", "老评论（低于游标）"),
				comment(103, "bot", `我自己回的\n${SELF_MARKER}`),
				comment(104, "YG", "/agent 也干活"),
			],
		});
		const out = await fetchNewComments({ run }, { repo: "x/y", cursor: "102" });
		assert.deepEqual(
			out.comments.map((c) => c.commentId),
			["104", "105"],
			"只取高于游标的、且跳过自己发的 —— 不跳就会自己触发自己",
		);
		assert.equal(out.nextCursor, "105", "游标要推进到最大 id");
		assert.equal(out.errors.length, 0, "正常情况不该有错误");
	}

	// issue 正文也要能触发 —— 2026-11-08 真仓库冒烟发现的缺口：
	// 触发词写在 issue 正文里是最自然的写法，而 /issues/{n}/comments 不含正文。
	{
		const run = makeRun({
			"/issues?state=open": [
				{
					number: 1,
					body: "/agent 把安装段补全",
					user: { login: "YG" },
					author_association: "OWNER",
					html_url: "https://github.com/x/y/issues/1",
					created_at: "2026-11-08T00:00:00Z",
				},
				{ number: 2, body: "   ", user: { login: "YG" }, author_association: "OWNER" },
			],
			"/issues/1/comments": [],
			"/issues/2/comments": [],
		});
		const out = await fetchNewComments({ run }, { repo: "x/y" });
		assert.equal(out.comments.length, 1, "issue 正文要占一个事件位；空正文不占");
		assert.equal(out.comments[0].commentId, "issue-1", "正文用虚拟 id issue-<号>");
		assert.equal(out.comments[0].kind, "issue-body", "要有 kind 标记，调用方分得出");
		assert.equal(out.comments[0].body, "/agent 把安装段补全", "正文原文要带出来");
		assert.equal(out.errors.length, 0, "正常情况不该有错误");
	}

	// 单点失败不毁整轮
	{
		const run = makeRun({
			"/issues?state=open": [{ number: 1 }, { number: 2 }],
			"/issues/1/comments": { code: 1, stdout: "", stderr: "HTTP 404: Not Found" },
			"/issues/2/comments": [comment(200, "YG", "/agent 干活")],
		});
		const out = await fetchNewComments({ run }, { repo: "x/y" });
		assert.equal(out.comments.length, 1, "2 号 issue 的评论要照常拿到");
		assert.equal(out.comments[0].commentId, "200", "拿到的正是 2 号那条");
		assert.equal(out.errors.length, 1, "1 号失败要记进 errors，不是静默吞");
		assert.match(out.errors[0], /404/, "错误里要带 gh 的真实原因");
	}

	// 整轮失败：issue 列表拉不到
	{
		const out = await fetchNewComments(
			{ run: async () => ({ code: 1, stdout: "", stderr: "HTTP 500" }) },
			{ repo: "x/y" },
		);
		assert.equal(out.comments.length, 0, "拉不到列表就不该有评论");
		assert.ok(out.errors.length > 0, "要报错，不能装作「这轮没有新评论」");
	}
	ok("GitHub 轮询：BigInt 比 id、跳自己发的、单点失败不毁整轮");
}

// —— 13. 整轮：observe 不跑、单条失败不挡后续、拉取失败不动游标 ——
{
	const { runRound } = await import("../lib/superagent/loop.js");
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const policyModule = await import("../lib/superagent/policy.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-loop-"));
	const ev = (id, body = "/agent 干活", login = "YG") => ({
		source: "github",
		repo: "a/b",
		issueNumber: 1,
		commentId: String(id),
		author: login,
		authorAssociation: "OWNER",
		body,
	});
	const policyOn = { repos: ["a/b"], actors: ["YG"], acceptMode: "auto", trigger: "/agent" };
	try {
		// observe：判定放行但不执行
		{
			const store = new SuperagentStore({ dir: path.join(dir, "observe") });
			let ran = 0;
			const out = await runRound(
				{
					store,
					source: { fetchNewComments: async () => ({ comments: [ev(1)], nextCursor: "1", scanned: 1, errors: [] }) },
					policy: policyModule,
					execute: async () => ((ran += 1), { status: "done", text: "x" }),
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: { ...policyOn, acceptMode: "observe" } },
			);
			assert.equal(ran, 0, "observe 模式绝不能真跑 —— 它是「先调策略再开闸」用的");
			assert.equal(out.accepted, 1, "判定层仍然要算出「放行了」");
			const state = await store.read();
			assert.equal(state.tickets["1"].status, "observed", "要记成 observed，面板上看得见");
		}

		// stop：记一笔，不执行
		{
			const store = new SuperagentStore({ dir: path.join(dir, "stop") });
			await runRound(
				{
					store,
					source: { fetchNewComments: async () => ({ comments: [ev(2, "/agent stop")], nextCursor: "2", scanned: 1, errors: [] }) },
					policy: policyModule,
					execute: async () => assert.fail("停机词不该执行"),
					reply: async () => assert.fail("停机词不该回评论"),
				},
				{ repo: "a/b", policy: policyOn },
			);
			const state = await store.read();
			assert.equal(state.tickets["2"].status, "stopped", "停机要留痕，不能静默跳过");
		}

		// 单条失败不挡后续 + 游标推进
		{
			const store = new SuperagentStore({ dir: path.join(dir, "partial") });
			const executed = [];
			const out = await runRound(
				{
					store,
					source: {
						fetchNewComments: async () => ({
							comments: [ev(10), ev(11), ev(12)],
							nextCursor: "12",
							scanned: 3,
							errors: ["2 号 issue 拉取失败"],
						}),
					},
					policy: policyModule,
					execute: async (req) => {
						executed.push(req.commentId);
						if (req.commentId === "11") return { status: "failed", reason: "worktree 被占" };
						return { status: "done", text: `做完 ${req.commentId}` };
					},
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.deepEqual(executed, ["10", "11", "12"], "一条失败不能让后面的不跑");
			assert.equal(out.executed, 2, "成功两条");
			assert.equal(out.replied, 2, "成功两条各回一条");
			assert.ok(
				out.errors.some((e) => e.includes("11")),
				"失败那条要进 errors，不能悄悄吞掉",
			);
			assert.ok(
				out.errors.some((e) => e.includes("2 号 issue")),
				"source 报的错也要透出来",
			);
			const state = await store.read();
			assert.equal(state.cursor.lastCommentId, "12", "本轮处理完要推进游标");
		}

		// 拉取失败：不动游标
		{
			const store = new SuperagentStore({ dir: path.join(dir, "fetchfail") });
			await store.claim("99");
			await store.advanceCursor("99");
			const out = await runRound(
				{
					store,
					source: {
						fetchNewComments: async () => {
							throw new Error("网络断了");
						},
					},
					policy: policyModule,
					execute: async () => assert.fail("拉取失败不该执行"),
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.ok(out.errors.length > 0, "拉取失败要报错");
			const state = await store.read();
			assert.equal(state.cursor.lastCommentId, "99", "拉取失败绝不能推进游标 —— 否则那批评论永久丢失");
		}
		ok("整轮：observe 不跑、停机留痕、单条失败不挡后续、拉取失败不动游标");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// —— 14. 出厂配置：每个键都有校验器、默认全关 ——
//
// 这是本仓库的既有规矩（`selftest.mjs` 里也有一条同样的）。漏一个键的校验器，
// 那个键写成什么值都会被悄悄丢掉 —— 用户改了配置却「没反应」，最难查。
{
	const { SUPERAGENT_DEFAULTS, SUPERAGENT_FIELDS } = await import("../lib/superagent/index.js");
	const fs = await import("node:fs");
	const path = await import("node:path");

	const template = JSON.parse(
		fs.readFileSync(path.join(import.meta.dirname, "..", "team", "extensions", "superagent.json"), "utf8"),
	);
	const keys = Object.keys(template).filter((key) => !key.startsWith("_"));
	assert.ok(keys.length > 0, "配置模板不能是空的");
	for (const key of keys) {
		assert.ok(
			Object.prototype.hasOwnProperty.call(SUPERAGENT_FIELDS, key),
			`配置模板里的 "${key}" 没有校验器 —— 写成什么值都会被悄悄丢掉`,
		);
		assert.ok(
			Object.prototype.hasOwnProperty.call(SUPERAGENT_DEFAULTS, key),
			`配置模板里的 "${key}" 没有默认值`,
		);
	}
	for (const key of Object.keys(SUPERAGENT_FIELDS)) {
		assert.ok(
			Object.prototype.hasOwnProperty.call(SUPERAGENT_DEFAULTS, key),
			`校验器 "${key}" 在 DEFAULTS 里没有对应默认值`,
		);
	}

	// 默认全关：这是「不给明确同意就不跑」的最后一道
	assert.equal(SUPERAGENT_DEFAULTS.enabled, false, "superagent 默认必须是关的");
	assert.equal(SUPERAGENT_DEFAULTS.acceptMode, "off", "默认 acceptMode 必须是 off（谁都不能触发）");
	assert.deepEqual(SUPERAGENT_DEFAULTS.actors, [], "默认名单必须为空");
	assert.equal(SUPERAGENT_DEFAULTS.repo, "", "默认不监听任何仓库");
	assert.equal(
		SUPERAGENT_DEFAULTS.permission,
		"read-only",
		"默认沙箱档位必须是 read-only —— 上游选 danger-full-access，这里不跟",
	);

	// 坏值一律拒绝（退到默认）
	assert.equal(SUPERAGENT_FIELDS.repo("not a repo"), undefined, "非 owner/name 形状要拒");
	assert.equal(SUPERAGENT_FIELDS.repo("a/b"), "a/b", "合法仓库名要放行");
	assert.equal(SUPERAGENT_FIELDS.acceptMode("always"), undefined, "未知 acceptMode 要拒");
	assert.equal(SUPERAGENT_FIELDS.permission("god-mode"), undefined, "未知沙箱档位要拒");
	assert.equal(SUPERAGENT_FIELDS.pollIntervalMs(100), undefined, "轮询间隔过小要拒（会打爆 API）");
	assert.equal(SUPERAGENT_FIELDS.actors(["a", 1]), undefined, "名单里混了非字符串要整体拒");
	assert.equal(SUPERAGENT_FIELDS.trigger("  "), undefined, "空白触发词要拒");
	ok("出厂配置：每个键都有校验器、默认全关、坏值一律拒");
}

// —— 15. 多仓库：游标按仓库分，互不借用 ——
//
// 2026-11-10 加多仓库时自检逮到的 bug：未知仓库回落到 lastCommentId，
// 而那个值属于**别的仓库**，于是新仓库的旧评论被当成「已处理」永久跳过。
{
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-cursor-"));
	try {
		const store = new SuperagentStore({ dir });
		await store.advanceCursor("100", "a/b");
		await store.advanceCursor("200", "c/d");
		assert.equal(await store.readCursor("a/b"), "100", "a/b 的游标不能受 c/d 影响");
		assert.equal(await store.readCursor("c/d"), "200", "c/d 的游标不能受 a/b 影响");
		assert.equal(
			await store.readCursor("x/y"),
			null,
			"未知仓库必须从 null 开始 —— 借别的仓库的游标会让它的旧评论被永久跳过",
		);
		// 单仓库时代的老文件：只有 lastCommentId，没有 byRepo
		fs.writeFileSync(
			path.join(dir, "state.json"),
			JSON.stringify({ version: 1, cursor: { lastCommentId: "77" }, seen: [], tickets: {} }),
		);
		const legacy = new SuperagentStore({ dir });
		assert.equal(
			await legacy.readCursor("x/y"),
			"77",
			"老文件（没有 byRepo）要能继续跑，否则升级后会把历史评论全重放一遍",
		);
		ok("多仓库游标：按仓库分、不互相借用、老文件能平滑升级");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// —— 16. worktree 隔离：建不出来就不跑，绝不退回主仓库 ——
//
// 隔离的理由：issue 正文是不可信输入，而 agent 会改文件。让它直接改主仓库 =
// 一次注入就能毁掉工作区。所以 worktreeBase 配了就必须建成功，建不出来宁可这轮失败。
{
	const { createAgentRunner } = await import("../lib/superagent/agent-runner.js");
	// 假 scope：agents.create 一被调用就说明「建 worktree 那步放过了」—— 那正是要防的
	const mustNotRun = {
		agents: {
			create: () => {
				throw new Error("不该走到 agents.create");
			},
		},
		agentPresets: {},
		get: () => undefined,
	};
	const runner = createAgentRunner({
		scope: mustNotRun,
		agentPreset: "team",
		// 指向一个**不存在**的目录 → worktreeNew 会报 not-a-repo
		worktreeBase: "C:/definitely-not-a-repo-xyz",
	});
	const outcome = await runner({ commentId: "wt-1", instruction: "说话", cwd: "C:/tmp" });
	assert.equal(outcome.ok, false, "建 worktree 失败就不该跑");
	assert.match(String(outcome.error), /worktree/i, `错误要说清是 worktree 建不出来：${outcome.error}`);
	ok("worktree 隔离：建不出来就拒绝执行，不退回主仓库");
}

// —— 17. 自动重试：次数封顶、退避、先 unclaim 再跑 ——
//
// 三个条件缺一不可：
//   ① 上次是 failed（done / needs-human 不该被重试）
//   ② attempts 没到 maxAttempts（真出问题时无限重试会烧掉整天额度还刷满日志）
//   ③ 退避到了（立刻重试会在一分钟内把同样的错误刷三遍，而环境那会儿没恢复）
{
	const { runRound } = await import("../lib/superagent/loop.js");
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const policyModule = await import("../lib/superagent/policy.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-retry-"));
	const policyOn = { repos: ["a/b"], actors: ["YG"], acceptMode: "auto", trigger: "/agent" };
	const noComments = { fetchNewComments: async () => ({ comments: [], nextCursor: null, scanned: 0, errors: [] }) };
	try {
		/** 造一条失败的 ticket。`endedAt` 用 base 时间减 waitedMs。 */
		const seedFailed = async (store, commentId, { attempts, waitedMs }) => {
			const now = Date.now();
			await store.saveTicket(commentId, {
				status: "failed",
				reason: "网络抖动",
				repo: "a/b",
				issueNumber: 1,
				instruction: "/agent 干活",
				attempts,
				startedAt: new Date(now - waitedMs - 1000).toISOString(),
				endedAt: new Date(now - waitedMs).toISOString(),
			});
		};

		// ① 满足条件 → 重跑
		{
			const store = new SuperagentStore({ dir: path.join(dir, "ok") });
			await seedFailed(store, "c-retry", { attempts: 1, waitedMs: 10 * 60_000 });
			const ran = [];
			const out = await runRound(
				{
					store,
					source: noComments,
					policy: policyModule,
					execute: async (req) => {
						ran.push(req.commentId);
						return { status: "done", text: "好了" };
					},
					reply: async () => ({ ok: true }),
					retry: { maxAttempts: 3, delaysMs: [60_000, 300_000, 900_000] },
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.deepEqual(ran, ["c-retry"], "失败过、等够了、没到顶 —— 该重跑");
			assert.ok(out.errors.some((e) => e.includes("c-retry")), "重试结果要进 errors（面板看得见）");
		}

		// ② 次数到顶 → 不跑
		{
			const store = new SuperagentStore({ dir: path.join(dir, "capped") });
			await seedFailed(store, "c-capped", { attempts: 3, waitedMs: 60 * 60_000 });
			let ran = 0;
			await runRound(
				{
					store,
					source: noComments,
					policy: policyModule,
					execute: async () => ((ran += 1), { status: "done", text: "x" }),
					reply: async () => ({ ok: true }),
					retry: { maxAttempts: 3, delaysMs: [60_000] },
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.equal(ran, 0, "attempts 到 maxAttempts 就不该再跑 —— 否则真出问题时无限重试");
		}

		// ③ 退避没到 → 不跑
		{
			const store = new SuperagentStore({ dir: path.join(dir, "backoff") });
			await seedFailed(store, "c-wait", { attempts: 1, waitedMs: 5_000 });
			let ran = 0;
			await runRound(
				{
					store,
					source: noComments,
					policy: policyModule,
					execute: async () => ((ran += 1), { status: "done", text: "x" }),
					reply: async () => ({ ok: true }),
					retry: { maxAttempts: 3, delaysMs: [60_000] },
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.equal(ran, 0, "才过 5 秒就重试会把同样的错刷三遍，而环境那会儿没恢复");
		}

		// ④ 不传 retry → 一次都不重试（默认行为不变）
		{
			const store = new SuperagentStore({ dir: path.join(dir, "off") });
			await seedFailed(store, "c-off", { attempts: 1, waitedMs: 60 * 60_000 });
			let ran = 0;
			await runRound(
				{
					store,
					source: noComments,
					policy: policyModule,
					execute: async () => ((ran += 1), { status: "done", text: "x" }),
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.equal(ran, 0, "没配 retry 就不该自己重试 —— 默认行为必须和以前一样");
		}
		ok("自动重试：满足三个条件才跑、到顶不跑、退避没到不跑、没配就不跑");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// —— 18. Thread 订阅：后续讨论不走 Eval、直接续给活着的 Ticket ——
//
// 上游 001-domain 的原话：Ticket 订阅 Thread 之后，"a person's message that reaches
// a Ticket this way takes no Eval"。这是「一次讨论能接着聊」的关键 ——
// 没有它，讨论一多就得每条都重写一遍触发词。
//
// `stopped` 是唯一会让 Thread 断掉的终态；`done` 仍然能接（跑完不等于讨论结束）。
{
	const { runRound } = await import("../lib/superagent/loop.js");
	const { SuperagentStore } = await import("../lib/superagent/store.js");
	const policyModule = await import("../lib/superagent/policy.js");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-thread-"));
	const policyOn = { repos: ["a/b"], actors: ["YG"], acceptMode: "auto", trigger: "/agent" };
	const ev = (id, body, issueNumber = 1) => ({
		source: "github",
		repo: "a/b",
		issueNumber,
		commentId: String(id),
		author: "YG",
		authorAssociation: "OWNER",
		body,
	});
	const oneComment = (event) => ({
		fetchNewComments: async () => ({ comments: [event], nextCursor: event.commentId, scanned: 1, errors: [] }),
	});
	try {
		// ① Thread 上有活着的 Ticket → 这条消息不走 Eval，直接续
		{
			const store = new SuperagentStore({ dir: path.join(dir, "resume") });
			await store.subscribe("a/b#1", "c-1");
			await store.saveTicket("c-1", { status: "done", repo: "a/b", issueNumber: 1, instruction: "/agent 第一件事" });
			const calls = [];
			const out = await runRound(
				{
					store,
					source: oneComment(ev(2, "顺便把这个也改了")), // 注意：没有触发词
					policy: policyModule,
					execute: async (req) => {
						calls.push(req);
						return { status: "done", text: "改好了" };
					},
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.equal(calls.length, 1, "该续跑一次");
			assert.equal(calls[0].commentId, "c-1", "续跑要复用原来那条 ticket id（面板上才是一条连续记录）");
			assert.equal(calls[0].resume, true, "要标成 resume，executor 才不会拿幂等挡掉");
			assert.equal(calls[0].messageId, "2", "要把新消息的 id 传下去（幂等按它判）");
			assert.equal(String(calls[0].instruction), "顺便把这个也改了", "正文原样当输入");
			assert.equal(out.executed, 1, "续跑成功要算一次执行");
		}

		// ② 人说停（stopped）→ Thread 断掉，后续不再续
		{
			const store = new SuperagentStore({ dir: path.join(dir, "stopped") });
			await store.subscribe("a/b#1", "c-1");
			await store.saveTicket("c-1", { status: "stopped", repo: "a/b", issueNumber: 1 });
			let resumed = 0;
			await runRound(
				{
					store,
					source: oneComment(ev(2, "继续啊")),
					policy: policyModule,
					execute: async (req) => {
						if (req.resume === true) resumed += 1;
						return { status: "done", text: "x" };
					},
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.equal(resumed, 0, "stopped 是唯一会让 Thread 断掉的终态");
		}

		// ③ issue 正文不参与续跑（它是 Thread 的开头，拿来续会把旧需求再执行一遍）
		{
			const store = new SuperagentStore({ dir: path.join(dir, "body") });
			await store.subscribe("a/b#1", "c-1");
			await store.saveTicket("c-1", { status: "done", repo: "a/b", issueNumber: 1 });
			let resumed = 0;
			await runRound(
				{
					store,
					source: oneComment({ ...ev("issue-1", "/agent 老需求"), kind: "issue-body" }),
					policy: policyModule,
					execute: async (req) => {
						if (req.resume === true) resumed += 1;
						return { status: "done", text: "x" };
					},
					reply: async () => ({ ok: true }),
				},
				{ repo: "a/b", policy: policyOn },
			);
			assert.equal(resumed, 0, "issue 正文是 Thread 的开头，不能拿去续一个进行中的任务");
		}
		ok("Thread 订阅：后续讨论不走 Eval 直接续、stopped 才断、issue 正文不参与");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// —— 19. PR 通道：有改动才开、提交/推送/开 PR 的顺序、已有 PR 不算失败 ——
//
// 上游 001-domain 把 PR 和评论列在同一层（"Acknowledgements, replies, pull requests
// and resolved reviews are all writes"），所以这里不是「回评论之后附送一个 PR」，
// 而是先看这次改动能不能形成 PR。
{
	const { openPullRequest, readWorktreeState, NO_CHANGE } = await import("../lib/superagent/git-channel.js");

	/** 假 git：按 argv[0] 返回预置结果。 */
	const makeGit = (table) => async (argv) => {
		const sub = argv[0];
		const hit = table[sub];
		if (hit === undefined) return { code: 0, stdout: "", stderr: "" };
		return typeof hit === "function" ? hit(argv) : hit;
	};

	// ① 干净且没新提交 → 不开 PR，也不算失败
	{
		const git = makeGit({
			status: { code: 0, stdout: "", stderr: "" },
			"rev-parse": { code: 0, stdout: "dsh-wt/sa-1\n", stderr: "" },
			"rev-list": { code: 0, stdout: "0\n", stderr: "" },
		});
		let ghCalls = 0;
		const out = await openPullRequest(
			{ git, gh: async () => ((ghCalls += 1), { code: 0, stdout: "", stderr: "" }) },
			{ worktree: "C:/wt", base: "master", repo: "a/b", pr: { title: "t", body: "b", commentId: "c1" } },
		);
		assert.equal(out.ok, true, "没改动不是失败");
		assert.equal(out.reason, NO_CHANGE, "要明确返回 no-change，调用方才知道「这次没 PR」");
		assert.equal(ghCalls, 0, "没改动就不该碰 gh");
	}

	// ② 有未提交改动 → 我们替它提交 → 推送 → 开 PR，顺序不能反
	{
		const order = [];
		const git = makeGit({
			status: { code: 0, stdout: " M lib/x.js\n?? new.txt\n", stderr: "" },
			"rev-parse": { code: 0, stdout: "dsh-wt/sa-2\n", stderr: "" },
			"rev-list": { code: 0, stdout: "0\n", stderr: "" },
			add: async () => (order.push("add"), { code: 0, stdout: "", stderr: "" }),
			commit: async () => (order.push("commit"), { code: 0, stdout: "", stderr: "" }),
			push: async () => (order.push("push"), { code: 0, stdout: "", stderr: "" }),
		});
		const out = await openPullRequest(
			{
				git,
				gh: async (argv) => (order.push("gh:" + argv[0] + ":" + argv[1]), { code: 0, stdout: "https://github.com/a/b/pull/9\n", stderr: "" }),
			},
			{ worktree: "C:/wt", base: "master", repo: "a/b", pr: { title: "改个东西", body: "b", commentId: "c2" } },
		);
		assert.deepEqual(order, ["add", "commit", "push", "gh:pr:create"], "顺序：add → commit → push → pr create");
		assert.equal(out.ok, true, "该成功");
		assert.equal(out.prUrl, "https://github.com/a/b/pull/9", "要把 PR 链接带出来（回评论要用）");
		assert.equal(out.branch, "dsh-wt/sa-2", "分支名要带出来");
	}

	// ③ 已有同名 PR → 不算失败（分支推上去了，PR 也在）
	{
		const git = makeGit({
			status: { code: 0, stdout: "", stderr: "" },
			"rev-parse": { code: 0, stdout: "dsh-wt/sa-3\n", stderr: "" },
			"rev-list": { code: 0, stdout: "2\n", stderr: "" },
			push: { code: 0, stdout: "", stderr: "" },
		});
		const out = await openPullRequest(
			{
				git,
				gh: async () => ({
					code: 1,
					stdout: "",
					stderr: "a pull request for branch \"dsh-wt/sa-3\" into branch \"master\" already exists:\nhttps://github.com/a/b/pull/7",
				}),
			},
			{ worktree: "C:/wt", base: "master", repo: "a/b", pr: { title: "t", body: "b", commentId: "c3" } },
		);
		assert.equal(out.ok, true, "已有 PR 不算失败");
		assert.equal(out.reason, "existing", "要标成 existing");
		assert.equal(out.prUrl, "https://github.com/a/b/pull/7", "要把已有的那条 PR 链接捞出来");
	}

	// ④ push 失败 → 明确失败，不继续开 PR
	{
		let ghCalls = 0;
		const git = makeGit({
			status: { code: 0, stdout: "", stderr: "" },
			"rev-parse": { code: 0, stdout: "dsh-wt/sa-4\n", stderr: "" },
			"rev-list": { code: 0, stdout: "1\n", stderr: "" },
			push: { code: 128, stdout: "", stderr: "fatal: could not read Username" },
		});
		const out = await openPullRequest(
			{ git, gh: async () => ((ghCalls += 1), { code: 0, stdout: "", stderr: "" }) },
			{ worktree: "C:/wt", base: "master", repo: "a/b", pr: { title: "t", body: "b", commentId: "c4" } },
		);
		assert.equal(out.ok, false, "push 失败要判失败");
		assert.match(String(out.error), /push/, "错误要说清是 push 失败");
		assert.equal(ghCalls, 0, "push 都失败了就别去开 PR");
	}

	// ⑤ readWorktreeState：base 不存在时 ahead 按 0 处理（不炸）
	{
		const git = makeGit({
			status: { code: 0, stdout: "", stderr: "" },
			"rev-parse": { code: 0, stdout: "dsh-wt/sa-5\n", stderr: "" },
			"rev-list": { code: 128, stdout: "", stderr: "fatal: bad revision" },
		});
		const state = await readWorktreeState(git, "C:/wt", "nope");
		assert.equal(state.ahead, 0, "基准分支不存在时 ahead 按 0 —— 不能让一次读失败毁掉整轮");
	}
	ok("PR 通道：没改动不开、顺序对、已有 PR 不算失败、push 失败不继续、读状态不炸");
}

console.log(`\nselftest-superagent：${passed} 项全过`);
