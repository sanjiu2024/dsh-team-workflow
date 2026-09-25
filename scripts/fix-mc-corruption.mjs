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
import { readSessionLog, writeSessionLog } from "../lib/session-log.js";

const ROLES = { "system/message": "system", "user/message": "user", "assistant/message": "assistant", "tool/result": "user" };
const FIX = process.argv.includes("--fix");
const root = process.env.DSH_SESSIONS_DIR ?? path.join(os.homedir(), ".dsh", "sessions");

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.startsWith("session.") && e.name.includes("jsonl")) out.push(p);
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
let fixedEvents = 0;
// 整批共一个备份目录（含毫秒的目录名会让每个文件各开一个，白造噪音）
const backupDir = FIX ? path.join(path.dirname(root), `sessions-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`) : undefined;

for (const file of files) {
	let events;
	let torn;
	try {
		({ events, torn } = readSessionLog(file));
	} catch (error) {
		console.log(`\n✗ ${file}\n    读不出来：${error?.message ?? error}`);
		damagedFiles++;
		continue;
	}
	if (torn) console.log(`⚠ ${file} 尾部有截断的帧（dsh 会自己修复；本脚本原样保留）`);

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
		// 备份放到会话目录**外**：文件名仍以 `session.` 开头，留在原目录会被 dsh 的
		// 会话枚举当成第二个会话扫出来（也可能被下次 fixer 重跑再改一遍）。
		fs.mkdirSync(backupDir, { recursive: true });
		const backup = path.join(backupDir, `${path.basename(path.dirname(file))}__${path.basename(file)}`);
		fs.copyFileSync(file, backup);
		writeSessionLog(file, events);
		console.log(`    已修，备份：${backup}`);
	}
}

console.log(`\n=== 汇总 ===`);
console.log(`受损会话：${damagedFiles} / ${files.length}`);
console.log(`受损事件：${fixedEvents}`);
console.log(FIX ? `\n已就地修复。备份：${backupDir}\n用 node scripts/verify-sessions.mjs 复验（它直接走 dsh 的加载路径）。` : "\n只扫描。加 --fix 就地修（备份写到会话目录外）。");

process.exit(damagedFiles > 0 && !FIX ? 1 : 0);
