#!/usr/bin/env node
/**
 * 自检：用假的 cordis ctx 把插件跑一遍，检查真正重要的行为。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 和 lib/util.js 的 sha256 保持一致，用途：断言哈希算的是哪个字符串 */
const sha256Ref = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// 审计日志、节流 overlay 写到临时目录，别碰真环境
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-selftest-"));
process.env.DSH_HOME = tempHome;

const { apply } = await import(new URL("../lib/index.js", import.meta.url).href);

/** 最小可用的 cordis ctx */
function makeCtx(baseUrl) {
	const handlers = new Map();
	const sections = [];
	const commands = [];
	const tools = [];
	const effects = [];
	const logs = [];
	return {
		baseUrl,
		logger: {
			info: (m) => logs.push(["info", m]),
			warn: (m) => logs.push(["warn", m]),
			error: (m) => logs.push(["error", m]),
		},
		systemPrompt: {
			section(section) {
				if (sections.some((s) => s.name === section.name)) {
					throw new Error(`duplicate prompt section ${section.name}`);
				}
				sections.push(section);
				return () => {
					const at = sections.indexOf(section);
					if (at >= 0) sections.splice(at, 1);
				};
			},
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {
				const list = handlers.get(event);
				const at = list.indexOf(handler);
				if (at >= 0) list.splice(at, 1);
			};
		},
		commands: {
			register(definition) {
				commands.push(definition);
				return () => {};
			},
		},
		tools: {
			register(definition) {
				tools.push(definition);
				return () => {};
			},
		},
		effect(fn, label) {
			effects.push(label ?? "effect");
			const dispose = fn();
			return () => dispose?.();
		},
		// 可选依赖：真 cordis 里 `ctx.inject([服务], cb)` 等该服务就结后再跑。
		// 这里模拟成“服务存在就立刻跑”，这样能真的测到 provider 注册。
		// 设 _noWeb 就不跑，用来验证没 web 服务时不会把整包带崩。
		inject(deps, callback) {
			const scoped = { ...this, web: this._web, logger: this.logger };
			if (this._web || !deps.includes("web")) callback(scoped);
			return () => {};
		},
		// 探针：这些服务"存在"
		get: () => undefined,
		_handlers: handlers,
		_sections: sections,
		_commands: commands,
		_tools: tools,
		_effects: effects,
		_logs: logs,
		_web: {
			providers: [],
			registerSearchProvider(provider) {
				this.providers.push(provider);
				return () => {};
			},
		},
	};
}

const ctx = makeCtx(new URL("../", import.meta.url).href);
apply(ctx, {});

// —— 1. 系统提示段 ——

const baseline = ctx._sections.find((s) => s.name === "team:baseline");
assert.ok(baseline, "缺少 team:baseline 系统提示段");
assert.equal(baseline.order, 600, "team:baseline 的 order 必须是 600（TEAM_POLICY）");
const baselineText = typeof baseline.text === "function" ? baseline.text(ctx) : baseline.text;
assert.ok(baselineText.includes("团队基线规范"), "团队规范没读进来");
assert.ok(baselineText.length > 500, "团队规范内容过短，可能没读到 team/RULES.md");
// 上游 pi-workflow v1.13.5 移植的审查边界纪律 —— 防止它被无意删掉。
assert.ok(
	baselineText.includes("派审查必须给边界") && baselineText.includes("输出上限"),
	"「派审查必须给边界」纪律段丢失（上游 v1.13.5 移植，见 docs/UPSTREAM-SYNC.md）",
);

// —— 2. 命令 ——

const names = ctx._commands.map((c) => c.name).sort();
assert.deepEqual(names, ["audit-log", "team-baseline", "thrift"], `命令不对：${names}`);

// —— 3. 审计日志：真喂事件 ——

const sessionEvents = ctx._handlers.get("session/event") ?? [];
assert.ok(sessionEvents.length >= 1, "没订阅 session/event");

