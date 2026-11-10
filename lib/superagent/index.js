/**
 * Superagent 的插件入口：配置、命令、条件激活。
 *
 * ## 为什么依赖走模块内 `ctx.inject` 而不是顶层 `inject`
 *
 * 它要 `agents` / `agentPresets` / `sessions` 等一堆宿主服务。写进顶层 `inject` 的话，
 * 当前 profile 缺任何一个，**整个插件**都会静默不激活 —— 那会连团队基线一起弄没。
 * 所以照 `lib/scheduler.js` 的做法：依赖不齐时只有 superagent 不激活，其余照常。
 *
 * ## Phase 1 的入口是「手工触发」
 *
 * 计划审查把顺序改了：最厚的「执行 + 回评论」先验通，轮询放最后。
 * 所以 `/superagent run <issue#> <指令>` 不依赖网络也能跑完整条链路，
 * 轮询要等 `enabled: true` 且 `gh` 可用才起。
 *
 * @module dsh-team-workflow/superagent
 */

import fs from "node:fs";
import path from "node:path";

import { createAgentRunner } from "./agent-runner.js";
import { executeTicket } from "./executor.js";
import { runRound } from "./loop.js";
import { decide, extractInstruction, normalizePolicy } from "./policy.js";
import { deliverReply } from "./reply-github.js";
import { fetchNewComments } from "./source-github.js";
import { SuperagentStore } from "./store.js";

/** 需要哪些宿主服务才激活。少一个就整块不激活（不影响插件其它部分）。 */
const REQUIRED_SERVICES = ["agents", "agentPresets", "sessions", "sessionPersistence", "workspaceRegistry", "subprocess"];

export const SUPERAGENT_DEFAULTS = Object.freeze({
	/** 默认关闭 —— 它会给一个会话喂 issue 正文，没有明确同意不该自己跑起来。 */
	enabled: false,
	/** 监听哪个仓库（`owner/name`）。空 = 不监听。单仓库用这个。 */
	repo: "",
	/** 多仓库。非空时**覆盖** `repo`（两个都写以数组为准）。每个仓库各自一个游标。 */
	repos: [],
	/** 状态文件放哪。空 = `<DSH_HOME>/team-workflow/superagent`。 */
	stateDir: "",
	/** 轮询间隔。 */
	pollIntervalMs: 60_000,
	/** Policy 的三个字段。``acceptMode`` 默认 `off` = 谁都不能触发。 */
	acceptMode: "off",
	actors: [],
	trigger: "/agent",
	/** 跑会话用哪个 agent preset。空 = `team`。 */
	agentPreset: "team",
	/** 沙箱档位。**默认 read-only** —— 不默认 danger-full-access。 */
	permission: "read-only",
	/** 执行时的工作目录。空 = `<stateDir>/work`。 */
	workdir: "",
	/** 单轮运行上限（毫秒）。 */
	runTimeoutMs: 30 * 60 * 1000,
});

export const SUPERAGENT_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	repo: (v) => (typeof v === "string" && (v === "" || /^[\w.-]+\/[\w.-]+$/.test(v)) ? v : undefined),
	// 只要有一条不合法就整体拒 —— 悄悄丢掉半条配置，用户会以为那条生效了。
	repos: (v) =>
		Array.isArray(v) && v.every((x) => typeof x === "string" && /^[\w.-]+\/[\w.-]+$/.test(x))
			? [...new Set(v)]
			: undefined,
	stateDir: (v) => (typeof v === "string" ? v : undefined),
	pollIntervalMs: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 5000 ? Math.floor(v) : undefined),
	acceptMode: (v) => (["off", "observe", "auto"].includes(v) ? v : undefined),
	actors: (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v.filter((x) => x.trim() !== "") : undefined),
	trigger: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	agentPreset: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	permission: (v) =>
		["read-only", "workspace-write", "danger-full-access"].includes(v) ? v : undefined,
	workdir: (v) => (typeof v === "string" ? v : undefined),
	runTimeoutMs: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 10_000 ? Math.floor(v) : undefined),
};

const service = (ctx, name) => {
	try {
		return ctx?.get?.(name) ?? ctx?.[name];
	} catch {
		return undefined;
	}
};

/** 用 profile 里配置好的 `gh` 跑一条命令。凭据在编排层，不下放给 agent。 */
function makeGhRunner(scope) {
	return async (argv) => {
		const subprocess = service(scope, "subprocess");
		if (!subprocess || typeof subprocess.spawn !== "function") {
			throw new Error("宿主没有 subprocess 服务，跑不了 gh");
		}
		const spawned = await subprocess.spawn({
			argv: ["gh", ...argv],
			graceMs: 20_000,
			stdio: { maxBytes: 4 * 1024 * 1024 },
		});
		const read = typeof spawned?.readFrom === "function" ? spawned.readFrom(0) : spawned;
		return {
			code: typeof read?.code === "number" ? read.code : 1,
			stdout: String(read?.stdout ?? ""),
			stderr: String(read?.stderr ?? ""),
		};
	};
}

