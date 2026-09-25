#!/usr/bin/env node
/**
 * 端到端验证：用 dsh **真实的重启恢复路径**加载每个会话。
 *
 * 走的是 cordis 的持久化服务 + `readColdSessionLog` —— 就是用户重启 dsh 后
 * 恢复历史对话时走的那条路。用户报的错正是从这里抛出来的：
 *   `dsh-session-query/lib/index.js:295` →
 *   `stored session "…" is corrupt: session event at seq N message must have role "user"`
 *
 * 为什么不自己复刻校验：形状规则会随 dsh 版本变。这个脚本直接起一个最小 cordis
 * 应用、挂 dsh 自己的持久化插件、调 dsh 自己的读取函数 —— 加载失败就是失败。
 *
 * 找不到 dsh 安装树时**跳过并明说**（与 selftest-preset-gen 的约定一致）。
 *
 *   node scripts/verify-sessions.mjs
 *   DSH_MODULES=<path/to/@deepseek-ai/> node scripts/verify-sessions.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const DSH = process.env.DSH_MODULES ?? "C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/";
const root = process.env.DSH_SESSIONS_DIR ?? path.join(os.homedir(), ".dsh", "sessions");

for (const rel of ["cordis/lib/index.js", "dsh-session-persistence-jsonl/lib/index.js", "dsh-session-query/lib/index.js"]) {
	if (!fs.existsSync(path.join(DSH, rel))) {
		console.log(`⚠ 跳过：找不到 dsh 安装树（${path.join(DSH, rel)}）。设 DSH_MODULES 指向 @deepseek-ai/ 再跑。`);
		process.exit(0);
	}
}
if (!fs.existsSync(root)) {
	console.log(`⚠ 跳过：${root} 不存在。`);
	process.exit(0);
}
if (process.env.DSH_SESSIONS_DIR === undefined && root === path.join(os.homedir(), ".dsh", "sessions")) {
	// 读的是用户真实数据 —— 只读不写，但值得说清楚
	console.log(`（读的是本机真实会话目录；只读，不写入）\n`);
}

const { Context } = await import(pathToFileURL(path.join(DSH, "cordis/lib/index.js")).href);
const JsonlPersistence = (await import(pathToFileURL(path.join(DSH, "dsh-session-persistence-jsonl/lib/index.js")).href)).default;
const { readColdSessionLog } = await import(pathToFileURL(path.join(DSH, "dsh-session-query/lib/index.js")).href);

const ctx = new Context();
ctx.plugin(JsonlPersistence, { root });
// 插件是异步挂载的。固定 sleep 在慢机器上会假跳过 —— 轮询到服务真正的出现。
async function waitForService(name, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const service = ctx.get(name);
		if (service) return service;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
const persistence = await waitForService("sessionPersistence");
if (!persistence) {
	console.log("⚠ 跳过：dsh 的持久化服务没挂上（版本变了？）。");	process.exit(0);
}

const sessions = await persistence.list();
if (sessions.length === 0) {
	console.log(`⚠ 跳过：${root} 下没有会话。`);
	process.exit(0);
}

let passed = 0;
const failures = [];
for (const snapshot of sessions) {
	const id = snapshot.header?.id ?? snapshot.id;
	try {
		const cold = await readColdSessionLog(persistence, id);
		passed++;
		if (process.env.VERBOSE) {
			const user = cold.events.filter((e) => e.type === "user/message").length;
			const assistant = cold.events.filter((e) => e.type === "assistant/message").length;
			console.log(`  ✓ ${id}  事件 ${cold.events.length}  user=${user} assistant=${assistant}`);
		}
	} catch (error) {
		failures.push([id, error?.message ?? String(error)]);
	}
}

console.log(`用 dsh 真实的 cold-read 路径加载会话（${root}）：`);
console.log(`  成功：${passed} / ${sessions.length}`);
for (const [id, why] of failures) console.log(`  ✗ ${id}\n      ${why}`);
if (failures.length === 0) console.log("\n所有会话都能被 dsh 正常加载。");
process.exit(failures.length > 0 ? 1 : 0);
