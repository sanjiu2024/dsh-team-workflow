/**
 * Report：让执行者自己说「干完了 / 在等 / 卡住了」（REQ-038 第四批）。
 *
 * ## 为什么不用工具，用一个文件
 *
 * 上游是让 agent 调 `orchestrator_report` 工具主动上报。我们这里换成**写文件**，理由三条：
 *
 * 1. **不碰宿主工具 API**。给会话挂一个工具要 `defineTool` + per-agent 的 `tools.register`，
 *    签名一旦对不上就是「整轮跑不起来」；而这条链路（`agents.create` → setup → mount）
 *    已经出过一次 `list_subagent_models` 重名的事故。
 * 2. **文件是跨进程可靠的**。执行在子会话里、编排在宿主里，中间隔着一层 API；
 *    文件在 worktree 里，两边都看得见。
 * 3. **可测**。读一个 JSON 能写单测；工具只能在真宿主里冒烟。
 *
 * ## 代价（诚实记下来）
 *
 * agent **可能不写**。那时的行为是退回「按事实推断」（`stage.js` ③ 那一段）——
 * 也就是**和现在完全一样**。所以这是一个「有则更好」的增强，不是必须。
 *
 * 格式（`<worktree>/.superagent/report.json`）：
 *
 * ```json
 * { "status": "ready", "summary": "改完了 lib/x.js，测试通过" }
 * ```
 *
 * @module dsh-team-workflow/superagent/report-file
 */

/** 允许的四种结论。和 `stage.js` 里的映射一一对应。 */
export const REPORT_STATUSES = Object.freeze(["ready", "waiting", "blocked", "failed"]);

/** 相对 worktree 的路径。故意藏在点目录里，免得混进业务的 diff。 */
export const REPORT_RELATIVE_PATH = ".superagent/report.json";

/** `summary` 的长度上限。超了截断 —— 它是给人看的一句话，不是报告正文。 */
export const MAX_SUMMARY_CHARS = 500;

/**
 * 校验并从原始 JSON 里取出 report。
 *
 * @param {unknown} raw 从磁盘读出来、已经 `JSON.parse` 过的东西
 * @returns {{ status: string, summary: string } | null} 不合法就 `null`（不抛）
 */
export function normalizeReport(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const status = String(raw.status ?? "").trim();
	if (!REPORT_STATUSES.includes(status)) return null;
	const summary = String(raw.summary ?? "").trim().slice(0, MAX_SUMMARY_CHARS);
	// summary 为空也认 —— 有些结论一句话说不出来（比如 failed 时只有堆栈）
	return { status, summary };
}

/**
 * 从 worktree 里读 report。读不到 / 坏掉 / 不合法，一律返回 `null`。
 *
 * 为什么全部吞掉：这是一条**可选**的上报通道。它坏掉不该让一次成功的执行判失败 ——
 * 那比「少一个信号」糟得多。
 *
 * @param {string} worktree worktree 的绝对路径
 * @param {{ readFileSync: Function, joinPath: Function, existsSync: Function }} fs 注入（测试里换假的）
 * @returns {{ status: string, summary: string } | null}
 */
export function readReportFrom(worktree, fs) {
	if (typeof worktree !== "string" || worktree === "") return null;
	if (!fs || typeof fs.readFileSync !== "function") return null;
	try {
		const file = fs.joinPath(worktree, REPORT_RELATIVE_PATH);
		if (typeof fs.existsSync === "function" && !fs.existsSync(file)) return null;
		const parsed = JSON.parse(String(fs.readFileSync(file, "utf8")));
		return normalizeReport(parsed);
	} catch {
		return null;
	}
}

/**
 * 给执行者的那句提示。拼在指令末尾。
 *
 * 为什么写得这么啰嗦：agent 看到「可选」常常就跳过；而这条通道**有值**的时候（说「我卡住了，
 * 因为 X」）比我们自己猜准得多。所以明确告诉它「写完这一条，人就少问你一轮」。
 *
 * @returns {string}
 */
export function reportInstruction() {
	return [
		"",
		"---",
		"",
		"## 干完之后（可选，但强烈建议）",
		"",
		`在你的工作目录里写一个 \`${REPORT_RELATIVE_PATH}\`，内容形如：`,
		"",
		"```json",
		'{ "status": "ready", "summary": "改完了 lib/x.js，npm test 全过" }',
		"```",
		"",
		"`status` 只能是这四个之一：",
		"",
		"- `ready` —— 活干完了，等审",
		"- `waiting` —— 我在这等下一句（比如需要确认方向再继续）",
		"- `blocked` —— 卡住了，需要人给信息/权限（`summary` 里写清楚缺什么）",
		"- `failed` —— 我做不成（`summary` 里写清楚为什么）",
		"",
		"写了这一条，人打开面板就能直接看到「等你审 / 卡住了」，不用翻你的输出猜。",
		"没写也不影响结果，只是会退回到「按执行状态猜」。",
	].join("\n");
}
