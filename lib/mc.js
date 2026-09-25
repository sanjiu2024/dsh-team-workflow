/**
 * 把 magic-context 架进 dsh。
 *
 * ## 结论（先读这段，再看代码）
 *
 * pi 的 `context` 事件拿【整个消息数组】进、出，是**请求级**变换：
 * 重排历史 + 给每条重打 `§N§` + 往头部插 `<session-history>` 块。
 * dsh **没有对应的请求级缝** —— `agent/pre-step` 的写入都进持久日志。
 * 但持久日志有一个 `replace` 能力，所以不是「落不了地」，而是**只能落一种形状**：
 *
 *   · **N→1 折叠可以落**。`surfaceOp: {op:'replace', startSeq, endSeq}` +
 *     `sourceEventSeqs`（必须稠密包含每个被遮蔽节点），把一段旧消息换成一个节点。
 *     这正是 dsh 自带压缩用的形状（`dsh-compaction-basic/lib/index.js:622`），
 *     原样照抄即可。切口必须**工具配对平衡**：切在 assistant `tool-call` 和
 *     对应 `tool/result` 中间 → 供应商 400。用官方的
 *     `toolPairingBalancedBefore/After` 判，不要自己数。
 *   · **1→1 整体替换不行**。`assistant/message` 只要带 `sourceEventSeqs` 就直接抛；
 *     其余类型要求 `shadowedSeqs.length === 1` 且**内容逐字相同**（只有
 *     `tool/result` 允许改内容）—— 所以「把每条消息重写成压缩过的文本」在 dsh
 *     上不可表达。这正是 pi 上 magic-context 用的机制，这里是真天花板。
 *   · **`§N§` 不能落**。每轮重打 ordinal，上一轮的前缀就是真历史，
 *     下一轮再叠一层，无界增生（而且会变成 `§1§ §1§`）。所以
 *     写 surface 前先把 `§N§` 剥掉，比对时也剥 —— 剥离后不是差异，就不算变更。
 *
 * 落地路径（见 `landOnSurface`）：
 *
 *   1. 折叠（N→1）→ `session.append("user/message", …, {surfaceOp:{op:'replace',…}})`。
 *      **必须在任何 append 之前做** —— append 会改 `surface.nodes`，之后算的
 *      切口表就错位了。
 *   2. 注入块 → `surfaceOp:"append"`，按文本去重（不是每轮堆一份）。
 *
 * 另有两个非 surface 落点：
 *
 *   · **系统提示** → dsh 原生 `systemPrompt.section`（order 700）。compartment 摘要
 *     从这里进，模型看不到折叠占位符也能看到摘要。实测：`system_prompt_hash`
 *     从空变成 `7aca8b0e…`、`system_prompt_tokens=1384`。
 *   · **数据写入** → facade 的 `message_end` / `tool_*` / `session_*` handler，走 DB，
 *     不碰 surface。实测：`source_contents` / `tags` / `message_history_index` 随会话增长。
 *
 * ## 代价（明确的天花板，不是遗漏）
 *
 * 模型在 surface 上看不到 `§N§` 前缀（我们主动剥了）。但 `ctx_expand` 的 ordinal
 * 读取走 bundle 自带的 raw-message provider（`readPiSessionMessages`），**不依赖
 * surface**，所以 `ctx_search` → `ctx_expand` 链路仍然可用。
 *
 * 每轮最多落一次折叠：一次 replace 会改 surface 下标，同一轮里再算就不可信。
 * 一轮只需折一次（historian 交付是按段推进的），所以这是设计而不是限制。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { alignSurface, createPiFacade, defaultStorageDir, resolveBundle, stripOrdinal, textOfMessage } from "./mc-adapter.js";

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

/** pi 伪 CLI 的落脚点。**路径不能含空格** —— bundle 用
 * `cmd.exe /d /s /c <path>` 调它，未加引号的路径会在空格处断开。
 * 所以放 `~/.dsh/team-workflow/pi-shim/`，不是包目录（cwd 含空格）。 */
