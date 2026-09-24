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
 * 算当前会话的请求压力（token）和窗口大小。
 *
 * 为什么要有这个函数：bundle 靠 `ctx.getContextUsage()` 判断「上下文是不是快满了」，
 * 从而决定要不要折叠（阈值 63%）。这个桩原来写死了 `{contextWindow, usedTokens: 0}`，
 * 字段名对不上导致它恒读 0%，折叠永远不会发生。
 *
 * 数据源按可靠性排序：
 *   `ctx.tokenMeter.measure(session).totalTokens`
 *     dsh 官方计量服务（dsh-base 里 id=token-meter，必定挂载）。它优先复用
 *     provider 上报的 usage，否则按 surface 重算——这是 dsh 自己用来做压缩
 *     决策的同一个数，不是我们猜的。
 *   `session.requestContext().contextWindow`
 *     路由声明的窗口大小。拿不到时退回 `MC_CONTEXT_WINDOW` 环境变量，
 *     最后兜底 128000（tier-std 的值）。窗口只影响百分比换算，不影响有无。
 *
 * 拿不到就返回 null，让 bundle 走它自己的「no usage info yet」分支并跳过本轮——
 * 比报一个 0% 好：0% 会被当成「上下文是空的」，是一个假的确定值。
 *
 * @returns {{tokens:number, contextWindow:number}|null}
 */
