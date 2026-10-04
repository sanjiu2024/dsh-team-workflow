#!/usr/bin/env node
/**
 * 修复「受保护首节点被顶掉」的会话日志，让打不开的会话能重新加载（见 REQ-006）。
 *
 * 症状（用户重启 dsh 后看到）：整个会话打不开，
 *   `SessionFormatError: system/message requires a protected first surface head`
 *
 * 成因（`lib/mc.js` 的老写法，已修）：`agent/pre-step` 在 `step()` **之前**跑，新会话
 * 此刻 surface 是空的 —— `system/message` 要等 pre-step 返回后才 append
 * （`dsh-agent-loop/lib/index.js:1052`）。MC 却在这一刻把两个注入块
 * （`<session-history>` / `<session-history-since>`）直接 append 到了 surface 上，
 * 于是它们成了第 0、1 个节点，本应是受保护头的 system/message 变成「后面才来的」。
 * append 时不校验（实测：空 surface 上先 append user/message 再 append system/message
 * **不抛**），所以直播期间毫无征兆；校验只在**重载**时跑
 * （`restoreReleasedV4Artifact` → `Relationships.foldSurface`）。
 *
 * 修法（只动这两处，别的一律不碰）：
 *   1. 把这两个注入块降级成 **unknown + ignorable** 记录 —— dsh 给「读不懂的记录」留的
 *      逃生口：`dsh-session/lib/index.js:298` 直接 return，不进 surface、surfaceOp /
 *      sourceEventSeqs 也不再校验。**原地保留 seq 与 payload**，不重排序、不重新编号
 *      （重排要连带改 sourceEventSeqs / shadowedSeqs / headerSeq …，风险高一个数量级）。
 *      内容零损失：这两个块是纯占位，且下面的拒修条件会逐字核对（见 REQUIRED_TEXTS）。
 *   2. 重算被波及的 compaction span 与 replace 范围（受保护头既不能被 shadow、也不能被
 *      replace 盖住），否则下一道校验 `shadowedSeqs do not name an exact current surface
 *      span` 会接着报。
 *
 * 这是**会重写用户真实数据**的脚本，所以：
 *   · 拒修条件从严：首节点必须**正好**是那两个占位文本，且每个事件只有一个 text 块。
 *     别的一律拒修并报出来（打印长度与哈希，不打印内容）—— 把它们从 surface 上摘掉
 *     等于让模型少看到那段内容，这个决定不能由脚本替用户做。
 *   · 写盘前用 dsh **自己的加载期校验**复验内存结果（`findDshModules()` 定位安装树，
 *     拿不到就不写、只报告）；写完再验一次，写失败自动从备份回滚。
 *   · 可能正被 dsh 追加的文件不碰：Linux 上直接查 `/proc/<pid>/fd` 有没有进程开着它，
 *     再加一道「读完之后 mtime/size 变了就放弃」的重查。确认 dsh 已停再上 `--force-live`。
 *   · 备份整批写到**会话目录外**（会话目录里任何 `session.` 开头的文件都会被当成第二个
 *     会话），已存在同名备份就拒写，不覆盖。
 *
 *   node scripts/fix-surface-head.mjs            # 只扫，报出来（有可修项则退出码 1）
 *   node scripts/fix-surface-head.mjs --fix      # 备份后原地修
 *   DSH_SESSIONS_DIR=… DSH_MODULES=… node scripts/fix-surface-head.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { findDshModules, skipWithoutDshModules } from "./dsh-modules.mjs";
import { heldOpen, readSessionLog, writeSessionLog } from "../lib/session-log.js";

const FIX = process.argv.includes("--fix");
const FORCE_LIVE = process.argv.includes("--force-live");
/** 去掉尾斜杠：`dirname(root)` 是备份要落的目录，带尾斜杠会落回会话目录里。 */
const root = path.resolve(process.env.DSH_SESSIONS_DIR ?? path.join(os.homedir(), ".dsh", "sessions"));
/** 刚被改过的文件默认跳过（dsh 的空闲会话也可能还开着 fd，下面还有 /proc 那道）。 */
const liveMsRaw = Number(process.env.DSH_LIVE_MS ?? 120_000);
// NaN 会让 `Date.now() - mtime < LIVE_MS` 恒 false —— 主判据静默失效，所以必须回落
const LIVE_MS = Number.isFinite(liveMsRaw) ? liveMsRaw : 120_000;

/**
 * dsh 的 surface 类型集合，抄自 `dsh-session-format-v3-to-v4/lib/index.js:485`。
 * 那份没有导出，只能抄；抄错也不会写坏东西 —— 写盘前的硬门是 dsh 自己的 `foldSurface`。
 */
