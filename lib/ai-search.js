/**
 * 网页搜索工具（`web_search`）。
 *
 * 为什么要有它：本机 `web_search` / `web_fetch` 长期挂在代理上（HTTP_PROXY 拒连），
 * agent 需要查外部事实时没有可用入口。这个工具把「检索」收在一次调用里：
 * 返回标题 + 链接 + 摘要，答案由调用方自己读页面得出 —— 不再让上游 LLM 代写。
 *
 * 为什么不做成 CLI：CLI 要模型自己拼命令、再从文本里解析结果；工具是结构化
 * 参数和结构化返回，少一次 shell 往返，也少一次解析出错的机会。
 *
 * 为什么走 new-api：SearXNG 自己不鉴权也不计费，直接暴露等于任何人都能白用。
 * 现在它被包成一个 OpenAI 兼容的 chat completion（模型名 `web-search`），
 * 由 new-api 负责鉴权、配额和计费（每次调用固定价 $0.00125，即 800 次 $1）。
 */
export const AI_SEARCH_DEFAULTS = {
	enabled: true,
	/** new-api 的 API 根地址（要带 /v1）；空则读 DSH_SEARCH_URL */
	url: "",
	/** new-api 的令牌 `sk-...`；空则读 DSH_SEARCH_TOKEN */
	token: "",
	/** new-api 侧暴露的模型名，计费按这个模型走 */
	model: "web-search",
	/** 默认召回条数 */
	defaultLimit: 8,
	/** 上限：再多只会把上下文塞满，结果质量并不会更好 */
	maxLimit: 20,
	/** 一次搜索通常 1~5s，给足余量 */
	timeoutMs: 60000,
};

export const AI_SEARCH_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	url: (v) => (typeof v === "string" ? v : undefined),
	token: (v) => (typeof v === "string" ? v : undefined),
	model: (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined),
	defaultLimit: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20 ? v : undefined),
	maxLimit: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 50 ? v : undefined),
	timeoutMs: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1000 ? v : undefined),
};

/** 把结果列表渲染成一段文本：模型看文本，这里的排版决定它引用得对不对。 */
function renderResult(value) {
	if (Array.isArray(value.results) && value.results.length > 0) {
		const parts = [];
		value.results.forEach((r, i) => {
			parts.push(`[${i + 1}] ${r.title}`);
			parts.push(`    ${r.url}`);
			if (r.snippet) parts.push(`    ${r.snippet}`);
			parts.push("");
		});
		if (value.elapsedMs) parts.push(`（${value.results.length} 条结果，耗时 ${(value.elapsedMs / 1000).toFixed(1)}s）`);
		return parts.join("\n").trim();
	}
	if (value.error) return value.error;
	return "（没有搜到结果）";
}

export function installAiSearch(ctx, config = {}) {
	const cfg = { ...AI_SEARCH_DEFAULTS, ...config };
	if (!cfg.enabled) return { enabled: false, status: "已关闭" };

	const base = String(cfg.url || process.env.DSH_SEARCH_URL || "").replace(/\/+$/, "");
	const token = String(cfg.token || process.env.DSH_SEARCH_TOKEN || "");

	if (base === "") {
		return {
			enabled: false,
			status: "没配搜索服务地址：设 DSH_SEARCH_URL（或 team/extensions/ai-search.json 的 url）",
		};
	}

	// 同名工具已经存在 → **跳过注册**，不抛。
	//
	// `dsh-tools` 的 NamedEntries 重名时直接抛（AGENTS.md §7 记过），而抛在 `apply` 里
	// 会让**整个插件**加载失败 —— 不只是这个工具没了，团队基线、小队、面板一起没。
	// 2026-11-08 在 headless profile 上真撞到：desktop 的预设禁用了宿主的 `web_search` 行，
	// 换个 profile 没禁，于是 `web_search is already registered`，整块挂掉。
	//
	// 这里的选择是：宿主已经有 web_search 就用宿主的（它至少比我这个「服务地址没配就不工作」
	// 的版本更可能有配置），并在状态里说清楚为什么没接管。
	const taken = (() => {
		try {
			return typeof ctx.tools?.get === "function" ? ctx.tools.get("web_search") !== undefined : false;
		} catch {
			return false;
		}
	})();
	if (taken) {
		return {
			enabled: false,
			status: "宿主已经有同名工具 web_search（这个 profile 的预设没禁用它的行），跳过注册以免整个插件加载失败",
		};
	}

	ctx.tools.register({
		name: "web_search",
		description:
			"联网搜索网页，返回标题、链接和摘要。适合「最新的 X 是什么」「某项目现在什么状况」「找相关论文」这类你不知道或会过期的外部事实。" +
			"返回 results（每条含 title/url/snippet），需要正文时再用 web_fetch 打开链接。" +
			"不要用它查本机文件或仓库内代码——那些用 grep/read。同一个话题一次搜够，不要每问一句搜一次。",
		parameters: {
			type: "object",
			required: ["query"],
			properties: {
				query: {
					type: "string",
					description: "要搜的问题。用自然语言写完整问题，比堆关键词效果好。",
				},
				limit: {
					type: "number",
					description: `召回多少条结果，默认 ${AI_SEARCH_DEFAULTS.defaultLimit}，上限 ${AI_SEARCH_DEFAULTS.maxLimit}。`,
				},
			},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					query: { type: "string" },
					results: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string" },
								url: { type: "string" },
								snippet: { type: "string" },
								engine: { type: "string" },
							},
						},
					},
					elapsedMs: { type: "number" },
					error: { type: "string" },
				},
			},
			render: (_args, value) => [{ type: "text", text: renderResult(value) }],
		},
		async execute(args, exec) {
			const query = String(args.query ?? "").trim();
			if (query === "") {
				return { query, results: [], error: "query 不能为空" };
			}

			const wanted = Number(args.limit);
			const limit = Number.isFinite(wanted) && wanted > 0
				? Math.min(Math.floor(wanted), cfg.maxLimit)
				: cfg.defaultLimit;

			const signals = [AbortSignal.timeout(cfg.timeoutMs)];
			if (exec?.signal) signals.push(exec.signal);
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

			// 独立的搜索接口：GET {base}/search?q=&limit=，按次计费，返回结果列表。
			try {
				const url = base + "/search?q=" + encodeURIComponent(query) + "&limit=" + limit;
				const res = await fetch(url, {
					headers: token ? { Authorization: "Bearer " + token } : {},
					signal,
				});
				const text = await res.text();
				if (!res.ok) {
					return { query, results: [], error: "搜索服务返回 " + res.status + "：" + text.slice(0, 200) };
				}
				const data = JSON.parse(text);
				return {
					query: String(data.query || query),
					results: (Array.isArray(data.results) ? data.results : []).map((r) => ({
						title: String(r.title || r.url || ""),
						url: String(r.url || ""),
						snippet: String(r.snippet || "").trim(),
						engine: String(r.engine || ""),
					})),
					elapsedMs: Number(data.elapsedMs) || 0,
					...(data.error ? { error: String(data.error) } : {}),
				};
			} catch (e) {
				return { query, results: [], error: "调用搜索服务失败（" + base + "）：" + (e?.message || e) };
			}
		},
	});

	return { enabled: true, status: `已启用 → ${base}（模型 ${cfg.model}）` };
}