const session = { id: "selftest-session", header: { version: 1, id: "selftest-session", createdAt: 1_700_000_000_000, cwd: "C:\\tmp", isSeeded: false } };
function feed(event) {
	for (const handler of sessionEvents) handler(session, event);
}
// dsh 的真实事件形状：payload 全在 `data` 下，且 tool/call.arguments 是
// 模型产出的**原始 JSON 字符串**。别改成扁平形状 —— 那样测不出这个 bug。
feed({ type: "turn/start", seq: 1, time: 0, data: { turn: 1 } });
feed({
	type: "user/message",
	seq: 2,
	time: 0,
	data: {
		role: "user",
		source: { kind: "user" },
		content: [{ type: "text", text: "你好" }],
	},
});
feed({
	type: "tool/call",
	seq: 3,
	time: 0,
	data: {
		turn: 1,
		step: 1,
		callId: "call-1",
		name: "bash",
		arguments: JSON.stringify({ command: "echo hi", apiKey: "sk-abcdefgh12345678" }),
	},
});
feed({
	type: "tool/result",
	seq: 4,
	time: 0,
	data: {
		turn: 1,
		step: 1,
		message: {
			role: "user",
			source: { kind: "tool", callId: "call-1" },
			content: [
				{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "hi" }] },
			],
		},
	},
});
feed({
	type: "assistant/message",
	seq: 5,
	time: 0,
	data: {
		turn: 1,
		step: 1,
		message: {
			role: "assistant",
			source: {
				kind: "model",
				provider: "new-api",
				model: "tier-std",
				replayState: { response: { stopReason: "stop" } },
			},
			content: [
				{ type: "text", text: "done" },
				{ type: "reasoning", text: "想一下" },
			],
		},
		usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 100 },
		stream: [],
	},
});
feed({ type: "compaction/prune", seq: 6, time: 0, data: { shadowedSeqs: [1, 2], shadowedTokenCount: 400 } });
feed({ type: "turn/end", seq: 7, time: 0, data: { turn: 1, reason: { kind: "completed" } } });

const auditDir = path.join(tempHome, "storages", "audit-log");
assert.ok(fs.existsSync(auditDir), `审计目录没建：${auditDir}`);
const files = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
assert.equal(files.length, 1, `期望 1 个审计文件，实际 ${files.length}`);

const raw = fs.readFileSync(path.join(auditDir, files[0]), "utf8").trimEnd();
const lines = raw.split("\n");
assert.ok(lines.length >= 7, `审计条数太少：${lines.length}`);
for (const line of lines) {
	assert.ok(Buffer.byteLength(line, "utf8") <= 8192, "审计行超过 8192 字节上限");
	const rec = JSON.parse(line);
	assert.equal(rec.v, 1, "记录版本 v 不对");
	assert.ok(typeof rec.ts === "string" && rec.ts.length > 0, "缺 ts");
	assert.ok(typeof rec.event === "string", "缺 event");
}

const byEvent = new Map();
for (const line of lines) {
	const rec = JSON.parse(line);
	byEvent.set(rec.event, (byEvent.get(rec.event) ?? 0) + 1);
}
for (const expected of ["turn_start", "tool_call", "tool_result", "compaction_prune", "turn_end"]) {
	assert.ok(byEvent.has(expected), `审计里缺 ${expected}；实际有 ${[...byEvent.keys()].join(", ")}`);
}
assert.equal(byEvent.get("tool_call"), 1, "tool_call 条数不对");
assert.equal(byEvent.get("tool_result"), 1, "tool_result 条数不对");

// 凭证脱敏：明文 apiKey 绝不能出现在日志里
assert.ok(!raw.includes("sk-abcdefgh12345678"), "审计日志里出现了明文 API key");

// 哈希字段是 sha256 形状
// 字段没读歪：真机上这三个曾经全是 null（事件形状猜错了）
const recs = lines.map((l) => JSON.parse(l));
const callRec = recs.find((r) => r.event === "tool_call");
assert.ok(callRec, "没有 tool_call 记录");
assert.equal(callRec.toolName, "bash", "tool_call.toolName 读歪了");
assert.equal(callRec.toolCallId, "call-1", "tool_call.toolCallId 读歪了");
assert.ok(callRec.argsPreview.includes("echo hi"), "tool_call.argsPreview 没解析出参数");
assert.equal(callRec.argsSha256, sha256Ref(JSON.stringify({ command: "echo hi", apiKey: "sk-abcdefgh12345678" })), "argsSha256 不是原始 arguments 字符串的哈希");
const usageRec = recs.find((r) => r.event === "assistant_usage");
assert.ok(usageRec.usage.input === 1000, "assistant_usage.usage.input 读歪了");
assert.equal(usageRec.hasThinking, true, "assistant_usage.hasThinking 没认出 reasoning 块");
assert.equal(usageRec.blockTypes.reasoning, 1, "assistant_usage.blockTypes 统计不对");
const resultRec = recs.find((r) => r.event === "tool_result");
assert.equal(resultRec.toolCallId, "call-1", "tool_result.toolCallId 没从 block 里取到");
assert.equal(resultRec.resultChars, 2, "tool_result.resultChars 不对");
const endRec = recs.find((r) => r.event === "turn_end");
assert.equal(endRec.reason, "completed", "turn_end.reason 没从对象里取到 kind");

