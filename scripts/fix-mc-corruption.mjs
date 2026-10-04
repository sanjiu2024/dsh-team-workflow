#!/usr/bin/env node
/**
 * 修复插件写坏的会话日志，让被打开的会话能重新加载（见 docs/HANDOFF-10）。
 *
 * 两类损坏，都只在**重载**时才被 dsh 校验发现（append 时不校验）：
 *   1. `role` 不对：`user/message` 的 data **就是** Message，加载期要求 role 逐字
 *      是 "user"（`assertMessageEventShape`）。`lib/mc.js` 把 bundle 返回的
 *      assistant 副本原样写了进去（158 处）。
 *   2. `id` 缺失：加载期要求 id 是非空字符串（`lacks an identified message`）。
 *      `lib/lens.js` 的 additionalContexts 构造 message 时漏了（12 处）。
 *
 * 两个根因都已在源码里修掉，新事件不会再坏。
 *
 * 修法只有一种：**只补/只改这两个字段，其他一律不动**。
 *   · 摘掉 surfaceOp 不行 —— surface-eligible 类型必须带标记，否则抛
 *     `requires a surfaceOp marker`。
 *   · 自替换不行 —— replace 的 startSeq/endSeq 必须 < 自身 seq。
 * 代价：role 被改的那批会作为「多出来的用户消息」留在 surface 上（内容上接近
 * 已有的 assistant 消息，是 bundle 重排的产物），多占一点 token。
 *
 *   node scripts/fix-mc-corruption.mjs          # 只扫，报出来（有损坏则退出码 1）
 *   node scripts/fix-mc-corruption.mjs --fix    # 备份后原地修（备份写到会话目录外）
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { heldOpen, readSessionLog, writeSessionLog } from "../lib/session-log.js";

const ROLES = { "system/message": "system", "user/message": "user", "assistant/message": "assistant", "tool/result": "user" };
const FIX = process.argv.includes("--fix");
const FORCE_LIVE = process.argv.includes("--force-live");
/** 去掉尾斜杠：`dirname(root)` 是备份要落的目录，带尾斜杠会落回会话目录里。 */
const root = path.resolve(process.env.DSH_SESSIONS_DIR ?? path.join(os.homedir(), ".dsh", "sessions"));
/** 最近改过的文件默认跳过（dsh 的空闲会话也可能还开着 fd）。 */
const liveMsRaw = Number(process.env.DSH_LIVE_MS ?? 120_000);
// NaN 会让 `Date.now() - mtime < LIVE_MS` 恒 false —— 主判据静默失效，所以必须回落
const LIVE_MS = Number.isFinite(liveMsRaw) ? liveMsRaw : 120_000;

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.startsWith("session.") && e.name.includes("jsonl") && !e.name.endsWith(".tmp")) out.push(p);
	}
	return out;
}

/** 找出一个事件里的损坏；没有返回 null。 */
function inspect(event) {
	const expected = ROLES[event?.type];
	if (!expected) return null;
	const message = event.type === "user/message" ? event.data : event.data?.message;
	if (!message || typeof message !== "object") return null;
	const roleBad = message.role !== expected;
	const idBad = typeof message.id !== "string" || message.id === "";
	if (!roleBad && !idBad) return null;
	return { message, roleBad, idBad, was: message.role };
}

const files = walk(root);
let damagedFiles = 0;
let fixedFiles = 0;
let skippedLive = 0;
let fixedEvents = 0;
// 整批共一个备份目录（含毫秒的目录名会让每个文件各开一个，白造噪音）
const backupDir = FIX ? path.join(path.dirname(root), `sessions-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`) : undefined;

