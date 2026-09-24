/**
 * 上下文节流：实时统计 + 配置 overlay。
 *
 * pi 版 context-thrift 是个消息重写器（在 LLM 调用前裁掉旧推理、精简工具声明、
 * stub 掉旧工具输出）。dsh 里**做不了重写** —— `llm/stream` 拿到的是深冻结的请求，
 * 只能替换回调结果、不能改 options；`tools/pre-execute` 的参数也是深冻结的。
 *
 * 所以这里做的是 dsh 自己那套的原生替代：
 *   - 压缩      → `@deepseek-ai/dsh-compaction-basic`（阈值/保留）
 *   - 工具输出  → `@deepseek-ai/dsh-compaction-tool-result-pruner`（按字符数裁剪）
 *   - 统计      → 本文件，订阅 `session/event` 累计真实用量
 *
 * 这两者的配置在**插件加载期**固定，运行期改不了。所以 `/thrift compact|prune`
 * 只写一份 overlay 配置，交给 `dsh-team thrift apply` 写进 profile patch，
 * 重启后生效。命令里会明说这一点，不假装立即生效。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { dshHome, readJsonConfig } from "./util.js";

export const THRIFT_DEFAULTS = {
	enabled: true,
	compactThresholdRatio: 0.8,
	pruneThresholdChars: 20000,
	pruneHeadChars: 4000,
	pruneTailChars: 2000,
};

export const THRIFT_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	compactThresholdRatio: (v) =>
		typeof v === "number" && v > 0 && v <= 1 ? v : undefined,
	pruneThresholdChars: (v) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined),
	pruneHeadChars: (v) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined),
	pruneTailChars: (v) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined),
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function installThrift(ctx, options) {
	const overlayFile = path.join(dshHome(), "team-workflow", "thrift.json");
	const pkgDefaults = { ...THRIFT_DEFAULTS, ...options.defaults };
	const config = readJsonConfig(overlayFile, pkgDefaults, THRIFT_FIELDS, (msg, quiet) => {
		if (!quiet) ctx.logger.warn(`[team:thrift] ${msg}`);
	});

	const stats = {
		promptTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		peakPromptTokens: 0,
		prunes: 0,
		prunedTokens: 0,
		compactions: 0,
	};

	const dispose = ctx.on("session/event", (session, event) => {
		try {
			if (!config.enabled) return;
			// dsh 事件：payload 全在 event.data 下
			const d = event.data ?? {};
			if (event.type === "assistant/message") {
				const usage = d.usage;
				if (!usage) return;
				// dsh 的计数互斥：计费输入 = input + cacheRead + cacheWrite
				const prompt = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
				stats.promptTokens += prompt;
				stats.cacheReadTokens += num(usage.cacheReadTokens);
				stats.cacheWriteTokens += num(usage.cacheWriteTokens);
				stats.outputTokens += num(usage.outputTokens);
				stats.reasoningTokens += num(usage.reasoningTokens);
				if (prompt > stats.peakPromptTokens) stats.peakPromptTokens = prompt;
			} else if (event.type === "compaction/prune") {
				stats.prunes += 1;
				stats.prunedTokens += num(d.shadowedTokenCount);
			} else if (event.type === "compaction/summary") {
				stats.compactions += 1;
			}
		} catch (err) {
			ctx.logger.warn(`[team:thrift] 统计失败：${err?.message ?? err}`);
		}
	});

	function describe() {
		return [
			"上下文节流（team-workflow）",
			`  本会话累计 prompt：${stats.promptTokens} tokens（缓存命中 ${stats.cacheReadTokens}）`,
			`  单次峰值 prompt：${stats.peakPromptTokens} tokens`,
			`  模型输出：${stats.outputTokens} tokens（推理 ${stats.reasoningTokens}）`,
			`  压缩 ${stats.compactions} 次，工具输出裁剪 ${stats.prunes} 次（省 ${stats.prunedTokens} tokens）`,
			"",
			"  生效配置（加载期固定）",
			`    compaction 阈值比：${config.compactThresholdRatio}`,
			`    pruner 阈值/头/尾：${config.pruneThresholdChars} / ${config.pruneHeadChars} / ${config.pruneTailChars} 字符`,
			`  overlay：${overlayFile}`,
			"",
			"  改 overlay 后需 `dsh-team thrift apply --profile <名>` 写进 profile 并重启 dsh。",
			"  实时压缩由 dsh 自带的 compaction / pruner 插件执行，本插件不重写消息。",
		].join("\n");
	}

	/** 写 overlay；不会被运行期的加载配置同步，所以明确提示需要重启 */
	function set(verb, value) {
		const next = readOverlay(overlayFile);
		if (verb === "compact") next.compactThresholdRatio = value;
		else next.pruneThresholdChars = value;
		fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
		fs.writeFileSync(overlayFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		if (verb === "compact") config.compactThresholdRatio = value;
		else config.pruneThresholdChars = value;
	}

	function summary() {
		return `峰值 prompt ${stats.peakPromptTokens} tokens，压缩 ${stats.compactions} 次，裁剪 ${stats.prunes} 次`;
	}

	return {
		dispose,
		describe,
		set,
		summary,
		config,
		stats,
		overlayFile,
	};
}

/** 读 overlay 原始对象，缺文件/坏 JSON 就当空 */
function readOverlay(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}
