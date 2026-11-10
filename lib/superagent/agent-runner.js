/**
 * 真跑一个 agent 会话，并把它的最终输出带回来。
 *
 * ## 这一层为什么单独存在
 *
 * `executor.js` 只做编排（claim → 跑 → 判结局），跑的动作通过 `runAgent` 注入 ——
 * 那里用假替身就能测。**这里是那个注入的真实现**，也是全模块唯一碰宿主内部 API 的地方：
 * `agents.create` / `agent.followup` / `agent.whenIdle` / `agent.session.snapshotEvents`。
 *
 * 调用序列照搬 `lib/scheduler.js` 的 `createExecutor`（那套是 2026-10 反复踩出来的）：
 *
 * ```text
 * agents.create({ sessionId, meta:{cwd,agentPreset}, setup })
 *   setup: 钉沙箱档位 + 钉审批策略 + 回读核对   ← 钉不上就拒绝执行
 * await agent.whenIdle()                        ← 先等它空闲，再塞消息
 * agent.followup(createUserMessage(...))
 * 等这一轮真的起来（seq 增长）                  ← 顺序反了会读到空事件
 * await agent.whenIdle() 或超时                 ← 等结束
 * agent.session.snapshotEvents() → lastAssistantText
 * ```
 *
 * ## 三条 fail-closed（都来自 2026-11-08 的计划审查）
 *
 * 1. **沙箱档位钉不上就不跑**：判据是**正向回读**（读会话日志里的 `sandbox/mode` 事件），
 *    不是「没记下错」。宿主 API 漂移时 setter 可能静默不生效。
 * 2. **审批策略钉不上就不跑**：无人值守的会话卡在等人点「允许」，比跑错更糟。
 * 3. **没有 cwd 不跑**：`agents.create` 不给 cwd 就继承进程 cwd，那会把仓库根当成工作区。
 *
 * @module dsh-team-workflow/superagent/agent-runner
 */

import fsSync from "node:fs";
import path from "node:path";

import { makeHostLoader } from "../dsh-exports.js";
import { readReportFrom } from "./report-file.js";
import { worktreeNew } from "../worktree.js";
import { lastAssistantText } from "./result.js";

/** 等「这一轮真的起来」的预算。scheduler 用的是同一个值。 */
const TURN_START_TIMEOUT_MS = 20_000;

/** 等这一轮结束的默认预算。 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 读这个会话还在跑的后台 job 列表。
 *
 * 拿不到就返回空数组 —— 这条是**增强**不是必需：宿主没注入 jobs 服务时，
 * 行为要和以前完全一样（当作没有后台任务）。判成「有活」会让每个 Ticket 永远不结束，
 * 那比漏判糟得多。
 *
 * @param {object} scope 宿主服务作用域
 * @param {string} sessionId
 * @returns {Array<{ id: string, kind: string, label: string, status: string }>}
 */
function readBackgroundJobs(scope, sessionId) {
	try {
		const jobs = scope?.jobs;
		if (!jobs || typeof jobs.list !== "function") return [];
		const all = jobs.list(sessionId);
		if (!Array.isArray(all)) return [];
		return all
			.filter((job) => job && (job.status === "running" || job.status === "stopping"))
			.map((job) => ({
				id: String(job.id ?? ""),
				kind: String(job.kind ?? ""),
				label: String(job.label ?? ""),
				status: String(job.status ?? ""),
			}));
	} catch {
		// 服务在但读失败：当作没有。理由同上 —— 漏判比误判轻。
		return [];
	}
}

/** 取会话日志里最后一条某事件某字段的值。 */
function lastEventField(session, type, field) {
	try {
		const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== type) continue;
			const value = event.data?.[field];
			if (value !== undefined) return value;
		}
	} catch {
		/* 读不到就当没读到 —— 调用方按「钉不上」处理 */
	}
	return undefined;
}

