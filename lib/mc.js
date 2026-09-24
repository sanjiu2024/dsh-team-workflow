/**
 * 把 magic-context 架进 dsh。
 *
 * ## 结论（先读这段，再看代码）
 *
 * pi 的 `context` 事件拿【整个消息数组】进、出，是**请求级**变换：
 * 重排历史 + 给每条重打 `§N§` + 往头部插 `<session-history>` 块。
 * dsh **没有对应的请求级缝**：`agent/pre-step` 的 append 和 surface 的
 * `replace` 都写进持久日志。把 pi 的 `context` 输出原样铺上 surface 会：
 *
 *   1. 每轮重打 ordinal，上一轮的前缀成了真历史 → 下一轮再叠一层，无界增生；
 *   2. 把 `tool/result` 节点换成 `user/message` → 打断 assistant `tool_calls`
 *      与 tool-result 的配对，供应商直接 400
 *      （`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）；
 *   3. `assistant/message` 根本不可替换（带 `sourceEventSeqs` 直接抛）。
 *
 * 所以**只有两个落点**能真正生效：
 *
 *   · **系统提示注入** → dsh 原生 `systemPrompt.section`。
 *     bundle 的 `before_agent_start` 返回 `{systemPrompt}`，是纯字符串拼接，
 *     零副作用。实测：`session_meta.system_prompt_hash` 从空变成
 *     `7aca8b0e…`、`system_prompt_tokens=1384`。
 *   · **数据写入** → facade 的 `message_end` / `tool_*` / `session_*` 等
 *     handler，走 DB，不碰 surface。实测：`source_contents` / `tags` /
 *     `message_history_index` 都随会话增长。
 *
 * `context` handler 只保留一个安全子集：把它**新产生**的 `<session-*>`
 * 注入块追加到尾部，按文本去重。历史改写一律不落地。
 *
 * ## 代价（明确的天花板，不是遗漏）
 *
 * 模型看不到历史消息上的 `§N§` 前缀。但 `ctx_expand` 的 ordinal 读取走
 * bundle 自带的 raw-message provider（`readPiSessionMessages`），**不依赖
 * surface**，所以 `ctx_search` → `ctx_expand` 链路仍然可用。
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { alignSurface, createPiFacade, defaultStorageDir, resolveBundle, textOfMessage } from "./mc-adapter.js";

/** 配置默认值。无 Config schema —— 手写叠层（与包内其他模块一致）。 */
export const MC_DEFAULTS = {
	enabled: true,
	bundleDir: undefined,
	storageDir: undefined,
};
export const MC_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	bundleDir: (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined),
	storageDir: (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined),
};

/**
 * 存储走独立目录，不碰 pi/opencode 的共享库。
 * 上游判断「是不是默认共享库」：
 *   if (!XDG_DATA_HOME && MAGIC_CONTEXT_TEST_DATA_DIR) return false;
 * 只换 MAGIC_CONTEXT_STORAGE_DIR 没用 —— 仍被判为共享库 → 扫全机 pi 进程
 * → 有老 build 的 pi 在跑就 fail-closed 拒绝启动。TEST_DATA_DIR 是上游
 * 自己留的隔离通道，代价是关掉 embedding provider（Phase 1 用不到）。
 */
function applyStorageEnv(config) {
	const dir = config.storageDir ?? defaultStorageDir();
	process.env.MAGIC_CONTEXT_STORAGE_DIR = dir;
	process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
	if (!process.env.MAGIC_CONTEXT_LOG_PATH) {
		process.env.MAGIC_CONTEXT_LOG_PATH = path.join(dir, "magic-context.log");
	}
	return dir;
}

/** pi 消息 → dsh 事件 data。
 *
 * dsh 每种 surface 事件的数据形状不同：
 *   user/message      → 直接就是 Message
 *   system/message    → {turn, step, message}
 *   assistant/message → {turn, step, message, stream}
 *   tool/result       → {turn, step, message: ToolResultMessage}
 * 错一个就抛 `Cannot read properties of undefined (reading 'content')`。
 */
