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

fs.writeFileSync(logFile, lines.join("\n"), "utf8");
log(`\n日志：${logFile}`);

const ok = mcTools.length > 0;
console.log(ok ? "\n✓ 适配层把 magic-context 挂起来了" : "\n✗ magic-context 没挂上");
process.exit(ok ? 0 : 1);
