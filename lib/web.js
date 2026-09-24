/**
 * 团队用的联网搜索后端。
 *
 * dsh 本来就带 `web_search` / `web_fetch` 两个工具（`@deepseek-ai/dsh-tool-web`），
 * 缺的只是能用的搜索 provider —— 出厂的 `web-search-deepseek` 要
 * `DEEPSEEK_API_KEY`，团队网关那个 key 是 new-api 的，用不了。
 *
 * 所以这里只做两件事，别的一律复用官方：
 *   1. 注册一个免 key 的搜索 provider（Bing 主、DDG 备），id = `bing`
 *   2. 用官方 `ctx.web.fetch()` 抓正文塞进 `WebSearchResult.content`，
 *      这就是「一步到位抓正文」——`dsh-tool-web` 渲染时 content 排在
 *      source 列表前面，模型一次拿到摘要+正文
 *
 * 抓取走 ctx.web.fetch 而不是自己 fetch：SSRF 防护、重定向校验、大小上限、
 * 超时都归官方 `dsh-web-fetch-http` 管，那些是最容易写漏的地方。
 */

/** 出厂的 deepseek provider 要 key，这里不需要，所以 available() 恒真。 */
const BING_URL = "https://cn.bing.com/search";
const DDG_URL = "https://html.duckduckgo.com/html/";

// 无 UA 会被 Bing 直接拦；但搜索和正文都走官方 ctx.web.fetch，UA 由它统一设
// （dsh-web-fetch-http 的 userAgent 配置项），这里不再自带一份。

export const WEB_DEFAULTS = {
	providerId: "bing",
	fallback: true,
	fetchBodies: true,
	maxBodies: 3,
	bodyChars: 6000,
	bodyTimeoutMs: 15000,
};

/** 字段校验器：返回 undefined 就是不采纳这个值（落回默认）。与其它扩展同一约定。 */
export const WEB_FIELDS = {
	providerId: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	fallback: (v) => (typeof v === "boolean" ? v : undefined),
	fetchBodies: (v) => (typeof v === "boolean" ? v : undefined),
	maxBodies: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined),
	bodyChars: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 200 ? v : undefined),
	bodyTimeoutMs: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1000 ? v : undefined),
};

// ── HTML 处理 ────────────────────────────────────────────────────────────────
// 只做「够用」的降噪：脚本/样式/导航一律扔掉，正文优先，拿不到就整页兜底。

const ENTITIES = {
	nbsp: "\u00a0", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
	ensp: " ", emsp: " ", thinsp: " ", hellip: "…", mdash: "—", ndash: "–",
	middot: "·", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”",
	lsquo: "‘", rsquo: "’", copy: "©", reg: "®", trade: "™", deg: "°",
};

/** 解 HTML 实体。命名实体走表，其余按 &#NNN; / &#xHH; 解。 */
export function decodeEntities(text) {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
		if (body[0] === "#") {
			const hex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[body.toLowerCase()] ?? whole;
	});
}

/** 去掉标签本身，保留文本。`<br>` / 块级标签折成换行。 */
function stripTags(html) {
	return html
		.replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)\s*>/gi, "\n")
		// `[^<>]` 而不是 `[^>]`：后者允许跨过下一个 `<`，于是一串 `<` 会让每个位置
		// 都向后重扫到串尾（O(n²)。实测 8 万个 `<` 要 12 秒，卡死事件循环——
		// 畸形页面是不受控输入，不能假定它长得正常）。写成 `[^<>]` 后是线性的。
		.replace(/<[^<>]*>/g, "");
}