export function piShimDir() {
	return path.join(homeDir(), ".dsh", "team-workflow", "pi-shim");
}

/**
 * 把伪 CLI 装到无空格目录并插进 PATH 最前面。
 *
 * bundle 的 `resolveWindowsPiCommand` 只扫 `process.env.PATH`（argv1 探测
 * 在 dsh 里会指向 dsh 自己的入口，用不上），所以这是唯一能生效的注入点。
 * 只改本进程 env，不写用户 profile、不碰全局 PATH。
 *
 * 副作用（已知，接受）：这是 **进程级** 的，bash/shell 等子进程全部继承。
 * 所以本会话里直接跑 `pi` 会命中伪 CLI（吐一行 NDJSON）而不是真 pi。
 * bundle 每次 spawn 都重扫 PATH，没有更干净的缝；真要用 pi 请写绝对路径。
 *
 * @param {string} packageRootUrl 包的 file:// URL（源文件在这）
 * @returns {string|null} 装好的目录，失败返回 null
 */
export function stagePiShim(packageRootUrl, log) {
	// `new URL("tools/pi-shim/", base)` 在 base 末尾没有斜杠时，会把最后一段
	// 当文件名换掉（…/repo → …/tools/pi-shim/），于是永远找不到源目录。
	// 包根 URL 带不带尾斜杠都合法，这里自己归一化。
	let src;
	try {
		const base = packageRootUrl.href.endsWith("/") ? packageRootUrl : new URL(`${packageRootUrl.href}/`);
		src = fileURLToPath(new URL("tools/pi-shim/", base));
	} catch (error) {
		// 包根 URL 不合法就拿不到源目录。伪 CLI 是 historian 的子进程依赖，
		// 装不上本该降级（返回 null），不该把整个插件启动拖下水。
		log?.(`[mc] 包根 URL 不合法，装不了 pi 伪 CLI：${error?.message ?? error}`);
		return null;
	}
	const dest = piShimDir();
	if (!fs.existsSync(src)) {
		log?.(`[mc] 找不到 pi 伪 CLI 源目录：${src}`);
		return null;
	}
	try {
		fs.mkdirSync(dest, { recursive: true });
		for (const name of fs.readdirSync(src)) {
			fs.copyFileSync(path.join(src, name), path.join(dest, name));
		}
	} catch (error) {
		log?.(`[mc] 装 pi 伪 CLI 失败：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}

	const sep = process.platform === "win32" ? ";" : ":";
	const current = process.env.PATH ?? "";
	const parts = current.split(sep).filter((p) => p.trim() !== "");
	if (!parts.some((p) => path.resolve(p) === path.resolve(dest))) {
		process.env.PATH = [dest, ...parts].join(sep);
	}
	log?.(`[mc] pi 伪 CLI 已就位：${dest}`);
	return dest;
}

function homeDir() {
	return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
}

/**
 * 读这个会话已生成的 compartment（四级折叠摘要）。
 *
 * historian 把老消息折成 P1-P4 四层摘要写进 `compartments`，越靠后的
 * sequence 越新。P1 是最凝练的骨架，P4 是最细的原文片段 —— 全注太长，
 * 只取 P1+P2（骨架 + 要点），兼顧信息量和 token 预算。
 *
 * 读的是只读连接，用完即关：这个函数每轮都会跑（pre-step 里刷新）。
 * 打不开 DB 就返回空串 —— 折叠是增强，不是主路，不能把 agent 拖死。
 *
 * @param {string|undefined} sessionId 当前 dsh 会话 id（= mc 的 session_id）
 * @returns {string} 拼好的 markdown 块，无内容时返回 ""
 */
function readCompartments(sessionId, limit = 8) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return "";
	const dir = process.env.MAGIC_CONTEXT_STORAGE_DIR;
	if (!dir) return "";
	let db;
	try {
		db = new DatabaseSync(path.join(dir, "cortexkit", "magic-context", "context.db"), { readOnly: true });
		const rows = db
			.prepare(
				`SELECT sequence, title, p1, p2 FROM compartments
				 WHERE session_id = ? AND COALESCE(legacy, 0) = 0
				 ORDER BY sequence DESC LIMIT ?`,
			)
			.all(sessionId, limit);
		if (rows.length === 0) return "";

		const parts = ["## Magic Context —— 已折叠的历史", ""];
		for (const row of rows.reverse()) {
			const head = row.title ? `### [#${row.sequence}] ${row.title}` : `### [#${row.sequence}]`;
			parts.push(head);
			if (row.p1) parts.push(row.p1.trim());
			if (row.p2) parts.push(row.p2.trim());
			parts.push("");
		}
		parts.push("需要原文时用 `ctx_search` 检索、`ctx_expand` 按序号取回。");
		return parts.join("\n");
	} catch {
		// 表还没建、DB 被锁、路径不对 —— 都不该打断 agent
		return "";
	} finally {
		try {
			db?.close();
		} catch {}
	}
}

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

