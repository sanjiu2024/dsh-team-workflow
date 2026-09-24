/**
 * rtk：命令路由提示 + 输出压缩。
 *
 * pi 版 pi-rtk-optimizer 的做法是**重写命令**（`rtk rewrite <cmd>`，命中就换成 `rtk <cmd>`）。
 * dsh 里没有 `tool_call` 拦截：`tools/pre-execute` 已经拿到深冻结的参数，
 * 唯一能挂钩的 `llm/stream` 也只能替换回调结果、改不了 request。
 * 所以 dsh 版拆成两半：
 *   1. 路由——一段系统提示，让模型自己把命令走 rtk
 *   2. 压缩——`tools/post-execute` 包一层，把结果按 rtk 的策略压小
 *
 * 压缩逻辑从 pi-rtk-optimizer 的 output-compactor 精简而来：ansi / 长行 / 空行 /
 * 行数上限 / 头尾保留。抓取聚合那套没搬——dsh 已经有
 * `dsh-compaction-tool-result-pruner` 在做同类的事，重复没意义。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
/** ANSI：CSI（含 OSC 和 2 字符转义） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const EMPTY_LINE_RE = /\n{3,}/g;

export const RTK_DEFAULTS = {
	enabled: true,
	/** 是否注入「命令优先走 rtk」这段系统提示 */
	routeViaPrompt: true,
	compactOutput: true,
	stripAnsi: true,
	maxChars: 12000,
	maxLines: 220,
	/** 小于这个长度的输出不动 */
	minChars: 1000,
	/** 声明了 shell 的参数键（未命中 rtk 时提示模型改用 rtk） */
	shellArgKeys: ["command", "cmd", "script"],
	/**
	 * 会压缩的工具名。
	 *
	 * `read` 故意不在里面：dsh 的 read 自己就限到 50KB / 2000 行 / 单行 2KB，
	 * 且输出带行号——头尾截断会让行号断档，反而害模型读错位置。它要更小时
	 * 应该用 offset/limit 分页。
	 *
	 * `grep` 才真需要：250 命中 × 单行 2KB = 最坏 500KB，且**没有总字节预算**
	 * （只有条数上限）。超限结果 dsh 会存进 spill，模型仍可按需取回。
	 */
	compactTools: ["bash", "pwsh", "shell", "run_code", "grep", "glob"],
};

export const RTK_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	routeViaPrompt: (v) => (typeof v === "boolean" ? v : undefined),
	compactOutput: (v) => (typeof v === "boolean" ? v : undefined),
	stripAnsi: (v) => (typeof v === "boolean" ? v : undefined),
	maxChars: (v) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined),
	maxLines: (v) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined),
	minChars: (v) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined),
	compactTools: (v) =>
		Array.isArray(v) && v.every((x) => typeof x === "string") ? v.slice() : undefined,
};

/** 找 rtk 可执行文件：包内 tools/ 优先，然后 PATH。找不到就整个功能静默降级。 */
export function resolveRtk(packageRoot, override) {
	if (typeof override === "string" && override !== "") {
		return fs.existsSync(override) ? override : null;
	}
	const exe = process.platform === "win32" ? "rtk.exe" : "rtk";
	// baseUrl 是包目录的 file: URL（loader 保证带尾斜杠），所以直接拼 tools/
	for (const relative of [`tools/${exe}`, `../tools/${exe}`]) {
		try {
			const file = fileURLToPath(new URL(relative, packageRoot));
			if (fs.existsSync(file)) return file;
		} catch {
			// baseUrl 不是合法 URL（例如直接跑单测）：落到 PATH 探测
		}
	}
	const probe = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
	return probe.status === 0 ? exe : null;
}

/** 提示词那段：告诉模型把 shell 命令交给 rtk */
export function routeSectionText(rtkPath) {
	return [
		"# 命令执行：优先走 rtk",
		"",
		`本机在 \`${rtkPath}\` 装了 rtk —— 一个把常见命令输出压成 LLM 友好格式的代理。`,
		"凡是下面这些命令，请原样在前面加 `rtk `，不要直接用原命令：",
		"",
		"`ls` `tree` `read` `grep` `rg` `find` `log` `diff` `git` `gh` `glab` `test`",
		"`err` `json` `deps` `env` `summary` `dotnet` `docker` `kubectl` `oc` `pnpm`",
		"`npm` `aws` `psql` `wget`",
		"",
		"例：`rtk git status`、`rtk grep -n foo src/`、`rtk pnpm test`。",
		"没装 rtk 时上面的规则自动失效，按原命令执行即可。",
		"",
		"注意：不要在 `rtk` 前面再加 `npx`/`pnpm exec`，也不要对已经以 `rtk ` 开头的命令再包一层。",
	].join("\n");
}

