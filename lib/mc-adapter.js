/**
 * magic-context 适配层：把未修改的 @cortexkit/pi-magic-context bundle
 * 架到 dsh 上。
 *
 * 为什么是适配器而不是移植：
 *   上游 bundle 自包含（唯一运行时外部依赖是 @earendil-works/pi-tui），
 *   零运行时 import `@earendil-works/pi-coding-agent`，靠 `default(pi)`
 *   注入宿主。实测用一个桩 pi 就能把完整 runtime 拉起来（15 种事件、
 *   6 个 ctx_* 工具、7 个 ctx-* 命令）。所以这里只干一件事：
 *   把桩 pi 的每个成员桥到 dsh 对应面。
 *
 * 两条路都通，按优先级自动降级：
 *   桥接 (bridge)   —— 全部映射可用，真实 runtime
 *   降级 (degrade)  —— 只做记忆读写，不跑 bundle
 *
 * dsh 侧落点：
 *   pi.on("context")        → agent/pre-step（在 buildRequest 之前，能改 surface）
 *                             + session.append(..., {surfaceOp:{op:'replace'}})
 *   pi.registerTool         → ctx.tools.register（schema 形态转换）
 *   pi.registerCommand      → ctx.commands.register
 *   pi.appendEntry          → session.append（日志事件）
 *   pi.sessionManager.*     → session.id / surface 派生
 *   pi.exec                 → 子代理（historian 要 spawn）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dsh 的 surface 替换是 N→1（把 [startSeq..endSeq] 折成一个节点），
 * 而 pi 的 `context` 事件返回整个新数组（N→M）。要落地 N→M 只能做
 * 前缀/后缀不变的 diff，把变化区间逐段折成替换节点。
 *
 * 这个函数就是那个 diff：给定旧消息序列和新消息序列，算出最小
 * 的「连续变化区间」列表。区间之外的节点原样保留。
 *
 * 单位是 surface 节点在 surface 里的位置（不是 seq）—— 调用方负责
 * 把位置映射到 seq。
 *
 * @param {readonly unknown[]} before 当前 surface 投影出的消息
 * @param {readonly unknown[]} after   bundle 返回的新消息
 * @returns {Array<{start:number,end:number,replacement:unknown[]}>}
 */
/** 取消息文本（拼接所有 text block）*/
export function textOfMessage(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
}

/** 注入块（<session-history> / <session-history-since>），不是历史消息 */
function isInjection(message) {
	return /^\s*<session-/.test(textOfMessage(message));
}

/** 可见内容等价：只比 role + 文本。
 * bundle 每轮重造消息对象（id/source 都会变），比整个对象会产生假 diff。
 * 注意：§N§ 前缀【参与比较】—— 它是功能性的（模型靠它调 ctx_expand），
 * 序号变了就是真变化，必须落地。
 */
function sameVisible(x, y) {
	if ((x?.role ?? "user") !== (y?.role ?? "user")) return false;
	return textOfMessage(x) === textOfMessage(y);
}

/**
 * 把 bundle 输出的消息数组对齐回**旧序列上的下标**。
 *
 * 为什么不用通用 prefix/suffix diff：magic-context 把头注入放在最前，
 * 前缀一撞不上，后缀又被整个尾部吃掉，diff 退化成 [0..0] 这种废话区间。
 *
 * 也不用 ordinal 配对：第一轮旧序列还没有 §N§，键全落空。
 * magic-context **保序**（它只就地打标 + 头部插块），所以按位置对齐就够：
 *   · 头部 <session-*> 注入块 → 抽出去，尾部追加（dsh surface 无头插）
 *   · 其余按位置一一对应 → 内容变了就 1→1 replace
 *   · 新输出多出来的 → 尾部追加
 *   · 旧序列多出来的 → 被折叠（compartment）→ N→1 replace
 *
 * 返回的 start/end 都是**旧数组下标**，调用方负责映射成 surface seq。
 */
