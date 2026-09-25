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

/** 一行 JSON → 事件；失败时报出发生在哪一行，不静默跳过。 */
function parseLine(line, where) {
	try {
		return JSON.parse(line);
	} catch (error) {
		throw new Error(`${where}: JSON 解析失败：${error?.message ?? error}\n  ${line.slice(0, 120)}`, { cause: error });
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

/** 一事件一帧写回（dsh 的 compressZstdFrame 也是每帧独立可解 + 带校验和）。 */
export function writeSessionLog(file, events) {
	const payload = file.endsWith(".zstd")
		? Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, "utf8"))))
		: Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	fs.writeFileSync(file, payload);
}