function toEventData(type, message) {
	let content = [];
	if (Array.isArray(message?.content)) content = message.content;
	else if (typeof message?.content === "string") content = [{ type: "text", text: message.content }];
	const msg = {
		id: message?.id ?? `mc-${Math.random().toString(36).slice(2, 10)}`,
		role: message?.role ?? "user",
		content,
		source: { kind: "plugin", plugin: "magic-context" },
	};
	if (type === "system/message") return { turn: 0, step: 0, message: msg };
	if (type === "assistant/message") return { turn: 0, step: 0, message: msg, stream: [] };
	// tool/result 的 message 必须是 ToolResultMessage：role 固定 user、内容是 tool-result block
	if (type === "tool/result") {
		// 当前 landOnSurface 只 append user/message，走不到这里。
		// 保留是因为 dsh 的 tool/result 必须是 {turn, step, message: ToolResultMessage}
		// 这个形状 —— 下次想动 tool 节点时不用再踩一次
		// `Cannot read properties of undefined (reading 'content')`。
		return {
			turn: 0,
			step: 0,
			message: {
				id: msg.id,
				role: "user",
				content: content.map((b) => (b?.type === "tool-result" ? b : { type: "tool-result", toolCallId: "mc", content: [{ type: "text", text: textOfMessage(message) }] })),
				source: { kind: "plugin", plugin: "magic-context" },
			},
		};
	}
	return msg;
}

/**
 * 把 bundle 返回的消息数组折回 dsh surface。
 *
 * 关键约束（实测得出的，不是猜的）：
 * dsh **没有「仅本次请求」的消息改写缝**。`agent/pre-step` 的 append 和
 * surface 的 replace 都写进持久日志。而 pi 的 `context` handler 只是**请求级**
 * 变换（把历史重排 + 重打 §N§ + 插注入块）—— 原样铺到 surface 上会：
 *   1. 每轮重打 ordinal，旧前缀成了真历史 → 下一轮再叠一层，无限增生；
 *   2. 把 tool/result 节点换成 user/message → 打断 assistant tool_calls 配对，
 *      供应商直接 400 `Messages with role 'tool' must be a response to…`。
 *
 * 所以这里只做一件安全的事：把 bundle 新产生的**注入块**（`<session-*>`）
 * 追加到尾部，且按文本去重（已存在的不再追加）。其余一律不落地。
 *
 * 代价（已知天花板）：模型看不到历史里的 `§N§` 前缀。但 ctx_expand 的 ordinal
 * 读取走 bundle 自己的 raw-message provider（`readPiSessionMessages`），
 * 不依赖 surface，所以 `ctx_search` → `ctx_expand` 链路仍然可用。
 */
export function landOnSurface({ session, before, after }) {
	const changes = alignSurface(before, after);
	const stats = { ops: 0, appended: 0, skipped: 0, forwarded: 0 };

	// 已经出现过的注入块文本（旧序列里可能已经躺着上几轮的）
	const seen = new Set((before ?? []).map((m) => textOfMessage(m).trim()));

	for (const change of changes) {
		if (change.kind !== "append") {
			stats.skipped += 1;
			continue;
		}
		for (const message of change.messages) {
			const text = textOfMessage(message).trim();
			if (seen.has(text)) {
				stats.skipped += 1;
				continue;
			}
			seen.add(text);
			try {
				session.append("user/message", toEventData("user/message", message), { surfaceOp: "append" });
				stats.appended += 1;
			} catch {
				stats.skipped += 1;
			}
		}
	}

	return stats;
}

/**
 * 装 magic-context。
 *
 * @param {object} deps
 * @param {import('cordis').Context} deps.ctx
 * @param {string} deps.packageRootUrl
 * @param {object} deps.config
 * @param {(msg:string)=>void} deps.log
 */
