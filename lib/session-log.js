#!/usr/bin/env node
/**
 * 按 dsh 自己的方式读多帧 zstd 会话日志。
 *
 * 关键：**不能靠搜 magic 字节切帧** —— 压缩数据里偶然出现 `28 B5 2F FD` 就会
 * 切错（实测把一行 JSON 劈成 `"9"` `"1"` 这类碎片）。dsh 自己用的是结构化扫帧：
 * 解析帧头（magic/descriptor/contentSize/dictID）再逐块跳（blockHeader + payload），
 * 见 `dsh-session-persistence-jsonl/lib/index.js` 的 `scanZstdFrames`。
 *
 * 这里复刻那个算法（它没导出）。这是 fix/verify 脚本的共同依赖。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528; // 小端读出来的值

/**
 * 找出所有完整帧的字节范围。
 * @param {Buffer} buffer
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/** 一行 JSON → 事件；失败时报出发生在哪一行，不静默跳过。**不打行内容**（可能是会话正文）。 */
function parseLine(line, where) {
	try {
		return JSON.parse(line);
	} catch (error) {
		throw new Error(`${where}: JSON 解析失败（该行 ${line.length} 字符，内容不打印）：${error?.message ?? error}`, { cause: error });
	}
}

/**
 * 读一个会话日志文件 → 逐事件对象。
 * @param {string} file
 * @returns {{events: object[], torn: boolean}}
 */
export function readSessionLog(file) {
	const buffer = fs.readFileSync(file);
	if (!file.endsWith(".zstd")) {
		const lines = buffer.toString("utf8").split("\n").filter(Boolean);
		return { events: lines.map((line, i) => parseLine(line, `${file} 第 ${i + 1} 行`)), torn: false };
	}
	const { frames, tornStart } = scanZstdFrames(buffer);
	const events = [];
	for (const [index, frame] of frames.entries()) {
		const text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
		for (const [offset, line] of text.split("\n").filter(Boolean).entries()) {
			events.push(parseLine(line, `${file} 帧 ${index}（字节 ${frame.start}）第 ${offset + 1} 行`));
		}
	}
	return { events, torn: tornStart !== undefined };
}

/**
 * 一事件一帧写回（dsh 的 compressZstdFrame 也是每帧独立可解 + 带校验和）。
 * @param {string} file
 * @param {object[]} events
 * @param {{expect?: {mtimeMs: number, size: number, ino: number}}} [options]
 *   `expect`：调用方读文件时记下的 stat。有它就在 `rename` 的**上一行**再核对一次 ——
 *   读完之后别的进程又写了就抛错（此时临时文件会被删掉，原文件一个字节都没动）。
 *   这是防「和正在 append 的 dsh 抢文件」的最后一米：备份拷贝 + 重压缩 + fsync 那段
 *   可能要上百毫秒，光靠调用方的第一道复核不够。
 */
export function writeSessionLog(file, events, { expect } = {}) {
	const payload = file.endsWith(".zstd")
		? Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, "utf8"))))
		: Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	// 原子替换：直接截断重写的话，中途被杀/写满会留下半截日志（那才是真的没救了）。
	// 临时名不能以 `session.` 开头 —— 会话目录里那种名字会被枚举成第二个会话。
	// 同目录 → rename 是原子的；权限沿用原文件的（`statSync().mode` 含文件类型位，要掩掉）。
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	let mode;
	try {
		mode = fs.statSync(file).mode & 0o777;
	} catch {
		mode = undefined;
	}
	try {
		const fd = fs.openSync(tmp, "w", mode);
		try {
			fs.writeFileSync(fd, payload);
			fs.fsyncSync(fd); // 先落盘再 rename —— 否则断电可能 rename 出一个 0 字节文件
		} finally {
			fs.closeSync(fd);
		}
		// 最后一米：从「读文件」到这一刻之间可能过了几百毫秒（备份 + 重压缩 + fsync），
		// 期间 dsh 要是又 append 了一批，我们就该放手而不是覆盖 —— 那批会写进已被换掉的旧 inode。
		if (expect) {
			const now = fs.statSync(file);
			if (now.mtimeMs !== expect.mtimeMs || now.size !== expect.size || now.ino !== expect.ino) {
				throw new Error("会话在写盘前被改过（mtime/size/inode 变了）—— 放弃本次改写，重跑即可");
			}
		}
		fs.renameSync(tmp, file);
		// 目录项本身也要落盘，不然 rename 可能还没生效就断电
		try {
			const dir = fs.openSync(path.dirname(file), "r");
			try {
				fs.fsyncSync(dir);
			} finally {
				fs.closeSync(dir);
			}
		} catch {
			// 有些平台/挂载不支持 fsync 目录，忽略
		}
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// 临时文件删不掉不改变结论
		}
		throw error;
	}
}

/**
 * 有进程正开着这个文件吗？`"yes"` / `"no"` / `"unknown"`（判不了，例如非 Linux）。
 *
 * 比 dev/ino 而不是路径字符串：硬链接、`/proc` 里的别名都能对上。
 * 但**别把它当排他锁**：dsh 是「每批 append 开一次 fd、写完就关」
 * （`dsh-session-persistence-jsonl` 的 append 路径），这里多半抓不到它 ——
 * 真正承重的判据是「这个文件最近没被写过」（调用方自己比 mtime/size）。
 */
export function heldOpen(file) {
	if (process.platform !== "linux") return "unknown";
	let target;
	try {
		target = fs.statSync(file);
	} catch {
		return "unknown";
	}
	let pids;
	try {
		pids = fs.readdirSync("/proc");
	} catch {
		return "unknown";
	}
	let unknown = false;
	for (const pid of pids) {
		if (!/^\d+$/.test(pid)) continue;
		let fds;
		try {
			fds = fs.readdirSync(`/proc/${pid}/fd`);
		} catch {
			// 别人的进程（EACCES）看不到，或它刚好退出（ESRCH）
			if (fs.existsSync(`/proc/${pid}`)) unknown = true;
			continue;
		}
		for (const fd of fds) {
			try {
				const at = fs.statSync(`/proc/${pid}/fd/${fd}`);
				if (at.dev === target.dev && at.ino === target.ino) return "yes";
			} catch {
				// fd 正好在这一刻关了 —— 跳过就好
			}
		}
	}
	return unknown ? "unknown" : "no";
}