/** pi 消息 → dsh `user/message` 的事件 data。
 *
 * 只能造 user/message：这是本模块唯一实际写到 surface 的类型（折叠载体 + 注入块）。
 *
 * 其他三种类型现在不写，所以**不在这里预留造法** —— 曾经预留过，三个分支全是
 * 坏形状：dsh 加载期要求 `assistant/message` 的 source 是 `{kind:"model", provider,
 * model}`、`tool/result` 是 `{kind:"tool", callId}`（且块里的 toolCallId 要与之一致），
 * 而当时统一写的是 `{kind:"plugin"}` —— 一旦有人启用那条分支，就是又一次同型
 * 事故（见 docs/HANDOFF-10）。真要用时按 dsh 的 `assertMessageEventShape` 现写。
 *
 * 除了形状，事件**信封**也不同：user/message 的 data 直接就是 Message；
 * system/assistant 要包 `{turn, step, message}`（assistant 还带 `stream`）；
 * tool/result 要 `{turn, step, message: ToolResultMessage}`。
 *
 * @param {object} message pi 形状的消息
 * @returns {object} `user/message` 的事件 data
 */
function toEventData(message) {
	let content = [];
	if (Array.isArray(message?.content)) content = message.content;
	else if (typeof message?.content === "string") content = [{ type: "text", text: message.content }];
	// role 绝不能沿用调用方的。`user/message` 的 data **就是** Message，而 dsh 的
	// 加载期校验要求它的 role 逐字是 "user"（`assertMessageEventShape`）。
	// append 时**不校验**（invariant 对 user/message 直接 break），所以错
	// role 会安静写进磁盘，直到下次重启重载才暴炸 —— 整个会话加载失败、
	// 用户所有对话消失。实测就这么写过 158 条（见 docs/HANDOFF-10）。
	return {
		id: message?.id ?? `mc-${Math.random().toString(36).slice(2, 10)}`,
		role: "user",
		content,
		source: { kind: "plugin", plugin: "magic-context" },
	};
}

/**
 * 把 bundle 返回的消息数组折回 dsh surface。
 *
 * 关键约束（读 dsh 源码 + 探针实测得出）：
 *   · dsh **没有「仅本次请求」的消息改写缝**。append / replace 都写进持久日志。
 *   · `surfaceOp.replace` 是 **N→1**（`dsh-session/lib/index.js:321` replacementRange）。
 *   · `assertProvenance`：`sourceEventSeqs` 必须**密集包含**被 shadow 的每个节点。
 *   · `assertToolResultRewrite`：**只在替换事件本身是 `tool/result` 时**才要求
 *     「1→1 且只改 content」—— 所以 `user/message` N→1 盖住含 tool 的整段**合法**
 *     （`dsh-compaction-basic` 就这么干）。
 *   · `assertSystemHeadRewrite`：node 0 若是 `system/message`，只能被 system/message 1→1 覆写。
 *   · 切开 assistant-tool_call / `tool/result` 配对 → 供应商 400
 *     `Messages with role 'tool' must be a response to…`，必须选平衡切口。
 *
 * 策略（对齐 dsh 自带压缩的两段式，但去掉冗余的 summary 事件）：
 *   1. 折叠：把 bundle 删掉的那段（midA）折成**一个用户消息**，文本极短 ——
 *      摘要在系统提示的 compartment 区（`refreshBlock`，order 700），不重复塞。
 *   2. 注入块：尾部追加 + 文本去重。
 *
 * 不落地的：1→1 内容改写（bundle 的 `[dropped §N§]` 哨兵、文本压缩）。
 *   `ponytail:` 这是纯 token 优化，不是正确性；要做就得把 pi 的
 *   `tool_use`/`tool_result` 转成 dsh 的 `tool-call`/`tool-result`，多一层形状转换。
 *   折叠（N→1）才是真正缩短 history、停掉 dsh 自带压缩的那一刀。
 *
 * 天花板：一轮最多落**一次** replace（replace 会改 surface 下标，第二个会算错）；
 * bundle 若在中段保留 M>1 条，跳过本轮折叠（不猜、不乱序），只落注入块。
 */