/** 轮询等会话出现新事件（`seq` 增长），用来判断「这一轮真的起来了」。 */
async function waitForTurnStart(session, fromSeq, budgetMs) {
	const started = Date.now();
	while (Date.now() - started < budgetMs) {
		const seq = typeof session?.seq === "number" ? session.seq : 0;
		if (seq > fromSeq) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/**
 * 造一个 `runAgent` —— 喂给 {@link module:dsh-team-workflow/superagent/executor} 的那个。
 *
 * @param {object} options
 * @param {object} options.scope 带 agents / agentPresets / sessions 等服务的上下文
 * @param {string} options.agentPreset 跑这个会话用哪个预设
 * @param {string} [options.permission] 沙箱档位，默认 `read-only`
 *   （**不默认 danger-full-access**：那是上游的选择，这里要显式传）
 * @param {number} [options.runTimeoutMs]
 * @param {(message: string) => void} [options.log]
 * @returns {(request: { commentId: string, instruction: string, cwd: string, repo?: string, issueNumber?: number }) =>
 *   Promise<{ ok: boolean, sessionId: string, text: string, error?: string }>}
 */
export function createAgentRunner({
	scope,
	agentPreset,
	permission = "read-only",
	/** 本地主仓库路径。给了就**每次执行都建一个独立 worktree**，agent 在那边干活。 */
	worktreeBase = "",
	runTimeoutMs = RUN_TIMEOUT_MS,
	log = () => {},
} = {}) {
	if (!scope || typeof scope.agents?.create !== "function") {
		throw new Error("createAgentRunner: scope 上没有 agents.create");
	}
	if (typeof agentPreset !== "string" || agentPreset === "") {
		throw new Error("createAgentRunner: 需要一个 agentPreset —— 空预设会让会话退化成「无预设」");
	}
	const host = makeHostLoader(scope);

	/** 懒加载宿主导出（`@deepseek-ai/*` 从本包解析不到，只能走 loader）。 */
	let runtime;
	async function modules() {
		if (runtime !== undefined) return runtime;
		const [llm, approval, sandbox] = await Promise.all([
			host.load("@deepseek-ai/dsh-llm", ["createUserMessage"]),
			host.load("@deepseek-ai/dsh-user-approval", ["setApprovalPolicy"]),
			host.load("@deepseek-ai/dsh-sandbox-policy", ["setSandboxMode"]),
		]);
		if (typeof llm?.createUserMessage !== "function") throw new Error("SUPERAGENT_RUNTIME_EXPORT_MISSING: createUserMessage");
		if (typeof approval?.setApprovalPolicy !== "function") throw new Error("SUPERAGENT_RUNTIME_EXPORT_MISSING: setApprovalPolicy");
		if (typeof sandbox?.setSandboxMode !== "function") throw new Error("SUPERAGENT_RUNTIME_EXPORT_MISSING: setSandboxMode");
		runtime = {
			createUserMessage: llm.createUserMessage,
			setApprovalPolicy: approval.setApprovalPolicy,
			setSandboxMode: sandbox.setSandboxMode,
		};
		return runtime;
	}

	return async function runAgent(request) {
		const commentId = String(request?.commentId ?? "");
		const instruction = String(request?.instruction ?? "");
		const sessionId = `sa-${commentId}`;

		if (instruction === "") return { ok: false, sessionId, text: "", error: "没有任务描述" };

		// ① 工作目录：配了 `worktreeBase` 就**每次执行都建一个独立 worktree**，
		//    agent 在那边改；没配就用传进来的 cwd（独立目录）。
		//
		//    为什么必须隔离：issue 正文是不可信输入，而 agent 的会话是 read-only/write 档
		//    不设上限时能改文件。让它直接改主仓库 = 一次注入就能毁掉工作区。
		//    worktree 是 git 自己的隔离，出事了 `worktree_drop` 一删就干净。
		let cwd = String(request?.cwd ?? "");
		let worktreePath = "";
		if (worktreeBase !== "") {
			const slug = `sa-${commentId}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 60);
			const created = await worktreeNew({ cwd: worktreeBase, name: slug, timeoutMs: 30_000 });
			if (created.ok !== true) {
				// 建不出 worktree 就不跑 —— 宁可这一轮失败，也不能退回到「直接改主仓库」
				return { ok: false, sessionId, text: "", error: `建 worktree 失败（${created.reason}）：${created.detail ?? ""}` };
			}
			cwd = created.path;
			worktreePath = created.path;
			log(`worktree：${worktreePath}（分支 ${created.branch}）`);
		}

		if (cwd === "") return { ok: false, sessionId, text: "", error: "没有工作目录（cwd）—— 不会拿进程 cwd 顶替" };

		const { createUserMessage, setApprovalPolicy, setSandboxMode } = await modules();

		/** setup 里记下的错：`agents.create` 未必透传 setup 的异常。 */
		let setupError;
		/** 正向标记：两条边界都真的写进去且回读一致，才置 true。 */
		let pinned = false;

		const setup = async (agentCtx, created) => {
			const agent = created ?? agentCtx?.agent;
			try {
				if (typeof scope.agentPresets?.mount === "function") {
					await scope.agentPresets.mount(agentCtx, agentPreset);
				}
				// ① 沙箱档位
				setSandboxMode(agent.session, permission);
				const appliedMode = lastEventField(agent.session, "sandbox/mode", "mode");
				if (appliedMode !== permission) {
					throw new Error(`沙箱档位回读不一致：应为 ${permission}，实际 ${appliedMode ?? "（日志里没有 sandbox/mode）"}`);
				}
				// ② 审批策略（必须在 ① 之后：顺序反了会被沙箱档位连带写的 approval 覆盖回去）
				setApprovalPolicy(agent.session, "never");
				const appliedApproval = lastEventField(agent.session, "approval/policy", "policy");
				if (appliedApproval !== "never") {
					throw new Error(`审批策略回读不一致：应为 never，实际 ${appliedApproval ?? "（日志里没有 approval/policy）"}`);
				}
				pinned = true;
			} catch (error) {
				setupError = String(error?.message ?? error);
				throw error;
			}
		};

		let handle;
		try {
			handle = await scope.agents.withoutInitiator(() =>
				scope.agents.create({ sessionId, meta: { cwd, agentPreset }, setup }),
			);
		} catch (error) {
			return { ok: false, sessionId, text: "", error: setupError ?? `创建会话失败：${String(error?.message ?? error)}` };
		}

		// 沙箱/审批没钉上就不许往下跑 —— 宁可这一轮失败，也不能按会话默认权限无人值守地跑
		if (!pinned) {
			await disposeQuietly(handle);
			return { ok: false, sessionId, text: "", error: setupError ?? "setup 没有被调用（宿主 API 可能已漂移）" };
		}

		const agent = handle.agent;
		try {
			await agent.whenIdle();
			const firstSeq = typeof agent.session?.seq === "number" ? agent.session.seq : 0;
			agent.followup(
				createUserMessage({
					content: [{ type: "text", text: instruction }],
					source: { kind: "superagent", commentId },
				}),
			);

			// 先等这一轮真的起来，再等它结束 —— 顺序反了会读到空事件集，把跑成功判成没跑
			const started = await waitForTurnStart(agent.session, firstSeq, TURN_START_TIMEOUT_MS);
			if (!started) log(`会话 ${sessionId} 在 ${TURN_START_TIMEOUT_MS}ms 内没观察到启动`);

			let timer;
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => resolve("timeout"), runTimeoutMs);
				timer.unref?.();
			});
			const settled = await Promise.race([agent.whenIdle().then(() => "idle"), deadline]);
			clearTimeout(timer);

			if (settled === "timeout") {
				log(`会话 ${sessionId} 超过 ${Math.round(runTimeoutMs / 60000)} 分钟，取消`);
				try {
					agent.cancel({ kind: "hook", reason: "superagent run timeout" });
				} catch (error) {
					log(`取消失败：${String(error?.message ?? error)}`);
				}
				// 超时也把已有内容带回去：agent 可能已经干了大半，全丢更浪费
				const partial = lastAssistantText(agent.session?.snapshotEvents?.() ?? []);
				// 超时**不是失败**（上游："An Assignment interrupted while busy restarts with a
				// recovery note"）。它是「卡在某个地方了，要人看一眼」—— 所以给一张 blocked 的
				// 结论卡，让面板显示「卡住了」而不是「失败了」，人一眼知道自己该动手。
				return {
					ok: false,
					sessionId,
					text: partial,
					error: `运行超时（${Math.round(runTimeoutMs / 60000)} 分钟）`,
					report: {
						status: "blocked",
						summary: `超过 ${Math.round(runTimeoutMs / 60000)} 分钟被取消，可能还没干完 —— 再派一次它会接着做`,
					},
				};
			}

			const text = lastAssistantText(agent.session?.snapshotEvents?.() ?? []);
			// worktree 路径带回去：面板要知道改在哪个分支、回评论要写进去
			// 读它自己写的结论（REQ-038 第四批）。读不到就是 null —— 那是「没写」，不是错。
			const report = worktreePath === ""
				? null
				: readReportFrom(worktreePath, {
						readFileSync: fsSync.readFileSync,
						existsSync: fsSync.existsSync,
						joinPath: path.join,
					});
			// 后台还有活吗（REQ-038 第六批）。
			//
			// **这是 whenIdle() 的盲区**：它只等 turn/step 走完，**不等后台 job**
			// （宿主 dsh-agent-loop/lib/index.js:872；job 归 session 所有，只在 owner
			// 销毁时才取消）。所以「agent 说完了」不等于「它起的东西也完了」——
			// 一个 run_in_background 的构建、一个 watch 任务，会在我们回完评论之后继续跑。
			//
			// 判据照抄宿主自己的写法（dsh-desktop-host/lib/index.js:101）：
			// jobs.list(id) 里还有 status ∈ {running, stopping} 就算「在跑」。
			// 注意已结算的记录**不会被移除**，所以必须按 status 过滤，不能看长度。
			const backgroundJobs = readBackgroundJobs(scope, sessionId);
			return {
				ok: true,
				sessionId,
				text,
				...(worktreePath === "" ? {} : { worktree: worktreePath }),
				...(report === null ? {} : { report }),
				...(backgroundJobs.length === 0 ? {} : { backgroundJobs }),
			};
		} catch (error) {
			return { ok: false, sessionId, text: "", error: String(error?.message ?? error) };
		} finally {
			// 会话要留在列表里给人看（面板里点得开），但 handle 必须释放
			await disposeQuietly(handle);
		}
	};
}

/** `dispose()` 可能返回 Promise，也可能抛 —— 都不能让它逃成 unhandled rejection。 */
async function disposeQuietly(handle) {
	try {
		await handle?.dispose?.();
	} catch {
		/* 释放失败不影响结果 */
	}
}
