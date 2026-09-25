/**
 * context7 文档查询 —— 直连 HTTP API，不走 MCP（dsh 里也没有 MCP）。
 *
 * API 是公开免 key 的（用户已确认免费额度够用）：
 *   搜索  GET https://context7.com/api/v1/search?query=<q>         → {results:[...]}
 *   文档  GET https://context7.com/api/v1<id>?type=txt&tokens=<n>  → 纯文本
 *
 * ── 为什么是「一个工具」而不是「搜索 + 取文档」两个 ──────────────────────
 * dsh 每一步都要把整份历史重发一遍。多一次工具调用 = 多一整个 step ≈ 5,437
 * 等效 token（实测每步 p50 54,366 计费 × cacheRead 0.1x）。而多注册一个工具的
 * 声明只值 ~120 tok × 0.1 = 12 等效 token/次。差 45 倍。
 *
 * 所以这里只暴露一个 `docs`：内部自己先搜后取，一次调用拿到最终文档。
 *
 * ── token 旋钮 ───────────────────────────────────────────────────────────
 * `tokens` 参数是官方给出的长度旋钮，但它**不是字符上限**：实测 chars/token
 * 随 tokens 增长（见下面 maxChars 的注释）。默认 2000 ≈ 7,800 字符，
 * 正好在每步新增内容的 p90 附近。
 *
 * ⚠️ `topic` 参数实测**不省反增**（routing 36,989 / middleware 40,974），
 * 所以不做默认，只在下游明确要时透传。
 *
 * 缓存：同一 (id, tokens, topic) 在 TTL 内复用。文档不像搜索结果那样易变，
 * 所以 TTL 给 1 小时（搜索缓存才需要 10 分钟那种短窗口）。
 */

export const CONTEXT7_DEFAULTS = {
	enabled: true,
	/** 搜索接口取前几条候选库 */
	maxCandidates: 3,
	/**
	 * 文档返回的 token 预算（官方旋钮，实测 ≈4~5 字符/token）。
	 * 2000 → 约 7,800 字符 ≈ 3,100 tok，正好在每步新增内容的 p90 附近：
	 * 够读到关键用法，又不会把一步塞满。
	 */
	defaultTokens: 2000,
	/** tokens 允许的区间 */
	minTokens: 500,
	/**
	 * 上限 8000 → 实测约 34,200 字符 ≈ 13,700 tok。
	 * 再高就等于把上下文窗口的三分之一灌进一条工具结果里了。
	 */
	maxTokens: 8000,
	/**
	 * 硬字符上限：防外部服务失控的兜底，不是常规路径。
	 * 采样 16 个库，tokens=8000 时最大 34,581 字符（4.32 字符/token）——
	 * 所以 40,000 只会在服务端行为异常（chars/token > 5）时才触发。
	 * 留着是因为 context7 是外部信任边界：它哪天改成多返回，不能直接灌进上下文。
	 */
	maxChars: 40_000,
	/** 文档缓存窗口。文档变化慢，给 1 小时 */
	cacheTtlMs: 3_600_000,
	cacheMaxEntries: 32,
	timeoutMs: 20_000,
};

export const CONTEXT7_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	maxCandidates: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10 ? v : undefined),
	maxChars: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 2000 ? v : undefined),
	defaultTokens: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 500 ? v : undefined),
	// clampTokens 会读 min/maxTokens；没有校验器就会被 readJsonConfig 静默丢掉，
	// 而配置模板里又写了这两个键 —— 改了以为生效、实际没生效。
	minTokens: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined),
	maxTokens: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined),
	cacheTtlMs: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined),
	cacheMaxEntries: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined),
	timeoutMs: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1000 ? v : undefined),
};

const SEARCH_URL = "https://context7.com/api/v1/search";
const DOC_BASE = "https://context7.com/api/v1";

/** 带超时的 GET，返回文本。失败抛错（调用方决定怎么说给模型听） */
async function getText(url, timeoutMs, signal) {
	const timer = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timer]) : timer;
	const res = await fetch(url, { signal: combined, redirect: "follow" });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

/**
 * 挑候选库。返回精简后的列表 —— 只留决策要用的字段。
 * 原样 30 条约 14,156 字符；精简后每条约 334 字符。
 */
/** 单条候选里 id/title 的长度上限。description 早就裁了，这两个没有 ——
 * 外部服务给的字符串没有理由无限长，一条 9000 字符的 title 就能撑到 18K 字符。*/
const CANDIDATE_FIELD_MAX = 200;

export function rankCandidates(payload, maxCandidates) {
	const results = Array.isArray(payload?.results) ? payload.results : [];
	const clip = (v) => (typeof v === "string" ? v.slice(0, CANDIDATE_FIELD_MAX) : undefined);
	return results
		// 没有 id 的候选没法取文档：留着会让请求变成 `.../api/v1undefined`，
		// 白打一次网络还报个看不懂的错。上游怪数据在这里就丢掉。
		.filter((item) => item !== null && typeof item === "object" && typeof item.id === "string" && item.id !== "")
		.slice(0, maxCandidates)
		.map((item) => ({
			id: clip(item.id),
			title: clip(item.title),
			description: typeof item.description === "string" ? item.description.slice(0, 200) : "",
			totalTokens: item.totalTokens,
			totalSnippets: item.totalSnippets,
			trustScore: item.trustScore,
			benchmarkScore: item.benchmarkScore,
		}));
}

/** 把候选列成给模型看的几行 */
export function formatCandidates(candidates) {
	return candidates
		.map((c, i) => `${i + 1}. ${c.title} — ${c.id}\n   ${c.description}${c.trustScore !== undefined ? ` (trust ${c.trustScore})` : ""}`)
		.join("\n");
}

