/**
 * 代码情报：仓库地图 + 符号定位，两个原生工具。
 *
 * ── 为什么不走 MCP ──────────────────────────────────────────────────────────
 * 社区里对应的是 Serena（语义检索）与 repomix（仓库摘要）两个 MCP server。
 * dsh 这边接 MCP 的代价是双份的：每个 server 的**工具 schema 常驻上下文**
 * （几百到几千 token，逐步重付），外加 `mcp__server__tool` 的桥接形态。
 * 本包已有先例（`context7.js` 的 `docs`、`lens-tools.js` 的 `lens_*`）：
 * 直接把能力注册成原生工具，schema 只值一次 ~120 tok，后续走 cacheRead 0.1x。
 *
 * ── 为什么是「两个工具」而不是四个 ──────────────────────────────────────────
 * 每多一次工具调用 = 多一个完整 step ≈ 把整份地板重发一遍（`AGENTS.md`
 * 「上下文成本」：消耗 ≈ 地板 × 调用次数）。所以：
 *   · 不给「列目录」单独开工具 —— 那正是 `glob` 已有的能力，重复注册是浪费；
 *   · `repo_map` 一次调用就给「结构 + 每文件导出了什么」，不让模型先 glob 再 read；
 *   · `symbol_refs` 一次调用就给「全部定义 + 全部引用」，不让模型 grep→改名→再 grep。
 *
 * ── 能力边界（必须诚实，否则模型会当编译器用）────────────────────────────────
 * 符号识别是**正则级近似**，不起任何 LSP 进程。宏、装饰器生成物、重载、
 * 跨文件类型推断都看不见。工具描述里写了这一点，别删。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CODEINTEL_DEFAULTS = {
	enabled: true,
	/** 一次最多扫多少文件。2000 个源文件 ≈ 一次调用 1~2 秒，再大就该用 focus/path 收窄 */
	maxFiles: 2000,
	/** 单文件上限。超过就不读（打包产物、压缩后的 js 都在这个量级以上） */
	maxFileBytes: 512 * 1024,
	/**
	 * 输出硬上限。24000 字符 ≈ 6000 tok，比一次「读 5 个文件」便宜一个数量级；
	 * 再高就等于把上下文窗口的一大块灌进一条工具结果（`context7.js` 的教训）。
	 */
	maxOutputChars: 24_000,
	/** 每个文件最多列几个符号，超了写 `…`：地图是索引，不是文档 */
	maxSymbolsPerFile: 10,
	/** symbol_refs 一次最多返回多少条命中 */
	maxHits: 60,
	/** 目录树默认深度 */
	defaultDepth: 8,
};

const isBool = (v) => (typeof v === "boolean" ? v : undefined);
const intIn = (min, max) => (v) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

export const CODEINTEL_FIELDS = {
	enabled: isBool,
	maxFiles: intIn(1, 50_000),
	maxFileBytes: intIn(1024, 64 * 1024 * 1024),
	maxOutputChars: intIn(1000, 400_000),
	maxSymbolsPerFile: intIn(1, 100),
	maxHits: intIn(1, 2000),
	defaultDepth: intIn(1, 40),
};

/**
 * 跳过表写死，不做可配置的 ignore 语法 —— 现在没有这个需求，
 * 而多一套 glob 语法就多一套「为什么它没跳过」的排查成本。
 */
const SKIP_DIRS = new Set([
	".git", ".hg", ".svn", "node_modules", "bower_components", "jspm_packages",
	"dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache",
	"target", "vendor", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
	".pytest_cache", ".gradle", ".idea", ".dsh-worktrees", ".dsh-audit",
]);

const SOURCE_EXT = new Set([
	".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
	".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".swift",
	".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".lua",
	".sh", ".bash", ".zsh", ".ps1", ".sql", ".vue", ".svelte",
]);

/**
 * 定义行识别。顺序有意义：先函数/类，再变量 —— 否则 `const f = () => {}` 会被当成变量。
 *
 * `topLevel: true` 只给 JS 的 `function` / `const` / `let` / `var`：
 * 缩进的那些是**函数内的局部变量**，不是这个文件对外的东西。实测在本仓库跑
 * 一次地图，30 行输出里 22 个是 `pkgRoot=`、`bundleDir=` 这类局部常量 ——
 * 地图退化成噪音，模型反而要多读几个文件确认。地图只列模块级。
 */
