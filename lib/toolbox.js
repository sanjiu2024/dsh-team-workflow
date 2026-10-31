/**
 * 工具箱：把 CLI 里高频的那几条命令做成主界面按钮（REQ-032）。
 *
 * 为什么不是「再做一个 CLI 的前端」：这些操作**必须在本机宿主里做**（改宿主 JS、重生成预设、
 * 改 profile），而面板跑在同一个 webServer 上，进程里就能拿到 `lib/purge/core.js` 与各个
 * 子系统的活状态 —— 比另起一个进程再读盘准。
 *
 * 三条设计约束：
 *   1. **白名单**：前端只能传 op 名，不能传任意参数/命令。列表在 `OPS` 里，加一条才算数。
 *   2. **危险操作要第二次确认**：打补丁会改宿主 JS、改预设会覆盖产物 —— 前端必须带
 *      `confirm: true`，服务端再核对一遍（防「误点」和「脚本直接打」）。
 *   3. **只认本机回环**：这些按钮等价于在本机执行命令，不能让外部页面驱动。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE = "/api/team/toolbox";
const CLI_TIMEOUT_MS = 180_000;

const errorText = (error) => String(error?.message ?? error ?? "未知错误");

/**
 * 可执行的 op 白名单。
 *
 * - `args`：交给 `bin/dsh-team.mjs` 的参数；`null` 表示这条**不**走 CLI，由本模块直接做
 * - `danger`：会改本机状态，前端要点两下
 * - `restart`：做完要重启 dsh 才完全生效
 */
export const OPS = {
	"purge.apply": {
		label: "应用补丁",
		desc: "把 86 条宿主补丁打上去（审批/沙箱/围栏/提示词）。改的是宿主安装目录的 JS。",
		danger: true,
		restart: true,
		args: null,
	},
	"purge.revert": {
		label: "撤销补丁",
		desc: "从备份原件还原宿主，保留 prompt-inject.md 用户文件。",
		danger: true,
		restart: true,
		args: null,
	},
	"preset.install": {
		label: "重生成团队预设",
		desc: "按 team/agent-settings.json 重写预设产物（改完要重启 dsh）。",
		danger: true,
		restart: true,
		args: ["preset", "install"],
	},
	"thrift.apply": {
		label: "应用节流配置",
		desc: "把团队阈值写进预设并重生成。",
		danger: true,
		restart: true,
		args: ["thrift", "apply"],
	},
	"scheduler.enable": {
		label: "开启定时任务",
		desc: "改本机开关；重启 dsh 后生效。",
		danger: true,
		restart: true,
		args: ["scheduler", "enable"],
	},
	"scheduler.disable": {
		label: "关闭定时任务",
		desc: "改本机开关；重启 dsh 后生效。",
		danger: true,
		restart: true,
		args: ["scheduler", "disable"],
	},
	"status": { label: "安装状态", desc: "装到哪个 profile、版本对不对。", args: ["status"] },
	"plugins": { label: "插件清单", desc: "profile 里装了哪些插件、哪些可选未装。", args: ["plugins"] },
	"skills": { label: "技能清单", desc: "本包与红队技能各有哪些。", args: ["skills"] },
	"mc.check": { label: "检查记忆层", desc: "magic-context bundle 是否可用。", args: ["mc", "check"] },
	"lens.check": { label: "检查 lens", desc: "pi-lens 能否启动。", args: ["lens", "check"] },
	"squad.ls": { label: "落盘小队", desc: "本工作目录落盘的小队。", args: ["squad", "ls"] },
	"bill": { label: "今日账单", desc: "今天的 token 消耗（含小队那半）。", args: ["bill"] },
};

function toolboxRoot() {
	// fileURLToPath 而不是手拆 URL.pathname：后者在 Windows 上会得到 "/C:/Users/..."，
	// 少一个盘符那次坑过（`path.resolve` 之后指向 C:\C:\Users）。
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** 只认本机回环：这些按钮等价于在本机执行命令。 */
function isLoopback(request) {
	const raw = String(request?.socket?.remoteAddress ?? "");
	return raw === "" || raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1";
}

/**
 * 同源：浏览器从本机页面发起的请求会带 Origin/Referer；没有这两个头的一律当非浏览器放行
 * （curl 本机调试），**带**了就必须是同源。
 */
function isSameOrigin(request) {
	const origin = String(request?.headers?.origin ?? "");
	const host = String(request?.headers?.host ?? "");
	if (!origin) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

function sendJson(response, status, value) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(value));
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				reject(new Error("请求体过大"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw.trim()) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(new Error(`请求体不是 JSON：${errorText(error)}`));
			}
		});
		request.on("error", reject);
	});
}

/** 跑一条 CLI，返回 `{ok, code, output}`；超时与失败都变成文本，不抛。 */
function runCli(root, args) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[path.join(root, "bin", "dsh-team.mjs"), ...args],
			{ cwd: root, timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
				resolve({ ok: !error, code: error?.code ?? 0, output: output || (error ? errorText(error) : "（没有输出）") });
			},
		);
	});
}

