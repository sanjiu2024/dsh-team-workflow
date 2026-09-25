/**
 * pi-lens 全套工具移植到 dsh —— 不改 pi-lens 源码，靠「假 pi 宿主」把它注册的工具截下来，
 * 转成 dsh 的 tool definition 再注册。
 *
 * 为什么不走 MCP：dsh 里根本没有 MCP（`ctx.tools.register` 是唯一入口）。
 *
 * ── 为什么默认不注册 13 个，而是全走后门 ────────────────────────────────
 * 13 个工具声明合计 18,773 字符 ≈ 7,509 tok。dsh 的工具是**每次请求全量重发**的
 * （审计日志实测：地板 9,984 tok 占账单 25%）。全常驻 = 地板 +75%，
 * 按 1570 次调用、cacheRead 0.1x 折算 = 真实成本 **+8.71%**。
 *
 * 而 `lens_check` 在 2092 次工具调用里只被用过 1 次。为一个 0.05% 使用率的能力
 * 花 8.71%，是明确的亏本。
 *
 * pi-lens 自己在 pi 里就是分级的：8 个常驻 + 5 个「情境工具」由
 * `pi_lens_activate_tools` 按需点亮。但那个机制依赖 `pi.getActiveTools()`——
 * dsh 没有这个 API，照搬不了。
 *
 * 所以这里只用**一个**工具当入口（`lens_tools`，声明 ~250 字符 ≈ 100 tok），
 * 13 个真工具全部由它在运行时注册/撤销（`tools.register` 返回 disposer，
 * 官方 `dsh-schedule` 就是这么做的）。
 *
 *   - 不激活 → 地板只 +0.19%，能力一个没少（只是要多一次调用去点亮）
 *   - 激活后 → 下一请求起 13 个工具全部在场（`systemPrompt.assemble` 每步现读活注册表）
 *   - 回合结束 → 自动撤销，地板回落
 *
 * 转录视图（transcriptView）不受影响：这里只动工具注册表，不碰渲染。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

export const LENS_TOOLS_DEFAULTS = {
	/** 关掉就回到老行为：只有 lens_check，一个 pi-lens 工具也不接 */
	enabled: true,
	/** pi-lens 目录覆盖。空 = 按 vendor → ~/.pi 的顺序自动找 */
	path: "",
};

/** 字段校验器：返回 undefined = 不采纳（落回默认），与其它扩展同一约定 */
export const LENS_TOOLS_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	path: (v) => (typeof v === "string" ? v.trim() : undefined),
};

/** dsh 参数 DSL 只认这些关键字；超纲的会被 assertSupportedJsonSchema 拒掉 */
const SCHEMA_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"examples",
]);

/**
 * pi-lens 用到但 dsh 不认的关键字，逐个给出等价替代。
 * 实测只有 3 类 6 处（ast_grep_* 的 paths、lens_diagnostics 的 paths/refreshRunners、
 * pi_lens_activate_tools 的 tools）。
 */
function sanitizeSchema(node) {
	if (!node || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map((item) => sanitizeSchema(item));
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "properties") {
			// properties 的 key 是属性名，不是关键字 —— 必须整个保留，只洗它的值
			const props = {};
			for (const [name, schema] of Object.entries(value ?? {})) props[name] = sanitizeSchema(schema);
			out.properties = props;
			continue;
		}
		if (key === "anyOf") {
			// dsh 只有 oneOf。pi-lens 只用 anyOf 表达「boolean 或 enum 字符串」，
			// oneOf 语义等价（两个分支互斥）。
			out.oneOf = (value ?? []).map((item) => sanitizeSchema(item));
			continue;
		}
		// minItems / maxItems 不用显式处理：下面的白名单（SCHEMA_KEYWORDS）里就没它们，
		// 会自动丢掉。丢掉只少一层本地数量校验，工具内部照样会挡。
		if (!SCHEMA_KEYWORDS.has(key)) continue;
		if (key === "items" || key === "oneOf") out[key] = sanitizeSchema(value);
		else out[key] = value;
	}
	return out;
}

