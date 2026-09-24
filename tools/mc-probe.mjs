#!/usr/bin/env node
/**
 * magic-context 探针：用一个桩 pi 把上游 bundle 完整跑一遍。
 *
 * 为什么需要它：真验证要启动 dsh GUI，CI 里做不到。但 bundle 是否真的
 * 装上（工具数、命令数、事件处理器、context 是否真改写消息）完全可以在
 * 一个独立进程里观测到 —— 它只需要一个 `pi` 对象。
 *
 *   node tools/mc-probe.mjs            用 vendor/ 下的 bundle（默认）
 *   MC_BUNDLE_DIR=… node tools/mc-probe.mjs
 *
 * 退出码 0 = 完整 runtime 起来了；非 0 = 降级或者根本没起来。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = process.env.MC_BUNDLE_DIR ?? path.join(pkgRoot, "vendor", "pi-magic-context");
const entry = path.join(bundleDir, "dist", "index.js");

if (!fs.existsSync(entry)) {
	console.error(`✗ 找不到 ${entry}`);
	console.error("  先跑：dsh-team mc install");
	process.exit(1);
}

// —— 用一个一次性目录当存储，绝不碰用户的真实库 ——
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mc-probe-"));

/**
 * 关键：用 `MAGIC_CONTEXT_TEST_DATA_DIR` 而不是 `MAGIC_CONTEXT_STORAGE_DIR`。
 *
 * 上游的迁移守卫这么判断「是不是共享库」：
 *   function isDefaultSharedDatabasePath(dbPath) {
 *     if (!XDG_DATA_HOME && MAGIC_CONTEXT_TEST_DATA_DIR) return false;   ← 这个分支
 *     return resolve(dbPath) === resolve(join(getMagicContextStorageDir(), "context.db"));
 *   }
 * 换库路径没用（仍然会被当成共享库 → 扫描全机 pi 进程 → 只要有旧 build 的
 * pi 在跑就 fail-closed）。TEST_DATA_DIR 是它自己留的隔离通道。
 *
 * 真跑到 dsh 里要靠同样这两行环境变量 —— 见 lib/mc-adapter.js 的注释。
 */
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = scratch;
process.env.MAGIC_CONTEXT_LOG_PATH = path.join(scratch, "mc.log");

// —— 桩 pi ——
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const renderers = new Map();

const session = { id: "dsh-probe", getSessionId: () => "dsh-probe", getBranch: () => [] };

const pi = {
	on(ev, handler) {
		const list = handlers.get(ev) ?? [];
		list.push(handler);
		handlers.set(ev, list);
		return () => {};
	},
	registerTool(t) {
		if (t?.name) tools.set(t.name, t);
	},
	registerCommand(name, options) {
		// 上游签名是 registerCommand(name, { handler, description, … })
		const key = typeof name === "string" ? name : (name?.name ?? undefined);
		if (key) commands.set(key, typeof name === "string" ? (options ?? {}) : name);
	},
	registerEntryRenderer(kind) {
		renderers.set(kind, true);
		return () => {};
	},
	registerFlag: () => () => {},
	getFlag: () => undefined,
	appendEntry: () => {},
	sendMessage: () => {},
	getAllTools: () => [...tools.values()].map((t) => ({ name: t.name, description: t.description })),
	getActiveTools: () => [...tools.keys()],
	setActiveTools: () => {},
	events: { on: () => () => {}, emit: () => {} },
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	compact: async () => {},
	sessionManager: session,
	model: { provider: "new-api", id: "tier-std" },
	harness: "pi",
};

const ctx = {
	sessionManager: session,
	model: pi.model,
	cwd: pkgRoot,
	hasUI: false,
	ui: { notify: () => {}, setStatus: () => {}, custom: async () => undefined },
	getContextUsage: () => ({ contextWindow: 128_000, usedTokens: 0 }),
	getSystemPrompt: () => "",
	abort: () => {},
	isIdle: () => true,
	seen: new Set(),
};

console.log(`bundle: ${entry}`);
const mod = await import(pathToFileURL(entry).href);
await mod.default(pi);
// 后台任务（git sweep、embedding drain…）是异步挂载的，给它一点时间
await new Promise((r) => setTimeout(r, 2500));

const toolNames = [...tools.keys()].sort();
const cmdNames = [...commands.keys()].filter(Boolean).sort();
const evNames = [...handlers.keys()].sort();

console.log(`\n工具 (${toolNames.length}): ${toolNames.join(", ") || "（无）"}`);
console.log(`命令 (${cmdNames.length}): ${cmdNames.join(", ") || "（无）"}`);
console.log(`事件 (${evNames.length}): ${evNames.join(", ") || "（无）"}`);

// —— 真跑一次 context handler，看它是否在改写消息 ——
const ctxHandlers = handlers.get("context") ?? [];
let transformed = false;
if (ctxHandlers.length > 0) {
	const event = {
		type: "context",
		messages: [
			{ role: "user", content: [{ type: "text", text: "第一条记忆：团队基线规定一律用中文回答" }] },
			{ role: "assistant", content: [{ type: "text", text: "好的" }] },
			{ role: "user", content: [{ type: "text", text: "第二条：不要按进程名杀 node" }] },
		],
	};
	try {
		const out = await ctxHandlers[0](event, ctx);
		const after = out?.messages ?? [];
		const injects = after.filter((m) => /session-history/.test(m.content?.[0]?.text ?? ""));
		transformed = injects.length > 0 || after.some((m) => /§\d+§/.test(m.content?.[0]?.text ?? ""));
		console.log(`\ncontext handler: 输入 ${event.messages.length} 条 → 输出 ${after.length} 条`);
		console.log(`  注入的块: ${injects.length}（<session-history> / <session-history-since>）`);
		for (const m of after) console.log(`  ${m.role.padEnd(9)} ${JSON.stringify(m.content?.[0]?.text ?? "").slice(0, 70)}`);
	} catch (error) {
		console.log(`\n✗ context handler 抛错: ${error?.message ?? error}`);
	}
}

// —— 读日志里的降级证据 ——
const logFile = process.env.MAGIC_CONTEXT_LOG_PATH;
let degraded = null;
if (fs.existsSync(logFile)) {
	const text = fs.readFileSync(logFile, "utf8");
	const m = /fail-closed blocking surface registered \(([a-z_]+)\)/.exec(text);
	if (m) degraded = m[1];
}

// 不删 scratch：bundle 的 SQLite 句柄还开着，Windows 上必 EPERM。它在
// %TEMP% 下，系统会自己清。
try {
	fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
} catch {
	console.log(`（scratch 未删：${scratch}）`);
}

console.log("\n" + "─".repeat(60));
if (degraded) {
	console.error(`✗ 降级运行（${degraded}）—— runtime 没真正挂载`);
	process.exit(2);
}
if (toolNames.length === 0) {
	console.error("✗ 一个工具都没注册 —— runtime 没起来");
	process.exit(2);
}
if (!transformed) {
	console.error("✗ context handler 存在但没有改写消息 —— 移植没有实际效果");
	process.exit(3);
}
console.log("✓ 完整 runtime 已挂载，context 改写生效");
process.exit(0);
