/**
 * pi-lens 接入（可选）。
 *
 * dsh 里没有 MCP，也没有 pi 的 extension API。能用的只有冷跑那条路：
 * `node <pi-lens>/dist/mcp/analyze-cli.js --file=… --cwd=…`
 * （快跑 3s、带 --lsp 约 10s；上报靠 stdout，advisory 性质，永远 exit 0）
 *
 * 这里只做两件事：
 *   1. 编辑完一个文件 → 跑一遍分析，把报告作为 additionalContext 挂到结果上
 *   2. 暴露一个 `lens_check` 工具，让模型按需主动跑
 *
 * `--turn-end` 那条路走不通：它要连 pi-lens 自己常驻的 MCP server IPC socket，
 * 冷进程里必然 skip。不假装能用。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

const EDIT_TOOLS = /^(?:edit|write|str_replace_editor|str-replace-editor|apply_patch)$/i;
const ANALYZE_TIMEOUT_MS = 30_000;

/**
 * 报告默认只留 blocking 行 + 汇总行。
 *
 * 为什么：`analyze-cli` 的报告会**整份**当 user 消息塞进上下文，一次编辑一条。
 * 2026-10-20 量账：lens 注入 49,358 字符/会话，是固定的第二大块，而其中绝大多数是
 * warning（实测常见形态就是「0 blocking, 24 warning(s)」）—— 没人会照它改，但它
 * 每一步都要被重发一次（cacheRead 按命中价也算钱，更算延迟）。
 * 汇总行留着，所以「这次有没有引入 block」永远看得到；要看全文跑 `lens_check`。
 */
const REPORT_MAX_CHARS = 6000;