/**
 * pi-lens 自己的启动器：它靠 `pi.getActiveTools()` 点亮 pi 的惰性工具。
 * dsh 没有那个 API，而且这里已经由 `lens_tools` 接管点亮 —— 留着它只会让模型
 * 以为调它有用（实际是空操作），所以直接剔除，省 419 字符。
 */
const PI_HOST_ONLY_TOOLS = new Set(["pi_lens_activate_tools"]);

/** 声明体积：模型看到的实际字符数（description + 参数 schema） */
function declSize(tool) {
	return (tool.description ?? "").length + JSON.stringify(tool.parameters ?? {}).length;
}

/**
 * 加载 pi-lens 并截获它注册的工具。
 * @returns {Promise<{tools: Array, dispose: () => void}|null>}
 */
async function captureTools(dir, warn) {
	const entry = path.join(dir, "dist", "index.js");
	if (!fs.existsSync(entry)) {
		warn(`[team:lens-tools] 找不到 ${entry}`);
		return null;
	}
	const captured = [];
	const noop = () => {};
	// pi 宿主是**同步**调 registerTool 的，所以把 default export 拿到手后要先给它假宿主，
	// 再才能读 captured。await import 之后再调。
	const host = new Proxy(
		{
			registerTool(tool) {
				if (tool && typeof tool.name === "string" && !PI_HOST_ONLY_TOOLS.has(tool.name)) captured.push(tool);
			},
			// getFlag 必须恒 false：`no-lsp` 是 negated flag，默认 false = LSP 启用。
			// 返回真值会把 LSP 关掉。
			getFlag: () => false,
			registerFlag: () => ({ get: () => undefined }),
			hasTool: () => false,
			getActiveTools: () => [],
			log: noop,
			warn: noop,
			error: noop,
		},
		{
			get(target, key) {
				if (key in target) return target[key];
				// then 必须显式返回 undefined：兜底返回的是可调用函数，而 await 会先
				// 探测 `host.then` —— 探到函数就当 thenable 去调，它却永远不 resolve，
				// `await mod.default?.(host, {})` 就永久挂住（不抛错、不走降级分支）。
				if (key === "then") return undefined;
				// 其余 pi API（on/settings/events…）一律给个吞掉调用的空壳，
				// 免得 pi-lens 初始化时炸在半路。
				return () => ({ get: noop, set: noop, on: noop, off: noop });
			},
		},
	);

	let mod;
	try {
		// 用 pathToFileURL 而不是手拼 `file://${p}`：手拼不会转义空格和 # 之类的字符。
		// 本仓库路径就带空格（`deepseek harness cj`），靠浏览器式解析碰巧能过，
		// 但含 # 的目录会被当 fragment 截掉 —— 直接找不到模块。
		mod = await import(pathToFileURL(entry).href);
	} catch (error) {
		warn(`[team:lens-tools] pi-lens 加载失败：${error?.message ?? error}`);
		return null;
	}
	try {
		await mod.default?.(host, {});
	} catch (error) {
		warn(`[team:lens-tools] pi-lens 初始化失败：${error?.message ?? error}`);
		return null;
	}
	if (captured.length === 0) {
		warn("[team:lens-tools] pi-lens 没注册任何工具");
		return null;
	}
	return { tools: captured };
}

/**
 * 把 pi-lens 工具对象转成 dsh 的 tool definition。
 *
 * 关键差异：
 *   - 参数：pi-lens 是标准 JSON Schema，dsh 是它自己的子集 → sanitizeSchema
 *   - execute：pi-lens 的签名是 execute(ctx, args)，ctx 要 {cwd:字符串}；
 *     dsh 是 execute(args, exec)，cwd 在 exec.agent.session.header.cwd
 *   - 返回值：pi-lens 返回 {content:[{type,text}]}；dsh 的 output.schema 是
 *     object-root，所以包成 {text} 再由 render 摊成文本
 */