const SURFACE_TYPES = new Set(["system/message", "user/message", "developer/message", "assistant/message", "tool/result"]);
/** 注入块降级后的类型：必须**不在** dsh 的已知类型表里，否则不叫 unknown。 */
const RETIRED_TYPE = "plugin:magic-context/session-history-injection";
/** 只认这两个占位文本（实测 19 个坏会话全部恰好是这两条，且都不含任何内容）。 */
const REQUIRED_TEXTS = [
	"<session-history></session-history>",
	"<session-history-since>(no new content since last materialization)</session-history-since>",
];

const DSH = findDshModules();
if (DSH === null) skipWithoutDshModules("fix-surface-head.mjs", "「修完能不能加载」这件事（需要 dsh 自己的加载期校验）");
const { sessionFormatCatalog } = await import(pathToFileURL(path.join(DSH, "dsh-session-format-catalog/lib/index.js")).href);

/** 枚举会话日志。`.tmp` 之类半成品不算（它们不是会话）。 */
function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.startsWith("session.") && entry.name.includes("jsonl") && !entry.name.endsWith(".tmp")) out.push(full);
	}
	return out;
}

/** 用 dsh 自己的加载期校验跑一遍事件数组（含 header）。 */
function validateEvents(events) {
	try {
		const restore = sessionFormatCatalog.createRestore(events[0], { recovery: "recoverable", validation: "current" });
		for (const row of events.slice(1)) restore.decodeRow(row);
		restore.finish();
		return { ok: true };
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
	}
}

// 「有没有进程开着这个文件」用 lib/session-log.js 的 heldOpen()：dsh 那个修复脚本也要用，修在共享处。

/** 事件的 content 数组（畸形就返回 undefined —— 按「读不懂」处理，不抛异常）。 */
function contentOf(event) {
	const content = event?.data?.content ?? event?.data?.message?.content;
	return Array.isArray(content) ? content : undefined;
}

/**
 * 取「那个占位文本」——只有满足下面全部条件才返回，否则 undefined（= 拒修）：
 * `user/message`、content 正好 **1** 块、那块的 type 是 `text`、`text` 是字符串、
 * 且除了 `type`/`text` **没有别的字段**。
 * 苛刻是故意的：多一个 image/工具块也算「这个节点有内容」，摘掉它等于让模型少看到那段。
 */
function soleText(event) {
	if (event?.type !== "user/message") return undefined;
	const content = contentOf(event);
	if (content?.length !== 1) return undefined;
	const block = content[0];
	if (block?.type !== "text" || typeof block.text !== "string") return undefined;
	if (Object.keys(block).some((key) => key !== "type" && key !== "text")) return undefined;
	return block.text.trim();
}

/** 打印用：只给类型和块数，**不打内容、也不打哈希**（正文可能含密钥，哈希能被用来验证猜测）。 */
function describe(event) {
	const blocks = contentOf(event) ?? [];
	return `${event?.type}（${blocks.length} 块）`;
}

/**
 * 走一遍 dsh 的 surface 折叠，一边定位抢先落地的节点，一边把 span / replace 范围重算好。
 *
 * 为什么按**下标**而不是按 seq 大小算：replace 事件会把新节点插在被替换那段的位置上，
 * 于是 surface 里的 seq 不单调（例如 [10, 50, 45]）。只有下标是可靠的。
 *
 * 本地复刻只为「定位与重写」：判定权在 `validateEvents()`（写盘前的硬门），
 * 两边不一致时结果会被拒绝，不会写坏东西。
 * @param {object[]} events 含 header 的完整事件数组
 * @returns {{kind: "ok"} | {kind: "refuse", why: string} | {kind: "repair", events: object[], preHead: number[], spans: number, ranges: number}}
 */
