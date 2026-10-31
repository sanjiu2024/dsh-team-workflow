/**
 * AI 搜索工具（`ai_search`）。
 *
 * 为什么要有它：本机 `web_search` / `web_fetch` 长期挂在代理上（HTTP_PROXY 拒连），
 * agent 需要查外部事实时没有可用入口。这个工具把「检索 + 读页 + 生成带引用答案」
 * 收在一次调用里，返回结构化的 answer + sources，模型拿到就能直接用。
 *
 * 为什么不做成 CLI：CLI 要模型自己拼命令、再从文本里解析引用编号；工具是结构化
 * 参数和结构化返回，少一次 shell 往返，也少一次解析出错的机会。
 *
 * 为什么地址走配置/环境变量：那台搜索服务器是私人的，写死进仓库等于公开。
 */
export const AI_SEARCH_DEFAULTS = {
	enabled: true,
	/** 搜索服务地址；空则读 DSH_SEARCH_URL */
	url: "",
	/** 服务端令牌；空则读 DSH_SEARCH_TOKEN（服务端没开鉴权时都可以不填） */
	token: "",
	/** 默认召回条数 */
	defaultLimit: 6,
	/** 上限：再多只会把上下文塞满，答案质量并不会更好 */
	maxLimit: 10,
	/** 一次问答实测 10~20s，给足余量 */
	timeoutMs: 180000,
};

export const AI_SEARCH_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	url: (v) => (typeof v === "string" ? v : undefined),
	token: (v) => (typeof v === "string" ? v : undefined),
	defaultLimit: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10 ? v : undefined),
	maxLimit: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20 ? v : undefined),
	timeoutMs: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1000 ? v : undefined),
};

/** 把答案和来源渲染成一段文本：模型看文本，这里的排版决定它引用得对不对。 */
function renderResult(value) {
	const parts = [value.answer || "（没有生成答案）"];
	if (Array.isArray(value.sources) && value.sources.length > 0) {
		parts.push("");
		parts.push("来源：");
		value.sources.forEach((s, i) => {
			parts.push(`[${i + 1}] ${s.title}`);
			parts.push(`    ${s.url}`);
		});
	}
	if (value.elapsedMs) parts.push("", `（耗时 ${(value.elapsedMs / 1000).toFixed(1)}s）`);
	return parts.join("\n");
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

	ctx.tools.register({
		name: "ai_search",
		description:
			"联网搜索并直接给出带引用的答案。适合「最新的 X 是什么」「某项目现在什么状况」「找相关论文」这类你不知道或会过期的外部事实。" +
			"返回 answer（正文，内含 [1][2] 形式的引用编号）+ sources（编号对应的标题与链接）。" +
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
					description: `召回多少条来源，默认 ${AI_SEARCH_DEFAULTS.defaultLimit}，上限 ${AI_SEARCH_DEFAULTS.maxLimit}。`,
				},
			},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					answer: { type: "string" },
					sources: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string" },
								url: { type: "string" },
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
				return { answer: "", sources: [], error: "query 不能为空" };
			}

			const wanted = Number(args.limit);
			const limit = Number.isFinite(wanted) && wanted > 0
				? Math.min(Math.floor(wanted), cfg.maxLimit)
				: cfg.defaultLimit;

			const url = `${base}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
			const signals = [AbortSignal.timeout(cfg.timeoutMs)];
			if (exec?.signal) signals.push(exec.signal);
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

			try {
				const res = await fetch(url, {
					headers: token ? { Authorization: `Bearer ${token}` } : {},
					signal,
				});
				const text = await res.text();
				if (!res.ok) {
					return {
						answer: "",
						sources: [],
						error: `搜索服务返回 ${res.status}：${text.slice(0, 200)}`,
					};
				}
				const data = JSON.parse(text);
				return {
					answer: String(data.answer || "").trim(),
					sources: (Array.isArray(data.sources) ? data.sources : []).map((s) => ({
						title: String(s.title || s.url || ""),
						url: String(s.url || ""),
					})),
					elapsedMs: Number(data.elapsedMs) || 0,
					...(data.error ? { error: String(data.error) } : {}),
				};
			} catch (e) {
				return {
					answer: "",
					sources: [],
					error: `调用搜索服务失败（${base}）：${e?.message || e}`,
				};
			}
		},
	});

	return { enabled: true, status: `已启用 → ${base}` };
}
