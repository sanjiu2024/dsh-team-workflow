/**
 * 人可调用的命令。
 *
 * 与 pi 版的区别：dsh 的 `ctx.commands.register` 只回显给 UI，
 * **不产生模型消息**。所以「看状态」类命令走这里；
 * 「要模型干活的」类（/review）走 user-invocable skill。
 */
import { describeSchedule } from "./scheduler.js";
import { listPresets, switchSessionPreset, currentPresetOf } from "./preset-switch.js";
import { invocationSessionId } from "./purge/rewind.js";

export function installCommands(ctx, deps) {
	const disposers = [];
	const ok = (b) => (b ? "✓" : "✗");

	// —— 换模式（REQ-030 方案 B）——
	//
	// 宿主禁止已开始的会话原地换 preset（agent-preset/locked），所以这条路是
	// 「新会话 + 交接预填 + 归档旧会话」，不是原地切换。命令只回显给 UI，
	// 不产生模型消息 —— 交接文本预填在**新会话**的输入框里，由用户按发送。
	disposers.push(
		ctx.commands.register({
			name: "preset",
			description: "换模式（agent preset）：list 看可用模式，use <id> 换（已开始的会话会开新会话并交接）",
			input: { hint: "list | use <id>" },
			handler: async (invocation) => {
				const raw = String(invocation?.rawInput ?? "").trim();
				const [verb, ...rest] = raw.split(/\s+/).filter(Boolean);
				const sessionId = invocationSessionId(invocation);

				if (!verb || verb === "list") {
					const rows = await listPresets(ctx);
					if (rows.length === 0) {
						return { kind: "error", text: "列不出可用模式（宿主没有 agentPresets 服务）" };
					}
					const current = await currentPresetOf(ctx, sessionId);
					const lines = ["可用模式："];
					for (const row of rows) {
						const mark = row.id === current ? " ← 当前" : row.isDefault ? "（默认）" : "";
						lines.push(`  ${row.id.padEnd(18)} ${row.name}${mark}`);
						if (row.description) lines.push(`      ${row.description}`);
					}
					lines.push("", "换：/preset use <id>");
					return { kind: "success", text: lines.join("\n") };
				}

				if (verb !== "use") {
					return { kind: "error", text: `不认识的子命令 "${verb}"：/preset list | use <id>` };
				}

				const wanted = rest[0];
				if (!wanted) return { kind: "error", text: "要指定模式 id：/preset use redteam" };

				const result = await switchSessionPreset(ctx, { sessionId, presetId: wanted });
				if (!result.ok) return { kind: "error", text: result.error };

				return {
					kind: "success",
					text: [
						`已换到「${result.preset}」—— 新会话 ${result.sessionId}`,
						result.archived ? `旧会话 ${result.parentId} 已归档` : `旧会话 ${result.parentId} 保留在列表里`,
						"",
						"交接已经预填进**新会话**的输入框：切过去看一眼，按发送才会开跑。",
						"（不自动发送是有意的：交接里可能含凭据/靶标，自动跑等于替你按了回车。）",
					].join("\n"),
				};
			},
		}),
	);


	const tc = deps.thrift;

	// magic-context 是 async 挂载的，命令跑的时候可能已经好了。
	// 拿个快照就行 —— 命令只是回显。
	let mcState = { enabled: false, reason: "pending" };
	Promise.resolve(deps.mcPromise)
		.then((r) => {
			mcState = r ?? { enabled: false, reason: "empty" };
		})
		.catch((error) => {
			mcState = { enabled: false, reason: String(error?.message ?? error) };
		});
	const mcLine = () => {
		if (mcState.enabled) {
			const s = mcState.stats ?? {};
			return `magic-context：开  工具 ${s.tools ?? 0} 个  改写 ${s.ops ?? 0} 次  尾部注入 ${s.appended ?? 0} 次  跳过 ${s.skipped ?? 0} 次  等首节点 ${s.headMissing ?? 0} 轮`;
		}
		return `magic-context：关  （${mcState.reason ?? "未知"}）`;
	};

	disposers.push(
		ctx.commands.register({
			name: "team-baseline",
			description: "查看团队基线的来源、版本与同步状态",
				handler: () => ({
				kind: "success",
				text: [
					`dsh-team-workflow ${deps.version}`,
					`包位置：${deps.root}`,
					`团队规范：${ok(deps.rulesExists)}  ${deps.rulesFile}`,
					`Skills：${deps.skillCount} 个  ${deps.skillsDir}`,
					`模型配置模板：${ok(deps.modelsExists)}`,
					`审计日志：${deps.audit.enabled ? "开" : "关"}  ${deps.audit.dir}（已写 ${deps.audit.count} 条）`,
					`上下文节流：${tc.config.enabled ? "开" : "关"}  ${tc.summary()}`,
					`rtk：${deps.rtk.active ? "开" : "关"}  ${deps.rtk.status}`,
					`lens：${deps.lens.enabled ? "开" : "关"}  ${deps.lens.status}`,
					`lens工具：${deps.lensTools?.enabled ? "开" : "关"}  ${deps.lensTools?.status ?? ""}`,
					`context7：${deps.context7?.enabled ? "开" : "关"}  ${deps.context7?.status ?? ""}`,
					mcLine(),
					deps.handoff?.describe() ?? "会话交接：关",
					deps.bashLinux?.describe() ?? "bash（linux 命令）：关",
					deps.autoUpdate?.describe() ?? "自动更新：关",
					deps.worktree?.describe() ?? "worktree 隔离：关",
					deps.computer?.describe() ?? "操控电脑：关（配置里关掉了）",
					deps.scheduler?.describe() ?? "定时任务：关",
					deps.squad?.describe() ?? "小队：关",
					"",
					"（这条命令能跑出来，本身就说明插件在工作）",
				].join("\n"),
			}),
		}),
	);

	disposers.push(
		ctx.commands.register({
			name: "thrift",
			description: "查看或调整上下文节流（compact / prune 阈值）",
			input: { hint: "[show|compact <ratio>|prune <chars>]", attachments: false },
			handler: (invocation) => {
				const [verb, arg] = invocation.rawInput.trim().split(/\s+/);
				try {
					if (!verb || verb === "show") {
						return { kind: "success", text: tc.describe() };
					}
					if (verb === "compact" || verb === "prune") {
						const n = Number(arg);
						if (!Number.isFinite(n) || n <= 0) {
							return { kind: "error", text: `用法：/thrift ${verb} <正数>` };
						}
						tc.set(verb, n);
						return { kind: "success", text: `已更新：\n${tc.describe()}` };
					}
					return { kind: "error", text: `未知参数 "${verb}"；用法：/thrift [show|compact <ratio>|prune <chars>]` };
				} catch (err) {
					return { kind: "error", text: String(err?.message ?? err) };
				}
			},
		}),
	);

	disposers.push(
		ctx.commands.register({
			name: "audit-log",
			description: "查看审计日志落点与本次会话已写条数",
			handler: () => ({
				kind: "success",
				text: [
					`开关：${deps.audit.enabled ? "开" : "关"}`,
					`目录：${deps.audit.dir}`,
					`本次进程已写：${deps.audit.count} 条`,
					`单行上限：8192 字节；单字段上限：${deps.audit.maxFieldChars} 字符`,
					`记录完整提示词：${deps.audit.recordFullPrompt ? "是" : "否"}`,
				].join("\n"),
			}),
		}),
	);

	disposers.push(
		ctx.commands.register({
			name: "team-scheduler",
			description: "查看定时任务调度器：开关、任务列表与最近运行记录",
			handler: () => {
				const scheduler = deps.scheduler;
				if (scheduler === undefined) {
					return { kind: "error", text: "调度器模块没有装配（不该发生，报个 bug）" };
				}
				if (scheduler.enabled !== true) {
					return {
						kind: "success",
						text: [
							"定时任务调度器：关（默认）",
							"",
							"开启：在终端跑 `dsh-team scheduler enable`，然后重启 dsh。",
							"它做什么：到点在**全新会话**里无人值守跑一段 prompt（8 种计划），",
							"          给模型 4 个 scheduler_* 工具，Web GUI 里多一个「定时任务」面板。",
							"注意：无人值守执行时审批策略被强制设为 never，",
							"      「权限」是唯一的安全边界，默认 read-only。",
						].join("\n"),
					};
				}
				const tasks = scheduler.store.readTasks();
				const allRuns = scheduler.store.readRuns();
				const runs = [];
				for (let i = allRuns.length - 1; i >= 0 && runs.length < 5; i -= 1) runs.push(allRuns[i]);
				const lines = [`定时任务调度器：开  存储 ${scheduler.store.dir}`, ""];
				if (tasks.length === 0) {
					lines.push("还没有任务。可以让模型用 scheduler_create 建一个。");
				} else {
					lines.push(`任务（${tasks.length} 个）：`);
					for (const task of tasks) {
						const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString("zh-CN") : "无";
						lines.push(`  ${task.enabled === true ? "·" : "×"} ${task.name}  [${describeSchedule(task.schedule)}]  下次 ${next}`);
					}
				}
				if (runs.length > 0) {
					lines.push("", "最近运行：");
					for (const run of runs) {
						const when = new Date(run.startedAt).toLocaleString("zh-CN");
						lines.push(`  ${run.status}  ${run.taskName ?? run.taskId}  ${when}${run.error ? `  ${run.error}` : ""}`);
					}
				}
				return { kind: "success", text: lines.join("\n") };
			},
		}),
	);

	return () => {
		for (const dispose of disposers) dispose();
	};
}