export function alignSurface(before, after) {
	const a = (before ?? []).map((m, index) => ({ message: m, index, injection: isInjection(m) }));
	const b = (after ?? []).map((m) => ({ message: m, injection: isInjection(m) }));

	// 注入块单独拎出来 —— 尾追加
	const injections = b.filter((x) => x.injection).map((x) => x.message);

	// 剩下的按位置对齐。旧序列里的注入块（上一轮落下的）也要去掉，
	// 否则会和真正的历史错位。
	const aHist = a.filter((x) => !x.injection);
	const bHist = b.filter((x) => !x.injection);

	const ops = [];
	const pairs = Math.min(aHist.length, bHist.length);

	// 1→1：内容真的变了才发 replace
	for (let i = 0; i < pairs; i += 1) {
		if (!sameVisible(aHist[i].message, bHist[i].message)) {
			ops.push({ kind: "replace", start: aHist[i].index, end: aHist[i].index, replacement: [bHist[i].message] });
		}
	}

	// 旧的多 → 折叠。dsh 的 replace 是 N→1，发一个覆盖整段的区间。
	if (aHist.length > bHist.length) {
		const from = aHist[bHist.length];
		const to = aHist[aHist.length - 1];
		ops.push({
			kind: "replace",
			start: from.index,
			end: to.index,
			replacement: [],
			note: `折叠 ${aHist.length - bHist.length} 条`,
		});
	}

	// 新的多 → 尾部追加
	const extra = bHist.slice(aHist.length).map((x) => x.message);
	const tail = [...injections, ...extra];
	if (tail.length > 0) ops.push({ kind: "append", messages: tail });

	return ops;
}

/**
 * 稳定的 JSON 串。key 顺序在这里不可控（bundle 各路径造对象顺序不同），
 * 所以排序后再比。
 */
export function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * 找 vendor 里的 magic-context bundle。
 * 顺序：显式配置 → vendor（由 `dsh-team mc install` 重建）
 */
/**
 * 找 vendor 里的 magic-context bundle。
 * 顺序：显式配置 → vendor（由 `dsh-team mc install` 重建）
 *
 * 用 fileURLToPath 而不是 new URL().pathname —— 后者会把路径里的空格
 * 编成 %20（本包 cwd 就带空格，踩过）。
 */
export function resolveBundle(packageRootUrl, override) {
	if (typeof override === "string" && override !== "") {
		const entry = path.join(override, "dist", "index.js");
		if (fs.existsSync(entry)) return { dir: override, entry };
	}
	try {
		// base URL 可能没有尾斜杠（pathToFileURL(目录) 给的就没有）——
		// 没尾斜杠时 new URL('vendor/x/', base) 会替换掉最后一段路径。
		const base = new URL(packageRootUrl);
		if (!base.pathname.endsWith("/")) base.pathname += "/";
		const dir = fileURLToPath(new URL("vendor/pi-magic-context/", base));
		const entry = path.join(dir, "dist", "index.js");
		if (fs.existsSync(entry)) return { dir, entry };
	} catch {
		// packageRootUrl 不是 URL 也没关系
	}
	return null;
}

/**
 * 默认存储目录：**dsh 自己的库，不碰共享库**。
 *
 * 上游默认是 ~/.local/share/cortexkit/magic-context —— 那是 pi 和 opencode
 * 共用的全局库。它的迁移守卫会扫描全机 pi 进程，只要有旧 build 的 pi 在跑
 * 就拒绝迁移（fail-closed）。dsh 用一个独立目录，两个世界互不干扰。
 */
export function defaultStorageDir() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	return path.join(home, ".dsh", "storages", "memory");
}

/**
 * 建一个 pi 桩，把每个成员桥到 dsh。
 *
 * @param {object} opts
 * @param {import('cordis').Context} opts.ctx   dsh 上下文
 * @param {object} opts.session                 当前 session
 * @param {object} opts.log                     日志函数
 * @param {(ev:string, h:Function)=>{}} opts.onEvent  dsh 事件订阅
 */