// —— 4. 节流统计用同一批事件累出来了 ——

const thriftCommand = ctx._commands.find((c) => c.name === "thrift");
const shown = thriftCommand.handler({ rawInput: "show" });
assert.equal(shown.kind, "success", `/thrift show 失败：${shown.text}`);
assert.ok(shown.text.includes("峰值 prompt：1600"), `/thrift show 没统计到峰值：\n${shown.text}`);
assert.ok(shown.text.includes("裁剪 1 次"), `/thrift show 没统计到裁剪：\n${shown.text}`);

// 参数校验
assert.equal(thriftCommand.handler({ rawInput: "compact abc" }).kind, "error", "/thrift 该拒绝非法参数");
assert.equal(thriftCommand.handler({ rawInput: "没见过的参数" }).kind, "error", "/thrift 该拒绝未知参数");

// —— 5. /team-baseline 能跑 ——

const baselineCommand = ctx._commands.find((c) => c.name === "team-baseline");
const info = baselineCommand.handler({});
assert.equal(info.kind, "success", `/team-baseline 失败：${info.text}`);
assert.ok(info.text.includes("dsh-team-workflow"), "/team-baseline 没打版本号");
assert.ok(info.text.includes("团队规范"), "/team-baseline 没打团队规范状态");

// —— 6. 异常隔离：坏事件不能把插件带崩 ——

for (const handler of sessionEvents) {
	handler(session, { type: "tool/call", seq: 1, time: 0, data: { arguments: null } });
	handler(session, { type: "tool/call", seq: 2, time: 0 });
	handler(session, { type: "tool/call", seq: 3, time: 0, data: { arguments: "不是 JSON" } });
	handler(session, { type: undefined });
	handler(session, { type: "turn/end" });
	handler(session, null);
}

// —— 7. rtk 压缩：只碰无总预算的工具，read 必须放过 ——

const { compactText, RTK_DEFAULTS, RTK_FIELDS } = await import("../lib/rtk.js");
const rtkCfg = { ...RTK_DEFAULTS };

// 超长文本真的被压小，且带省略标记
const big = Array.from({ length: 400 }, (_, i) => `src/f${i}.ts:${i}: 命中行`).join("\n");
const compacted = compactText(big, rtkCfg);
assert.ok(typeof compacted === "string", "超长 grep 输出应该被压");
assert.ok(compacted.length < big.length, "压缩后应该真的变短");
assert.ok(compacted.includes("省略"), "压缩后必须告知被截断，否则模型会以为这就是全部命中");

// 短输出不动
assert.equal(compactText("短", rtkCfg), null, "小于 minChars 的输出不该动");

// read 不在压缩名单里（行号断了会害模型读错位置）
assert.ok(!RTK_DEFAULTS.compactTools.includes("read"), "read 不能被 rtk 压");
assert.ok(RTK_DEFAULTS.compactTools.includes("grep"), "grep 必须被 rtk 压（250 命中 × 2KB 无总预算）");

// 配置校验器：坏值一律拒绝（退到默认）
assert.equal(RTK_FIELDS.compactTools("bash"), undefined, "非数组应被拒");
assert.equal(RTK_FIELDS.compactTools([1, 2]), undefined, "非字符串元素应被拒");
assert.deepEqual(RTK_FIELDS.compactTools(["grep"]), ["grep"], "合法数组应放行");

// —— 8. tools/post-execute 挂上了 ——

assert.ok(ctx._handlers.has("tools/post-execute"), "没订阅 tools/post-execute");
assert.ok(ctx._tools.some((t) => t.name === "lens_check"), "缺少 lens_check 工具");