const DEF_PATTERNS = [
	{ kind: "fn", topLevel: true, re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
	{ kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "fn", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
	{ kind: "fn", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
	{ kind: "fn", re: /^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)/ },
	{ kind: "fn", re: /^\s*func\s+([A-Za-z_]\w*)/ },
	{ kind: "type", re: /^\s*(?:export\s+)?(?:default\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "type", re: /^\s*(?:pub\s+)?(?:struct|enum|trait|union|impl)\s+([A-Za-z_]\w*)/ },
	{
		kind: "type",
		re: /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|open|\s)*\b(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/i,
	},
	{ kind: "const", topLevel: true, re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
	// 类方法 / 对象简写方法：缩进有名 + 参数表 + `{`，排除 if/for/while/switch/function
	{
		kind: "method",
		re: /^\s+(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{]+)?\{\s*$/,
		skip: new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "do", "try", "with"]),
	},
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 词边界匹配。这不是可选优化 —— 少了它 `alpha` 会把 `alphabet` 全部算成引用。 */
export function makeWordMatcher(symbol) {
	return new RegExp(`(?:^|[^\\w$])${escapeRe(symbol)}(?![\\w$])`);
}

/**
 * 从一段源码里抽符号。返回 [{ name, kind, line }]（行号 1 起）。
 *
 * 只认「行首（或缩进后）就是声明」的形状：漏掉 `export default function` 之后
 * 那种奇怪写法是可以接受的，误报（把普通语句当声明）不可接受 —— 后者会让
 * 地图变噪音，模型反而要多读文件确认。
 *
 * **排序看的是「哪类符号更可能被找」**，不是行号：函数/类/类型在前，模块级常量垫底。
 * 实测 `tools/mc-call.mjs` 顶格排了 10 个 `const pkgRoot = …`，把 5 个函数全挤出
 * `maxSymbolsPerFile` 之外 —— 模型看到的是一个只有配置常量的地图，于是还得去读文件。
 */
const KIND_PRIORITY = { fn: 0, class: 0, type: 1, method: 2, const: 9 };

export function extractSymbols(text, maxSymbols = CODEINTEL_DEFAULTS.maxSymbolsPerFile) {
	const out = [];
	const lines = text.split("\n");
	const collectCap = Math.max(maxSymbols * 4, 40); // 先多收一些，排序后再截断
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.length > 400) continue; // 压缩后的一行文件：整行都是噪音
		const indented = /^[ \t]/.test(line);
		for (const { kind, re, skip, topLevel } of DEF_PATTERNS) {
			const m = re.exec(line);
			if (!m) continue;
			const name = m[1];
			if (skip?.has(name)) continue;
			// 缩进的 function/const 是函数内局部量 —— 地图上不列（见 DEF_PATTERNS 注释）
			if (topLevel === true && indented) continue;
			// 同名只留第一次（同一个名字在类里重复声明方法很常见，地图上没必要重复）
			if (out.some((s) => s.name === name)) break;
			out.push({ name, kind, line: i + 1 });
			break;
		}
		if (out.length >= collectCap) break;
	}
	out.sort((a, b) => (KIND_PRIORITY[a.kind] ?? 5) - (KIND_PRIORITY[b.kind] ?? 5) || a.line - b.line);
	return out.slice(0, maxSymbols);
}

/** 这个文件是不是「值得看」的源码：按扩展名 + 大小 + 是否二进制。 */
export function isSourceFile(abs, size, maxFileBytes) {
	if (!SOURCE_EXT.has(path.extname(abs).toLowerCase())) return false;
	if (size > maxFileBytes) return false;
	const fd = fs.openSync(abs, "r");
	try {
		const head = Buffer.alloc(Math.min(512, size));
		fs.readSync(fd, head, 0, head.length, 0);
		return !head.includes(0); // NUL 字节 = 二进制
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * 深度受限地收集源码文件。跳过表见 SKIP_DIRS；不跟随符号链接（环会让扫描停不下来）。
 * 返回 [{ rel, abs, size }]，rel 用 `/` 分隔（Windows 上也一样，输出才稳定）。
 */
export function scanFiles(root, { maxFiles, maxFileBytes, depth }) {
	const found = [];
	const stack = [{ dir: root, rel: "", level: 0 }];
	while (stack.length > 0 && found.length < maxFiles) {
		const { dir, rel, level } = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // 权限不足/刚被删：跳过，不要炸整次调用
		}
		for (const e of entries) {
			if (found.length >= maxFiles) break;
			if (e.isSymbolicLink()) continue;
			const abs = path.join(dir, e.name);
			const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				if (e.name.startsWith(".") && e.name !== ".github") continue;
				if (level + 1 <= depth) stack.push({ dir: abs, rel: childRel, level: level + 1 });
				continue;
			}
			if (!e.isFile()) continue;
			let size = 0;
			try {
				size = fs.statSync(abs).size;
			} catch {
				continue;
			}
			if (!SOURCE_EXT.has(path.extname(abs).toLowerCase())) continue;
			if (size > maxFileBytes) continue;
			if (!isSourceFile(abs, size, maxFileBytes)) continue;
			found.push({ rel: childRel, abs, size });
		}
	}
	return found;
}

const charBudget = (cfg) => cfg.maxOutputChars;
const truncNotice = (what) => `\n…（已截断：${what}。用 focus / path 收窄，或调小 depth、maxFiles）`;

/** 地图里给符号起个短标签：常量加 `=`，让人一眼分清「名字」和「赋值」 */
const labelOf = (s) => (s.kind === "const" ? `${s.name}=` : s.name);

/**
 * 仓库地图：目录树 + 每文件的导出符号。
 * `focus` 是子串过滤（不是 glob）—— glob 语义在模型手里常写错，子串不会。
 */
export function buildRepoMap(files, { focus = "", maxSymbolsPerFile, maxOutputChars, rootLabel = "" }) {
	const picked = focus === "" ? files : files.filter((f) => f.rel.includes(focus));
	const header = `repo_map ${rootLabel}（${picked.length} 个源文件）`;
	if (picked.length === 0) return `${header}\n（没有匹配的源文件${focus ? `，focus=「${focus}」` : ""}）`;

	const lines = [header];
	let over = false;
	for (const f of picked) {
		let text = "";
		try {
			text = fs.readFileSync(f.abs, "utf8");
		} catch {
			continue;
		}
		const syms = extractSymbols(text, maxSymbolsPerFile);
		const lineCount = text.length === 0 ? 0 : text.split("\n").length;
		const symText = syms.length === 0 ? "（无导出符号）" : syms.map(labelOf).join(", ");
		const row = `${f.rel} (${lineCount} 行) — ${symText}`;
		if (lines.join("\n").length + row.length > charBudget({ maxOutputChars })) {
			over = true;
			break;
		}
		lines.push(row);
	}
	if (over) lines.push(truncNotice("输出到上限"));
	return lines.join("\n");
}

/**
 * 符号定位：定义行优先，其余按文件路径排序。
 * 定义判定用同一套 DEF_PATTERNS —— 地图和定位对「什么算定义」必须一致，
 * 否则地图上列出的名字在 refs 里找不到定义行。
 */
export function findReferences(files, symbol, { maxHits, maxOutputChars, rootLabel = "" }) {
	const matcher = makeWordMatcher(symbol);
	const defs = [];
	const refs = [];
	for (const f of files) {
		if (defs.length + refs.length >= maxHits) break;
		let text = "";
		try {
			text = fs.readFileSync(f.abs, "utf8");
		} catch {
			continue;
		}
		if (!matcher.test(text)) continue; // 文件级预筛：整文件不含这个名字就不逐行扫
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			if (line.length > 600) continue;
			if (!matcher.test(line)) continue;
			const hit = { rel: f.rel, line: i + 1, text: line.trim().slice(0, 200) };
			if (isDefinitionLine(line, symbol)) defs.push(hit);
			else refs.push(hit);
			if (defs.length + refs.length >= maxHits) break;
		}
	}
	const head = `symbol_refs: ${symbol} ${rootLabel}（扫 ${files.length} 个文件 → 定义 ${defs.length} 处，引用 ${refs.length} 处${defs.length + refs.length >= maxHits ? "，已达 maxHits" : ""}）`;
	const out = [head];
	if (defs.length > 0) {
		out.push("== 定义 ==");
		for (const d of defs) out.push(`${d.rel}:${d.line}  ${d.text}`);
	}
	if (refs.length > 0) {
		out.push("== 引用 ==");
		for (const r of refs) out.push(`${r.rel}:${r.line}  ${r.text}`);
	}
	if (defs.length + refs.length === 0) out.push("（没找到。符号名区分大小写；跨语言重导出/宏生成的符号本工具看不见）");
	const text = out.join("\n");
	return text.length > maxOutputChars ? text.slice(0, maxOutputChars) + truncNotice("输出到上限") : text;
}

export function isDefinitionLine(line, symbol) {
	for (const { re, skip } of DEF_PATTERNS) {
		const m = re.exec(line);
		if (m && m[1] === symbol && !skip?.has(symbol)) return true;
	}
	return false;
}

/**
 * 装两个工具。`exec` 里拿会话工作目录（dsh 不给工具传 cwd 之外的上下文，
 * 见 `bash-linux.js:630` —— 全包统一走同一个取值口径）。
 */
export function installCodeintel(ctx, config = {}) {
	const cfg = { ...CODEINTEL_DEFAULTS, ...config };
	if (!cfg.enabled) return { enabled: false, status: "已关闭", tools: [] };

	const stats = { repoMapCalls: 0, refCalls: 0, lastFiles: 0 };
	const baseCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

	const resolveRoot = (argPath, exec) => {
		const cwd = baseCwd(exec);
		const p = typeof argPath === "string" && argPath.trim() !== "" ? argPath.trim() : ".";
		return path.resolve(cwd, p);
	};

	const scan = (root, depth) => {
		if (!fs.existsSync(root)) return null;
		if (!fs.statSync(root).isDirectory()) return null;
		const files = scanFiles(root, {
			maxFiles: cfg.maxFiles,
			maxFileBytes: cfg.maxFileBytes,
			depth: Number.isInteger(depth) ? depth : cfg.defaultDepth,
		});
		stats.lastFiles = files.length;
		return files;
	};

	const disposers = [];

	disposers.push(
		ctx.tools.register({
			name: "repo_map",
			description:
				"仓库地图：一次调用给出目录下的源文件与每个文件导出的符号（函数/类/类型/常量）,替代「先 glob 再逐个读文件摸结构」。只读、本地、零网络。符号识别是正则级近似（不起 LSP），宏/装饰器生成物看不见。默认跳过 node_modules/.git/dist 等。",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "仓库或子目录路径，默认当前会话工作目录" },
					focus: { type: "string", description: "只列路径里包含这个子串的文件（子串匹配，不是 glob），例如 `src/agent`" },
					depth: { type: "number", description: `最大目录深度，默认 ${cfg.defaultDepth}` },
				},
				additionalProperties: false,
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { map: { type: "string" } },
				},
				render: (_args, value) => [{ type: "text", text: value.map }],
			},
			async execute(args, exec) {
				stats.repoMapCalls += 1;
				const root = resolveRoot(args?.path, exec);
				const files = scan(root, args?.depth);
				if (files === null) return { map: `不是目录或不存在：${root}` };
				const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
				return {
					map: buildRepoMap(files, {
						focus,
						maxSymbolsPerFile: cfg.maxSymbolsPerFile,
						maxOutputChars: cfg.maxOutputChars,
						rootLabel: `@ ${root}`,
					}),
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "symbol_refs",
			description:
				"符号定位：一次调用给出某个符号（函数/类/变量）的全部定义行与引用行（`文件:行 源码`）,替代「grep 一次改个写法再 grep 一次再逐个读文件」这类多步来回。区分定义与引用,按词边界匹配（alpha 不会命中 alphabet）。只读、本地、零网络。正则级近似：跨语言重导出、宏生成、同名重载都会混在一起。",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "符号名，区分大小写，例如 `installCodeintel`" },
					path: { type: "string", description: "搜索起点目录，默认当前会话工作目录" },
					maxHits: { type: "number", description: `最多返回多少条命中，默认 ${cfg.maxHits}` },
					depth: { type: "number", description: `最大目录深度，默认 ${cfg.defaultDepth}` },
				},
				required: ["symbol"],
				additionalProperties: false,
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { report: { type: "string" } },
				},
				render: (_args, value) => [{ type: "text", text: value.report }],
			},
			async execute(args, exec) {
				stats.refCalls += 1;
				const symbol = String(args?.symbol ?? "").trim();
				if (symbol === "") return { report: "请给出 symbol。" };
				const root = resolveRoot(args?.path, exec);
				const files = scan(root, args?.depth);
				if (files === null) return { report: `不是目录或不存在：${root}` };
				const maxHits = Number.isInteger(args?.maxHits) ? Math.max(1, Math.min(args.maxHits, 2000)) : cfg.maxHits;
				return {
					report: findReferences(files, symbol, {
						maxHits,
						maxOutputChars: cfg.maxOutputChars,
						rootLabel: `@ ${root}`,
					}),
				};
			},
		}),
	);

	return {
		enabled: true,
		status: "repo_map + symbol_refs",
		tools: ["repo_map", "symbol_refs"],
		stats,
		dispose: () => {
			for (const d of disposers) {
				try {
					d?.();
				} catch {
					/* 卸载失败不该影响宿主退出 */
				}
			}
		},
	};
}
