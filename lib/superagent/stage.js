/**
 * Ticket 的 stage：面板靠它显示「什么需要人」（REQ-038 第三批）。
 *
 * ## 为什么 stage 要算而不是存
 *
 * 上游 `003-execution.md` 的定义是「每个打开的 Ticket 有一个 stage，由**它在等什么**决定」。
 * 「在等什么」完全由已有事实推出来 —— Report 是什么、有没有 Assignment、投递成没成。
 * 存一份就等于多一个会和事实脱节的字段（`tickets.ts` 里那套状态机要维护一致性，
 * 代价在这里不值得）。
 *
 * ## 和上游的差别（诚实说明）
 *
 * 上游 7 个 stage 里，`person/delivery` 和 `idle` 我们**做不出来**：
 *
 * - `person/delivery`：需要「投递一条 Input 到 Executor 失败的次数 + 退避状态」。
 *   我们的执行模型是「起一个会话、跑完就结束」，没有「往运行中的会话投递」这一步。
 * - `idle`：需要 Report 说 `waiting` —— 那是 agent 主动上报的，我们没有上报工具。
 *
 * 所以这版**只有 5 个**。等加了上报工具（`superagent_report`）之后 `idle` 才成立；
 * `person/delivery` 要等执行模型变成长期的 worker slot（第四批 worker slot）。
 *
 * 与其假装有 7 个然后两档永远算不出来，不如只有 5 个且每个都对。
 *
 * @module dsh-team-workflow/superagent/stage
 */

/** 面板标签（中文，和工具箱其它地方一致）。 */
export const STAGE_LABELS = Object.freeze({
	"person/review": "等你审",
	"person/answer": "等你回答",
	"person/blocked": "卡住了",
	"person/failed": "失败了",
	"working": "在干",
	"working/queued": "排队中",
	"idle": "等下一句",
	"person/delivery": "投递失败",
});

/** 需要人介入的 stage 前缀。面板据此分组。 */
export const PERSON_PREFIX = "person/";

/**
 * 从一个 Ticket 的事实算出它的 stage。
 *
 * 读法照上游那张表：**从上到下，第一个匹配的赢**。
 *
 * @param {object} ticket `store` 里那条 ticket（status / report / text / attempts）
 * @param {{ live?: boolean }} [context] `live` = 这个 Ticket 还订阅着某个 Thread（能接后续讨论）
 * @returns {{ stage: string, label: string, needsPerson: boolean, reason: string }}
 */
export function stageOf(ticket, context = {}) {
	const status = String(ticket?.status ?? "");
	const report = ticket?.report;

	// ① 有人说停 —— 上游把这个当成「结束」，不在 7 个 stage 里。明确返回，别让它落进 working。
	if (status === "stopped") {
		return { stage: "stopped", label: "已停", needsPerson: false, reason: "有人说停，Thread 也退订了" };
	}

	// ② agent 主动上报的 Report 优先于我们自己的推断 —— 它比「跑完了没输出」这种信号准得多。
	if (report !== undefined && report !== null) {
		const kind = String(report.status ?? "");
		if (kind === "ready") {
			return { stage: "person/review", label: STAGE_LABELS["person/review"], needsPerson: true, reason: String(report.summary ?? "agent 说干完了，等审") };
		}
		if (kind === "waiting") {
			return { stage: "idle", label: STAGE_LABELS.idle, needsPerson: false, reason: String(report.summary ?? "agent 说在等下一句") };
		}
		if (kind === "blocked") {
			return { stage: "person/blocked", label: STAGE_LABELS["person/blocked"], needsPerson: true, reason: String(report.summary ?? "agent 说卡住了") };
		}
		if (kind === "failed") {
			return { stage: "person/failed", label: STAGE_LABELS["person/failed"], needsPerson: true, reason: String(report.summary ?? "agent 说失败了") };
		}
	}

	// ③ 没有 Report 时退回我们自己的事实推断。
	if (status === "running") {
		return { stage: "working", label: STAGE_LABELS.working, needsPerson: false, reason: "正在跑" };
	}
	if (status === "failed") {
		return { stage: "person/failed", label: STAGE_LABELS["person/failed"], needsPerson: true, reason: String(ticket.reason ?? "执行失败") };
	}
	if (status === "needs-human") {
		// 「跑完了但一句话没说」和「触发词后面没内容」都落这里 —— 两者都要人看一眼
		return { stage: "person/answer", label: STAGE_LABELS["person/answer"], needsPerson: true, reason: String(ticket.reason ?? "需要人看一眼") };
	}
	if (status === "done") {
		// 跑完且有输出 = 等人审。上游把 `ready` 归到 person/review，我们没上报工具，
		// 就把 `done` 当成「它说完了，你来判断要不要合」。
		return { stage: "person/review", label: STAGE_LABELS["person/review"], needsPerson: true, reason: "跑完了，等你看结果" };
	}
	if (status === "observed") {
		// observe 模式：判定放行但没跑。这是「策略还没开闸」，不是等谁。
		return { stage: "idle", label: STAGE_LABELS.idle, needsPerson: false, reason: String(ticket.reason ?? "observe 模式，未执行") };
	}

	// ④ 剩下的（没有 Assignment / 刚建好还没跑）：排队。
	const live = context.live === true;
	return {
		stage: "working/queued",
		label: STAGE_LABELS["working/queued"],
		needsPerson: false,
		reason: live ? "排队中（Thread 还订阅着）" : "排队中",
	};
}

/**
 * 一批 Ticket 按「要不要人」分组，供面板用。
 *
 * @param {Array<object>} tickets
 * @param {(ticketId: string) => boolean} [isLive]
 * @returns {{ person: object[], working: object[] }}
 */
export function groupByStage(tickets, isLive = () => false) {
	const person = [];
	const working = [];
	for (const ticket of tickets ?? []) {
		const info = stageOf(ticket, { live: isLive(String(ticket?.commentId ?? "")) });
		const row = { ...ticket, ...info };
		if (info.needsPerson) person.push(row);
		else working.push(row);
	}
	// 需要人的排前面；同组内按 stage 名稳一下，面板刷新时不跳
	const byStage = (a, b) => (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0);
	person.sort(byStage);
	working.sort(byStage);
	return { person, working };
}
