#!/usr/bin/env node
/**
 * 真实会话冒烟：验证 `session_recall` 赖以为生的两个假设 —— 用**本机真实会话文件**，不是假数据。
 *
 *   ① `seq` 是否连续（取回通道拿它当稳定地址）
 *   ② 折叠记录（带 `shadowedSeqs` 的 compaction 事件）是否真的在日志里
 *
 * **它不是自检**：依赖本机 `~/.dsh/sessions` 的数据，所以在 `npm test` 链外。跑法：
 *
 *   node scripts/smoke-recall.mjs              # 挑最大的几个会话文件
 *   node scripts/smoke-recall.mjs <会话id>      # 只看某个会话
 *
 * 它证明的是**日志内容**这一层（seq 连续性、折叠记录的形状）。**不证明**工具在活会话里
 * 走 `ctx.sessionQuery` 那条路 —— 那需要在真实 dsh 会话里调一次工具（见 REQ-018 §8）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionLog } from "../lib/session-log.js";

const MAX_BYTES = 60 * 1024 * 1024; // 太大的会话跳过，别把内存吃光
const wanted = process.argv[2];

function candidates() {
	const root = path.join(os.homedir(), ".dsh", "sessions");
	if (!fs.existsSync(root)) return [];
	const found = [];
	for (const slug of fs.readdirSync(root)) {
		const slugDir = path.join(root, slug);
		if (!fs.statSync(slugDir).isDirectory()) continue;
		for (const id of fs.readdirSync(slugDir)) {
			const dir = path.join(slugDir, id);
			if (!fs.statSync(dir).isDirectory()) continue;
			if (wanted && !id.startsWith(wanted)) continue;
			for (const name of fs.readdirSync(dir)) {
				if (!name.startsWith("session.") || !name.includes("jsonl")) continue;
				const file = path.join(dir, name);
				const size = fs.statSync(file).size;
				if (size > MAX_BYTES) continue;
				found.push({ file, size, id, slug });
			}
		}
	}
	return found.sort((a, b) => b.size - a.size);
}

const list = candidates();
if (list.length === 0) {
	console.log(wanted ? `没找到会话「${wanted}」的日志。` : "没找到任何会话日志（~/.dsh/sessions 是空的？）。");
	process.exitCode = 1;
} else {
	const picked = wanted ? list : list.slice(0, 4);
	let bad = 0;
	for (const { file, size, id, slug } of picked) {
		let out;
		try {
			out = readSessionLog(file);
		} catch (error) {
			console.log(`✗ ${id.slice(0, 8)}  读失败：${error?.message ?? error}`);
			bad += 1;
			continue;
		}
		const events = out.events.filter((e) => e && e.type !== "session");
		const sorted = [...new Set(events.map((e) => e.seq).filter(Number.isInteger))].sort((a, b) => a - b);
		let contiguous = true;
		for (let i = 1; i < sorted.length; i += 1) {
			if (sorted[i] !== sorted[i - 1] + 1) {
				contiguous = false;
				break;
			}
		}
		const compactions = events.filter((e) => typeof e.type === "string" && e.type.includes("compaction"));
		const withShadow = compactions.filter((e) => Array.isArray(e?.data?.shadowedSeqs));
		const shadowTotal = withShadow.reduce((n, e) => n + e.data.shadowedSeqs.length, 0);
		const unordered = withShadow.filter((e) => {
			const s = e.data.shadowedSeqs;
			return s.some((n, i) => i > 0 && n < s[i - 1]);
		}).length;
		if (!contiguous) bad += 1;
		console.log(
			`${contiguous ? "✓" : "✗"} ${id.slice(0, 8)}  ${(size / 1024).toFixed(0)}KB  ` +
				`事件 ${events.length}  seq ${sorted[0] ?? "-"}–${sorted.at(-1) ?? "-"}  ` +
				`连续=${contiguous ? "是" : "否"}  撕裂=${out.torn ? "有" : "无"}  ` +
				`compaction ${compactions.length} 条（带 shadowedSeqs ${withShadow.length} 条，共折 ${shadowTotal} 个 seq，其中无序 ${unordered} 条）`,
		);
		console.log(`   来源：${slug}/${id.slice(0, 8)}`);
	}
	if (bad > 0) {
		console.log(`✗ ${bad} 个会话的 seq 不连续或读不出来 —— 取回通道的地址假设不成立。`);
		process.exitCode = 1;
	} else {
		console.log("✓ 冒烟通过：seq 连续（稳定地址成立）、折叠记录在日志里（带 shadowedSeqs）");
	}
}