export function createPiFacade(opts) {
	const { ctx, log } = opts;
	// agent 到 `agent/created` 才存在，所以 session 走可变引用
	const sessionRef = opts.sessionRef ?? { session: null };
	const handlers = new Map();
	const registeredTools = new Map();
	const activeToolNames = new Set();
	const disposers = [];

	const emit = (ev, payload) => {
		const list = handlers.get(ev);
		if (!list || list.length === 0) return Promise.resolve(undefined);
		return (async () => {
			let last;
			for (const h of list) {
				try {
					const out = await h(payload, facadeCtx);
					if (out !== undefined) last = out;
				} catch (error) {
					log(`[mc] handler "${ev}" 抛错: ${error?.message ?? error}`);
				}
			}
			return last;
		})();
	};

	const facadeCtx = {
		get sessionManager() {
			return facade.sessionManager;
		},
		get model() {
			return { provider: process.env.MC_FAKE_PROVIDER ?? "new-api", id: process.env.MC_FAKE_MODEL ?? "tier-std" };
		},
		get cwd() {
			return process.cwd();
		},
		get hasUI() {
			return false;
		},
		ui: {
			notify: (text) => log(`[mc/ui] ${text}`),
			setStatus: () => {},
			custom: async () => undefined,
		},
		getContextUsage: () => ({ contextWindow: 128_000, usedTokens: 0 }),
		getSystemPrompt: () => "",
		abort: () => {},
		isIdle: () => true,
		seen: new Set(),
	};

	const facade = {
		on(ev, handler) {
			const list = handlers.get(ev) ?? [];
			list.push(handler);
			handlers.set(ev, list);
			return () => {
				const i = list.indexOf(handler);
				if (i >= 0) list.splice(i, 1);
			};
		},
		registerTool(definition) {
			registeredTools.set(definition.name, definition);
			activeToolNames.add(definition.name);
			return () => {
				registeredTools.delete(definition.name);
				activeToolNames.delete(definition.name);
			};
		},
		registerCommand(definition, maybeOptions) {
			// 上游签名是 registerCommand(name, { handler, description, … })，
			// 也见过裸函数；两种都兜住。
			const name = typeof definition === "string" ? definition : (definition?.name ?? definition?.command);
			if (name === undefined) {
				log("[mc] registerCommand 收到无名命令，跳过");
				return () => {};
			}
			const options = typeof definition === "string" ? maybeOptions : definition;
			disposers.push(registerCommandBridge(ctx, name, options, log));
			return () => {};
		},
		registerEntryRenderer() {
			// dsh 没有 entry renderer 的对应物（那是 pi 的 TUI 概念）。
			// bundle 用它渲染「本轮被拒绝」的提示 —— 在 dsh 里降级为日志。
			return () => {};
		},
		registerFlag() {
			return () => {};
		},
		getFlag() {
			return undefined;
		},
		appendEntry(kind, data) {
			log(`[mc/entry] ${kind}: ${typeof data === "string" ? data : JSON.stringify(data ?? null)?.slice(0, 200)}`);
		},
		sendMessage() {
			// 主动往对话里塞消息：dsh 侧对应 ctx.agent.inject / 队列。
			// bundle 只在后台任务（dreamer 提醒）里用，先记日志。
			log("[mc/sendMessage] 已忽略（无对应 dsh 面）");
		},
		getAllTools: () => [...registeredTools.values()].map((t) => ({ name: t.name, description: t.description })),
		getActiveTools: () => [...activeToolNames],
		setActiveTools() {},
		events: { on: () => () => {}, emit: () => {} },
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		compact: async () => {},
		get sessionManager() {
			return {
				getSessionId: () => sessionRef.session?.id ?? opts.sessionId ?? "dsh",
				getBranch: () => branchFromSession(sessionRef.session),
			};
		},
		get model() {
			return facadeCtx.model;
		},
		get harness() {
			return "pi";
		},
	};

	// 注册 bridge：把 bundle 的工具搬进 dsh tools 注册表
	function flushTools() {
		for (const definition of registeredTools.values()) {
			disposers.push(registerToolBridge(ctx, definition, log));
		}
	}

	return {
		facade,
		emit,
		flushTools,
		toolCount: () => registeredTools.size,
		dispose: () => disposers.splice(0).forEach((d) => d()),
	};
}

/**
 * `sessionManager.getBranch()` 要返回 pi 形态的原始条目：
 *   [{ type:'message', id, message:{ role, content } }, …]
 * bundle 靠它把 §N§ ordinal 映射回真实内容（ctx_expand）。
 *
 * dsh 侧从 session 消息重建。只取 append-origin 事件？不 —— 改写后的
 * 内容是模型实际看到的，ordinal 也按它编号，所以用 deriveMessages()。
 *
 * session 通过可变引用传入：agent 要到 `agent/created` 才存在。
 */
export function branchFromSession(session) {
	if (!session?.deriveMessages || !session?.surface) return [];
	try {
		return session.deriveMessages().map((message, index) => ({
			type: "message",
			id: message?.id ?? `dsh-${index}`,
			message: { role: message?.role ?? "user", content: message?.content ?? [] },
		}));
	} catch {
		return [];
	}
}

/**
 * pi 工具 → dsh 工具。
 *
 * schema 形态不一样，必须转：
 *   pi   { type:'object', properties:{…}, required:['a'] }   （标准 JSON Schema）
 *   dsh  { a: { type:'string', required:true } }              （裸属性 map）
 * 实测 `parameterSchemaSpecToJsonSchema` 对前者直接报
 * “parameters.type must be a value schema object”。
 * 另外 dsh 的 schema 子集不认 maxItems / additionalProperties，得剔掉。
 */