export function measureSessionTokens(ctx, session, log = () => {}) {
	let tokens;
	// 用 ctx.get("tokenMeter") 而不是直接读 ctx.tokenMeter：cordis 的 ctx 是访问器代理，
	// 没 inject 的服务直接读会【抛】「cannot get property \"tokenMeter\" without inject」，
	// 不是返回 undefined（这条已经用探针验过了）。插件在进程启动早期就 apply，
	// 不该为了一个可选服务把 token-meter 挂进必需依赖（那样没装就整个插件起不来）。
	// ctx.get 是官方的「不需要 inject 地读取服务」口子（cordis reflect.d.ts）。
	let meter;
	try {
		meter = ctx?.get?.("tokenMeter");
	} catch (error) {
		log(`[mc] 读 tokenMeter 失败: ${error?.message ?? error}`);
	}
	try {
		tokens = meter?.measure?.(session)?.totalTokens;
	} catch (error) {
		log(`[mc] tokenMeter.measure 抛错: ${error?.message ?? error}`);
	}
	if (!Number.isFinite(tokens)) {
		try {
			// 没有 token-meter 时退一步：按可见消息粗略估。宁可粗略也不要 0。
			const messages = session?.deriveMessages?.() ?? [];
			const chars = messages.reduce((sum, m) => sum + textOfMessage(m).length, 0);
			tokens = chars > 0 ? Math.ceil(chars / 3.5) : undefined;
		} catch {
			tokens = undefined;
		}
	}
	if (!Number.isFinite(tokens)) return null;

	let contextWindow;
	try {
		contextWindow = session?.requestContext?.()?.contextWindow;
	} catch {
		contextWindow = undefined;
	}
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		const configured = Number(process.env.MC_CONTEXT_WINDOW);
		contextWindow = Number.isFinite(configured) && configured > 0 ? configured : 128_000;
	}
	return { tokens, contextWindow };
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

	// pi 的命令 handler **不 return 正文**：它把正文交给 UI 通道
	// （`pi.appendEntry(type, {title, text})` 或 `ctx.ui.notify(text)`），
	// 自己返回 undefined。dsh 的命令恰好相反 —— 正文靠 handler 的返回值。
	//
	// 不开这个捕获窗口，7 个命令在 dsh 里全是哑的：`kind: "success"` 配一个
	// 空字符串。实测 /ctx-status 本来算出了完整状态面板
	// （`Magic Context Status\nContext: 0.0% of usable context …`），
	// 桥接层把它丢了，一个字都没显示。
	const entryCapture = [];

	/** 正文可能来自 appendEntry 的 `{text}` / 裸字符串，或 ui.notify 的字符串。 */
	const captureEntryText = (value) => {
		const text = typeof value === "string" ? value : value?.text;
		if (typeof text !== "string" || text.length === 0) return;
		entryCapture.at(-1)?.push(text);
	};

	/**
	 * 在捕获窗口内跑 `run`，把窗口期间命令发出的正文一并收走。
	 *
	 * 用栈而不是单个变量：窗口可能嵌套（命令里再触发命令/后台流程），
	 * finally 里必定弹出，异常路径也不会把窗口留在栈上。
	 */
	async function captureEntries(run) {
		const bucket = [];
		entryCapture.push(bucket);
		try {
			return { result: await run(), text: bucket.join("\n\n") };
		} finally {
			entryCapture.pop();
		}
	}

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
			notify: (text) => {
				captureEntryText(text);
				log(`[mc/ui] ${text}`);
			},
			setStatus: () => {},
			custom: async () => undefined,
		},
		// ★ 这里必须是 bundle 读的那三个字段名，不是我们自己想当然的名字。
		//
		// bundle 的触发评估（vendor/pi-magic-context/dist/index.js:30409）读的是：
		//   piUsage.tokens / piUsage.percent / piUsage.contextWindow
		// 我们原来返回 {contextWindow, usedTokens} —— `usedTokens` 对不上 `tokens`，
		// 于是 tokens 和 percent 都是 undefined，拿不到 session_meta 时
		// 占用率恒为 0%，而折叠阈值是 63%：**永远不会触发**。
		// 日志里就是这个样子：
		//   historian trigger eval: usage=0.0% (0 tokens) [piUsage fallback]
		//   compartment trigger: not firing at 0.0% — below proactive floor (63%)
		// 表现就是用户看到的：只有注入，从不折叠。
		//
		// 真实数据来源（两处都是权威值，优先 provider 实测）：
		//   1. ctx.tokenMeter.measure(session).totalTokens —— dsh 官方计量服务，
		//      优先复用 provider 上报的 usage，否则按 surface 重算
		//   2. session.requestContext().contextWindow —— 路由声明的窗口
		// 两者都拿不到时返回 null：bundle 会走「no usage info yet」并跳过本轮，
		// 这比报 0% 诚实——0% 会被当成「上下文是空的」，是一个假的确定值。
		getContextUsage: () => {
			const session = sessionRef.session;
			if (session === null || session === undefined) return null;
			const measure = measureSessionTokens(ctx, session, log);
			if (measure === null) return null;
			const { tokens, contextWindow } = measure;
			if (!Number.isFinite(tokens) || tokens <= 0) return null;
			const percent = Number.isFinite(contextWindow) && contextWindow > 0 ? (tokens / contextWindow) * 100 : null;
			return { tokens, percent, contextWindow };
		},
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
			disposers.push(registerCommandBridge(ctx, name, options, log, facadeCtx, captureEntries));
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
			// 命令的正文就是从这里出来的（见 captureEntries 的注释）。
			captureEntryText(data);
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
			disposers.push(registerToolBridge(ctx, definition, log, facadeCtx));
		}
	}

	return {
		facade,
		emit,
		flushTools,
		toolCount: () => registeredTools.size,
		/** bundle 看到的那一面（测桩用，比如断言 getContextUsage 的字段名）。 */
		facadeCtx,
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

/**
 * pi 工具 → dsh 工具。
 *
 * ⚠️ `toolCtx` **必须**是 facadeCtx，不能另造一个精简的。
 *
 * 曾经的写法是这里现造 `{cwd, hasUI, ui}` —— 结果 bundle 的 6 个 `ctx_*` 工具
 * **全部 100% 报错**：它们第一件事就是 `ctx.sessionManager.getSessionId()`，
 * 而精简 ctx 上没有 `sessionManager`，于是抛
 *   TypeError: Cannot read properties of undefined (reading 'getSessionId')
 * 被 bundle 的 try/catch 包成 `isError: true`。
 *
 * 这个 bug 藏了很久，因为报错长得像「工具本身有问题」：审计日志里 17 次
 * ctx_memory、8 次 ctx_search、6 次 ctx_note、5 次 ctx_reduce 全是 isError，
 * 而它们的结果长度全都是 67 字节（= `Error: Cannot read properties of
 * undefined (reading 'getSessionId')` 的 sha256 一模一样）。
 * 记忆功能整个是死的，但表面上「工具在、命令在、注入也在」。
 *
 * 用 facadeCtx 而不是补一个假的 sessionManager：facadeCtx 的
 * `sessionManager` 是 getter，跟着 `sessionRef` 走 —— agent 出现后自动是
 * 真 session（真 id、真 branch），不需要在这里重算一遍。
 */
function registerToolBridge(ctx, definition, log, toolCtx) {
	try {
		ctx.tools.register({
			name: definition.name,
			description: definition.description ?? "",
			parameters: toDshParameters(definition.parameters),
			// 契约要点（`@deepseek-ai/dsh-tools` `createSuccessResult`，index.js:3415）：
			// `execute` 返回的是 **value**，要先过 `output.schema` 校验，再交给
			// `output.render(args, value)` 出文本。三者必须自洽。
			//
			// 曾经的写法是 schema 声明 object、`execute` 却直接返回字符串、`render`
			// 返回 undefined —— 校验当场失败，模型收到的是
			//   tool "ctx_note" returned invalid output: "value" must be an object
			// 工具能跑通、ctx 也传对了，但**一个字都到不了模型**。
			// 对照：lib/lens.js 的 lens_check 是同一套契约的正确写法。
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { text: { type: "string" } },
				},
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args, exec) {
				const result = await definition.execute(
					exec?.callId ?? "mc",
					args,
					exec?.signal,
					() => {},
					toolCtx,
				);
				const text = piResultText(result);
				// 契约要点之三：pi 用 **返回值里的 `isError`** 表示失败，dsh 用
				// **抛错**表示失败。`createSuccessResult` 给每个返回值盖章
				// `isError: false`（dsh-tools index.js:3439），失败态是
				// `toolErrorResult` 在 catch 里给的（index.js:3195）。
				// 桥接不转这一下，bundle 那 7 处 `isError: true`
				// （如 index-5tw61yhp.js:38608 query 缺失）就全成了成功结果 ——
				// 审计日志用 `block.isError` 判失败（lib/audit.js:314），失败从此
				// 在日志里查无此错，正是 bug #1 藏了那么久的那个原因。
				if (result?.isError) throw new Error(stripDshErrorPrefix(text));
				return { text };
			},
		});
	} catch (error) {
		log(`[mc] 注册工具 ${definition.name} 失败: ${error?.message ?? error}`);
	}
}