// —— 9. 版本号两处一致 ——
// 发出去了才发现“改了包没记录”或者“记了没改包”的事发生过，所以在这里卡死。
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
assert.ok(headings.length > 0, "CHANGELOG.md 里一个版本节都没有");
assert.equal(headings[0], pkg.version, `CHANGELOG 最新一节是 ${headings[0]}，package.json 是 ${pkg.version}`);

// —— 10. 联网搜索：解析与正文提取 ——
// 解析器是纯函数，拿真实形状的 HTML 片段测。这两段是从必应/DDG 实际响应里
// 剪出来的结构，不是编的 —— 编的片段测不出选择器写错。
const { decodeEntities, htmlToText, parseBingHtml, parseDdgHtml, WEB_DEFAULTS, makeSearchProvider } = await import(new URL("../lib/web.js", import.meta.url).href);

assert.equal(decodeEntities("a&amp;b &lt;c&gt; &#65; &nbsp;x"), "a&b <c> A \u00a0x", "实体解码不对");
assert.equal(decodeEntities("&unknown; &#xZZ;"), "&unknown; &#xZZ;", "未知实体应原样保留，不能吃掉");

const bingHtml = `
<ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a">示例<b>标题</b></a></h2>
<div class="b_caption"><p class="b_lineclamp4">第一段&nbsp;摘要</p></div></li>
<li class="b_algo"><h2><a href="/relative/b">相对链接</a></h2>
<p class="b_lineclamp2">第二段摘要</p></li>
<li class="b_algo"><h2><a href="mailto:x@y.com">非 http</a></h2></li>
</ol>`;
const bing = parseBingHtml(bingHtml, 5);
assert.equal(bing.length, 2, `必应应解析出 2 条（mailto 要丢掉），实际 ${bing.length}`);
assert.equal(bing[0].url, "https://example.com/a", "绝对链接应原样保留");
assert.equal(bing[0].title, "示例标题", "标题里的标签要剥掉");
assert.equal(bing[0].snippet, "第一段 摘要", "摘要要解实体并合并空白");
assert.equal(bing[1].url, "https://cn.bing.com/relative/b", "相对链接要按必应域名补全");

const ddgHtml = `<div class="result"><a rel="nofollow" class="result__a" href="https://ddg.example/1">DDG 标题</a>
<a class="result__snippet">DDG 摘要</a></div>`;
const ddg = parseDdgHtml(ddgHtml, 5);
assert.equal(ddg.length, 1, "DDG 应解析出 1 条");
assert.equal(ddg[0].url, "https://ddg.example/1", "DDG 的 href 是直链，不该被改写");
assert.equal(ddg[0].snippet, "DDG 摘要", "DDG 摘要没解析出来");

const page = `<html><body><nav>导航垃圾</nav><main><h1>正文标题</h1>${"<p>正文段落内容在此。</p>".repeat(30)}</main></body></html>`;
const text = htmlToText(page);
assert.ok(text.startsWith("正文标题"), "应优先取 <main> 而不是整个 body");
assert.ok(!text.includes("导航垃圾"), "nav 里的内容不该进正文");
assert.equal(htmlToText(""), "", "空输入要返回空串，不能抛");
// 正文太短时要能退回整个 body，否则 SPA 页面会一个字都拿不到
const thin = `<html><body><div class="x">${"短内容。".repeat(20)}</div></body></html>`;
assert.ok(htmlToText(thin).length > 0, "候选区太短时应退回 body");

// 畸形页面不能把事件循环拖死。正文是不受控输入，抓到的东西可以很脏。
// 曾经的两个正则 `<[^>]+>` 和 `<[^>]+class="…"` 里的 `[^>]` 允许跨过下一个 `<`，
// 于是一串 `<` 会让每个位置都向后重扫到串尾——O(n²)。
// 实测：8 万个 `<` 要 11.9 秒，直接把 agent 卡住；改成 `[^<>]` 后 1ms。
// 这里卡 3 秒就算失败，防的是“有人又把 `[^<>]` 改回 `[^>]`”。
{
	const evil = "<".repeat(80000);
	const t0 = Date.now();
	htmlToText(evil);
	const ms = Date.now() - t0;
	assert.ok(ms < 3000, `畸形输入耗时 ${ms}ms——正则可能又退化成 O(n²) 了`);

	// 顺带守住：改完要还能从真实页面里认出正文容器，不能为了快把功能丢下
	const real = `<div class="markdown-body vp-doc">${"<p>正文内容</p>".repeat(50)}</div>`;
	assert.ok(htmlToText(real).includes("正文内容"), "class= 候选容器应该还能认出来");
}

