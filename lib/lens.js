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
			stats.findings += 1;
			// 报告给模型看，但不是错误：不改这次调用的成败。
			// source 必须是对象：UserMessage.source 是 MessageSourceMap 的成员。
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
						content: [{ type: "text", text: `[pi-lens 自动检查]\n${text}` }],
						source: { kind: "plugin", plugin: "team:lens" },
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
