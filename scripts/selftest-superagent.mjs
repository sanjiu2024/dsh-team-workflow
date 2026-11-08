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

console.log(`\nselftest-superagent：${passed} 项全过`);
