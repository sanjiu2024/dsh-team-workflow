#!/usr/bin/env node
/**
 * 真实数据冒烟：拿**真实会话日志**里的消息喂给确定性折叠，看产物大小、确定性、以及 ② 能不能解析。
 *
 * 为什么单独一个脚本、不进 `npm test`：它依赖本机会话日志（环境相关），跑起来也不快；
 * 自检里用的是构造输入。这个脚本回答的是**算法在真数据上像不像话**。
 *
 *   node scripts/smoke-fold.mjs [会话id]        # 不给就用最近一个有日志的会话
 *
 * 事件 → 模型侧消息的投影**照宿主规则**（`dsh-session/lib/types/surface.js:75-105`）：
 * `user/message → data`、`tool/result → data.message`、`assistant/message → data.message`。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseCheckpoint } from "../lib/context-filter.js";
import { contentText, foldMessages } from "../lib/fold-core.js";
import { readSessionLog } from "../lib/session-log.js";

const SESSIONS = join(homedir(), ".dsh", "sessions");

function findLogs() {
	const out = [];
	if (!existsSync(SESSIONS)) return out;
	for (const slug of readdirSync(SESSIONS)) {
		const dir = join(SESSIONS, slug);
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const id of entries) {
			const file = join(dir, id, "session.v4.jsonl.zstd");
			if (existsSync(file)) out.push({ id, file, mtime: statSync(file).mtimeMs });
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** 照宿主投影规则把事件变成模型侧消息（只处理三种会产出消息的类型）。 */
function project(event) {
	if (event?.type === "user/message") return event.data;
	if (event?.type === "tool/result") return event.data?.message ?? null;
	if (event?.type === "assistant/message") return event.data?.message ?? null;
	return null;
}

const wanted = process.argv[2];
const logs = findLogs();
const target = wanted ? logs.find((l) => l.id.startsWith(wanted)) : logs[0];
if (!target) {
	console.error("没找到会话日志（~/.dsh/sessions/*/*/session.v4.jsonl.zstd）");
	process.exitCode = 1;
} else {
	const { events, torn } = readSessionLog(target.file);
	console.log(`会话 ${target.id}：${events.length} 条事件${torn ? "（日志尾部有撕裂）" : ""}`);

	// 取一段「像被压缩区间」的消息：跳过开头的 checkpoint，取最后 120 条消息
	const messages = events.map(project).filter(Boolean);
	const window = messages.slice(-120);
	const inputChars = window.reduce((n, m) => n + contentText(m).length, 0);

	const first = foldMessages(window);
	const second = foldMessages(window);
	console.log(`输入：${window.length} 条消息 / ${inputChars} 字符`);
	console.log(`产物：${first.text.length} 字符（${((first.text.length / Math.max(1, inputChars)) * 100).toFixed(1)}% 留存）`);
	console.log(`统计：保留 ${first.stats.keptChars} / 丢弃 ${first.stats.droppedChars} / 裁剪 ${first.stats.truncated} 处`);
	console.log(`确定性：两次产物${first.text === second.text ? "逐字节相同 ✓" : "不同 ✗"}`);
	const wrapped = `前言\n\n<compacted-summary>\n${first.text}\n</compacted-summary>\n\n后语`;
	const parsed = parseCheckpoint(wrapped);
	const entries = parsed ? parsed.blocks.filter((b) => b.kind === "entry").length : 0;
	console.log(`② 可解析的条目数：${entries}`);
	console.log(`是否比输入小：${first.text.length < inputChars ? "是 ✓" : "否 ✗"}`);
	console.log("\n--- 产物开头 600 字符 ---");
	console.log(first.text.slice(0, 600));
	if (first.text.length < inputChars && first.text === second.text && entries > 0) {
		console.log("\n✓ 冒烟通过");
	} else {
		console.error("\n✗ 冒烟未通过（见上面几行）");
		process.exitCode = 1;
	}
}
