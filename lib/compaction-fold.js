#!/usr/bin/env node
/**
 * 确定性折叠后端（REQ-018 的 ①）：**不调 LLM** 的压缩后端。
 *
 * ## 缝：子类化 `BasicCompactionEngine`，只覆写 `summarize()`
 *
 * 不直接继承 `CompactionEngine` —— 自动触发（`agent/pre-step` 压力 + `agent/request-error`
 * overflow）、压力判定、**事务骨架**（锁 / stability 断言 / start→summary→replace→end）、
 * token 计量、以及那几条不变量校验**全在 basic 里**，基类零提供（侦察结论，见 REQ-018 §6）。
 * 覆写 `summarize()` 之后**唯一变化的只有摘要内容**，其余全部继承 —— 风险面最小的那条路。
 *
 * `summarize` 是 basic 唯一的子类定制钩子（`dsh-compaction-basic/lib/index.js:796` 的注释
 * 自己这么写），经 `dependencies.summarize`（:1016）调回 `this.summarize`（:587）。
 *
 * ## 返回值为什么长这样
 *
 * `SummaryResult` 是个交叉类型：要么带 `rawOutput` + `llmStreamCall: true`（真的走了一次
 * `ctx.llm.stream()`），要么**都不带**（"an unmarked template, remote, or other summarizer"）。
 * 折叠不属于前者 —— 一次模型调用都没有 —— 所以走未标记那一支：`{ summary, provider: "", model: "" }`。
 * 空 provider/model 合法（`dsh-compaction-basic/lib/index.js:205` 只要求成对空或成对非空）。
 *
 * ## 为什么必须异步取基类
 *
 * 本包以 symlink 装在 profile 下，realpath 是仓库自己 —— `import "@deepseek-ai/dsh-compaction-basic"`
 * 会从仓库往上找 `node_modules`，找不到。所以走 `lib/dsh-exports.js` 的宿主加载器
 * （`ctx.loader.import`，由 profile 解析）。**cordis 会 await 异步插件**（`ctx.plugin()` 返回
 * thenable，2026-10-16 用 cordis 本体实测过），所以 async `apply` 里注册服务是安全的，
 * 启动完成时服务一定已经在。
 */
import { makeHostLoader } from "./dsh-exports.js";
import { FOLD_TARGET_RATIO, contentText, foldMessages } from "./fold-core.js";

/**
 * framing 的固定开销（token）：前言 + `<compacted-summary>` 标签。
 *
 * **实测**（2026-10-16，拿本机三个真实 checkpoint 用宿主自己的 `estimateMessage` 量的）：
 * 恒为 **85 tokens**，与正文长度无关 —— 占正文的 4.5% / 3.8% / 1.9%。
 * 为什么必须显式算它：basic 的闸比的是 **framing 之后**的估值，而这里算的是正文。
 * 常规区间（几千 token）上那 85 可以忽略；**极小区间**上不行 —— 正文 200 tokens 时它占 42%，
 * 于是 0.6×200 + 85 = 205 ≥ 200，**闸会 throw，整次压缩失败**。
 */
export const FRAME_OVERHEAD_TOKENS = 85;

/**
 * 折叠产物必须比被压内容小到这个程度。
 *
 * 为什么不是「只要小于 1 就行」：basic 的闸比的是 **framing 之后**的估值，而这里算的是摘要正文，
 * 中间差一个固定开销 —— 见下面的 `FRAME_OVERHEAD_TOKENS`（**实测 85 token**，不是估的）。
 * 小区间上那 85 能占几十个百分点：正文压到 0.6、到闸那儿可能就成了 1.2，**它会 throw，
 * 整次压缩失败**。留 40% 余量买的是这个。
 */
export const SAFE_RATIO = 0.6;

/** 插件名（团队预设里 compaction 那一行的 `name` 指过来）。 */
export const name = "compaction-fold";

/**
 * 依赖：basic 那一套（骨架与计量）+ **`loader`**。
 *
 * `loader` 是这条路上最容易漏的一个：cordis 的 ctx 是访问器代理，**没 inject 的服务读一下就抛**
 * （`cannot get property "loader" without inject`），不是返回 undefined。而基类只能靠
 * `ctx.loader.import` 异步取（本包 symlink 在 profile 下、realpath 解析不到 `@deepseek-ai/*`）——
 * 漏了它，插件在真实宿主里**一加载就抛**，而假 ctx 把 loader 当普通属性给了，套件全绿。
 * 2026-10-16 集成冒烟（`scripts/smoke-fold-host.mjs`，真基类 + 真 cordis）逮到的。
 */
export const inject = ["loader", "llm", "tokenMeter", "sessions"];

/** 用宿主的计量器估一串模型侧消息的 token（与 basic 的尺寸闸同一把尺）。 */
export function estimateMessages(meter, messages) {
	if (typeof meter?.estimateMessage !== "function") return undefined;
	let total = 0;
	for (const message of messages) {
		const tokens = meter.estimateMessage(message);
		if (typeof tokens === "number" && Number.isFinite(tokens)) total += tokens;
	}
	return total;
}