/**
 * 装 superagent。
 *
 * @param {object} ctx 插件上下文
 * @param {{ config?: object, dshHome?: () => string, log?: (m: string) => void }} options
 * @returns {{ describe: () => string, dispose: () => void, state: object }}
 */
export function installSuperagent(ctx, { config = {}, dshHome, log = () => {} } = {}) {
	const state = { status: "未启用", activated: false, tickets: 0, lastRound: null, timer: null };
	const disposers = [];
	const cfg = { ...SUPERAGENT_DEFAULTS, ...config };
	const stateDir = cfg.stateDir === "" ? path.join(dshHome?.() ?? ".", "team-workflow", "superagent") : cfg.stateDir;

	if (cfg.enabled !== true) {
		state.status = "关闭（team/extensions/superagent.json 的 enabled=false）";
		return { describe: () => state.status, dispose: () => {}, state };
	}
	// 多仓库：repos 非空就以它为准，否则退回单个 repo。
	// 两个都空 = 不监听任何仓库，直接关掉（而不是每轮空转）。
	const repoList = cfg.repos.length > 0 ? cfg.repos : cfg.repo === "" ? [] : [cfg.repo];
	if (repoList.length === 0) {
		state.status = "关闭（没配 repo / repos）";
		return { describe: () => state.status, dispose: () => {}, state };
	}

	// 「没激活」必须有声音。
	//
	// `ctx.inject(deps, cb)` 只在**依赖全部就绪**时回调；缺一个就永远不回调 ——
	// 不报错、不打日志、状态一直停在「未启用」。2026-11-08 在 headless profile 上真撞到：
	// 那个 profile 没有 `agentPresets` / `workspaceRegistry` / `subprocess`，
	// 于是 superagent 整块静默失效，而面板上看起来只是「没开」。
	//
	// 3 秒是「服务该就绪了」的经验值；没就绪就逐个探一遍，把缺的**名字**报出来。
	ctx.effect(() => {
		const timer = setTimeout(() => {
			if (state.activated) return;
			const missing = REQUIRED_SERVICES.filter((name) => {
				try {
					return ctx.get(name) === undefined;
				} catch {
					return true;
				}
			});
			state.status = `未激活：缺服务 ${missing.join(", ") || "(探测不到具体名字)"}`;
			log(`superagent 未激活，缺服务：${missing.join(", ") || "(未知)"}`);
		}, 3000);
		timer.unref?.();
		return () => clearTimeout(timer);
	}, "team:superagent:diagnose");

	ctx.inject(REQUIRED_SERVICES, (scope) => {
		state.activated = true;
		state.status = `已启用 · ${repoList.join(", ")}`;
		const store = new SuperagentStore({ dir: stateDir });
		const policy = normalizePolicy({ repos: repoList, actors: cfg.actors, acceptMode: cfg.acceptMode, trigger: cfg.trigger });
		const workdir = cfg.workdir === "" ? path.join(stateDir, "work") : cfg.workdir;
		// cwd 必须先存在：`agents.create` 拿到不存在的目录时行为未定义 —— 最坏是静默回落到
		// 进程 cwd，那就把仓库根当成工作区了。显式建，建不出来就让这一块不激活并说清楚。
		try {
			fs.mkdirSync(workdir, { recursive: true });
		} catch (error) {
			state.status = `已停用：工作目录建不出来（${workdir}）：${String(error?.message ?? error)}`;
			state.activated = false;
			return;
		}

		const runAgent = createAgentRunner({
			scope,
			agentPreset: cfg.agentPreset,
			permission: cfg.permission,
			runTimeoutMs: cfg.runTimeoutMs,
			log,
		});

		const execute = (request) => executeTicket({ store, runAgent, log }, { ...request, branch: "" });
		const reply = (request) => deliverReply({ store, run: makeGhRunner(scope), ...request }, request);
		const source = { fetchNewComments: (options) => fetchNewComments({ run: makeGhRunner(scope) }, options) };

		/**
		 * 每个仓库各跑一轮，把结果合成一份。
		 *
		 * 为什么串行而不是并发：runRound 内部会写状态文件（游标/Ticket），并发写会互相踩；
		 * 而多仓库的轮询本来也不急 —— 一天几十条评论的规模，串行的延迟可以忽略。
		 */
		const roundAllRepos = async () => {
			const merged = { scanned: 0, accepted: 0, executed: 0, replied: 0, skipped: 0, errors: [] };
			for (const repo of repoList) {
				try {
					const one = await runRound(
						{ store, source, policy: { decide, extractInstruction, normalizePolicy }, execute, reply, log },
						{ repo, policy },
					);
					for (const key of ["scanned", "accepted", "executed", "replied", "skipped"]) merged[key] += Number(one?.[key] ?? 0);
					if (Array.isArray(one?.errors)) merged.errors.push(...one.errors.map((e) => `[${repo}] ${e}`));
				} catch (error) {
					// 一个仓库炸了不能拖垮其它仓库
					merged.errors.push(`[${repo}] 轮次异常：${String(error?.message ?? error)}`);
				}
			}
			return merged;
		};

		// —— 命令 ——
		disposers.push(
			ctx.commands.register({
				name: "superagent",
				description: "GitHub 主动代理：status 看状态，run <issue#> <指令> 手工触发，round 跑一轮轮询",
				input: { hint: "status | run <issue#> <指令> | round" },
				handler: async (invocation) => {
					const raw = String(invocation?.rawInput ?? "").trim();
					const [verb, ...rest] = raw.split(/\s+/).filter(Boolean);
					const sessionId = invocation?.sessionId ?? invocation?.session?.id ?? "";

					if (!verb || verb === "status") {
						const snapshot = await store.read();
						const tickets = await store.listTickets();
						state.tickets = tickets.length;
						const lines = [
							`superagent：${state.status}`,
							`仓库：${repoList.join(", ")}`,
							`策略：acceptMode=${policy.acceptMode}  触发词=${policy.trigger}  名单=${policy.actors.join(",") || "(空)"}`,
							`游标：${snapshot.cursor.lastCommentId ?? "(未开始)"}`,
							`状态目录：${stateDir}`,
							`会话：${sessionId || "(当前会话无 id)"}`,
							`Ticket：${tickets.length} 条`,
						];
						for (const ticket of tickets.slice(0, 5)) {
							lines.push(`  · ${ticket.commentId} ${ticket.status ?? "?"} ${ticket.reason ?? ""}`);
						}
						if (state.lastRound) lines.push(`上一轮：${state.lastRound}`);
						return { kind: "success", text: lines.join("\n") };
					}

					if (verb === "run") {
						// 多仓库时目标仓库不能猜：允许 `/superagent run <owner/repo> <issue#> <指令>`。
						// 单仓库时保持旧写法（第一个数字就是 issue 号），不给日常用法加负担。
						const args = [...rest];
						const targetRepo = args[0]?.includes("/") ? args.shift() : repoList[0];
						if (!repoList.includes(targetRepo)) {
							return { kind: "error", text: `仓库 ${targetRepo} 不在监听列表里（${repoList.join(", ")}）` };
						}
						const issueNumber = Number(args[0]);
						const instruction = args.slice(1).join(" ").trim();
						if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
							return {
								kind: "error",
								text: repoList.length > 1
									? `用法：/superagent run <owner/repo> <issue#> <指令>\n监听中：${repoList.join(", ")}`
									: "用法：/superagent run <issue#> <指令>",
							};
						}
						if (instruction === "") return { kind: "error", text: "要写指令，例如 /superagent run 7 把 README 补全" };
						const commentId = `manual-${issueNumber}-${Date.now()}`;
						const outcome = await execute({ commentId, repo: targetRepo, issueNumber, instruction, cwd: workdir });
						state.lastRound = `${commentId} → ${outcome.status}`;
						return {
							kind: outcome.status === "done" ? "success" : "error",
							text: [
								`${commentId}：${outcome.status}（${outcome.reason}）`,
								outcome.sessionId ? `会话：${outcome.sessionId}` : "",
								outcome.text ? `\n输出：\n${outcome.text}` : "",
							]
								.filter(Boolean)
								.join("\n"),
						};
					}

					if (verb === "round") {
						const result = await roundAllRepos();
						state.lastRound = JSON.stringify(result);
						return {
							kind: result.errors.length === 0 ? "success" : "error",
							text: [
								`扫到 ${result.scanned} 条评论，放行 ${result.accepted} 条`,
								`执行 ${result.executed}，回评论 ${result.replied}，跳过 ${result.skipped}`,
								...(result.errors.length > 0 ? ["", "错误：", ...result.errors.slice(0, 8)] : []),
							].join("\n"),
						};
					}

					return { kind: "error", text: `不认识的子命令 "${verb}"：/superagent status | run | round` };
				},
			}),
		);

		// —— 轮询（可选）——
		if (cfg.pollIntervalMs > 0) {
			const timer = setInterval(() => {
				void roundAllRepos()
					.then((result) => {
						state.lastRound = JSON.stringify(result);
					})
					.catch((error) => log(`轮询失败：${String(error?.message ?? error)}`));
			}, cfg.pollIntervalMs);
			timer.unref?.();
			state.timer = timer;
			disposers.push(() => clearInterval(timer));
		}
	});

	return {
		describe: () => state.status,
		dispose: () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 忽略 */
				}
			}
		},
		state,
	};
}