export function landOnSurface({ session, before, after }) {
	const stats = { ops: 0, appended: 0, skipped: 0, folds: 0, foldedNodes: 0, mismatch: 0, reason: "" };
	const changes = alignSurface(before, after);

	// —— 1. 先折叠（N→1 replace）——
	// 必须在任何 append 之前：append 会改 surface.nodes，之后算的切口表就错位了。
	const region = changes.find((c) => c.kind === "replace");
	if (region) {
		if ((region.midB?.length ?? 0) > 1) {
			// 中段保留了多条 → 顺序无法用一次 N→1 保住，不猜
			stats.skipped += 1;
			stats.reason = `mid-kept-${region.midB.length}`;
		} else {
			const seqs = surfaceSeqs(session);
			if (seqs.length !== (before?.length ?? 0)) {
				// deriveMessages() 会跳过空 content 的投影节点；两边算法一致才对得上
				stats.mismatch += 1;
				stats.reason = `seq-mismatch ${seqs.length}!==${before?.length ?? 0}`;
			} else {
				const cuts = balancedCuts(session, seqs);
				let start = region.start;
				let end = region.end;
				// 收缩到平衡切口：不平衡就把边缘留在外面（它们继续可见，不折）
				while (start <= end && !cuts[start]) start += 1;
				while (end >= start && !cuts[end + 1]) end -= 1;
				// node 0 是 system prompt，只能被 system/message 覆写
				if (start === 0 && end >= 0 && session.eventAt(seqs[0])?.type === "system/message") {
					start += 1;
					while (start <= end && !cuts[start]) start += 1;
				}
				if (start > end) {
					stats.skipped += 1;
					stats.reason = "no-balanced-cut";
				} else {
					const shadowed = seqs.slice(start, end + 1);
					const mid = region.midB ?? [];
					// carrier 必须剥掉 §N§ 再写 surface。bundle 每轮按位置重打 ordinal，
					// 留着原文就成了真历史，下一轮再叠一层 → 无界增生（§8§ §7§ §6§ …）。
					// 剥掉后不是差异，会被 alignSurface 的 normText 认成同一条，闭环才闭合。
					// 模型在 surface 上就看不到 §N§ 了（已知代价，见文件头注释）。
					const carrier = mid.length === 1 && mid[0]?.role === "user" && !hasToolBlocks(mid[0])
						? stripOrdinaled(mid[0])
						: { role: "user", content: [{ type: "text", text: `[magic-context] 已折叠 ${shadowed.length} 条历史；摘要见系统提示的 compartment 区。` }] };
					try {
						session.append("user/message", toEventData(carrier), {
							surfaceOp: { op: "replace", startSeq: seqs[start], endSeq: seqs[end] },
							sourceEventSeqs: [...shadowed],
						});
						stats.ops += 1;
						stats.folds += 1;
						stats.foldedNodes += shadowed.length;
					} catch (error) {
						stats.skipped += 1;
						stats.reason = `append-threw: ${error?.message ?? error}`;
					}
				}
			}
		}
	}
	if (!region) stats.reason = "no-shrink";

	// —— 2. 再追加注入块 ——
	// 已经出现过的注入块文本（旧序列里可能已经躺着上几轮的）
	const seen = new Set((before ?? []).map((m) => textOfMessage(m).trim()));
	for (const change of changes) {
		if (change.kind !== "append") continue;
		for (const message of change.messages) {
			const text = textOfMessage(message).trim();
			if (seen.has(text)) {
				stats.skipped += 1;
				continue;
			}
			seen.add(text);
			try {
				session.append("user/message", toEventData(message), { surfaceOp: "append" });
				stats.appended += 1;
			} catch {
				stats.skipped += 1;
			}
		}
	}

	return stats;
}