/**
 * 折出一段摘要正文，并用**宿主的计量器**核对「确实更小」。
 *
 * 为什么要自己核对：basic 有一道闸（`dsh-compaction-basic/lib/index.js:601`）
 * `framedSummaryTokenCount >= shadowedRouteTokenCount` 就 **throw** —— 那是**整次压缩失败**，
 * 比折叠得不够狠严重得多。折叠侧已经按字符保证了「比输入小」，这里再用 token 复核一遍；
 * 不达标就按更狠的比例重折（仍然确定性：比例是算出来的，不是试出来的）。
 */
/** 会被压缩 shadow 的 role（`system` / `developer` 是 basic 前置的对话头，不在区间里）。 */
const SHADOWED_ROLES = new Set(["user", "assistant", "tool"]);

export function foldForBudget(messages, meter, { log = () => {}, targetRatio = FOLD_TARGET_RATIO } = {}) {
	// **分母只算被 shadow 的区间**。独立测逮到的 P1：`SummarizationInput.messages` 是
	// 「系统头 + 被压区间」（`dsh-compaction-basic/lib/types/summarizer.d.ts:23`），而 basic 的闸
	// （`index.js:601`）只比 `prepared.shadowedRouteTokenCount`（= 选中节点的 Σtokens，:576-577）。
	// 拿整个 messages 当分母，ratio 会系统性偏小 (1 + S/R) 倍 —— 系统头一大，`fellBack` 就永不触发，
	// 然后 basic 的闸直接 **throw**，整次压缩失败：正是 `fellBack` 要防的那个场景。
	const region = messages.filter((message) => SHADOWED_ROLES.has(message?.role));
	const inputTokens = estimateMessages(meter, region);
	let result = foldMessages(region, { targetRatio });
	if (inputTokens === undefined || inputTokens === 0) return { ...result, inputTokens, ratio: undefined };

	// 比的是**framing 之后**的估值（basic 的闸就是这么算的），所以把那个常数加上。
	const framedRatio = (tokens) => (tokens === undefined ? undefined : (tokens + FRAME_OVERHEAD_TOKENS) / inputTokens);
	let summaryTokens = estimateMessages(meter, [{ role: "user", content: [{ type: "text", text: result.text }] }]);
	let ratio = framedRatio(summaryTokens);
	let attempt = 0;
	// 最多再狠三档；每一档都是确定的（ratio 减半），不是随机试。
	while (ratio !== undefined && ratio >= SAFE_RATIO && attempt < 3) {
		attempt += 1;
		result = foldMessages(region, { targetRatio: targetRatio / 2 ** attempt });
		summaryTokens = estimateMessages(meter, [{ role: "user", content: [{ type: "text", text: result.text }] }]);
		ratio = framedRatio(summaryTokens);
	}
	if (ratio !== undefined && ratio >= 1) {
		// 到这一步说明连折叠都压不下来（例如区间里全是必须逐字留的用户原话）。
		// 与其让 basic 抛「summary is not smaller」，不如**退回超类**去调 LLM —— 那条路至少能压下来。
		log(`[fold] 折不动（估算 ${summaryTokens} ≥ ${inputTokens} tokens）→ 退回 basic 的 LLM 摘要`);
		return { text: undefined, inputTokens, summaryTokens, ratio, fellBack: true };
	}
	return { ...result, inputTokens, summaryTokens, ratio, attempts: attempt };
}

/**
 * 插件入口。`config` 就是预设里 compaction 那一行的 config（basic 的 schema，本类继承，
 * 所以 `thresholdRatio` / `headroomTokens` / `retainRatio` 这些键照常有效）。
 */
export async function apply(ctx, config = {}) {
	const log = (message) => ctx.logger?.info?.(message);
	const kit = await makeHostLoader(ctx).load("@deepseek-ai/dsh-compaction-basic", ["BasicCompactionEngine"]);
	if (typeof kit.BasicCompactionEngine !== "function") {
		throw new Error("dsh-compaction-basic 没导出 BasicCompactionEngine（宿主升级了？）");
	}
	const Base = kit.BasicCompactionEngine;

	class FoldCompactionEngine extends Base {
		/** 唯一的定制点：把「调模型写摘要」换成「确定性折叠」。 */
		async summarize(input, agent, signal) {
			const messages = Array.isArray(input?.messages) ? input.messages : [];
			const folded = foldForBudget(messages, this.ctx?.tokenMeter, { log });
			if (folded.fellBack || typeof folded.text !== "string") {
				// 折不动就交回超类（它会调 LLM）—— 宁可多花一次调用，也不要让压缩直接失败。
				return super.summarize(input, agent, signal);
			}
			const chars = messages.reduce((n, m) => n + contentText(m).length, 0);
			log(
				`[fold] 确定性折叠：${messages.length} 条消息 / ${chars} 字符 → ${folded.text.length} 字符` +
					`（${folded.ratio === undefined ? "未估算" : `${(folded.ratio * 100).toFixed(1)}% tokens`}）`,
			);
			return { summary: [{ type: "text", text: folded.text }], provider: "", model: "" };
		}
	}

	// 服务名 "compaction" 由基类构造里的 super(ctx, "compaction") 决定（重名会抛，所以同一个
	// profile 里只能有一个压缩后端 —— 切后端就是换预设里那一行的 name）。
	new FoldCompactionEngine(ctx, config);
}