function analyze(events) {
	const surface = [];
	const out = events.slice();
	const preHead = [];
	let head;
	let spans = 0;
	let ranges = 0;
	const removed = new Set();

	for (let i = 1; i < events.length; i += 1) {
		const event = events[i];
		if (!SURFACE_TYPES.has(event?.type)) {
			if (event?.type !== "compaction/prune" && event?.type !== "compaction/summary") continue;
			// span 记录必须逐字等于「当时 surface 上的一段」，所以按下标切、再滤掉不留下的
			const range = event.data?.shadowedRange ?? {};
			const first = surface.indexOf(range.start);
			const last = surface.indexOf(range.end);
			if (first < 0 || last < first) return { kind: "refuse", why: `seq ${event.seq} 的 ${event.type} 范围不在 surface 上` };
			const kept = surface.slice(first, last + 1).filter((seq) => seq !== head && !removed.has(seq));
			if (kept.length === 0) return { kind: "refuse", why: `seq ${event.seq} 的 ${event.type} 会被摘空，交人工判断` };
			if (kept.length !== last - first + 1) {
				out[i] = { ...event, data: { ...event.data, shadowedRange: { start: kept[0], end: kept.at(-1) }, shadowedSeqs: kept } };
				spans += 1;
			}
			continue;
		}

		const op = event.surfaceOp;
		if (op === undefined || op === "append") {
			// 受保护头 = surface 上第一个 system/message（修完之后它就是首节点）
			if (event.type === "system/message" && head === undefined) head = event.seq;
			else if (head === undefined) {
				preHead.push(event.seq);
				removed.add(event.seq);
				out[i] = { ...event, type: RETIRED_TYPE, ignorable: true };
			}
			surface.push(event.seq);
			continue;
		}

		const first = surface.indexOf(op.startSeq);
		const last = surface.indexOf(op.endSeq);
		if (first < 0 || last < first) return { kind: "refuse", why: `seq ${event.seq} 的 replace [${op.startSeq},${op.endSeq}] 不在 surface 上` };
		const span = surface.slice(first, last + 1);
		const kept = span.filter((seq) => seq !== head && !removed.has(seq));
		if (kept.length === 0) return { kind: "refuse", why: `seq ${event.seq} 的 replace 会被摘空` };
		if (kept.length !== span.length) {
			out[i] = { ...event, surfaceOp: { op: "replace", startSeq: kept[0], endSeq: kept.at(-1) } };
			ranges += 1;
		}
		// 受保护头必须留在原处，所以它不能跟着被 splice 掉 —— 否则后面的下标全错位
		surface.splice(first, span.length, ...(span.includes(head) ? [head, event.seq] : [event.seq]));
	}

	if (head === undefined) return { kind: "refuse", why: "surface 上没有 system/message，不是这个 bug，别用本脚本修" };
	if (preHead.length === 0) return { kind: "ok" };

	const bySeq = new Map(events.slice(1).map((event) => [event.seq, event]));
	const texts = preHead.map((seq) => soleText(bySeq.get(seq)));
	// 数量也必须正好：preHead 是 [这两个占位, 别的有内容的节点] 时不能也算「只有它们」
	const exact =
		texts.length === REQUIRED_TEXTS.length &&
		texts.every((text) => text !== undefined) &&
		REQUIRED_TEXTS.every((required) => texts.filter((text) => text === required).length === 1);
	if (!exact) {
		const seen = preHead.map((seq) => describe(bySeq.get(seq))).join(" / ");
		return { kind: "refuse", why: `首节点不是那两个已知空占位块（可能有内容），拒修：${seen}` };
	}
	return { kind: "repair", events: out, preHead, spans, ranges };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const files = walk(root);
const stat = { files: files.length, unreadable: 0, torn: 0, broken: 0, refused: 0, live: 0, fixed: 0 };
// 整批共一个备份目录（含毫秒的目录名会让每个文件各开一个，白造噪音）
const backupDir = FIX ? path.join(path.dirname(root), `sessions-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`) : undefined;

for (const file of files) {
	try {
		const at0 = fs.statSync(file); // 读之前的样子，写之前要复核
		const { events, torn } = readSessionLog(file);
		if (torn) {
			console.log(`⚠ ${file} 尾部有截断的帧 —— 先让 dsh 自己修好，本轮跳过它`);
			stat.torn += 1;
			continue;
		}

		const before = validateEvents(events);
		if (before.ok) continue; // 幂等：已经能加载的文件不碰

		const result = analyze(events);
		stat.broken += 1;
		console.log(`\n✗ ${file}\n    加载不了：${before.error}`);
		if (result.kind === "ok") {
			// 加载不了但首节点没问题 —— 是别的坏法，不归这个脚本管。仍然报出来并计入退出码，
			// 否则「扫出 0 个可修」会被当成「没有坏会话」。
			stat.refused += 1;
			console.log(`    拒修：首节点没问题，是别的坏法（本脚本只修受保护首节点被顶掉这一种）`);
			continue;
		}
		if (result.kind === "refuse") {
			stat.refused += 1;
			console.log(`    拒修：${result.why}`);
			continue;
		}

		// 只打印**已知占位常量**的前 44 字；任何别的形状一律只给类型与块数（正文可能含密钥）
		const labels = result.preHead.map((seq) => {
			const event = events.find((e) => e?.seq === seq);
			const text = soleText(event);
			return text !== undefined && REQUIRED_TEXTS.includes(text) ? JSON.stringify(text.slice(0, 44)) : describe(event);
		});
		console.log(`    抢先落地的表面节点：seq ${result.preHead.join(",")} ← ${labels.join(" / ")}`);
		const after = validateEvents(result.events);
		if (!after.ok) {
			stat.refused += 1;
			console.log(`    拒修：修完仍加载不了，不写盘 —— ${after.error}`);
			continue;
		}
		console.log(`    修：注入块 → ${RETIRED_TYPE}（ignorable，原地保留 seq 与内容）；重算 span ${result.spans} 处、replace ${result.ranges} 处`);

		if (!FIX) continue;
		// —— 三道并发保护：谁都不许和正在写这个文件的 dsh 抢 ——
		const held = heldOpen(file);
		if (!FORCE_LIVE && held === "yes") {
			stat.live += 1;
			console.log(`    ⚠ 有进程正开着这个文件 —— 本轮跳过。先在 GUI 里关掉这个会话 / 退出 dsh，再来 --fix`);
			continue;
		}
		if (held === "unknown") console.log(`    · 无法确认没有别的进程开着它（非 Linux，或有进程看不到）—— 本轮只有「最近没被写过」这一道兜底`);
		if (!FORCE_LIVE && Date.now() - at0.mtimeMs < LIVE_MS) {
			stat.live += 1;
			console.log(`    ⚠ ${Math.round((Date.now() - at0.mtimeMs) / 1000)}s 前还在写 —— 本轮跳过；确认它已经停了再加 --force-live`);
			continue;
		}
		const at1 = fs.statSync(file);
		if (at1.mtimeMs !== at0.mtimeMs || at1.size !== at0.size) {
			stat.live += 1;
			console.log(`    ⚠ 读完之后文件又被写了（mtime/size 变了）—— 放弃本次改写，重跑即可`);
			continue;
		}

		fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
		try {
			// 备份目录可能被别的进程/umask 放宽过 —— 里面是完整会话正文，不能是全局可读
			if ((fs.statSync(backupDir).mode & 0o077) !== 0) fs.chmodSync(backupDir, 0o700);
		} catch {
			// Windows / 特殊挂载上不支持，忽略
		}
		const backup = path.join(backupDir, path.relative(root, file).replace(/[\\/]/g, "__"));
		if (fs.existsSync(backup)) {
			// 同名备份只可能是「上一轮留下的」：与当前文件字节相同就是同一份，可以复用；
			// 不同则是上次写到一半的残片 —— 那它覆盖不回去，必须停下来人工看。
			if (!fs.readFileSync(backup).equals(fs.readFileSync(file))) {
				stat.refused += 1;
				console.log(`    拒修：已存在同名备份且与当前文件不一致（上次可能写了一半）—— ${backup}`);
				continue;
			}
		} else {
			fs.copyFileSync(file, backup);
		}
		try {
			fs.chmodSync(backup, 0o600);
		} catch {
			// Windows / 特殊挂载上不支持，忽略
		}
		// 写失败不需要回滚：writeSessionLog 是「临时文件 + rename」，抛错时原文件还没被碰过。
		// （在这里 copyFileSync 回滚反而会把完好的原文件非原子地重写一遍。）
		// expect：CAS 复核落在 rename 上一行，把「读完之后又被写」的窗口压到微秒级。
		writeSessionLog(file, result.events, { expect: { mtimeMs: at0.mtimeMs, size: at0.size, ino: at0.ino } });
		const reread = validateEvents(readSessionLog(file).events);
		if (!reread.ok) throw new Error(`${file} 写盘后校验失败：${reread.error}\n备份在 ${backup}，可直接覆盖回去`);
		stat.fixed += 1;
		console.log(`    已修，备份：${backup}`);
	} catch (error) {
		stat.unreadable += 1;
		console.log(`\n✗ ${file}\n    跳过：${error?.message ?? error}`);
	}
}

console.log(`\n=== 汇总（${root}）===`);
console.log(`会话文件：${stat.files}　加载不了：${stat.broken}　已修：${stat.fixed}　拒修：${stat.refused}　因并发跳过：${stat.live}　读不出/尾部截断：${stat.unreadable + stat.torn}`);
if (FIX && stat.fixed > 0) console.log(`备份：${backupDir}`);
if (FIX) console.log(`用 node scripts/verify-sessions.mjs 复验（走 dsh 真实的 cold-read 路径）。`);
else console.log(`\n只扫描。加 --fix 就地修（备份写到会话目录外）。`);
// 自洽：broken = fixed + live + refused + pending。读不出/尾部截断的文件不算「干净」——
// 扫描时若把它当 0 退出，就等于把「坏帧/坏 JSON 的会话」静默报成没问题。
const pending = stat.broken - stat.fixed - stat.live - stat.refused;
const unread = stat.unreadable + stat.torn;
let exitCode = 0;
if (FIX) {
	// 因并发跳过的会话也是「没修完」—— 没显式 --force-live 时就算进去（否则整批被跳过也退 0）
	if (pending + stat.refused + unread + (FORCE_LIVE ? 0 : stat.live) > 0) exitCode = 1;
} else if (stat.broken - stat.refused > 0 || unread > 0) {
	exitCode = 1;
}
process.exit(exitCode);
