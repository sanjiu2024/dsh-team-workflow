#!/usr/bin/env node
/**
 * `kb_search`：本地文档语料的**统一入口**（REQ-043）。
 *
 * ## 为什么不是 RAG
 *
 * 这个包零运行时依赖、纯 ESM。没有 embedding、没有向量库，能做的只有关键词检索。
 * 那和现有的 `grep` 差别只在三点：
 *
 * 1. **入口统一**：一个工具管若干文档根目录，不用先 `glob` 再 `read` 再拼；
 * 2. **出处**：结果直接带 `路径:行号: 原文`，模型不用为了定位再读一遍文件；
 * 3. **预算**：结果过 `capToolText` 那一套（`lib/tool-budget.js`）。
 *
 * 省的不是「检索质量」，是**轮次** —— 而轮次才是贵的（每轮都要重发整个上下文地板）。
 *
 * ## 什么时候挂
 *
 * 没有 `<DSH_HOME>/kb-roots.json` 就**不注册工具**。理由：工具会一直占着系统提示与
 * 选择面，用不上就不该出现。要开就写一个文件：
 *
 * ```json
 * { "roots": ["D:/docs", "C:/Users/me/notes"], "exts": [".md", ".txt"] }
 * ```
 *
 * ## 安全边界
 *
 * 只读、只扫文本、有大小与数量上限。跳过 `.git` / `node_modules` / 工作树目录 ——
 * 那里面要么是别人的产物，要么会一次扫出几十万文件。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 配置文件位置与默认值。 */
export const KB_SEARCH_DEFAULTS = {
	roots: [],
	exts: [".md", ".mdx", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".py", ".yml", ".yaml", ".toml"],
	maxFiles: 5000,
	maxFileBytes: 512 * 1024,
	maxHits: 20,
	maxChars: 12000,
	/** 跳过这些目录名：不是别人的产物，就是会一次扫出海量文件的。 */
	skipDirs: [".git", "node_modules", "dist", "build", ".next", ".dsh-worktrees", ".venv", "__pycache__"],
};

export function kbConfigPath(home) {
	return path.join(home, "kb-roots.json");
}

/** 读配置。没有文件返回 null（= 不启用），坏文件也返回 null 并给出原因。 */
export function readKbConfig(home) {
	const file = kbConfigPath(home);
	if (!fs.existsSync(file)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const roots = Array.isArray(raw?.roots) ? raw.roots.filter((r) => typeof r === "string" && r.trim() !== "") : [];
		if (roots.length === 0) return null;
		return {
			...KB_SEARCH_DEFAULTS,
			...raw,
			roots,
			exts: Array.isArray(raw?.exts) && raw.exts.length > 0 ? raw.exts : KB_SEARCH_DEFAULTS.exts,
		};
	} catch {
		return null;
	}
}

const isBinary = (buf) => buf.includes(0);

/** 递归收集候选文件（有上限，命中上限就停）。 */
export function collectFiles(roots, opts = {}) {
	const cfg = { ...KB_SEARCH_DEFAULTS, ...opts };
	const out = [];
	const stack = roots.map((r) => path.resolve(r));
	while (stack.length > 0 && out.length < cfg.maxFiles) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (out.length >= cfg.maxFiles) break;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (cfg.skipDirs.includes(e.name)) continue;
				stack.push(full);
			} else if (e.isFile()) {
				if (!cfg.exts.includes(path.extname(e.name).toLowerCase())) continue;
				out.push(full);
			}
		}
	}
	return out;
}

/**
 * 在语料里搜。纯函数（只读文件）。
 *
 * @returns {{hits: Array<{file: string, line: number, text: string}>, scanned: number, capped: boolean}}
 */
export function searchKb(query, opts = {}) {
	const cfg = { ...KB_SEARCH_DEFAULTS, ...opts };
	const needle = String(query ?? "").trim();
	if (needle === "") return { hits: [], scanned: 0, capped: false };
	const lower = needle.toLowerCase();
	const files = collectFiles(cfg.roots, cfg);
	const hits = [];
	let scanned = 0;
	let capped = false;

	for (const file of files) {
		if (hits.length >= cfg.maxHits) {
			capped = true;
			break;
		}
		let buf;
		try {
			const stat = fs.statSync(file);
			if (stat.size > cfg.maxFileBytes) continue;
			buf = fs.readFileSync(file);
		} catch {
			continue;
		}
		if (isBinary(buf)) continue;
		scanned += 1;
		const lines = buf.toString("utf8").split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (lines[i].toLowerCase().includes(lower)) {
				hits.push({ file, line: i + 1, text: lines[i].trim().slice(0, 300) });
				if (hits.length >= cfg.maxHits) {
					capped = true;
					break;
				}
			}
		}
	}
	return { hits, scanned, capped };
}

/** 渲染成模型能直接用的文本。 */
export function formatHits(result, query) {
	if (!result || result.hits.length === 0) {
		return `没有在语料里找到「${query}」。换个更短的词，或确认根目录配置（${"kb-roots.json"}）。`;
	}
	const head = `命中 ${result.hits.length} 条（扫了 ${result.scanned} 个文件${result.capped ? "，已到上限" : ""}）：`;
	const body = result.hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
	return `${head}\n${body}`;
}

/** 挂工具。没有配置就返回未启用。 */
export function installKbSearch(ctx, home, config = null) {
	const cfg = config ?? readKbConfig(home);
	if (!cfg || !Array.isArray(cfg.roots) || cfg.roots.length === 0) {
		return { enabled: false, status: "未配置 kb-roots.json" };
	}
	ctx.tools.register({
		name: "kb_search",
		description:
			"在本地文档语料里做关键词检索（不是语义检索）。返回 路径:行号: 原文，省掉先 glob 再 read 的来回。" +
			` 根目录：${cfg.roots.join(" / ")}。要读全文再用 read 打开具体文件。`,
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: {
				query: { type: "string", description: "关键词（不区分大小写的子串匹配）" },
				limit: { type: "number", description: `最多几条，默认 ${cfg.maxHits}` },
			},
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		async execute(args) {
			const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : cfg.maxHits;
			const result = searchKb(args?.query, { ...cfg, maxHits: limit });
			return { text: formatHits(result, args?.query) };
		},
	});
	return { enabled: true, status: `已挂载，根目录 ${cfg.roots.length} 个` };
}