for (const file of files) {
	let events;
	let torn;
	let at0;
	try {
		at0 = fs.statSync(file); // 读之前的样子，写之前要复核（按住下面那道并发判据）
		({ events, torn } = readSessionLog(file));
	} catch (error) {
		console.log(`\n✗ ${file}\n    读不出来：${error?.message ?? error}`);
		damagedFiles++;
		continue;
	}
	if (torn) {
		// 尾部有残帧时不能整文件重写：那半帧会被永久丢掉。等 dsh 自己把它收干净再修。
		console.log(`⚠ ${file} 尾部有截断的帧 —— 只报告不改（等 dsh 自己收干净，或先把文件修完整）`);
		if (FIX) {
			damagedFiles++;
			continue;
		}
	}

	const bad = [];
	for (const event of events) {
		const found = inspect(event);
		if (found) bad.push([event, found]);
	}
	if (bad.length === 0) continue;
	damagedFiles++;
	console.log(`\n✗ ${file}`);
	for (const [event, found] of bad) {
		if (found.idBad) found.message.id = `recovered-${event.seq}-${randomUUID().slice(0, 8)}`;
		if (found.roleBad) found.message.role = ROLES[event.type];
		fixedEvents++;
		const what = [found.roleBad ? `role "${found.was}" → "${ROLES[event.type]}"` : null, found.idBad ? "补上缺失的 id" : null].filter(Boolean).join(" + ");
		console.log(`    seq ${event.seq}：${what}（来源 plugin=${found.message.source?.plugin ?? "-"}）`);
	}
	console.log(`    共 ${bad.length} 处`);

	if (FIX) {
		// 正在被 dsh 追加的会话不能重写：writeSessionLog 是 rename 替换 inode，
		// dsh 那批事件会写进已 unlink 的旧 inode —— 静默丢事件。宁可这轮不修。
		if (!FORCE_LIVE && (heldOpen(file) === "yes" || Date.now() - at0.mtimeMs < LIVE_MS)) {
			skippedLive++;
			console.log(`    ⚠ 这个会话可能正被 dsh 写着 —— 本轮跳过，确认停掉再加 --force-live`);
			continue;
		}
		const at1 = fs.statSync(file);
		if (at1.mtimeMs !== at0.mtimeMs || at1.size !== at0.size) {
			skippedLive++;
			console.log(`    ⚠ 读完之后文件又被写了 —— 放弃本次改写，重跑即可`);
			continue;
		}
		// 备份放到会话目录**外**：文件名仍以 `session.` 开头，留在原目录会被 dsh 的
		// 会话枚举当成第二个会话扫出来（也可能被下次 fixer 重跑再改一遍）。
		fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
		try {
			// 备份目录里是完整会话正文，别让 umask 或别的进程把它放宽成全局可读
			if ((fs.statSync(backupDir).mode & 0o077) !== 0) fs.chmodSync(backupDir, 0o700);
		} catch {
			// Windows / 特殊挂载上不支持，忽略
		}
		// 用相对路径做备份名：不同项目目录下同名会话不会互相覆盖
		const backup = path.join(backupDir, path.relative(root, file).replace(/[\\/]/g, "__"));
		if (fs.existsSync(backup) && !fs.readFileSync(backup).equals(fs.readFileSync(file))) {
			skippedLive++;
			console.log(`    ⚠ 已存在同名备份且与当前文件不一致（上次可能写了一半）—— 跳过：${backup}`);
			continue;
		}
		if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
		try {
			fs.chmodSync(backup, 0o600);
		} catch {
			// 同上，忽略
		}
		// expect：CAS 复核落在 rename 上一行，防「读完之后又被写」
		writeSessionLog(file, events, { expect: { mtimeMs: at0.mtimeMs, size: at0.size, ino: at0.ino } });
		// 写后复验：不然「已修」只是一句话（校验和坏帧会被 readSessionLog 报出来）
		const back = readSessionLog(file);
		if (back.events.some((event) => inspect(event))) throw new Error(`写盘后仍有损坏：${file}（备份在 ${backup}，可直接覆盖回去）`);
		fixedFiles++;
		console.log(`    已修，备份：${backup}`);
	}
}

console.log(`\n=== 汇总 ===`);
console.log(`会话文件：${files.length}　受损会话：${damagedFiles}　已修：${fixedFiles}　因并发跳过：${skippedLive}`);
console.log(`受损事件：${fixedEvents}`);
if (!FIX && damagedFiles > 0) console.log(`\n只扫描。加 --fix 就地修（备份写到会话目录外）。`);
else if (FIX) console.log(`备份：${backupDir}\n用 node scripts/verify-sessions.mjs 复验（它直接走 dsh 的加载路径）。`);
// 没修完就退非 0：跳过的会话也是「还没修」，不能报成干净
let exitCode = 0;
if (FIX ? damagedFiles - fixedFiles > 0 : damagedFiles > 0) exitCode = 1;
process.exit(exitCode);