/** 读本机状态（只读，全部 try/catch —— 任一子系统挂了不能把整块面板打红）。 */
async function collectStatus(deps = {}) {
	const root = deps.root ?? toolboxRoot();
	const rows = [];

	const readJson = (file) => {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return null;
		}
	};

	const pkg = readJson(path.join(root, "package.json"));
	rows.push({ key: "版本", value: String(pkg?.version ?? "未知") });

	// 补丁状态：gatherState 要枚举宿主目录，套个 5 秒缓存，面板反复刷新不要每次都跑。
	let purgeLine = "读不到";
	try {
		const core = await import("./purge/core.js");
		const state = await core.gatherState();
		const applied = Object.values(state?.patch_status ?? {}).filter((s) => s === "applied").length;
		const pending = Object.values(state?.patch_status ?? {}).filter((s) => s === "pending").length;
		purgeLine = `${applied}/${core.ALL_PATCHES.length} 已清洗${pending ? ` · ${pending} 待清洗` : ""}`;
	} catch (error) {
		purgeLine = `读不到：${errorText(error)}`;
	}
	rows.push({ key: "补丁", value: purgeLine });

	// 团队预设产物：落点在 `$DSH_HOME/team-workflow/preset-team/`（不是包内）。
	const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	const presetFile = path.join(dshHome, "team-workflow", "preset-team", "cordis.patch.yml");
	try {
		const st = fs.statSync(presetFile);
		rows.push({ key: "团队预设", value: `已生成 · ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}` });
	} catch {
		rows.push({ key: "团队预设", value: "还没生成（点「重生成团队预设」）" });
	}

	// 本机开关
	const ext = (name) => readJson(path.join(root, "team", "extensions", name));
	const scheduler = ext("scheduler.json");
	rows.push({ key: "定时任务", value: scheduler?.enabled === true ? "开" : "关" });
	const brief = ext("redteam-brief.json");
	rows.push({ key: "红队稿", value: brief?.enabled === false ? "关" : "开" });

	// 各子系统（由 index.js 传活状态进来）
	for (const [label, value] of Object.entries(deps.subsystems ?? {})) {
		rows.push({ key: label, value: String(value) });
	}

	return { ok: true, rows, ops: Object.fromEntries(Object.entries(OPS).map(([key, op]) => [key, { label: op.label, desc: op.desc, danger: op.danger === true, restart: op.restart === true }])) };
}

/**
 * 「应用补丁」到底算不算成功。
 *
 * `na` / `skipped` / `partial` / `off` 表示**这份构建里没有对应目标** —— hooks 插件没装、
 * 官方自己把挂针拿掉了、这份主题里没有标定句 —— 不是补丁失败。判据复用
 * `core.summarizeApplyReport`（soft 与 failed 同源），工具箱不再自己发明一套：
 * 2026-10-31 实测，8 条 `na` + 1 条 `skipped` 被算成「失败=9」，整个按钮标红。
 *
 * `core` 是动态 import 进来的模块（toolbox 不静态依赖 purge，避免循环）；不传时用同一份
 * 状态表兜底，自检会比对两边对同一批状态给的结论是否一致。
 */
export function classifyApplyReport(report, core = null) {
	const rows = Array.isArray(report) ? report : [];
	const applied = rows.filter((r) => r.status === "applied").length;
	const already = rows.filter((r) => r.status === "already").length;
	let failed;
	let soft;
	if (core && typeof core.summarizeApplyReport === "function") {
		const summary = core.summarizeApplyReport(rows);
		failed = summary.failed ?? [];
		// core 的 soft 把 applied / already 也算进去（它对「软」的定义是「没挡住 apply」）；
		// 这里要的是「没落地、但不算失败」，两档口径必须对齐，否则面板会把 70 条已应用显示成「不适用」。
		soft = (summary.soft ?? []).filter((r) => r.status !== "applied" && r.status !== "already");
	} else {
		// 与 core.ALWAYS_SOFT_STATUSES 同一份表；漂了自检会红。
		const softStatuses = new Set(["applied", "already", "partial", "missing_file", "skipped", "na", "off"]);
		failed = rows.filter((r) => !softStatuses.has(r.status));
		soft = rows.filter((r) => softStatuses.has(r.status) && r.status !== "applied" && r.status !== "already");
	}
	return { ok: failed.length === 0, applied, already, soft, failed };
}