/** 压空白：行内空格合并，最多留一个空行，去掉行首尾空白。 */
function collapse(text) {
	return text
		.replace(/[ \t\u00a0\u2000-\u200b]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * HTML → 纯文本。
 *
 * 优先 `<main>` / `<article>` / 常见正文容器；只有候选内容明显太短（< 300 字符，
 * 说明抓到的是骨架或占位符）才退回整个 body。SPA 站点（内容靠 JS 渲染）这里
 * 救不了，只能拿到很短的结果——已知上限，不额外上无头浏览器。
 */
export function htmlToText(html) {
	if (typeof html !== "string" || html === "") return "";
	const candidates = [
		/<main\b[^>]*>([\s\S]*?)<\/main>/i,
		/<article\b[^>]*>([\s\S]*?)<\/article>/i,
		/<[^<>]+class="[^"]*(?:markdown-body|vp-doc|article-content|post-content|entry-content|content-body)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|section)>/i,
	];
	for (const re of candidates) {
		const match = re.exec(html);
		if (match) {
			const text = collapse(decodeEntities(stripTags(match[1])));
			if (text.length > 300) return text;
		}
	}
	const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
	return collapse(decodeEntities(stripTags(body ? body[1] : html)));
}

// ── 结果页解析 ───────────────────────────────────────────────────────────────

/** 相对链接补成绝对，非 http(s)（mailto、javascript:）一律丢掉。 */
function absolute(href, base) {
	try {
		const url = new URL(decodeEntities(href), base);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

/** Bing 结果：`<h2><a href>标题</a></h2>` + 紧随其后的 `b_lineclamp` 摘要。 */
export function parseBingHtml(html, limit) {
	const out = [];
	const re = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]{0,2000}?)(?=<h2|<\/ol>|$)/gi;
	let match;
	while ((match = re.exec(html)) !== null && out.length < limit) {
		const url = absolute(match[1], "https://cn.bing.com/");
		if (!url) continue;
		const title = collapse(decodeEntities(stripTags(match[2])));
		const snippetMatch = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(match[3]);
		const snippet = snippetMatch ? collapse(decodeEntities(stripTags(snippetMatch[1]))) : "";
		if (title === "" && snippet === "") continue;
		out.push({ url, ...(title !== "" ? { title } : {}), ...(snippet !== "" ? { snippet } : {}) });
	}
	return out;
}

/** DDG HTML 版结果：`a.result__a`（href 是直链） + `a.result__snippet`。 */
export function parseDdgHtml(html, limit) {
	const out = [];
	const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,2000}?)(?=<a[^>]*class="[^"]*result__a|<\/div>\s*<\/div>\s*$|$)/gi;
	let match;
	while ((match = re.exec(html)) !== null && out.length < limit) {
		const url = absolute(match[1], "https://duckduckgo.com/");
		if (!url) continue;
		const title = collapse(decodeEntities(stripTags(match[2])));
		const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(match[3]);
		const snippet = snippetMatch ? collapse(decodeEntities(stripTags(snippetMatch[1]))) : "";
		if (title === "" && snippet === "") continue;
		out.push({ url, ...(title !== "" ? { title } : {}), ...(snippet !== "" ? { snippet } : {}) });
	}
	return out;
}

// ── 网络 ─────────────────────────────────────────────────────────────────────

/**
 * 取一个文档。走官方 fetch provider，**不**自己用 globalThis.fetch。
 *
 * 为什么：本机是 Clash TUN + fake-IP（所有域名解析到 198.18.0.x）。这环境下
 * Node 内置 fetch 会拿到 0 个响应头 + 乱码正文（实测 3/3 复现），而 dsh 的
 * fetch provider 用的是装了 dispatcher 的 undici，同一个 URL 正常返回真 HTML。
 *
 * 顺带把 SSRF 防护、重定向校验、大小上限、超时都交给官方实现。
 * 注意：SSRF 那道检查会放行真正的代理路由（代理自己解析域名），所以要走代理
 * 就得让进程能看到 HTTPS_PROXY —— 否则 fake-IP 会被当成 reserved 拦掉。
 */
