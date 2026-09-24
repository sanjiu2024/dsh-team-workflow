#!/usr/bin/env node
/**
 * 集成自检：用**真的 dsh Session**，验证 magic-context 的 context 改写
 * 能经 landOnSurface 落到 surface 上，且 deriveMessages() 真的变了。
 *
 * 这是移植里最容易假成功的一环 —— 桩 pi 里 "handler 返回了新数组" 毫无
 * 意义，必须证明改动真的进了模型能看到的消息序列。
 *
 *   node scripts/selftest-surface.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DSH = process.env.DSH_MODULES ?? "C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/";
const { Session } = await import(pathToFileURL(path.join(DSH, "dsh-session/lib/index.js")).href);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mc-surface-"));
process.env.MAGIC_CONTEXT_LOG_PATH = path.join(scratch, "mc.log");
process.env.MAGIC_CONTEXT_STORAGE_DIR = path.join(scratch, "memory");
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = path.join(scratch, "memory");

const { createPiFacade } = await import(pathToFileURL(path.join(root, "lib", "mc-adapter.js")).href);
const { resolveBundle } = await import(pathToFileURL(path.join(root, "lib", "mc-adapter.js")).href);

const log = (m) => console.log(m);
const session = Session.create("surface-probe");
const src = { kind: "plugin", plugin: "probe" };
let n = 0;
const um = (t) => ({ id: `m${n++}`, role: "user", content: [{ type: "text", text: t }], source: src });

// 三条历史
session.append("user/message", um("记忆一：一律用中文回答"), { surfaceOp: "append" });
session.append("user/message", um("记忆二：不要按进程名杀 node"), { surfaceOp: "append" });
session.append("user/message", um("随便一问"), { surfaceOp: "append" });

const before = session.deriveMessages();
log(`改写前 (${before.length} 条):`);
for (const m of before) log(`  ${m.role.padEnd(9)} ${m.content[0]?.text}`);

// —— 用真实适配层挂 bundle ——
// resolveBundle 要的是【包根目录的 URL】—— 它内部拼 vendor/pi-magic-context/
const found = resolveBundle(pathToFileURL(path.join(root, ".")), "");
if (!found) throw new Error("找不到 bundle；先跑 dsh-team mc install");
log(`\nbundle: ${found.entry}`);

const sessionRef = { session };
const pi = createPiFacade({
	ctx: {
		logger: { info: log, warn: log, error: log },
		commands: { register: () => () => {} },
		tools: { register: () => () => {} },
	},
	log,
	sessionRef,
});
const { default: boot } = await import(pathToFileURL(found.entry).href);
await boot(pi.facade);

const out = await pi.emit("context", { type: "context", messages: structuredClone(before) });
const after = out?.messages ?? [];
log(`\nbundle 输出 (${after.length} 条):`);
for (const m of after) log(`  ${m.role.padEnd(9)} ${String(m.content?.[0]?.text ?? "").slice(0, 60)}`);

// —— diff + 落地（复刻 mc.js 的 landOnSurface）——
const { landOnSurface } = await import(pathToFileURL(path.join(root, "lib", "mc.js")).href);
const { alignSurface } = await import(pathToFileURL(path.join(root, "lib", "mc-adapter.js")).href);

// 先看看对齐器算出了什么
const plan = alignSurface(before, after);
log(`\n对齐计划:`);
for (const op of plan) {
	if (op.kind === "append") log(`  append ${op.messages.length} 条`);
	else log(`  ${op.kind} [${op.start}..${op.end}] → ${op.replacement.length} 条 ${op.note ?? ""}`);
}

// before 要深拷 —— bundle 原地改传入数组
const result = landOnSurface({ session, before: structuredClone(before), after, log });
log(`\n落地：${JSON.stringify(result)}`);

const final = session.deriveMessages();
log(`\n改写后 (${final.length} 条):`);
for (const m of final) log(`  ${m.role.padEnd(9)} ${String(m.content?.[0]?.text ?? "").slice(0, 60)}`);

const changed = JSON.stringify(before.map((m) => m.content?.[0]?.text)) !== JSON.stringify(final.map((m) => m.content?.[0]?.text));
const hasHistory = final.some((m) => /session-history/.test(m.content?.[0]?.text ?? ""));
// §N§ 是**已知天花板**：dsh 没有「仅本次请求」的消息改写缝，
// 把 ordinal 钉进 surface 会每轮叠一层 + 打断 tool_call 配对。
// ctx_expand 的 ordinal 走 bundle 自带 raw-message provider，不依赖它。
const noOrdinalOnSurface = !final.some((m) => /§\d+§/.test(m.content?.[0]?.text ?? ""));
// 去重：注入块不应该重复堆
const injectionCount = final.filter((m) => /^\s*<session-history(>|\-since>)/.test(m.content?.[0]?.text ?? "")).length;
const noDup = injectionCount <= 2;
log(`\n消息序列真的变了: ${changed ? "✓" : "✗"}`);
log(`含 <session-history> 注入: ${hasHistory ? "✓" : "✗"}`);
log(`ordinal 未污染 surface（预期，见注释）: ${noOrdinalOnSurface ? "✓" : "✗"}`);
log(`注入块未重复堆积 (${injectionCount}): ${noDup ? "✓" : "✗"}`);

try {
	fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
	// Windows 上 SQLite 句柄还没放，删不掉就算了 —— 在 %TEMP% 里
}
process.exit(changed && hasHistory && noOrdinalOnSurface && noDup ? 0 : 1);
