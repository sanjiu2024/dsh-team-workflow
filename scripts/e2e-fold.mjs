#!/usr/bin/env node
/**
 * 折叠端到端：真 `installMagicContext`（含 pi 伪 CLI 上线 + historian 配置）
 * → 真 historian 交付 compartment → `agent/pre-step` 真的把折叠落到 dsh surface。
 *
 * 这是决定性的那一个：前面所有单测都在验证「给定 before/after 能否落地」，
 * 这里验证的是「真 bundle 产出的 after 能不能落地」。
 *
 * 跑得比较久（historian 要 spawn 子进程 + 调模型），约 1-3 分钟。
 *
 *   node scripts/e2e-fold.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DSH = process.env.DSH_MODULES ?? "C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fold-"));
// 独立库：绝不能碰 pi/opencode 的共享 DB（schema v85 vs 90 会卡迁移守卫）
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = scratch;
process.env.MAGIC_CONTEXT_STORAGE_DIR = path.join(scratch, "mem");
process.env.MAGIC_CONTEXT_LOG_PATH = path.join(scratch, "mc.log");
// 逼出折叠：小窗口 + 低阈值 + 关掉「尾巴太小」的第二道闸
process.env.MC_CONTEXT_WINDOW = "6000";
const cfgHome = path.join(scratch, "cfg");
process.env.XDG_CONFIG_HOME = cfgHome;
fs.mkdirSync(path.join(cfgHome, "cortexkit"), { recursive: true });
fs.writeFileSync(
	path.join(cfgHome, "cortexkit", "magic-context.jsonc"),
	JSON.stringify({
		execute_threshold_percentage: 20,
		min_proactive_tail_token_estimate: 0,
		min_proactive_tail_message_count: 0,
		// historian 必须显式配：读写的是模型引用，走 pi 伪 CLI
		historian: { pi: { model: "new-api/tier-std" } },
	}),
);

const { Session } = await import(pathToFileURL(path.join(DSH, "dsh-session/lib/index.js")).href);
const { createPiFacade, resolveBundle } = await import(pathToFileURL(path.join(root, "lib", "mc-adapter.js")).href);
const { landOnSurface, stagePiShim } = await import(pathToFileURL(path.join(root, "lib", "mc.js")).href);

const log = (m) => process.env.VERBOSE && console.log(m);
const session = Session.create("e2e-fold");
const src = { kind: "plugin", plugin: "probe" };
const block = (t) => ({ type: "text", text: t });
const sessionRef = { session };

// 真上线 pi 伪 CLI —— historian 靠它在 PATH 上找到 "pi"
const shimDir = stagePiShim(pathToFileURL(path.join(root, ".")), log);
console.log(`pi 伪 CLI: ${shimDir}`);

// 假 ctx：只提供 createPiFacade 真正会碰的那几个面
const fakeCtx = {
	logger: { info: log, warn: log, error: log },
	tools: { register: () => () => {} },
	commands: { register: () => () => {} },
	systemPrompt: { section: () => () => {} },
	on: () => () => {},
	get: () => undefined,
	inject: () => () => {},
};
const pi = createPiFacade({ ctx: fakeCtx, log, sessionRef });
const found = resolveBundle(pathToFileURL(path.join(root, ".")), "");
const { default: boot } = await import(pathToFileURL(found.entry).href);
await boot(pi.facade);
pi.flushTools();
console.log(`bundle 已挂载：工具 ${pi.toolCount()} 个`);

// 造历史：含工具配对，且内容够长以推高占用率
for (let i = 0; i < 10; i += 1) {
	session.append("user/message", { id: `u${i}`, role: "user", content: [block(`消息${i}：${"很长的内容".repeat(200)}`)], source: src }, { surfaceOp: "append" });
	session.append("assistant/message", {
		turn: i, step: 0, stream: [],
		message: { id: `a${i}`, role: "assistant", content: [block(`回复${i}`), { type: "tool-call", id: `c${i}`, name: "read", arguments: "{}" }], source: src },
	}, { surfaceOp: "append" });
	session.append("tool/result", {
		turn: i, step: 0,
		message: { id: `r${i}`, role: "user", content: [{ type: "tool-result", toolCallId: `c${i}`, content: [block("结果".repeat(300))] }], source: src },
	}, { surfaceOp: "append" });
}

// 驱动一轮 context，逼 historian 触发
const before = session.deriveMessages();
const out = await pi.emit("context", { type: "context", messages: structuredClone(before) });
console.log(`bundle context: ${before.length} → ${out?.messages?.length}`);

// 等 historian（真子进程）交付
console.log("等 historian 交付 compartment（最多 180s）...");
const dbPath = path.join(scratch, "cortexkit", "magic-context", "context.db");
let compartments = 0;
for (let w = 1; w <= 180; w += 1) {
	await new Promise((r) => setTimeout(r, 1000));
	if (!fs.existsSync(dbPath)) continue;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		compartments = db.prepare("select count(*) c from compartments").get().c;
		db.close();
	} catch {}
	if (compartments > 0) { console.log(`historian 交付 ${compartments} 个 compartment（${w}s）`); break; }
	if (w % 30 === 0) console.log(`  ...${w}s`);
}
if (compartments === 0) {
	const lg = fs.existsSync(process.env.MAGIC_CONTEXT_LOG_PATH) ? fs.readFileSync(process.env.MAGIC_CONTEXT_LOG_PATH, "utf8") : "";
	const hints = lg.split("\n").filter((l) => /historian (failure|trigger|:)|DISABLED|invoking subagent|spawned pid|child_exit/.test(l)).slice(-8);
	console.log("!! historian 未交付。日志线索：");
	for (const h of hints) console.log("   " + h.replace(/^\[[^\]]+\]\s*/, ""));
	process.exit(3);
}

// 交付后：再驱动 context —— 这次它应该真的删消息了
let landedTotal = 0;
for (let round = 1; round <= 3; round += 1) {
	const b = session.deriveMessages();
	const o = await pi.emit("context", { type: "context", messages: structuredClone(b) });
	const a = o?.messages;
	const r = landOnSurface({ session, before: structuredClone(b), after: a, log });
	const f = session.deriveMessages();
	const dangling = session.surface.nodes.filter((s) => !session.eventAt(s));
	const calls = new Set(); const results = new Set();
	for (const m of f) for (const bl of m.content ?? []) {
		if (bl?.type === "tool-call") calls.add(bl.id);
		if (bl?.type === "tool-result") results.add(bl.toolCallId);
	}
	const orphan = [...calls].filter((x) => !results.has(x)).length + [...results].filter((x) => !calls.has(x)).length;
	console.log(`轮${round}: before=${b.length} bundle=${a?.length} final=${f.length} folds=${r?.folds} 悬空=${dangling.length} 孤儿=${orphan}`);
	landedTotal += r?.folds ?? 0;
	if (dangling.length || orphan) { console.log("!! 异常"); process.exit(4); }
	// 下一轮追加一条，模拟真实步进
	session.append("user/message", { id: `n${round}`, role: "user", content: [block(`第${round}轮`)], source: src }, { surfaceOp: "append" });
}

console.log(landedTotal > 0 ? `e2e ✓ 折叠落地 ${landedTotal} 次` : "e2e ✗ 一轮都没落地");
try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
process.exit(landedTotal > 0 ? 0 : 1);