/** 单条输出压缩；返回 null 表示不动 */
export function compactText(text, config) {
	if (typeof text !== "string" || text.length < config.minChars) return null;
	let out = text;
	if (config.stripAnsi && ANSI_RE.test(out)) {
		ANSI_RE.lastIndex = 0;
		out = out.replace(ANSI_RE, "");
	}
	ANSI_RE.lastIndex = 0;
	out = out.replace(/\r\n/g, "\n").replace(EMPTY_LINE_RE, "\n\n");

	let lines = out.split("\n");
	let trimmedLines = false;
	if (lines.length > config.maxLines) {
		const head = Math.ceil(config.maxLines * 0.7);
		const tail = config.maxLines - head;
		lines = [
			...lines.slice(0, head),
			`… [rtk] 省略 ${lines.length - head - tail} 行 …`,
			...lines.slice(lines.length - tail),
		];
		trimmedLines = true;
	}
	out = lines.join("\n");

	let charTrimmed = false;
	if (out.length > config.maxChars) {
		const head = Math.floor(config.maxChars * 0.7);
		const tail = config.maxChars - head;
		out = `${out.slice(0, head)}\n… [rtk] 省略 ${out.length - head - tail} 字符 …\n${out.slice(out.length - tail)}`;
		charTrimmed = true;
	}
	if (!trimmedLines && !charTrimmed && out === text) return null;
	return out;
}

/** 递归替换 content 里的文本块 */
function rewriteBlocks(content, config) {
	let changed = false;
	const next = content.map((block) => {
		if (!block || typeof block !== "object" || typeof block.text !== "string") return block;
		const compacted = compactText(block.text, config);
		if (compacted === null) return block;
		changed = true;
		return { ...block, text: compacted };
	});
	return changed ? next : null;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function installRtk(ctx, config) {
	const rtkPath = resolveRtk(ctx.baseUrl, config.path);
	const active = config.enabled && rtkPath !== null;
	const stats = { calls: 0, savedChars: 0, rewrites: 0 };

	if (config.enabled && config.routeViaPrompt) {
		ctx.systemPrompt.section({
			name: "team:rtk",
			order: 650,
			text: active
				? routeSectionText(rtkPath)
				: "（团队基线想让你走 rtk 压缩命令输出，但本机没找到 rtk.exe；按原命令执行即可。）",
		});
	}

	// 事实性提示，不是拦截：模型没走 rtk 时不改行为，只在结果里如实说一句。
	if (active) {
		ctx.on("tools/post-execute", async (exec, result, next) => {
			const decision = await next();
			try {
				if (!config.compactOutput) return decision;
				if (decision.kind !== "accept" || !result.content?.length) return decision;
				const name = exec.name ?? "";
				// 只为输出无总预算的工具压缩：
				//   read 自带 50KB 上限 + 行号语义（截断会断行号）→ 不碰
				//   其它 fs 工具结果小或结构化 → 不碰
				const compactable = Array.isArray(config.compactTools)
					? config.compactTools
					: RTK_DEFAULTS.compactTools;
				if (!compactable.some((t) => t.toLowerCase() === name.toLowerCase())) return decision;
				const compacted = rewriteBlocks(result.content, config);
				if (!compacted) return decision;
				stats.calls += 1;
				const before = result.content.reduce((n, b) => n + (b?.text?.length ?? 0), 0);
				const after = compacted.reduce((n, b) => n + (b?.text?.length ?? 0), 0);
				stats.savedChars += Math.max(0, before - after);
				return { ...decision, content: compacted };
			} catch (err) {
				ctx.logger.warn(`[team:rtk] 压缩失败：${err?.message ?? err}`);
				return decision;
			}
		});
	}

	return {
		rtkPath,
		active,
		status: active ? `压缩 ${stats.calls} 次，省 ${stats.savedChars} 字符` : "未找到 rtk.exe，已降级",
		stats,
	};
}

/** 供 CLI 用：包内 rtk 是否就位 */
export function bundledRtk(packageRoot) {
	return resolveRtk(packageRoot);
}
