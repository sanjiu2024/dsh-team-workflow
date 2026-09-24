#!/usr/bin/env node
/**
 * 端到端自检：在真 dsh 进程上下文之外，用本包的 installMagicContext
 * 跑一遍，确认适配层能真把 bundle 挂起来（不依赖 dsh GUI/headless）。
 *
 * 与 tools/mc-probe.mjs 的区别：探针直接用桩 pi；这里走【本包真实的
 * 适配层代码路径】—— resolveBundle / applyStorageEnv / createPiFacade /
 * landOnSurface 都真跑。
 *
 *   node scripts/selftest-mc.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logFile = path.join(os.tmpdir(), "dsh-team-mc-selftest.log");
const lines = [];
const log = (m) => {
	lines.push(m);
	console.log(m);
};

// 用一个一次性存储目录，别碰用户真实库
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mc-selftest-"));
process.env.MAGIC_CONTEXT_LOG_PATH = path.join(scratch, "mc.log");

// —— 极简 cordis ctx 桩，足够 apply() 跑到底 ——
const registered = { tools: [], commands: [], effects: [], events: new Map() };
const ctx = {
	logger: { info: (m) => log(String(m)), warn: (m) => log(`WARN ${m}`), error: (m) => log(`ERR ${m}`) },
	on(ev, handler) {
		const list = registered.events.get(ev) ?? [];
		list.push(handler);
		registered.events.set(ev, list);
	},
	tools: { register: (d) => (registered.tools.push(d), () => {}) },
	commands: { register: (d) => (registered.commands.push(d), () => {}) },
	effect: (fn) => registered.effects.push(fn),
	sessions: { list: () => [], create: () => null },
	systemPrompt: { section: () => () => {} },
	// 可选依赖：这个桩没有 web 服务，应该静静跳过而不是报错
	inject: () => () => {},
};

const { apply } = await import(pathToFileURL(path.join(root, "lib", "index.js")).href);
apply(ctx, { mc: { storageDir: path.join(scratch, "memory") } });

// mc 是 async 挂载的，等一会
await new Promise((r) => setTimeout(r, 4000));

const mcTools = registered.tools.filter((t) => /^ctx_|^todowrite$/.test(t.name));
log(`\n注册工具 ${registered.tools.length} 个，其中 magic-context ${mcTools.length} 个：${mcTools.map((t) => t.name).join(", ")}`);
log(`注册命令 ${registered.commands.length} 个：${registered.commands.map((d) => "/" + d.name).join(", ")}`);

const memDir = path.join(scratch, "memory");
log(`\n存储目录 ${memDir} 内容：`);
try {
	for (const f of fs.readdirSync(memDir)) log(`  ${f}  ${fs.statSync(path.join(memDir, f)).size} B`);
} catch (error) {
	log(`  （读不到：${error.message}）`);
}

// 找 context handler 真跑一次
const preHandlers = registered.events.get("agent/created") ?? [];
log(`\nagent/created 处理器 ${preHandlers.length} 个`);

// ── 占用率上报的字段名 ────────────────────────────────────────────────
// bundle 的折叠触发器（threshold 63%）读的是 piUsage.tokens / .percent，
// 而这里曾经返回 {contextWindow, usedTokens} —— 字段名对不上 → 恒读 0% →
// 只有注入、从不折叠。这条断言防的是「又改回错的字段名」。
{
	const { createPiFacade, measureSessionTokens } = await import("../lib/mc-adapter.js");

	// 先直接测数据源
	const fakeSession = {
		deriveMessages: () => [{ role: "user", content: [{ type: "text", text: "x".repeat(3500) }] }],
		requestContext: () => ({ contextWindow: 128000 }),
	};
	// ⚠️ 必须给 ctx 一个 `get(name)`：真 dsh 里读服务走的是 `ctx.get("tokenMeter")`，
	// 不是直接读 `ctx.tokenMeter`（后者没 inject 会抛）。桩直接摆个 `tokenMeter`
	// 属性，测的就成了「假想中的 API」而不是真 API —— 曾经就是这么红掉的。
	const meterCtx = { get: (name) => (name === "tokenMeter" ? { measure: () => ({ totalTokens: 90000 }) } : undefined) };
	const measured = measureSessionTokens(meterCtx, fakeSession, () => {});
	assert.deepEqual(measured, { tokens: 90000, contextWindow: 128000 }, "应该从 ctx.get('tokenMeter') 取到权威 token 数");
	assert.equal(measureSessionTokens({ get: () => undefined }, { deriveMessages: () => [], requestContext: () => ({}) }, () => {}), null, "全拿不到时应返回 null，不能报 0");
	// 拿不到 tokenMeter 时要退到按可见消息粗估，而不是直接报 null
	const est = measureSessionTokens({ get: () => undefined }, fakeSession, () => {});
	assert.ok(est && est.tokens > 900, `没有 tokenMeter 时应按字符粗估，实际 ${JSON.stringify(est)}`);

	// 再测桩真的把字段名报对了
	const rec = createPiFacade({
		ctx: meterCtx,
		log: () => {},
		sessionRef: { session: fakeSession },
	});
	const usage = rec.facadeCtx.getContextUsage();
	assert.ok(usage !== null && usage !== undefined, "getContextUsage 不该返回空");
	assert.equal(typeof usage.tokens, "number", "必须叫 tokens —— bundle 读的是这个名字");
	assert.equal(typeof usage.percent, "number", "必须叫 percent");
	assert.equal(usage.contextWindow, 128000, "必须叫 contextWindow");
	assert.ok(Math.abs(usage.percent - 70.3125) < 0.01, `percent 要按 tokens/窗口 算，实际 ${usage.percent}`);
	assert.ok(usage.percent > 63, "这个场景应该超过 63% 的折叠阈值，否则折叠不会触发");
	log(`\n占用率上报：${usage.tokens} tokens / ${usage.contextWindow} = ${usage.percent.toFixed(1)}%（阈值 63%，会触发折叠）`);
}

// ── 真调一次 ctx_* 工具（走 registerToolBridge 的真实路径）──────────────
// 守的是「工具全 100% 报错却没人发现」这个具体事故：桥接层曾给 bundle 传一个
// 精简 ctx（只有 cwd/hasUI/ui），而 bundle 的工具第一件事就是
// `ctx.sessionManager.getSessionId()` —— 抛 TypeError 被包成 isError，
// 6 个工具、7 个命令全是死的，但表面上「工具注册了、命令也在」。
//
// 这里不另造 ctx：直接用 apply() 里真注册进 ctx.tools 的那份 definition，
// 调它的 execute，就等于跑真实桥接代码。审计日志里的指纹是「结果恒为 67 字节」，
// 所以这里连长度一起断言 —— 报错文本恰好就是 67 字节。
{
	const args = { action: "read" };
	const tool = registered.tools.find((t) => t.name === "ctx_note");
	assert.ok(tool, "ctx_note 应该已注册");

	// ① 返回值必须满足 output.schema —— dsh 在 createSuccessResult 里就是这么查的
	//    （dsh-tools/lib/index.js:3415）。只调 execute 不看 schema 是查不出事的：
	//    schema 声明 object、execute 返回字符串，直调一切正常，进 dsh 立刻
	//    `returned invalid output: "value" must be an object`，模型一个字都收不到。
	let value;
	try {
		value = await tool.execute(args, { callId: "selftest-1" });
	} catch (error) {
		assert.fail(`工具 execute 不该抛错：${error?.message ?? error}`);
	}
	const schema = tool.output?.schema;
	assert.equal(schema?.type, "object", "output.schema 必须是 object 根");
	assert.equal(typeof value, "object", `execute 必须返回对象（dsh 校验 output.schema），实际 ${typeof value}`);
	assert.ok(value !== null && !Array.isArray(value), "execute 必须返回普通对象，不能是 null/数组");
	for (const [key, spec] of Object.entries(schema.properties ?? {})) {
		if (spec?.type === "string") assert.equal(typeof value[key], "string", `字段 ${key} 应为 string`);
	}
	assert.deepEqual(
		Object.keys(value).sort(),
		Object.keys(schema.properties ?? {}).sort(),
		"返回字段必须与 schema 声明一致（多传会被 additionalProperties:false 拒掉）",
	);

	// ② 但真正给模型看的是 render 的输出 —— 它必须是非空文本
	const blocks = tool.output.render(args, value);
	const shown = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? "").join("") : "";
	assert.ok(shown.trim().length > 0, "output.render 必须产出非空文本，否则模型什么都看不到");
	assert.ok(!/getSessionId/.test(shown), `工具不该报 getSessionId 错（桥接层没把 sessionManager 传下去），实际：${shown.slice(0, 200)}`);
	assert.ok(shown.includes("Notes"), `ctx_note 应该正常返回笔记面板，实际：${shown.slice(0, 200)}`);

	// ③ 失败态必须转成「抛错」
	//    pi 用返回值里的 `isError: true` 表示失败，dsh 只认抛错
	//    （`createSuccessResult` 给每个返回值盖章 isError:false）。
	//    不转的话 bundle 的失败全成成功，而审计日志正是靠 block.isError 判失败的
	//    —— bug #1 能在日志里藏那么久，靠的就是这个信号。
	const search = registered.tools.find((t) => t.name === "ctx_search");
	assert.ok(search, "ctx_search 应该已注册");
	await assert.rejects(
		() => search.execute({}, { callId: "selftest-2" }),
		(error) => {
			assert.ok(
				!error.message.startsWith("Error: "),
				`失败文本自带的前缀要剥一层（dsh 会再拼一次），否则模型看到 "Error: Error: …"，实际：${error.message}`,
			);
			return true;
		},
		"bundle 用返回值里的 isError 表示失败，桥接必须转成抛错",
	);

	// 命令同样要传完整 ctx：挑一个真会读 sessionManager 的跑一次
	const cmd = registered.commands.find((d) => d.name === "ctx-status");
	assert.ok(cmd, "ctx-status 应该已注册");
	let out;
	try {
		out = await cmd.handler({ rawInput: "" });
	} catch (error) {
		out = { kind: "threw", text: `${error?.message ?? error}` };
	}
	assert.ok(
		!/getSessionId/.test(String(out?.text ?? "")),
		`命令不该报 getSessionId 错，实际：${String(out?.text ?? "").slice(0, 200)}`,
	);
	log(`\n工具/命令真调用：ctx_note → ${JSON.stringify(shown.slice(0, 60))}… / ctx-status → ${out?.kind}`);
}

fs.writeFileSync(logFile, lines.join("\n"), "utf8");
log(`\n日志：${logFile}`);

const ok = mcTools.length > 0;
console.log(ok ? "\n✓ 适配层把 magic-context 挂起来了" : "\n✗ magic-context 没挂上");
process.exit(ok ? 0 : 1);