async function fetchDocument(ctx, url, config, signal, what) {
	const timeout = AbortSignal.timeout(config.bodyTimeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const result = await ctx.web.fetch({ url }, combined);
	if (result.body.content === "") throw new Error(`${what}返回了空内容`);
	return result.body;
}

/** 取一份必须是 HTML 的文档（搜索结果页）；不是 HTML 就当失败。 */
async function fetchHtml(ctx, url, config, signal, what) {
	const body = await fetchDocument(ctx, url, config, signal, what);
	if (body.kind !== "html") throw new Error(`${what}返回的不是 HTML（${body.kind}）`);
	return body.content;
}

async function searchBing(ctx, query, limit, config, signal) {
	const url = `${BING_URL}?q=${encodeURIComponent(query)}&count=${limit}`;
	return parseBingHtml(await fetchHtml(ctx, url, config, signal, "必应"), limit);
}

/** DDG 用 GET（本机是被反爬 202 拦着的，留着当备胎）。 */
async function searchDdg(ctx, query, limit, config, signal) {
	const url = `${DDG_URL}?q=${encodeURIComponent(query)}`;
	return parseDdgHtml(await fetchHtml(ctx, url, config, signal, "DDG"), limit);
}

// ── provider ─────────────────────────────────────────────────────────────────

/** 组装 provider。导出出来是为了能在没有 dsh 的情况下单测。 */
export function makeSearchProvider(ctx, config, log = () => {}) {
	return {
		id: config.providerId,
		available: () => true,

		async search(request, signal) {
			const limit = request.maxResults ?? 8;
			let sources = [];
			const tried = []; // 试过哪些后端，失败时要原样报出来
			let via = "bing";
			const errors = [];
			tried.push("bing");
			try {
				sources = await searchBing(ctx, request.query, limit, config, signal);
			} catch (error) {
				errors.push(`bing：${error?.message ?? error}`);
				if (!config.fallback) throw error;
				log(`[team:web] Bing 失败（${error?.message ?? error}），转 DDG`);
			}
			if (sources.length === 0 && config.fallback) {
				via = "duckduckgo";
				tried.push("duckduckgo");
				try {
					sources = await searchDdg(ctx, request.query, limit, config, signal);
				} catch (error) {
					errors.push(`duckduckgo：${error?.message ?? error}`);
					log(`[team:web] DDG 也失败（${error?.message ?? error}）`);
				}
			}
			if (sources.length === 0) {
				// 别静默返回空——空结果和不工作的后端在模型眼里一样，排查时也一样。
				// 两个后端都试过就要两个都点名，只报最后一个会把上一个的失败藏起来。
				return {
					sources: [],
					truncated: false,
					content: `搜索没有返回任何结果。后端：${via}（已试 ${tried.join(" / ")}）。${
						errors.length > 0 ? `失败原因：${errors.join("；")}` : "页面拿到了，但解析出 0 条结果。"
					}`,
				};
			}

			const truncated = sources.length > limit;
			if (truncated) sources = sources.slice(0, limit);

			// 只给前几条抓正文——每条一次网络往返，全抓会把搜索拖成分钟级。
			let content;
			if (config.fetchBodies && config.maxBodies > 0) {
				const targets = sources.slice(0, config.maxBodies);
				const bodies = await Promise.all(
					targets.map(async (source) => {
						try {
							const body = await fetchDocument(ctx, source.url, config, signal, "正文");
							const text = body.kind === "html" ? htmlToText(body.content) : collapse(body.content);
							return text === "" ? null : { url: source.url, title: source.title, text: text.slice(0, config.bodyChars) };
						} catch (error) {
							log(`[team:web] 抓正文失败 ${source.url}：${error?.message ?? error}`);
							return null;
						}
					}),
				);
				const landed = bodies.filter((entry) => entry !== null);
				if (landed.length > 0) {
					content = landed
						.map((entry) => `### ${entry.title ?? entry.url}\n${entry.url}\n\n${entry.text}`)
						.join("\n\n---\n\n");
				}
			}

			log(`[team:web] ${via} 命中 ${sources.length} 条${content ? "，带正文" : ""}`);
			return { ...(content ? { content } : {}), sources, truncated };
		},
	};
}

/**
 * 注册搜索 provider。
 *
 * 用 `ctx.inject(["web"], …)` 而不是模块级 `inject` —— 这样没挂 web 服务的组合
 * （比如精简 profile）只是少一个能力，不会让整个 dsh-team-workflow 起不来。
 */export function installWebSearch(ctx, config) {
	ctx.inject(["web"], (scoped) => {
		const provider = makeSearchProvider(scoped, config, (m) => scoped.logger.info(m));
		scoped.web.registerSearchProvider(provider);
		scoped.logger.info(`[team:web] 搜索 provider 「${provider.id}」已注册`);
	});
}