/**
 * pi 工具返回值 → 给模型看的纯文本。
 *
 * pi 的形状是 `{content:[{type:'text',text}], isError}`；非文本块（图片等）
 * 忽略。拿不到已知形状时退化成整段 JSON —— 宁可显示得丑，也不能把内容吞掉。
 */
function piResultText(result) {
	if (typeof result === "string") return result;
	if (result && Array.isArray(result.content)) {
		return result.content
			.map((b) => (b?.type === "text" ? b.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	if (result === undefined || result === null) return "";
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

/**
 * 剥掉 pi 失败文本自带的 `Error: ` 前缀，交给 dsh 重新拼一层。
 *
 * dsh 的失败结果统一由 `toolErrorResult` 拼 `Error: ${message}`
 * （dsh-tools index.js:3496），而 bundle 的失败文本本身已经写成
 * `Error: 'query' is required.`。不剥一层，模型看到的是
 * `Error: Error: 'query' is required.` —— 同一句话说两遍。
 */
function stripDshErrorPrefix(text) {
	const prefix = "Error: ";
	return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * pi 命令 → dsh 命令。
 *
 * 同样必须传 facadeCtx（理由见 registerToolBridge 的注释）：bundle 的命令
 * handler 也要 `ctx.sessionManager.getSessionId()`，精简 ctx 会让 7 个
 * `/ctx-*` 命令一起废掉。
 *
 * 但 ctx 传对了还不够 —— pi 的命令 handler **不 return 正文**，正文走
 * `pi.appendEntry` / `ctx.ui.notify` 这些 UI 通道，dsh 却只认 handler 的
 * 返回值。所以正文要开捕获窗口从那条通道捞回来（见 captureEntries）。
 * 分开的两件事：传对 ctx 让命令**不报错**，开捕获窗口让命令**有输出**。
 */
function registerCommandBridge(ctx, name, definition, log, cmdCtx, capture) {
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
					const { result: out, text: emitted } = await capture(() => piHandler(raw, cmdCtx));
					// UI 通道来的正文优先：它才是命令真正的答复。返回值只作兜底，
					// 少数命令（比如 /todos 在无 UI 环境下）会直接 return 一句话。
					const returned = typeof out === "string" ? out : (out?.message ?? out?.text ?? "");
					return { kind: "success", text: emitted || returned };
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
