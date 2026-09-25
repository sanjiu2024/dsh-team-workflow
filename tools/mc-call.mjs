#!/usr/bin/env node
/**
 * 用桩 pi 真跑一次 ctx_* 工具，看错误体是不是还在。
 *
 * 审计日志只留 isError + resultSha256（这是对的，日志不该存正文），
 * 所以要验证「ctx_* 到底报什么错」只能自己把 bundle 跑起来、真调一次。
 *
 *   node tools/mc-call.mjs --list          列出桥接后的工具名
 *   node tools/mc-call.mjs ctx_memory '{"action":"get","ids":[1]}'
 *
 * 退出码 0 = 调用成功；1 = 工具报错（正文打出来）；2 = 环境没起来。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = process.env.MC_BUNDLE_DIR ?? path.join(pkgRoot, "vendor", "pi-magic-context");
const entry = path.join(bundleDir, "dist", "index.js");

if (!fs.existsSync(entry)) {
	console.error(`✗ 找不到 ${entry}；先跑 dsh-team mc install`);
	process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mc-call-"));
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = scratch;
process.env.MAGIC_CONTEXT_LOG_PATH = path.join(scratch, "mc.log");

const session = { id: "dsh-call", getSessionId: () => "dsh-call", getBranch: () => [] };

// 关键：bundle 必须拿到 facade（不是自造的桩），并且要 flushTools() 之后
// 才有桥接后的工具。要验证的正是「经 mc-adapter 桥接之后」的行为 ——
// 包括 isError → 抛错、以及 sessionManager getter 那一步。
const { createPiFacade } = await import(new URL("../lib/mc-adapter.js", import.meta.url).href);

const registered = new Map();
const fakeCtx = {
	tools: { register: (def) => registered.set(def.name, def) },
	on: () => () => {},
	commands: { register: () => {} },
	clientModules: { register: () => {} },
	getContextUsage: () => ({ contextWindow: 128_000, usedTokens: 0 }),
};

const { facade, flushTools, toolCount } = createPiFacade({ ctx: fakeCtx, log: () => {}, sessionRef: { session } });
await (await import(pathToFileURL(entry).href)).default(facade);
await new Promise((r) => setTimeout(r, 2000));
flushTools();

if (registered.size === 0) {
	console.error(`✗ 一个工具都没桥接上（bundle 注册了 ${toolCount()} 个）——环境没起来`);
	process.exit(2);
}

const argv = process.argv.slice(2);
if (argv[0] === "--list" || argv.length === 0) {
	console.log([...registered.keys()].sort().join("\n"));
	process.exit(0);
}

const [name, rawArgs] = argv;
const bridged = registered.get(name);
if (bridged === undefined) {
	console.error(`✗ 没注册 ${name}；已注册：${[...registered.keys()].sort().join(", ")}`);
	process.exit(2);
}

let args = {};
if (rawArgs !== undefined) {
	try {
		args = JSON.parse(rawArgs);
	} catch (error) {
		console.error(`✗ 参数不是合法 JSON：${error.message}`);
		process.exit(2);
	}
}

try {
	const value = await bridged.execute(args, { callId: "probe" });
	const text = value?.text ?? "";
	console.log(`✓ ${name} 成功（${Buffer.byteLength(text, "utf8")} 字节）`);
	console.log(text.slice(0, 2000));
	process.exit(0);
} catch (error) {
	console.error(`✗ ${name} 报错：${error?.message ?? error}`);
	process.exit(1);
}