export async function installMagicContext({ ctx, packageRootUrl, config, log }) {
	const found = resolveBundle(packageRootUrl, config.bundleDir);
	if (!found) {
		log("[mc] 没找到 bundle；跑 `dsh-team mc install`。跳过 magic-context。");
		return { enabled: false, reason: "bundle-missing" };
	}

	const storageDir = applyStorageEnv(config);
	log(`[mc] bundle: ${found.entry}`);
	log(`[mc] 存储: ${storageDir}（独立库，不碰 pi/opencode 共享库）`);

	const stats = { tools: 0, commands: 0, contexts: 0, ops: 0, appended: 0, skipped: 0 };
	// agent 到 `agent/created` 才存在，facade 和 pre-step 都靠这个可变引用
	const sessionRef = { session: null };

	// agent 出现时才注册 per-agent 的 pre-step —— 它是 agent 级事件，
	// 全局 ctx 上注册收不到（先例：dsh-agent/lib/index.js:160 用 agentCtx.on）。
	ctx.on("agent/created", ({ agent }) => {
		const inner = agent?.ctx;
		if (!inner?.on) return;
		sessionRef.session = agent.session ?? null;

		// 系统提示注入：bundle 里唯一**干净可移植**的那部分。
		// 它返回 {systemPrompt}，不重排消息数组。
		//
		// 坑：`systemPrompt.section` 的 `text` 类型是 `string | ((ctx) => string)`
		// —— **不是 Promise**。bundle 的 handler 是 async，所以不能直接当 text。
		// 只能先 await 好存进闭包，再同步吐出去。
		//
		// 时序：`agent/pre-step` 在 `step()` 的 `systemPrompt.project` 之前，
		// 所以那里刷新完，同轮的提示就是新的。
		let mcBlock = "";
		const refreshBlock = async () => {
			const emit = facadeRef.emit;
			if (typeof emit !== "function") return;
			try {
				const out = await emit("before_agent_start", { type: "before_agent_start", systemPrompt: "", prompt: "" });
				const next = out?.systemPrompt;
				mcBlock = typeof next === "string" ? next.trim() : "";
			} catch (error) {
				log(`[mc] 系统提示注入失败: ${error?.message ?? error}`);
			}
		};
		if (inner.systemPrompt?.section) {
			inner.systemPrompt.section({ name: "magic-context:block", order: 700, text: () => mcBlock });
		}
		void refreshBlock();

		inner.on("agent/pre-step", async (_payload, next) => {
			const decision = await next();
			void refreshBlock();
			if (decision?.kind === "reject") return decision;
			const session = agent.session;
			if (!session?.surface) return decision;
			const emitContext = facadeRef.emit;
			if (typeof emitContext !== "function") return decision;

			// bundle 会**原地改 event.messages 数组**（push 注入块 + 给每条打 §N§）。
			// 所以必须传一份、留一份 —— 快照自己不能交给它。
			const snapshot = structuredClone(session.deriveMessages());
			let after;
			try {
				const out = await emitContext("context", { type: "context", messages: structuredClone(snapshot) });
				after = out?.messages;
			} catch (error) {
				log(`[mc] context 处理失败: ${error?.message ?? error}`);
				return decision;
			}
			if (!Array.isArray(after)) return decision;

			try {
				const landed = landOnSurface({ session, before: snapshot, after });
				stats.contexts += 1;
				stats.ops += landed.ops;
				stats.appended += landed.appended;
				stats.skipped += landed.skipped;
			} catch (error) {
				log(`[mc] surface 落地失败: ${error?.message ?? error}`);
			}
			// decision.messages 不动 —— 注入块已通过 surface 落地，再塞会重复。
			return decision;
		});

		// 系统提示注入不再走这里。
	});

	let facadeRef = {};
	try {
		const mod = await import(pathToFileURL(found.entry).href);
		const boot = mod.default;
		if (typeof boot !== "function") {
			log("[mc] bundle 没有 default 导出函数；跳过。");
			return { enabled: false, reason: "bad-entry" };
		}
		const pi = createPiFacade({ ctx, log, sessionRef });
		// 要整个 pi：facade 只给 bundle 用，emit/flushTools 在它外面。
		facadeRef = pi;
		await boot(pi.facade);
		pi.flushTools();
		stats.tools = pi.toolCount();
		log("[mc] runtime 已挂载");
	} catch (error) {
		log(`[mc] boot 失败: ${error?.message ?? error}`);
		return { enabled: false, reason: "boot-failed", storageDir };
	}

	return { enabled: true, storageDir, stats };
}

export { alignSurface, resolveBundle };