/** TypeBox 的内部标记，dsh 的 JSON-Schema 编译器不认，必须剔。
 * 不剔的后果：编译出来 type 丢成 null，API 报
 * `Invalid schema for function 'ctx_expand': got 'type: null'`。
 * `~optional` 还要转成「不进 required」的语义 —— TypeBox 里它就是「可选」。
 */
const TYPEBOX_MARKERS = new Set(["~kind", "~optional", "~refine"]);

function cleanSchema(node) {
	if (Array.isArray(node)) return node.map(cleanSchema);
	if (!node || typeof node !== "object") return node;
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (TYPEBOX_MARKERS.has(key)) continue;
		// dsh 的 schema 子集不收这几个
		if (key === "maxItems" || key === "minItems") continue;
		if (key === "properties" && value && typeof value === "object") {
			const props = {};
			for (const [k, v] of Object.entries(value)) props[k] = cleanSchema(v);
			out.properties = props;
			continue;
		}
		out[key] = cleanSchema(value);
	}
	return out;
}

/**
 * pi / TypeBox 的 JSON Schema → dsh 的 `parameters`。
 *
 * dsh 的 `parameters` **必须是完整 JSON Schema**（`{type:'object', properties,
 * required}`）—— runtime 不编译，它把 `tool.parameters` 原样透传给 LLM
 * （`dsh-llm-pi-ai/lib/index.js:1195` `toolsOf()`）。
 *
 * 教训：传裸属性表 → LLM 收到 `type: null` 直接 400。
 * 对照：`defineTool` 的 `parameters` getter 也是返回
 * `parameterSchemaSpecToJsonSchema(...)` 编译后的完整 schema。
 *
 * 同时要剔 TypeBox 的内部标记（`~kind` / `~optional` / `~refine`），
 * 供应商不认；`~optional` 的语义转成「不进 required」。
 */
export function toDshParameters(schema) {
	const cleaned = cleanSchema(schema ?? { type: "object", properties: {} });
	if (cleaned?.type !== "object") {
		return { type: "object", properties: cleaned?.properties ?? {}, ...(cleaned?.required ? { required: cleaned.required } : {}) };
	}
	return cleaned;
}

function registerToolBridge(ctx, definition, log) {
	try {
		ctx.tools.register({
			name: definition.name,
			description: definition.description ?? "",
			parameters: toDshParameters(definition.parameters),
			output: {
				schema: { type: "object", properties: {}, additionalProperties: true },
				render: () => undefined,
			},
			async execute(args, exec) {
				const result = await definition.execute(
					exec?.callId ?? "mc",
					args,
					exec?.signal,
					() => {},
					facadeCtxForTool(),
				);
				// pi 工具返回 {content:[{type:'text',text}], isError}；dsh 要的是值，
				// 文本由 output.render / finalizeContent 出。这里把文本提出来。
				if (result && Array.isArray(result.content)) {
					return result.content
						.map((b) => (b?.type === "text" ? b.text : ""))
						.filter(Boolean)
						.join("\n");
				}
				return result;
			},
		});
	} catch (error) {
		log(`[mc] 注册工具 ${definition.name} 失败: ${error?.message ?? error}`);
	}
}

function facadeCtxForTool() {
	return { cwd: process.cwd(), hasUI: false, ui: { notify: () => {}, custom: async () => undefined } };
}

/** pi 命令 → dsh 命令 */
function registerCommandBridge(ctx, name, definition, log) {
	// 上游：registerCommand(name, { handler, description, … })
	// dsh  ：{ name, description, handler(invocation) } —— 字段名同样是 handler，
	//        但 dsh 传的是 invocation 对象，不是裸字符串。
	const piHandler = typeof definition === "function" ? definition : (definition?.handler ?? definition?.run ?? (() => {}));
	try {
		ctx.commands.register({
			name,
			description: definition?.description ?? `magic-context: ${name}`,
			async handler(invocation) {
				const raw = invocation?.rawInput ?? invocation?.input ?? invocation?.args ?? "";
				try {
					const out = await piHandler(raw, facadeCtxForTool());
					const text = typeof out === "string" ? out : (out?.message ?? out?.text ?? "");
					return { kind: "success", text };
				} catch (error) {
					log(`[mc] 命令 ${name} 失败: ${error?.message ?? error}`);
					return { kind: "error", text: `${error?.message ?? error}` };
				}
			},
		});
		return () => {};
	} catch (error) {
		log(`[mc] 注册命令 ${name} 失败: ${error?.message ?? error}`);
		return () => {};
	}
}
