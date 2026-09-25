/**
 * 人可调用的命令。
 *
 * 与 pi 版的区别：dsh 的 `ctx.commands.register` 只回显给 UI，
 * **不产生模型消息**。所以「看状态」类命令走这里；
 * 「要模型干活的」类（/review）走 user-invocable skill。
 */
export function installCommands(ctx, deps) {
	const disposers = [];
	const ok = (b) => (b ? "✓" : "✗");

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
			return `magic-context：开  工具 ${s.tools ?? 0} 个  改写 ${s.ops ?? 0} 次  尾部注入 ${s.appended ?? 0} 次  跳过 ${s.skipped ?? 0} 次`;
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

	return () => {
		for (const dispose of disposers) dispose();
	};
}