/** 执行一个 op。`purge.*` 直接调 core（同进程，状态最准），其余走 CLI（与命令行为一致）。 */
async function runOp(deps, op, opName) {
	const root = deps.root ?? toolboxRoot();
	if (op.args === null) {
		const core = await import("./purge/core.js");
		if (opName === "purge.apply") {
			core.applyRuntimeEnv?.();
			const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
				preserveClientBundles: false,
				forApply: true,
			});
			await core.patchAllShims?.();
			const verdict = classifyApplyReport(report, core);
			// 官方宿主整树在 app.asar 里：补丁写进 resources/app 之后还必须让 asar 让位，
			// 否则 Electron 下次照样加载旧 asar —— 2026-10-31 实测：面板报 applied=70，
			// 而 resources/app.asar 原封不动，补丁一条都没生效（命令 /purge apply 早就在做这一步，
			// 工具箱漏了）。
			const sealed = core.desktopAsarStillSealed?.() === true;
			const lines = [
				`宿主：${hosts.map((h) => h.aiBase).join(", ") || "(无)"}`,
				`applied=${verdict.applied} already=${verdict.already}`
					+ `${verdict.soft.length ? ` 不适用/跳过=${verdict.soft.length}` : ""}`
					+ `${verdict.failed.length ? ` 失败=${verdict.failed.length}` : ""}`,
				...verdict.soft.slice(0, 12).map((r) => `  · #${r.patch_id} ${r.name} → ${r.status}`),
				...verdict.failed.slice(0, 12).map((r) => `  ✗ #${r.patch_id} ${r.name} → ${r.status}`),
				"",
			];
			let after = null;
			if (sealed) {
				lines.push("宿主还封在 app.asar 里：补丁写进了 resources/app，重启时把 app.asar 改名让位。");
				lines.push("马上重启 dsh，不用手动操作。");
				after = () => {
					try {
						core.restartSealedDesktopIfNeeded?.({ ctx: deps.ctx });
					} catch (error) {
						console.error("[team] 密封包重启失败：", error);
					}
				};
			} else {
				lines.push("重启 dsh 后完全生效。");
			}
			return { ok: verdict.ok, output: lines.join("\n"), after };
		}
		if (opName === "purge.revert") {
			const { reverted, errors } = await core.revertAllHosts();
			await core.revertAllShims?.();
			return {
				ok: errors.length === 0,
				output: [
					`已还原 ${reverted.length} 个宿主文件${errors.length ? `，失败 ${errors.length}` : ""}`,
					...errors.map(([p, e]) => `  ✗ ${p}：${e}`),
					"",
					"prompt-inject.md 保留（用户文件）；重启 dsh 完全恢复。",
				].join("\n"),
			};
		}
		return { ok: false, output: `没有实现的 op：${opName}` };
	}
	const result = await runCli(root, op.args);
	return { ok: result.ok, output: result.output };
}

/**
 * 挂工具箱路由。
 *
 * @param ctx cordis 上下文
 * @param deps `{ root, subsystems }` —— `subsystems` 是各子系统的活状态（字符串）
 */
export function installToolbox(ctx, deps = {}) {
	ctx.inject(["webServer"], (host) => {
		host.effect(() => {
			const disposer = host.webServer.register({
				kind: "exact",
				path: ROUTE,
				handler: async (request, response) => {
					if (request.method === "GET") {
						try {
							return sendJson(response, 200, await collectStatus(deps));
						} catch (error) {
							return sendJson(response, 500, { ok: false, error: errorText(error) });
						}
					}
					if (request.method !== "POST") {
						response.setHeader("allow", "GET, POST");
						return sendJson(response, 405, { ok: false, error: "只接受 GET / POST" });
					}
					if (!isLoopback(request) || !isSameOrigin(request)) {
						return sendJson(response, 403, { ok: false, error: "只接受本机同源请求" });
					}

					let body;
					try {
						body = await readBody(request);
					} catch (error) {
						return sendJson(response, 400, { ok: false, error: errorText(error) });
					}

					const opName = String(body?.op ?? "");
					const op = OPS[opName];
					if (!op) return sendJson(response, 400, { ok: false, error: `没有这个操作：${opName}` });
					if (op.danger === true && body?.confirm !== true) {
						return sendJson(response, 428, { ok: false, error: `「${op.label}」会改本机状态，请求里要带 confirm: true` });
					}

					try {
						const result = await runOp({ ...deps, ctx }, op, opName);
						const sent = sendJson(response, 200, {
							ok: result.ok === true,
							output: result.output,
							restart: op.restart === true,
						});
						// 响应先落地，再动宿主：密封包那条路会把当前进程带走（改名 app.asar + 重启），
						// 先回响应，用户才看得到「打了多少条」。
						if (typeof result.after === "function") {
							setTimeout(() => {
								try {
									result.after();
								} catch {
									/* 进程可能已经退出 */
								}
							}, 300);
						}
						return sent;
					} catch (error) {
						return sendJson(response, 500, { ok: false, error: errorText(error) });
					}
				},
			});
			// register 可能返回 disposer，也可能返回 void（宿主版本差异）
			return () => {
				try {
					if (typeof disposer === "function") disposer();
				} catch {
					/* ignore */
				}
			};
		}, "team:toolbox");
	});
}

export const TOOLBOX_ROUTE = ROUTE;
