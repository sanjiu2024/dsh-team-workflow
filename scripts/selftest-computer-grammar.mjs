#!/usr/bin/env node
/**
 * 自检：命令文法两侧不许漂移（REQ-024 步骤 2）。
 *
 * 为什么单独一条：命令文法天生分居两个文件 —— JS 侧 `buildCommand` 负责编码，
 * daemon.ps1 侧 `Invoke-Body` 负责解码。步骤 2 把 285 行 PS 从 `lib/computer.js`
 * 搬进独立文件后，这两处从「同一个文件里的两段」变成了「跨文件跨语言」，
 * 是最容易单边改动的地方：改了一边，另一边不报错，运行时才以「未知命令」炸掉。
 * REQ-024 §6 把这条列进步骤 2 验收，就是因为它只能靠断言守。
 *
 * 三条断言（都带防假绿）：
 *   1. kind 集合双向包含：JS 发出的每个 kind，PS 必须认（`quit` 由主循环消费，单独校验）。
 *   2. PS 分支里只允许 `fakehuman` 是 JS 不发起的（自检专用的人为事件）。
 *   3. MAGIC 跨语言一致 —— 它在 C# 里是常量、在 config.js 里是常量，纯手工同步，无运行时校验。
 *
 * 反向验证（改坏必须红，改完逐字节还原）：
 *   - 把 protocol.js 某个 `case "scroll":` 改成 `case "scrol":` → 本自检必红
 *   - 把 daemon.ps1 某个 `'shot'` 分支改成 `'shots'` → 本自检必红
 *   - 把 daemon.ps1 的 MAGIC 改一位 → 本自检必红
 *
 *   node scripts/selftest-computer-grammar.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const ROOT = new URL("../", import.meta.url);
const PROTOCOL = new URL("lib/computer/core/protocol.js", ROOT);
const CONFIG = new URL("lib/computer/core/config.js", ROOT);
const DAEMON = new URL("lib/computer/drivers/win32/daemon.ps1", ROOT);

/** 取一个函数/函数的源码片段：从 startMarker 到下一个顶层 `\nexport ` 或 `\nfunction `。 */
function sliceBlock(src, startMarker) {
	const at = src.indexOf(startMarker);
	assert.notEqual(at, -1, `找不到 ${startMarker}`);
	const rest = src.slice(at + startMarker.length);
	const stop = rest.search(/\n(?:export |function )/);
	return stop === -1 ? rest : rest.slice(0, stop);
}

// ── 解析两侧 ────────────────────────────────────────────────────────────────

const protocolSrc = fs.readFileSync(PROTOCOL, "utf8");
const jsBody = sliceBlock(protocolSrc, "export function buildCommand");
const jsKinds = new Set([...jsBody.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]));

const daemonSrc = fs.readFileSync(DAEMON, "utf8");
const psBody = sliceBlock(daemonSrc, "function Invoke-Body");
const psKinds = new Set([...psBody.matchAll(/^\s+'([a-z_]+)'\s*\{/gm)].map((m) => m[1]));

// 防假绿：解析不出来就静默「两边都空、断言通过」，是这类静态检查最典型的骗局。
assert.ok(jsKinds.size >= 5, `JS 侧只解析出 ${jsKinds.size} 个 kind，解析规则可能已失效`);
assert.ok(psKinds.size >= 5, `PS 侧只解析出 ${psKinds.size} 个 kind，解析规则可能已失效`);

// ── 断言 1：JS 发出的，PS 必须认 ────────────────────────────────────────────

// `quit` 不在 switch 里：它由主循环单独消费（读到就 break），所以要先证明那条判定还在。
const quitHandled = /if \(\$body\.Trim\(\) -eq 'quit'\) \{ break \}/.test(daemonSrc);
assert.ok(quitHandled, "daemon.ps1 主循环里找不到 quit 判定 —— 杀掉守护进程的命令没人接了");

const psSpecial = new Set(["quit"]);
const jsOnly = [...jsKinds].filter((k) => !psKinds.has(k) && !psSpecial.has(k));
assert.deepEqual(jsOnly, [], `buildCommand 会发出这些 kind，但 daemon.ps1 不认：${jsOnly.join(", ")}`);

// ── 断言 2：PS 认的，JS 必须能发起（除自检专用） ────────────────────────────

const jsSpecial = new Set(["fakehuman"]);
const psOnly = [...psKinds].filter((k) => !jsKinds.has(k) && !jsSpecial.has(k));
assert.deepEqual(psOnly, [], `daemon.ps1 认这些 kind，但 buildCommand 不会发起：${psOnly.join(", ")}`);

// 自检专用口子只能是 fakehuman，且它必须真的还在（那条端到端反向验证靠它）
assert.ok(psKinds.has("fakehuman"), "fakehuman 分支没了 —— 「钩子拦人放 AI」的端到端验证就失去手段");

// ── 断言 3：MAGIC 跨语言一致 ────────────────────────────────────────────────

const { MAGIC } = await import(CONFIG);
const magicMatch = daemonSrc.match(/public const int MAGIC = (-?\d+);/);
assert.ok(magicMatch, "daemon.ps1 里找不到 C# 的 MAGIC 常量");
assert.equal(
	Number(magicMatch[1]),
	MAGIC,
	`MAGIC 两侧不一致：config.js=${MAGIC}，daemon.ps1=${magicMatch[1]}。` +
		"它是注入事件的标记，不一致会导致 AI 的鼠标被自己的钩子当成人操作拦掉（或反之，人操作被放行）",
);

// ── 报告 ────────────────────────────────────────────────────────────────────

const sortedJs = [...jsKinds].sort().join(" ");
const sortedPs = [...psKinds].sort().join(" ");
process.stdout.write(
	`✓ 自检通过：命令文法两侧一致（JS ${jsKinds.size} 个 kind：${sortedJs}）\n` +
		`  （PS ${psKinds.size} 个分支：${sortedPs}；quit 由主循环消费，fakehuman 为自检专用）\n` +
		`  MAGIC=${MAGIC} 两侧一致\n` +
		`  PS 脚本：lib/computer/drivers/win32/daemon.ps1（${daemonSrc.split("\n").length} 行）\n`,
);
