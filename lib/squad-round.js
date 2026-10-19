/**
 * 一轮成员循环：起一轮、流事件落转录、四个收尾出口。
 *
 * **为什么单独一个文件**：2.0.2→2.0.9 那 8 个 patch 里 11 个 P1 **全部**集中在
 * 「起一轮 + 四个出口」的边界上（`finally` 护了 `.then` 漏了、`.then` 护了 `requestWait` 漏了……），
 * 而它们原来挤在 2347 行的 `squad.js` 里 —— 改一个出口看不出另一个出口，这是那批 P1 的物理原因。
 *
 * **怎么读**：`startMember` 起一轮 → 成员循环（`lib/squad-loop.js`）→ 收尾四个出口：
 * `then`（停下来等别人 / 正常结束 / 被停过 / **被新一轮顶掉**）、`catch`（基础设施失败）、
 * `finally`（补位 + 唤醒）。每个出口都先认「现在挂的还是不是我这一轮」（`member.running?.abort !== outer`）——
 * 这条判据不许分叉，加出口时必须一起护。
 *
 * 依赖全部**显式注入**（`deps`），不从 `squad.js` import —— 否则两个文件互相 import 成环。
 */
import { addUsage, messageText } from "./squad-loop.js";
import { formatReport, parseReport } from "./squad-report.js";

	export function startMember(deps, squad, member, { provider, model, resume } = {}) {
	// 已经在跑就不许再起一条：起第二条会**覆盖 `member.running`**（旧的那个 AbortController
	// 从此停不掉），`!resume` 时还会清空它正在写的转录。工具描述里承诺「正在跑时会被拒」，
	// 护栏必须真在这儿（`squad_spawn` 那条路原来一个都没有）。
	// 被 `squad_stop` 掐过的那条（`aborted`）可以覆盖：主 agent 停掉就是想腾出位子重来。
	// 覆盖之后**旧那轮的 finally 不许清掉新句柄** —— 所以 finally 里要认身份（见下）。
	if (deps.isRunning(member)) {
		return { ok: false, detail: `「${member.label}」正在跑 —— 等它收工，或要插话用 squad_say` };
	}
	if (squad.closed) return { ok: false, detail: deps.closedDetail(squad) };
	// 显式起一轮 = 这队又有人管了（换个会话接手同一个 cwd 时就是这样）→ 撤掉「别自动点火」
	squad.aborted = undefined;
	// 宿主跑不起来就**先别动任何状态**：先清等待标记再失败的话，成员会永久停在「等待」
	// 而唤醒标记已经没了（独立测实测：`waitingFor=undefined`、状态还是「等待」）。
	// REQ-025 之后成员跑在原生会话里，缺什么由 `lib/squad-agent.js` 在建立时判并回报，
	// 这里只留一条「宿主没有 agents 服务」的早期退出 —— 没有它连会话都建不出来。
	if (typeof deps.ctx.get?.("agents")?.create !== "function") {
		return { ok: false, detail: "宿主没有 agents 服务（create），成员跑不起来" };
	}
	// **起新的一轮就把「等待」标记清掉**：不清的话这轮跑完会被收尾里那个
	// 「停下来等别人」分支吞掉（状态退回「等待」、回报不解析、黑板不写收工），
	// 而被等的人早就收工了 —— 于是永久卡在「等待」。重派 / 续聊 / 审查复用同名成员
	// 都会走到这里，所以清在**这一处**。
	member.waitingFor = undefined;
	// **跨轮清理只在这一处**。原来这里是两个字段（`stopNote` / `waitNote`），各清各的 ——
	// 2.0.6 的事故正是从这里漏出去的：停一个「等待中」的成员时写的是 `stopNote`，而那条分支的
	// `.then` 早就跑过了、没人消费，于是那句「被停掉」留到**下一轮**，重派跑完了结论栏却写着
	// 上一轮的停因。合成一个 `roundEnd` 之后，「清」这件事物理上只有一个入口。
	// 形状：`{ kind: "stopped" | "waiting", reason, at }` —— `kind` 让两种「为什么结束」
	// 不可能互相冒充（合并字段最容易出的错就是拿错语义）。
	member.roundEnd = undefined;
	// **档位降级链**：主档是调用方传进来的（可能来自 override），后面接 `roles` 里配的其余档。
	// 网关有没有某条渠道是环境事实 —— 配了本机没有的档（本机 `tier-power` 报 503）原来只能
	// 「重试一次后判卡住」，审查这一层就永远起不来。链上换档会**写进结论栏**，不静默。
	// **只有「按角色取来的档」才走降级链**：显式传过 model 的（`squad_spawn(model:"tier-std")`、
	// 或者 `squad_update` 指定过档）不许被链顶掉 —— 否则「显式指定」会变成「起点」，
	// 重试时反而换到链上更贵的档（独立测逮到：显式 tier-std 被换到 tier-power）。
	// 判据复用 `member.modelFromRole`（`lib/squad.js:1780` 改角色时用的是同一条）。
	const tierChain =
		member.modelFromRole === true
			? [model, ...deps.roleModelChain(member.role).filter((m) => m !== model)]
			: [model];
	// 换过档就把「从哪档换到哪档」记下来，收尾时**并进结论**（不然收尾那句「收工（N 步…）」
	// 会把换档这件事盖掉 = 静默换档，用户不知道这次是谁在跑）。
	let tierNote;
	const outer = new AbortController();
	member.running = { abort: outer, startedAt: Date.now() };
	member.status = "在跑";
	member.note = undefined;
	member.startedAt = Date.now();
	member.updatedAt = Date.now();
	if (!resume) member.transcript = [];   // 续聊保留上次的转录（它是同一件事的延续）
	// `bashPolicy` 留着：成员的作用域工具目前只有 board / check / say / wait，用不到它，
	// 但 `env` 是「这个成员看到的世界」的唯一入口，将来加工具时不必再改一层。
	const env = {
		worktree: member.worktree,
		ctx: deps.ctx,
		signal: outer.signal,
		// 等别人（A6）：成员自己掐停这次，等目标收工再被叫回来
		stopSelf: () => outer.abort(),
		bashPolicy: deps.policyFor(member.worktree),
		board: (boardText) => deps.appendBoard(squad, { from: member.label, text: boardText }, deps.boardLimit),
		// 直投（REQ-015）：成员之间说话。目标在跑就进它的待投队列，否则排队等它下次跑。
		say: (to, text) => deps.deliverSay(squad, { from: member.label, to, text }),
		// 勾验收（A10）：成员自己勾。谁勾的记在谁头上，且**勾了就落盘 + 上黑板**
		// —— 验收进度不该只活在某个成员的转录里。
		wait: (target, note) => deps.requestWait(squad, member, target, note, () => outer.abort(), outer),
		check: (item, note) => {
			const r = deps.markAcceptance(squad, member, item, note);
			if (r.ok) {
				deps.appendBoard(squad, { from: member.label, text: `☑ 验收 ${r.index + 1}：${r.entry.text}${note ? `（${note}）` : ""}` }, deps.boardLimit);
				deps.persistSquad(squad);
			}
			return r;
		},
	};

	/**
	 * 转录的两道内存护栏：**条数**（只留最后 deps.TRANSCRIPT_LIMIT 条）与**单条正文**
	 * （模型能一次吐几十 KB，光限条数挡不住 —— 200 条 × 128KB 就是几十 MB）。
	 *
	 * REQ-025 之后转录来自会话事件（整轮跑完一次取回来），不再有逐步的 `onEvent` ——
	 * 所以护栏从「push 时裁」挪到「整份取回时裁」，两道都还在。
	 */
	function clipTranscript(events) {
		const list = Array.isArray(events) ? events : [];
		return list.slice(-deps.TRANSCRIPT_LIMIT).map((event) => ({
			...event,
			text: typeof event?.text === "string" && event.text.length > deps.TRANSCRIPT_TEXT_MAX ? `${event.text.slice(0, deps.TRANSCRIPT_TEXT_MAX)}…（转录截断）` : event?.text,
		}));
	}

	/**
	 * 一次尝试：把这一轮交给 `lib/squad-agent.js` 在**原生会话**里跑。
	 *
	 * 超时（`memberTimeoutMinutes`）由那边管 —— 它要把宿主的 driver 真 `cancel` 掉，
	 * 在门外挂一个自己的定时器是掐不掉它的。这里只负责把外部的 abort 联进去。
	 */
	async function attemptOnce({ task, tier }) {
		const controller = new AbortController();
		const onOuterAbort = () => controller.abort();
		outer.signal.addEventListener("abort", onOuterAbort, { once: true });
		const startedAt = Date.now();
		try {
			return await deps.runMemberRound({
				squad,
				member,
				env,
				task,
				// 已经有会话就接着它跑（续聊 / 换档重试），没有就新建一个
				sessionId: typeof member.sessionId === "string" && member.sessionId !== "" ? member.sessionId : undefined,
				resume: typeof member.sessionId === "string" && member.sessionId !== "",
				provider,
				model: tier,
				// 角色白名单与 bash 闸门：两条老配置（REQ-016 A4 / REQ-011 §6.4）现在落在
				// 原生会话的 `restrict` 上，由 `lib/squad-agent.js` 执行。
				allowTools: deps.roleToolsFor(member.role),
				bash: deps.config.bash,
				// token 预算（A2）：原生会话里没有「步边界」，改成事件边界结算（见 squad-agent）
				budgetLeft: deps.budgetLeftFor(squad, member),
				signal: controller.signal,
			});
		} catch (err) {
			// 走到这里是基础设施层面的失败（agents/sessions 服务、loader 崩了）
			return { status: "卡住", kind: "infra", reason: `基础设施失败：${err?.message ?? String(err)}`, steps: 0, usage: {}, transcript: [], created: false, sessionId: undefined };
		} finally {
			outer.signal.removeEventListener("abort", onOuterAbort);
			member.durationMs = (member.durationMs ?? 0) + (Date.now() - startedAt);
		}
	}

	const loop = (async () => {
		// 开跑前先把排队中的消息发出去（不在跑时投的，攒到这次）
		const queued = member.inbox ?? [];
		member.inbox = [];
		let task = resume?.task ?? deps.memberTaskText(squad, member);
		const extra = queued.map((m) => messageText(m)).filter((t) => t !== "");
		if (extra.length > 0) task = `${task}\n\n── 队里给你的消息 ──\n${extra.join("\n")}`;
		let result;
		for (let attempt = 1; attempt <= deps.config.retries + 1; attempt += 1) {
			// token 预算（A2）：原生会话里没有「步边界」可插，改成**轮边界**判 ——
			// 一轮跑完（或重试前）就结算，超了不再往下放。比原来的粒度粗，但账是真的：
			// 旧那套在一步里就能烧掉一大截，这里至少保证「超了就不再有下一轮」。
			const left = deps.budgetLeftFor(squad, member)?.({});
			if (typeof left === "number" && Number.isFinite(left) && left <= 0) {
				return { status: "卡住", kind: "max-tokens", reason: "token 预算用尽（小队/成员上限）", steps: 0, usage: {}, transcript: member.transcript ?? [], created: false, sessionId: undefined };
			}
			member.attempts = (member.attempts ?? 0) + 1;
			// 第 N 次用链上第 N 个档（越界就停在最后一个）：主档用不了才轮到降级档
			const tier = tierChain[Math.min(attempt - 1, tierChain.length - 1)];
			result = await attemptOnce({ task, tier });
			member.usage = addUsage(member.usage ?? {}, result.usage);
			member.updatedAt = Date.now();
			// **会话真的建/续上了才记 id**：没建起来就记下来的话，下一轮会拿一个盘上
			// 不存在的 id 去 resume，而 resume 的失败会被当成「续不上」静默改建新会话。
			if (result.created === true && typeof result.sessionId === "string" && result.sessionId !== "") {
				member.sessionId = result.sessionId;
			}
			deps.persistSquad(squad);
			// 只对基础设施失败重试；被中止 / 收工都不重试
			if (result.status === "完成" || result.kind !== "infra") break;
			if (attempt > deps.config.retries) break;
			const nextTier = tierChain[Math.min(attempt, tierChain.length - 1)];
			if (nextTier !== tier) tierNote = `${tier ?? "provider 默认"} → ${nextTier}`;
			member.note =
				nextTier !== tier
					? `第 ${attempt} 次因「${result.reason}」中断，换档重试（${tier ?? "provider 默认"} → ${nextTier}）…`
					: `第 ${attempt} 次因「${result.reason}」中断，正在重试…`;
			// 续聊/重试都接着**同一个会话**（`member.sessionId` 上面刚记下），
			// 不再自己拼一段「上一次中断了」的假任务 —— 真历史在会话里。
			task = `上一次因为「${result.reason}」中断了。请接着做，不要重头再来。`;
		}
		return result;
	})();
	member.promise = loop
		.then((result) => {
			// 这一轮已经被**新的一轮**顶掉了（`squad_stop` 之后立刻重派，2.0.7 才允许重叠）——
			// 那就一个字段都别写：否则旧轮收尾会把新一轮的「在跑」盖成「完成」/「卡住」，
			// 转录也会被旧内容复活（自检实测逮到）。它的产出在转录里，不丢。
			// 判据是「现在挂的还是不是**我这一轮**」，不是「有没有更新的轮」：
			// 新一轮先收尾时 `member.running` 已经被它的 finally 清成 undefined，
			// 用 `member.running && …` 就会放行，旧轮照样把状态/结论/黑板盖回去（独立测实测）。
			if (member.running?.abort !== outer) return;
			// 转录在**这一处**落地（原生会话不再逐步推事件）：等待/收工/卡住三种出口
			// 都要留痕，所以放在分支之前 —— 放进下面任何一支，另外两支就没转录了。
			// 续聊是**追加**（`startMember` 在 resume 时没清旧的），重跑才是覆盖。
			const clipped = clipTranscript(result.transcript);
			member.transcript = resume ? [...(member.transcript ?? []), ...clipped].slice(-deps.TRANSCRIPT_LIMIT) : clipped;
			// A6：这次是「停下来等别人」，不是卡住 —— 状态与原因都按等待写，也不写黑板/解析回报
			// （它还没干完，写「收工」是假话）。
			if (member.waitingFor) {
				const why = member.roundEnd?.kind === "waiting" ? member.roundEnd.reason : undefined;
				member.status = "等待";
				member.note = `在等「${member.waitingFor}」收工${why ? `（${why}）` : ""}`;
				member.roundEnd = undefined;
				member.endedAt = Date.now();
				member.updatedAt = Date.now();
				deps.persistSquad(squad);
				return;
			}
			// 本轮被 `squad_stop` 停过 → 终态就是「卡住」：流不认 abort 时它还会吐最后一段，
			// `result.status` 会是「完成」，那样工具说「判卡住」、状态却是「完成」（独立测实测）。
			const stopped = member.roundEnd?.kind === "stopped" ? member.roundEnd.reason : undefined;
			member.status = stopped ? "卡住" : result.status;
			// 原因优先，否则「被中止」会把「为什么停」吃掉
			member.note = `${stopped ?? result.reason}（${result.steps} 步，${deps.usageLine(result.usage)}${tierNote ? `；中途换档 ${tierNote}` : ""}）`;
			member.roundEnd = undefined;
			member.endedAt = Date.now();
			member.updatedAt = Date.now();
			// 结论直接进黑板：主 agent 不必读转录就知道它做成了什么、卡在哪。
			let last;
			for (let i = result.transcript.length - 1; i >= 0; i -= 1) {
				const e = result.transcript[i];
				if (e.role === "assistant" && typeof e.text === "string" && e.text.trim() !== "") {
					last = e;
					break;
				}
			}
			// A8：把最后那段话解析成四段（解析不出来就 parsed:false + 原文，不编）
			member.report = parseReport(last?.text);
			// A7：审查成员的结论挂到**被审者**那一行 —— 不然「审过了」只活在审查者自己的转录里，
			// 而转录是会压缩、会重启丢的。
			if (typeof member.reviews === "string" && member.reviews !== "") {
				const reviewed = squad.members.get(member.reviews);
				if (reviewed) {
					reviewed.review = {
						by: member.label,
						at: Date.now(),
						status: result.status,
						note: member.note ?? undefined,
						report: member.report ?? undefined,
					};
					reviewed.updatedAt = Date.now();
				}
			}
			// 用**实际状态词**，别再写死「卡住」：截断（步数用尽）和超时都不是卡住，
			// 黑板是给人看的，词不对人就误判（2026-10-19 用户就被这个骗过一次）。
			const head = `${member.label} ${result.status === "完成" ? "收工" : result.status}：${result.reason}`;
			// 解析出来了就写**摘要**（黑板是给人扫的，不是放全文的地方）；没解析出来写原文
			const body = member.report.parsed ? formatReport(member.report) : (last?.text ?? "");
			deps.appendBoard(squad, { from: member.label, text: (body ? `${head}\n${body}` : head).slice(0, deps.MAX_BOARD_TEXT) }, deps.boardLimit);
			deps.persistSquad(squad);
		})
		.catch((err) => {
			// 同 `.then`：这一轮被顶掉了就别写（唯一没护的出口，独立测静态指出）
			if (member.running?.abort !== outer) return;
			// 走到这里说明是基础设施层面的失败（llm 服务、loader、执行器崩了）——
			// 正常情况下循环自己已经把失败变成「卡住」了。
			member.status = "卡住";
			member.note = `基础设施失败：${err?.message ?? String(err)}${tierNote ? `；中途换档 ${tierNote}` : ""}`;
			member.updatedAt = Date.now();
			deps.persistSquad(squad);
			deps.log(`成员「${member.label}」跑挂了：${err?.stack ?? err}`);
		})
		.finally(() => {
			// **认身份**：`squad_stop` 掐过之后守卫会放行重派，那时 `member.running` 已经是
			// **新一轮**的句柄了 —— 无脑清会把新一轮的 controller 抹掉（那一轮就再也停不掉）。
			if (member.running?.abort === outer) member.running = undefined;
			member.endedAt = Date.now();
			// 补位（A3）必须挂 **finally**：挂 then 的话异常路径不补位，排队的成员会永久堵死。
			deps.drainQueue(squad);
			// 叫醒「被等者已收工」的成员（A6）也在 finally：等的人不能因为异常路径就永远醒不来。
			// 扫描式的好处：**等者自己这一轮收尾时也会顺手把自己捞起来**（就是上面那个竞态）。
			deps.wakeWaiters(squad);
		});
	return { ok: true };
}