/** pi 消息里有没有工具块（有就不能当 replace 载体：形状对不上 dsh）。 */
function hasToolBlocks(message) {
	return (message?.content ?? []).some((b) => /^tool[_\-]/.test(b?.type ?? ""));
}

/**
 * 深拷一份消息，并把文本块开头的 `§N§` 剥掉。
 *
 * 只在写 surface 前用。不原地改 —— bundle 传进来的对象可能还在它自己的
 * 缓存里，改了会污染它下一轮的前缀比对。
 */
function stripOrdinaled(message) {
	return {
		...message,
		content: (message?.content ?? []).map((block) =>
			block?.type === "text" && typeof block.text === "string"
				? { ...block, text: stripOrdinal(block.text) }
				: block,
		),
	};
}

/**
 * surface 上每个节点的 seq，顺序与 `deriveMessages()` 严格一致。
 * `deriveEventMessage` 对空 content 的 system/assistant 返回 null，
 * `deriveMessages()` 会跳过 —— 这里用同一个投影函数过滤，才能下标对齐。
 */
function surfaceSeqs(session) {
	const out = [];
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (!event) continue;
		if (session.deriveEventMessage(event)) out.push(seq);
	}
	return out;
}

/**
 * 工具配对平衡的切口表：`cuts[i] === true` 表示「seqs[i] 之后」可以安全切。
 * 复刻 `@deepseek-ai/dsh-compaction` 的 `eventDelta`（那个包从插件里解析不到，
 * 所以本地复刻这十几行 —— 也可改为 `ctx.compaction` 的 `toolPairingBalanced*`）。
 */
function balancedCuts(session, seqs) {
	const cuts = [true];
	let open = 0;
	for (const seq of seqs) {
		const event = session.eventAt(seq);
		if (event?.type === "assistant/message") {
			open += (event.data?.message?.content ?? []).filter((b) => b?.type === "tool-call").length;
		} else if (event?.type === "tool/result") {
			open -= 1;
		}
		cuts.push(open === 0);
	}
	return cuts;
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
	// historian 是 bundle 里唯一会 spawn 外部进程的部分（PiSubagentRunner）。
	// 它在 Windows 上扫 PATH 找 `pi.cmd` —— 装我们的伪 CLI 顶上去。
	const shimDir = stagePiShim(packageRootUrl, log);
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
				const base = typeof next === "string" ? next.trim() : "";
				// compartment（historian 产出四级折叠摘要）不经过 before_agent_start ——
				// 它写在 DB 里，由 bundle 的 context 处理器负责注入，而那条路在 dsh
				// 上落不了地。这里自己读出来拼进系统提示。
				const folded = readCompartments(sessionRef.session?.id);
				mcBlock = [base, folded].filter((s) => s && s.length > 0).join("\n\n");
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
				// 落地结果必须可见：用户报「折叠永远不触发」时，没有这行就只能猜。
				if (landed.folds > 0) {
					log(`[mc] 折叠已落地：${landed.foldedNodes} 条 → 1（surface ${snapshot.length} → ${session.deriveMessages().length}）`);
				} else if (landed.appended > 0) {
					log(`[mc] 注入块已落地 ${landed.appended} 个（未折叠：${landed.reason || "无可折区间"}）`);
				}
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

	return { enabled: true, storageDir, shimDir, stats };
}

export { alignSurface, resolveBundle };