function toDshTool(tool, ctx, stats) {
	return {
		name: tool.name,
		description: tool.description ?? tool.name,
		parameters: sanitizeSchema(tool.parameters ?? { type: "object", properties: {} }),
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string" } },
			},
			render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
		},
		async execute(args, exec) {
			stats.calls += 1;
			// pi-lens 要的 ctx：cwd 必须是字符串（它内部直接拼路径，不是函数）
			const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
			const lensCtx = {
				cwd,
				pi: null,
				log: () => {},
				warn: (m) => ctx.logger.warn(`[team:lens-tools] ${m}`),
				error: (m) => ctx.logger.warn(`[team:lens-tools] ${m}`),
				hasTool: () => false,
			};
			try {
				const result = await tool.execute(lensCtx, args ?? {});
				return { text: renderPiResult(result) };
			} catch (error) {
				stats.errors += 1;
				return { text: `pi-lens 工具 ${tool.name} 执行失败：${error?.message ?? error}` };
			}
		},
	};
}

/** pi-lens 的返回是 {content:[{type:"text",text}]}，摊成纯文本 */
function renderPiResult(result) {
	if (typeof result === "string") return result;
	if (result && Array.isArray(result.content)) {
		return result.content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	if (result === undefined || result === null) return "（无输出）";
	return JSON.stringify(result, null, 1);
}

/**
 * @param {object} ctx cordis 上下文
 * @param {string} packageRootUrl 包根 URL
 * @param {object} config 覆盖配置（`.dsh/team-workflow/extensions/lens-tools.json`）
 */
export function installLensTools(ctx, packageRootUrl, config = {}) {
	const dir = resolveLensDir(packageRootUrl, config.path);
	if (!dir) return { enabled: false, status: "未找到 pi-lens，工具集未接入" };

	const stats = { calls: 0, errors: 0, activations: 0, captured: 0 };
	/** 本次激活期内已注册的工具 disposer */
	let disposers = [];
	/**
	 * 点亮这批工具的 agents。
	 *
	 * 为什么必须记住是谁点亮的：本插件注册在**根作用域**（bundle 级），而
	 * dsh-scope 的规则是「带祖先标签的监听者会收到派发到后代 key 的事件」——
	 * 所以我们这个 ctx.on 能看到**同进程每一个 agent** 的事件，包括子代理
	 * （dsh 的子代理是同进程的：dsh-subagent-in-process-driver 里就是
	 * `parent.ctx.agents.create(...)`）。
	 *
	 * 用**集合**而不是单个 owner：dsh 的工具注册表是全局的，一个名字只有一个
	 * 槽位。父子两个 agent 都调过 activate，实际只有第一份注册生效，但它俩都
	 * 「用着」这批工具。若只记一个 owner，后点的那个一结束就把工具全撤了，
	 * 先点的那个下一步就找不到工具。
	 *
	 * 而且每人要的集合**可以不一样**（A 只要 2 个，B 要全部）。所以不能「谁最后
	 * 点谁说了算」—— 那样 A 后点一个子集就会把 B 的 12 个挤掉。正确的是维持
	 * 不变式：**在场面 = 所有人需求集的并集**，每次需求变动都按并集重建。
	 */
	const owners = new Map();
	/** 最近一次 captureTools 拿到的全部工具（按名字索引），reconcile 重建时要用 */
	let available = new Map();

	/** 把所有注册物理拆掉（不动 owners）：注册表是全局的，拆了就是所有人一起没。 */
	const teardown = () => {
		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch (error) {
				ctx.logger.warn(`[team:lens-tools] 撤销失败：${error?.message ?? error}`);
			}
		}
		disposers = [];
	};

	/**
	 * 把在场工具重建为「所有人需求的并集」。
	 *
	 * 必须先 teardown 再注册：同一个名字已挂着时再 `ctx.tools.register` 会抛
	 * duplicate。全拆重建也顺带让「子集变并集」这类变更自然收敛。
	 *
	 * 重建会把**所有** owner 的工具重新注册一遍（即使只是某一个人的集合变了）。
	 * 代价是几次 register，换来的是任何调用顺序下都只有一个正确答案 ——
	 * 增量 diff 会引入「谁先谁后」的分支，而这类分支正是 P2 那个 bug 的温床。
	 */
	const reconcile = () => {
		const wanted = new Set();
		for (const names of owners.values()) for (const name of names) wanted.add(name);
		teardown();
		if (wanted.size === 0) return [];
		const registered = [];
		for (const name of wanted) {
			const tool = available.get(name);
			if (!tool) continue;
			try {
				disposers.push(ctx.tools.register(toDshTool(tool, ctx, stats)));
				registered.push(name);
			} catch (error) {
				ctx.logger.warn(`[team:lens-tools] 注册 ${name} 失败：${error?.message ?? error}`);
			}
		}
		return registered;
	};

	/**
	 * 某个 agent 不再需要工具了：删掉它的需求，剩下的按并集重建。
	 * 还有别人在用就只销掉它那部分。`agent === null`（拿不到身份）没法判断，
	 * 只能全部释放。
	 */
	const releaseOwner = (agent = null) => {
		if (agent !== null) owners.delete(agent);
		else owners.clear();
		reconcile();
	};

	/**
	 * 这个事件该不该触发撤销。
	 *
	 * 只有点亮过工具的 agent 的回合结束/转 idle 才该撤 —— 否则一个子代理
	 * 跑完就会把父代理的 LSP 工具拔掉（两者同进程共享一份根作用域注册表）。
	 *
	 * 身份对不上就不动：漏撤的代价是工具常驻到下次启动，误撤的代价是
	 * 正常干活的 agent 突然没了工具、命令直接失败。
	 */
	const ownedBy = (payload) => owners.size > 0 && (payload?.agent === undefined || owners.has(payload.agent));

	ctx.tools.register({
		name: "lens_tools",
		description:
			"按需点亮 pi-lens 的代码情报工具（符号搜索、模块/项目结构、AST 检索与替换、LSP 跳转/引用/hover）。这些工具默认不在场，先调本工具点亮，再在下一步使用；点亮状态在当前回合内保持。也有 lens_check 可直接用。",
		parameters: {
			type: "object",
			required: ["action"],
			properties: {
				action: {
					type: "string",
					enum: ["list", "activate", "deactivate"],
					description:
						"list = 只列出可用工具和说明；activate = 点亮（配 tools）；deactivate = 立刻撤销、让地板回落。",
				},
				tools: {
					type: "array",
					items: { type: "string" },
					description:
						"activate 时要点亮的工具名。省略 = 点亮全部。可用名字见 action=list 的输出。",
				},
			},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string" } },
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		async execute(args, exec) {
			// exec.agent 是调这个工具的 agent（dsh-tool-fs 也这么取 cwd）。
			// dsh 在 dsh-agent-loop/lib/index.js:517 无条件塞入 `agent:
			// ctx.agents.requireInitiator()`，而 requireInitiator 在拿不到 initiator 时
			// 直接抛 —— 所以它**必然在场**，`?? null` 只是为了不依赖这个内部细节。
			const agent = exec?.agent ?? null;
			if (args.action === "deactivate") {
				releaseOwner(agent);
				return { text: "已撤销 pi-lens 工具，后续请求的地板回到基线。" };
			}
			const captured = await captureTools(dir, (m) => ctx.logger.warn(m));
			if (!captured) return { text: "pi-lens 不可用（加载失败或没找到），工具集未接入。" };

			const all = captured.tools;
			available = new Map(all.map((t) => [t.name, t]));
			if (args.action === "list") {
				const rows = all
					.map((t) => `  ${t.name.padEnd(24)} ${trimSnippet(t.description)}`)
					.sort()
					.join("\n");
				return { text: `可用 ${all.length} 个 pi-lens 工具：\n${rows}\n\n用 action=activate 点亮（可带 tools 只点亮子集）。` };
			}

			// activate
			const wanted = Array.isArray(args.tools) && args.tools.length > 0 ? new Set(args.tools) : null;
			// 记下这个人要哪些，然后按「所有人需求的并集」重建。
			// 全量激活就用全名集，子集就记子集 —— 后点的子集不会挤掉别人要的。
			const picked = wanted ? all.filter((t) => wanted.has(t.name)) : all;
			if (picked.length === 0) {
				const known = all.map((t) => t.name).join(", ");
				return { text: `没有匹配的工具。可用名字：${known}` };
			}
			owners.set(agent, new Set(picked.map((t) => t.name)));
			const registered = reconcile();
			stats.activations += 1;
			stats.captured = all.length;
			const extra = Math.round(registered.reduce((sum, name) => sum + declSize(all.find((t) => t.name === name)), 0) / 2.5);
			return {
				text:
					`已点亮 ${registered.length} 个工具：${registered.join(", ")}。\n` +
					`这些工具从**下一个请求**起可用；声明体积 +${extra} tok/次。用完请 action=deactivate 把地板降回来。`,
			};
		},
	});

	// 回合结束撤销。两个事件都要挂 —— 它们覆盖的路径不重合：
	//
	//   `agent/turn-stopping`（走 dispatch.serial，`cb(...args)` 直接调，不是
	//   waterfall，**没有 next**）：正常跑完一个回合。
	//
	//   `agent/status`→idle：**中断/报错时的唯一兜底**。dsh-agent-loop 只在正常
	//   分支 dispatch turn-stopping（lib/index.js:967）；一旦 signal.throwIfAborted()
	//   抛了（用户按 Esc）就直接跳 catch/finally，那个 dispatch 根本不会执行。
	//   而 setPhase({kind:"idle"}) 在驱动循环的 finally 里（lib/index.js:877），
	//   不管怎么结束都会跑到。少了这条，按一次 Esc 就让 12 个工具永久常驻。
	//
	//   `agent/disposed`：最后一道保险。agent 都没了，它点亮的工具当然该撤。
	//   正常情况下 idle 先跑（子代理驱动是 `await child.whenIdle()` 之后才 dispose），
	//   所以这条平时不会额外做什么；但 idle 与 dispose 之间隔着异步（announcing /
	//   detachRequested 会推迟派发），会话被直接关掉时可能只走 dispose。
	//   兜底成本为零，漏撤的代价是工具永久常驻。
	ctx.on("agent/turn-stopping", (payload) => {
		if (ownedBy(payload)) releaseOwner(payload?.agent ?? null);
	});
	ctx.on("agent/status", (payload) => {
		if (payload?.status === "idle" && ownedBy(payload)) releaseOwner(payload?.agent ?? null);
	});
	ctx.on("agent/disposed", (payload) => {
		if (ownedBy(payload)) releaseOwner(payload?.agent ?? null);
	});

	return {
		enabled: true,
		dir,
		status: `已接入 ${dir}（12 个工具按需点亮；入口 lens_tools）`,
		stats,
	};
}

function trimSnippet(text) {
	const one = String(text ?? "").replace(/\s+/g, " ").trim();
	return one.length > 78 ? `${one.slice(0, 77)}…` : one;
}

/** 只在 pi-lens 目录层面复用 lens.js 的解析序，避免两处逻辑漂移 */
function resolveLensDir(packageRootUrl, override) {
	const candidates = [];
	if (typeof override === "string" && override !== "") candidates.push(override);
	try {
		candidates.push(fileURLToPath(new URL("vendor/pi-lens", packageRootUrl)));
	} catch {
		// 非 URL baseUrl：跳过
	}
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	candidates.push(path.join(home, ".pi", "agent", "npm", "node_modules", "pi-lens"));
	candidates.push(path.join(home, ".pi", "npm", "node_modules", "pi-lens"));
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "dist", "index.js"))) return dir;
	}
	return null;
}

export { sanitizeSchema, renderPiResult };