/**
 * 库名与候选标题是否指向同一个库。用来避免「搜到一条明显就是它」时还多跑一轮。
 * 归一化掉大小写、空格、点、横线、下划线：`fastapi` == `FastAPI`，
 * `node-fetch` == `Node Fetch`。
 */
export function sameLibraryName(library, candidate) {
	const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s._-]/g, "");
	const want = norm(library);
	return want !== "" && norm(candidate?.title) === want;
}

/**
 * 装 context7 工具。用 `ctx.inject` 之外的形式：这里不需要 dsh 的 web 服务，
 * 直接 fetch（context7 是固定域名，没有 SSRF 面）。
 */
export function installContext7(ctx, config = {}) {
	const cfg = { ...CONTEXT7_DEFAULTS, ...config };
	if (!cfg.enabled) return { enabled: false, status: "已关闭" };

	const stats = { calls: 0, errors: 0, cacheHits: 0, chars: 0 };
	const cache = new Map();

	const clampTokens = (n) => {
		if (typeof n !== "number" || !Number.isFinite(n)) return cfg.defaultTokens;
		return Math.min(cfg.maxTokens, Math.max(cfg.minTokens, Math.round(n)));
	};

	ctx.tools.register({
		name: "docs",
		description:
			"查第三方库/框架的官方文档与代码示例（数据来自 context7，免 key）。给库名 + 想查的问题，一次调用直接返回文档片段。适合「这个库的 API 怎么用」这类问题，比联网搜索更准。",
		parameters: {
			type: "object",
			required: ["library"],
			properties: {
				library: {
					type: "string",
					description: "库或框架名，例如 `fastapi`、`react`、`pydantic`。也可直接给 context7 的 id（`/websites/xxx`）。",
				},
				query: {
					type: "string",
					description: "要查的具体问题，例如 `dependency injection`、`file upload`。留空则返回该库的通用文档。",
				},
				tokens: {
					type: "number",
					description: `文档长度预算（token）。默认 ${cfg.defaultTokens}。小一点更省上下文，但可能截断。`,
				},
				topic: {
					type: "string",
					description: "可选。context7 的服务端主题过滤。注意实测它会**增加**返回量，一般不要填。",
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
			stats.calls += 1;
			const library = String(args.library ?? "").trim();
			if (library === "") return { text: "请给出 library（库名或 context7 id）。" };
			const tokens = clampTokens(args.tokens);

			try {
				// 1. 已经是 id（以 / 开头）就直接用，省一次搜索
				let id = library.startsWith("/") ? library : null;

				if (id === null) {
					const query = String(args.query ?? "").trim();
					const searchUrl = `${SEARCH_URL}?query=${encodeURIComponent(library)}`;
					const raw = JSON.parse(await getText(searchUrl, cfg.timeoutMs, exec?.signal));
					const candidates = rankCandidates(raw, cfg.maxCandidates);
					if (candidates.length === 0) {
						return { text: `context7 里没搜到「${library}」。换个更常见的库名，或直接用 /websites/xxx 形式的 id。` };
					}
					// 只有一条，或有一条标题和库名完全同名 → 直接用，不用模型再选一次。
					// 后者很常见：搜 `fastapi` 第一条就叫 FastAPI（下面还有
					// /tiangolo/fastapi 等同名项），为这个再跑一步是纯浪费。
					const exact = candidates.find((c) => sameLibraryName(library, c));
					if (candidates.length === 1 || exact) id = (exact ?? candidates[0]).id;
					else {
						// 多条候选：返回列表让模型自己定，避免猜错库白烧一次文档请求
						return {
							text:
								`「${library}」匹配到多个库，请用 library 直接填 id 再调一次：\n\n${formatCandidates(candidates)}` +
								`${query !== "" ? `\n\n（要查的问题：${query}）` : ""}`,
						};
					}
				}

				// 2. 取文档
				// topic 先归一化再入键：请求用的是 trim 过的值，键若用原值，
				// `" routing "` 和 `"routing"` 会算成两条而实际是同一个请求 —— 白跑一次网络。
				const topic = typeof args.topic === "string" ? args.topic.trim() : "";
				const cacheKey = JSON.stringify([id, tokens, topic]);
				const hit = cache.get(cacheKey);
				let text;
				if (hit && Date.now() - hit.at < cfg.cacheTtlMs) {
					stats.cacheHits += 1;
					text = hit.value;
				} else {
					const params = new URLSearchParams({ type: "txt", tokens: String(tokens) });
					if (topic !== "") params.set("topic", topic);
					text = await getText(`${DOC_BASE}${id}?${params}`, cfg.timeoutMs, exec?.signal);
					// tokens 不是字符上限（实测 chars/token 能到 5），所以再兜一刀硬上限。
					// 截断必须说出来 —— 静默截断会让模型以为自己看到了全部文档。
					if (text.length > cfg.maxChars) {
						text = `${text.slice(0, cfg.maxChars)}\n\n[... 文档过长已截断：共 ${text.length} 字符，只返回前 ${cfg.maxChars}。用 topic 缩小范围，或调小 tokens 再查 ...]`;
					}
					if (text.trim() !== "") cache.set(cacheKey, { at: Date.now(), value: text });
					// 先塞后裁：Map 迭代顺序 = 插入顺序
					while (cache.size > cfg.cacheMaxEntries) cache.delete(cache.keys().next().value);
				}

				stats.chars += text.length;
				return { text: text.trim() === "" ? `context7 对 ${id} 返回了空文档。` : `# ${id}\n\n${text}` };
			} catch (error) {
				stats.errors += 1;
				ctx.logger.warn(`[team:context7] 查询失败：${error?.message ?? error}`);
				return { text: `context7 查询失败：${error?.message ?? error}` };
			}
		},
	});

	return { enabled: true, status: "已接入（工具：docs）", stats };
}
