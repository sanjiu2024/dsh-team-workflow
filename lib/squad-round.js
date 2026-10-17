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
import { LOOP_DEFAULTS, addUsage, messageText, runMemberLoop } from "./squad-loop.js";
import { memberToolsFor, runMemberTool } from "./squad-tools.js";
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
	// 宿主没有 llm 就**先别动任何状态**：先清等待标记再失败的话，成员会永久停在「等待」
	// 而唤醒标记已经没了（独立测实测：`waitingFor=undefined`、状态还是「等待」）。
	const llm = deps.ctx.get?.("llm");
	if (!llm || typeof llm.stream !== "function") {
		return { ok: false, detail: "宿主没有 llm 服务（stream），成员跑不起来" };
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
	const outer = new AbortController();
	member.running = { abort: outer, startedAt: Date.now() };
	member.status = "在跑";
	member.note = undefined;
	member.startedAt = Date.now();
	member.updatedAt = Date.now();
	if (!resume) member.transcript = [];   // 续聊保留上次的转录（它是同一件事的延续）
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
	const { tools, schemas } = memberToolsFor({ bash: deps.config.bash, allow: deps.roleToolsFor(member.role) });
	const allowed = new Set(tools.map((tool) => tool.name));
	const onEvent = (event) => {
		// 旧轮（被顶掉的）继续吐字不许写进新一轮的转录 —— 新一轮 `startMember` 刚把它清空
		if (member.running?.abort !== outer) return;
		// 内存护栏两道：**条数**（只留最后 deps.TRANSCRIPT_LIMIT 条）与**单条正文**
		// （模型能一次吐几十 KB，光限条数挡不住 —— 200 条 × 128KB 就是几十 MB）。
		member.transcript.push({
			...event,
			text: typeof event.text === "string" && event.text.length > deps.TRANSCRIPT_TEXT_MAX ? `${event.text.slice(0, deps.TRANSCRIPT_TEXT_MAX)}…（转录截断）` : event.text,
			at: Date.now(),
		});
		while (member.transcript.length > deps.TRANSCRIPT_LIMIT) member.transcript.shift();
	};

	/** 一次尝试：自己的 AbortController（超时）+ 外部的 abort 联进来。 */
	async function attemptOnce({ seed, task }) {
		const controller = new AbortController();
		const onOuterAbort = () => controller.abort();
		outer.signal.addEventListener("abort", onOuterAbort, { once: true });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, deps.config.memberTimeoutMinutes * 60_000);
		// **不要 unref**：这个定时器是这次尝试唯一的终点。unref 之后，一旦事件循环没有别的
		// 待办（自检里就是这样），进程会直接退出 —— 超时永远不会发生。
		const startedAt = Date.now();
		try {
			const kit = await deps.loadKit();
			const result = await runMemberLoop({
				kit,
				stream: (options) => llm.stream(options),
				provider,
				model,
				system: deps.memberSystemPrompt({ squad, member, bashMode: env.bashPolicy?.mode, toolNames: [...allowed] }),
				task,
				messages: seed,
				// 每步边界取待投消息：成员在跑时别人投给它的那几句话
				takeInbox: () => {
					const queued = member.inbox ?? [];
					member.inbox = [];
					return queued;
				},
				// token 预算（A2）：小队与成员两个上限取更紧的；都不限就返回 undefined
				budgetLeft: deps.budgetLeftFor(squad, member),
				// 发给 provider 的是**只有线上字段**的那份（`run` 不出去）
				tools: schemas,
				// 执行器只认给出去的工具：模型幻觉出一个没给它的工具名（比如关掉的 bash）也要拒
				executeTool: (call) =>
					allowed.has(call.name)
						? runMemberTool(call.name, call.arguments, env)
						: { text: `[失败] 这个成员没有 \`${call.name}\` 工具（可用：${[...allowed].join(" / ")}）`, isError: true },
				onEvent,
				signal: controller.signal,
				limits: { ...LOOP_DEFAULTS, maxSteps: deps.config.maxSteps },
			});
			if (timedOut) {
				return { ...result, status: "卡住", kind: "timeout", reason: `超过 ${deps.config.memberTimeoutMinutes} 分钟上限` };
			}
			return result;
		} catch (err) {
			// 走到这里是基础设施层面的失败（llm 服务、loader、执行器崩了）
			if (timedOut) {
				return { status: "卡住", kind: "timeout", reason: `超过 ${deps.config.memberTimeoutMinutes} 分钟上限`, steps: 0, usage: {}, transcript: [], messages: seed ?? [] };
			}
			return { status: "卡住", kind: "infra", reason: `基础设施失败：${err?.message ?? String(err)}`, steps: 0, usage: {}, transcript: [], messages: seed ?? [] };
		} finally {
			clearTimeout(timer);
			outer.signal.removeEventListener("abort", onOuterAbort);
			member.durationMs = (member.durationMs ?? 0) + (Date.now() - startedAt);
		}
	}

	const loop = (async () => {
		// 开跑前先把排队中的消息发出去（不在跑时投的，攒到这次）
		const queued = member.inbox ?? [];
		member.inbox = [];
		let seed = resume?.messages;
		let task = resume?.task ?? deps.memberTaskText(squad, member);
		const extra = queued.map((m) => messageText(m)).filter((t) => t !== "");
		if (extra.length > 0) task = `${task}\n\n── 队里给你的消息 ──\n${extra.join("\n")}`;
		let result;
		for (let attempt = 1; attempt <= deps.config.retries + 1; attempt += 1) {
			member.attempts = (member.attempts ?? 0) + 1;
			result = await attemptOnce({ seed, task });
			member.usage = addUsage(member.usage ?? {}, result.usage);
			member.updatedAt = Date.now();
			member.history = result.messages;
			deps.persistSquad(squad);
			// 只对基础设施失败重试；被中止 / maxSteps 耗尽 / 收工都不重试
			if (result.status === "完成" || result.kind !== "infra") break;
			if (attempt > deps.config.retries) break;
			member.note = `第 ${attempt} 次因「${result.reason}」中断，正在重试…`;
			seed = result.messages;
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
			member.note = `${stopped ?? result.reason}（${result.steps} 步，${deps.usageLine(result.usage)}）`;
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
			const head = result.status === "完成" ? `${member.label} 收工：${result.reason}` : `${member.label} 卡住：${result.reason}`;
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
			member.note = `基础设施失败：${err?.message ?? String(err)}`;
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