// —— 11. provider 真注册了，而且搜索链路跑得通 ——
// 这一段用假 ctx.web 走完整条路：Bing → 解析 → （假）抓正文 → 组装 content。
// 不是只试纯函数，而是试“组装出来的东西真的是 dsh 要的形状”。
const provider = ctx._web.providers.find((p) => p.id === "bing");
assert.ok(provider, `没注册 id=bing 的搜索 provider，注册了：${ctx._web.providers.map((p) => p.id)}`);
assert.equal(provider.available(), true, "免 key 的 provider 必须恒可用，否则 dsh 会报 PROVIDER_CONFIGURED_UNAVAILABLE");

// 假 ctx.web.fetch。搜索和正文都走官方 fetch provider，拦的是那一个入口。
// （以前这里换的是 globalThis.fetch；搜索改用 ctx.web.fetch 后就拦不住了。）
const realFetch = globalThis.fetch;
const seen = [];
ctx._web.fetch = async ({ url }, signal) => {
	// 真的 ctx.web.fetch 会看 signal，取消时直接抛。这里也必须照做，否则
	// 「缓存不该跨会话传递 signal」那条断言就是永真的——不管缓存多错都能过。
	if (signal?.aborted) {
		throw Object.assign(new Error("aborted"), { name: "AbortError" });
	}
	seen.push(String(url));
	const content = String(url).includes("bing.com")
		? bingHtml
		: `<html><body><main>${"<p>抓回来的正文段落。</p>".repeat(20)}</main></body></html>`;
	return { url, statusCode: 200, body: { kind: "html", content }, truncated: false };
};
try {
	const result = await provider.search({ query: "测试", maxResults: 5 });
	assert.ok(Array.isArray(result.sources), "sources 必须是数组");
	assert.equal(result.sources.length, 2, `应返回 2 条 sources，实际 ${result.sources.length}`);
	assert.equal(result.truncated, false, "没超上限时 truncated 应为 false");
	assert.ok(typeof result.content === "string" && result.content.length > 0, "没带正文——「一步到位抓正文」没生效");
	assert.ok(result.content.includes("抓回来的正文段落"), "content 里应含抓回来的正文");
	assert.ok(result.content.includes("https://example.com/a"), "content 里应标明正文对应哪个来源");
	assert.ok(seen.some((u) => u.includes("bing.com")), "没真的去请求必应");

	// 正文条数上限真的生效：maxBodies=3，4 条结果只该抓 3 次正文
	// 这里必须换个 query —— 沿用上面的词会被查询缓存拦住，看不到任何 fetch，
	// 断言就退化成永真了。
	seen.length = 0;
	const many = await provider.search({ query: "测试正文上限", maxResults: 5 });
	assert.ok(many, "第二次搜索应能完成");
	const bodyHits = seen.filter((u) => !u.includes("bing.com")).length;
	assert.ok(bodyHits > 0, `没抓正文，maxBodies 断言会退化成永真：seen=${seen.join(", ")}`);
	assert.ok(bodyHits <= 3, `maxBodies=3，实际抓了 ${bodyHits} 次正文`);

	// 后端坏掉时不能静默返回空 —— 空结果和不工作看着一模一样，排查时也一样。
	// 这条是踩过的坑：搜索拿不到结果时，模型和人都以为「真没结果」。
	// 同样要换 query：缓存命中的话永远不会走到 fetch，这条就白测了。
	const workingFetch = ctx._web.fetch;
	ctx._web.fetch = async () => {
		throw Object.assign(new Error('URL hostname "x" resolves to a non-public IP address'), {
			code: "WEB_BLOCKED_URL",
		});
	};
	const empty = await provider.search({ query: "测试后端损坏", maxResults: 5 });
	assert.deepEqual(empty.sources, [], "后端坏了应该是 0 条 sources");
	assert.ok(empty.content && empty.content.length > 0, "后端坏了必须给出可读原因，不能静默返回空");
	assert.ok(
		empty.content.includes("bing") && empty.content.includes("duckduckgo"),
		`content 应说明两个后端都试过，实际：${empty.content}`,
	);
	assert.ok(
		empty.content.includes("non-public IP"),
		`content 应带上失败原因，实际：${empty.content}`,
	);
	ctx._web.fetch = workingFetch;

	// —— 11b. 查询缓存 ——
	// 09-25 那天 13 次 web_search 里 6 次是重复查询，最密一组只隔 26 秒。
	// 下面这几条钉住：同一个查询不重复打网络，但换 limit / 换抓正文配置就得重新打。
	//
	// TTL 默认值定在 09-25 的实测间隔上：那天 6 次重复的间隔是
	// 26s/127s/293s/315s/448s/2186s。5 分钟只拦得住 3 次，10 分钟拦得住 5 次，
	// 而 10~30 分钟都是 5 次 —— 所以取 10 分钟（同收益下陈旧窗口最小）。
	// 这条不只是记数字：有人把默认改成 1 分钟（基本白加）或 1 天（搜索结果严重过期）时得报。
	assert.ok(
		WEB_DEFAULTS.cacheTtlMs >= 300_000 && WEB_DEFAULTS.cacheTtlMs <= 1_800_000,
		`cacheTtlMs 默认 ${WEB_DEFAULTS.cacheTtlMs}ms 超出实测合理区间 [5分,30分]：太小拦不住那 6 次重复，太大搜索结果过期`,
	);
	assert.ok(WEB_DEFAULTS.cacheMaxEntries >= 1, "cacheMaxEntries 至少得能存一条，否则等于没缓存");
	seen.length = 0;
	const q1 = await provider.search({ query: "缓存测试甲", maxResults: 5 });
	const netAfterFirst = seen.filter((u) => u.includes("bing.com")).length;
	assert.ok(netAfterFirst >= 1, "第一次搜索应该真去打网络");

	seen.length = 0;
	const q2 = await provider.search({ query: "缓存测试甲", maxResults: 5 });
	assert.equal(
		seen.filter((u) => u.includes("bing.com")).length,
		0,
		`同一查询第二次不该再打网络，实际请求了：${seen.join(", ")}`,
	);
	assert.deepEqual(q2.sources, q1.sources, "缓存命中的结果应该和第一次一致");
	assert.equal(q2.content, q1.content, "缓存的 content 也应该一字不差");

	// limit 不同就是不同请求：5 条和 8 条不能共用一条缓存
	seen.length = 0;
	await provider.search({ query: "缓存测试甲", maxResults: 8 });
	assert.ok(
		seen.some((u) => u.includes("bing.com")),
		"maxResults 变了必须重新搜 —— 否则模型拿到的是按 5 条裁过的旧结果",
	);

	// 不同查询当然不能串味
	seen.length = 0;
	const q3 = await provider.search({ query: "缓存测试乙", maxResults: 5 });
	assert.ok(seen.some((u) => u.includes("bing.com")), "换查询词必须真去搜");
	assert.equal(q3.sources.length, q1.sources.length, "假 fetch 对任何词都返回同样两条");

	// 失败不能被缓存：网络抖一下就把「搜不到」钉住 5 分钟，比不快多了
	seen.length = 0;
	const brokenFetch = ctx._web.fetch;
	ctx._web.fetch = async () => {
		throw Object.assign(new Error("boom"), { code: "WEB_BLOCKED_URL" });
	};
	const failed = await provider.search({ query: "缓存测试丙", maxResults: 5 });
	assert.deepEqual(failed.sources, [], "坏后端应该返回 0 条");
	ctx._web.fetch = brokenFetch;
	seen.length = 0;
	const recovered = await provider.search({ query: "缓存测试丙", maxResults: 5 });
	assert.ok(
		seen.some((u) => u.includes("bing.com")),
		"上一次失败的结果不该被缓存 —— 后端恢复了必须能再试",
	);
	assert.ok(recovered.sources.length > 0, "后端恢复后应该能拿到结果");

	// 缓存不得跨会话传递调用方的 signal。缓存是进程级的（一份 provider 服务
	// 所有会话），如果把 in-flight 的 Promise 存进去，那条 Promise 绑的是第一个
	// 调用方的 signal —— A 会话一取消，B 会话会收到一个不是它引起的取消错误。
	// 所以只缓存已完成的成功结果：A 带着已 abort 的 signal 去搜，B 用干净
	// signal 跟在后面，B 必须拿到结果而不是被 A 的取消带连。
	{
		seen.length = 0;
		const aborted = new AbortController();
		aborted.abort();
		const a = provider.search({ query: "缓存测试丁", maxResults: 5 }, aborted.signal).catch((e) => ({ error: e }));
		const b = provider.search({ query: "缓存测试丁", maxResults: 5 });
		await a;
		const rb = await b;
		assert.ok(
			rb.sources && rb.sources.length > 0,
			"另一会话用干净 signal 搜同一组词必须拿到结果，不能被别人的取消带连",
		);
	}

	// 下面几条要自建 provider（改 TTL / 改容量），得自己拼一个跟真 inject
	// 里同形状的 ctx：真代码里 `ctx.inject(["web"], ...)` 交下来的是
	// `{...ctx, web: ctx._web}`，provider 读的正是 `ctx.web.fetch`。
	const scoped = { ...ctx, web: ctx._web, logger: ctx.logger };

	// TTL 真的会过期：不能只看“命中过”就算完，得看它会不会永远命中。
	// 缓存过期了还继续命中，搜索结果就永久不刷新了。
	{
		seen.length = 0;
		const shortTtl = makeSearchProvider(scoped, { ...WEB_DEFAULTS, cacheTtlMs: 1 }, () => {});
		await shortTtl.search({ query: "缓存过期测试", maxResults: 5 });
		// 让 1ms 的 TTL 真的过去（一次真 await 足够）
		await new Promise((r) => setTimeout(r, 5));
		seen.length = 0;
		await shortTtl.search({ query: "缓存过期测试", maxResults: 5 });
		assert.ok(
			seen.some((u) => u.includes("bing.com")),
			"TTL 过了就必须重新搜 —— 否则搜索结果永久不刷新，比没有缓存还坏",
		);
	}

	// cacheTtlMs = 0 是真的关掉缓存（不是“永不命中”也不是“永不失效”）
	{
		seen.length = 0;
		const off = makeSearchProvider(scoped, { ...WEB_DEFAULTS, cacheTtlMs: 0 }, () => {});
		await off.search({ query: "缓存关闭测试", maxResults: 5 });
		seen.length = 0;
		await off.search({ query: "缓存关闭测试", maxResults: 5 });
		assert.ok(
			seen.some((u) => u.includes("bing.com")),
			"cacheTtlMs=0 时必须每次真搜（把缓存关掉）",
		);
	}

	// 驱逐：容量满了必须丢最旧的，而且不能把新条目也一起丢了 / 死循环
	{
		const tiny = makeSearchProvider(scoped, { ...WEB_DEFAULTS, cacheTtlMs: 600_000, cacheMaxEntries: 2 }, () => {});
		await tiny.search({ query: "驱逐甲", maxResults: 5 });
		await tiny.search({ query: "驱逐乙", maxResults: 5 });
		await tiny.search({ query: "驱逐丙", maxResults: 5 });
		// 丙刚写进去，必须还在缓存里
		seen.length = 0;
		await tiny.search({ query: "驱逐丙", maxResults: 5 });
		assert.equal(
			seen.filter((u) => u.includes("bing.com")).length,
			0,
			"刚搜过的（最新的）条目被驱逐了 —— 驱逐把新的也丢了",
		);
		// 甲是最旧的，容量 2 装了三组，甲应该已被丢
		seen.length = 0;
		await tiny.search({ query: "驱逐甲", maxResults: 5 });
		assert.ok(
			seen.some((u) => u.includes("bing.com")),
			"最旧的条目该被驱逐（没驱逐 = 容量上限没生效，会无界涨内存）",
		);
	}
} finally {
	globalThis.fetch = realFetch;
}

// 没 web 服务时必须静静跳过，不能把整包带崩
const bareCtx = makeCtx(new URL("../", import.meta.url).href);
bareCtx._web = undefined;
apply(bareCtx, {});
assert.ok(bareCtx._sections.some((s) => s.name === "team:baseline"), "没 web 服务时团队基线也应照常加载");

// —— 12. 清理 ——

fs.rmSync(tempHome, { recursive: true, force: true });

console.log("✓ 自检通过：系统提示段 / 命令 / 审计落盘与脱敏 / 节流统计 / rtk 压缩范围 / 版本一致 / 搜索解析与组装 / 异常隔离");