/** 只留 blocking/汇总，warning 折成一行计数；再按字符上限兜底截断。 */
export function trimLensReport(text, { onlyBlocking = true, maxChars = REPORT_MAX_CHARS } = {}) {
	if (typeof text !== "string" || text === "") return "";
	let out = text;
	if (onlyBlocking) {
		const kept = [];
		let warnings = 0;
		for (const line of text.split(/\r?\n/)) {
			// ⚠ 开头的是 warning 明细；🔴 是 blocking，必须留
			if (/^\s*⚠/.test(line)) {
				warnings += 1;
				continue;
			}
			kept.push(line);
		}
		out = warnings > 0 ? `${kept.join("\n").trimEnd()}\n…（另有 ${warnings} 条 warning 省略；要看全文跑 lens_check）` : kept.join("\n");
	}
	if (Number.isInteger(maxChars) && maxChars > 0 && out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n…（已截断，原文 ${out.length} 字符；要看全文跑 lens_check）`;
	}
	return out;
}

/** 找 pi-lens 安装位置：显式配置 → 包内 vendor → pi 的 npm 全局 → profile */
export function resolveLens(packageRootUrl, override) {
	const candidates = [];
	if (typeof override === "string" && override !== "") candidates.push(override);
	try {
		candidates.push(fileURLToPath(new URL("vendor/pi-lens", packageRootUrl)));
	} catch {
		// 非 URL baseUrl：跳过
	}
	candidates.push(path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-lens"));
	candidates.push(path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "npm", "node_modules", "pi-lens"));

	for (const dir of candidates) {
		const cli = path.join(dir, "dist", "mcp", "analyze-cli.js");
		if (fs.existsSync(cli)) return { dir, cli };
	}
	return null;
}

function runAnalyze(found, file, cwd, withLsp, signal) {
	return new Promise((resolve) => {
		const args = [found.cli, `--file=${file}`, `--cwd=${cwd}`];
		if (withLsp) args.push("--lsp");
		const child = spawn(process.execPath, args, {
			cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		const timer = setTimeout(() => child.kill(), ANALYZE_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, text: `pi-lens 启动失败：${error.message}` });
		});
		child.on("close", () => {
			clearTimeout(timer);
			const text = out.trim();
			// analyze-cli 自己会把 console.log 重定向到 stderr，只有报告走 stdout
			resolve(text ? { ok: true, text } : { ok: false, text: err.trim() });
		});
	});
}

export function installLens(ctx, packageRootUrl, config = {}) {
	const found = resolveLens(packageRootUrl, config.path);
	if (!found) return { enabled: false, status: "未找到 pi-lens，相关功能关闭" };

	const stats = { runs: 0, findings: 0, skipped: 0 };

	// —— 编辑后自动体检 ——
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		const decision = await next();
		try {
			if (!EDIT_TOOLS.test(exec.name ?? "") || decision.kind !== "accept") return decision;
			const file = exec.arguments?.file_path ?? exec.arguments?.path ?? exec.arguments?.filePath;
			if (typeof file !== "string" || file === "") return decision;
			// dsh 没给会话 cwd：tool/result.data 里也没有，用当前进程 cwd 退而求其次
			const cwd = process.cwd();
			const { ok, text } = await runAnalyze(found, file, cwd, config.lsp === true, exec.signal);
			stats.runs += 1;
			if (!ok || text === "") {
				stats.skipped += 1;
				return decision;
			}
			// 只喂 blocking（见 trimLensReport 的注释）；全削光就当没发现
			const report = trimLensReport(text, config);
			if (report === "") {
				stats.skipped += 1;
				return decision;
			}
			stats.findings += 1;
			// 报告给模型看，但不是错误：不改这次调用的成败。
			// source 必须是对象：UserMessage.source 是 MessageSourceMap 的成员。
			// 但 format v4 起 `kind` 只能是生产者自己的名字 —— 写回退休的
			// `{kind:"plugin", plugin}` 会让这一轮直接抛「requires a
			// producer-owned source kind」，而这里挂的是**每次编辑**都会走的
			// 钩子。`plugin:team:lens` 与 dsh v3→v4 迁移的 `producerKind` 同形。
			// id 也必须给：加载期 `assertMessageEventShape` 要求它是非空字符串，
			// 缺了会写进磁盘后重载时才暴炸（实测 12 处 `lacks an identified
			// message`，见 docs/HANDOFF-10）。append 时不校验，所以这里必须自己守。
			return {
				...decision,
				additionalContexts: [
					...(decision.additionalContexts ?? []),
					{
						id: randomUUID(),
						role: "user",
						content: [{ type: "text", text: `[pi-lens 自动检查]\n${report}` }],
						source: { kind: "plugin:team:lens" },
					},
				],
			};
		} catch (err) {
			ctx.logger.warn(`[team:lens] 检查失败：${err?.message ?? err}`);
			return decision;
		}
	});

	// —— 按需检查 ——
	// 注意：dsh 的 `parameters` / `output.schema` 不是 JSON Schema，
	// 是属性表 DSL（`required: true` 标在属性上），由 defineTool 编译。
	// `render` 的签名是 (args, value)，不是 (value)。
	ctx.tools.register({
		name: "lens_check",
		description:
			"用一个静态分析流水线体检指定文件：语法/结构（tree-sitter + ast-grep）、lint（biome/ruff）、复杂度、类型（需要 lsp=true，约 10 秒）。改完代码、或想知道某文件有没有隐藏问题时用。只读，不修改文件。",
		parameters: {
			type: "object",
			properties: {
				file: { type: "string", description: "要检查的文件路径，绝对或相对当前目录" },
				cwd: { type: "string", description: "工作目录，默认当前进程目录" },
				lsp: { type: "boolean", description: "是否带上类型检查（更慢，但能查出类型错误）" },
			},
			required: ["file"],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				// 注意：输出 schema 里不能写 `required: true` —— 它是给参数用的，
				// valueSchemaSpecToJsonSchema 走 allowRequired:false，写了直接报 unsupported。
				properties: { report: { type: "string" } },
			},
			render: (_args, value) => [{ type: "text", text: value.report }],
		},
		async execute(args, exec) {
			const cwd = typeof args.cwd === "string" && args.cwd !== "" ? args.cwd : process.cwd();
			const file = path.isAbsolute(args.file) ? args.file : path.resolve(cwd, args.file);
			if (!fs.existsSync(file)) return { report: `文件不存在：${file}` };
			const { ok, text } = await runAnalyze(found, file, cwd, args.lsp === true, exec.signal);
			stats.runs += 1;
			return { report: ok && text !== "" ? text : `没有发现问题（或分析器不可用）。${ok ? "" : `\n${text}`}` };
		},
	});

	return {
		enabled: true,
		dir: found.dir,
		status: `已接入 ${found.dir}；已跑 ${stats.runs} 次`,
		stats,
	};
}
