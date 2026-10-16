/**
 * 小队（squad）—— 主 agent 建多个小队、成员一起朝目标推进（REQ-009）。
 *
 * ── 为什么叫「小队」而不是「团队」 ──────────────────────────────────────────
 * 这个包本身叫 `dsh-team-workflow`，系统提示里那一大段叫「团队基线规范」——
 * 「团队」在这套东西里已经指**规范**。再拿它指「运行时的一群子 agent」，
 * 两边都会看不懂。所以运行时那群子 agent 叫**小队**（squad）。
 *
 * ── 要解决什么 ──────────────────────────────────────────────────────────
 * 现在派子代理是「一次性」的：一次派一个、结果回来就结束。多个子代理之间**不能互相
 * 说话**（dsh 的 `send_message` 只允许父↔子），于是：
 *   · 三个子代理分头调研，各自的发现无法汇到一处，只能全回到主 agent 的对话里，
 *     主 agent 的上下文成了唯一的共享内存 —— 它一压缩，细节就没了；
 *   · 「谁在队里、谁在干什么、目标推到哪」全靠对话记着，跨轮就散。
 * 小队把这三样东西结构化：**目标、名册、黑板**。
 *
 * ── 四条设计决定（详见 REQ-009 §5/§6 与 REQ-011） ──────────────────────────
 *  1. **状态只在当前会话**（主 agent 选的）：`Map<ownerSessionId, Map<名, Squad>>`，
 *     靠 `ctx.on("session/disposed", …)` 在会话销毁时清掉。
 *     `ctx.effect` 的 dispose 是**插件拆除**、不是会话结束（`lib/audit.js:91` 是
 *     按 session id 存 Map 的先例），所以只能这么落。
 *  2. **成员不是 dsh 的子 agent**（REQ-011，用户明确要求「完全独立于 subagent」）：
 *     不建会话、不建 agent。成员的 agent loop 由 `squad-loop.js` 自己驱动，工具由
 *     `squad-tools.js` 自己实现。代价是成员**调不到 dsh 的工具**、也**没有** dsh 的
 *     审批通道；替代品是「fs 工具的路径钉死在成员自己的 worktree 里」+ bash 走 dsh 的
 *     沙箱策略（`ctx.shell` + 显式传 `sandboxPolicy`）。
 *  3. **黑板仍然是真的共享**：成员往黑板写字，走的是它自己的 `board` 工具 → 小队的
 *     执行器代为落库，作者是那个成员。主 agent 不用当传声筒。
 *  4. **权限按「所有者 / 成员」分**：改小队的动作（建队、派成员、改行、收队）只有
 *     所有者调得到 —— 成员根本没有 dsh 工具；它那一侧的动作发生在自己的 loop 里、
 *     由小队执行器代为落库。多小队之间互相隔离也靠这条。
 *
 * ── 不做什么 ────────────────────────────────────────────────────────────
 *  · **不落盘**：进程内、会话级，会话结束就没了（所以没有 `$DSH_HOME/...json`）；
 *    成员的转录同样只在进程内存里。
 *  · **不设成员上限**（主 agent 选的）：`squad_status` 会显示人数，那是信息不是闸门。
 *  · **不做审批**：dsh 的审批服务硬依赖真实 Session 的开着的 turn，成员没有 Session，
 *    拿不到（REQ-011 §5/§6.4 写明这是明确的安全代价）。也不自动合并代码。
 *  · **不做成本闸门**：不数 token、不掐轮数。但成员循环自己带护栏（`LOOP_DEFAULTS`：
 *    步数 / 单步工具数 / 单条结果长度 / 历史长度）—— 那不是限流，是没有它就是无界循环。
 * 唯一的内存护栏是 `boardLimit`、单条文本长度上限与转录条数上限。
 *
 * ── 与客户端面板的关系 ──────────────────────────────────────────────────
 * `snapshot()` / `snapshotAll()` 把状态转成**无损 JSON**（只有 string/number/
 * boolean/null/数组/对象，绝不放 `undefined`），`renderSnapshot()` 把同一份快照渲染成
 * 人看的文本 —— 一条数据路径、两个渲染器，工具输出与面板不会各说各话。
 * 面板走 HTTP（`/api/team/squad`，见 `registerSquadRoutes`），**只读**：
 * `/squads` 给名册，`/transcript` 给某个成员的转录（「看转录」就是看这个）。
 */
import { makeHostLoader } from "./dsh-exports.js";
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { dshHome } from "./util.js";
import { createSquadStore, reviveSquad, workspaceKey } from "./squad-store.js";
import { toParameterSchema } from "./util.js";
import { isTrustedRequest, sendJson } from "./api-http.js";
import { LOOP_DEFAULTS, addUsage, messageText, runMemberLoop } from "./squad-loop.js";
import { MEMBER_TOOLS, memberToolsFor, runMemberTool } from "./squad-tools.js";

export const SQUAD_DEFAULTS = {
	enabled: true,
	/** 黑板最多留多少条（超了丢最旧的）。内存护栏，不是限流。 */
	boardLimit: 500,
	/** 成员默认用哪个档位：团队网关的别名（`tier-std/power/max`），想换档在 `squad_spawn` 里传 `model`。 */
	provider: "new-api",
	model: "tier-std",
	/** 成员循环最多几步（护栏，理由见 LOOP_DEFAULTS）。 */
	maxSteps: LOOP_DEFAULTS.maxSteps,
	/**
	 * 成员能不能用 `bash`。
	 *
	 * 默认开（成员要能跑测试/构建才叫干活）。**但在 `danger-full-access` 的机器上，
	 * bash 等于宿主权限、且没有审批** —— 那是成员唯一能「弄没东西」的工具。要真隔离就
	 * 把它关掉：成员只剩钉在工作区里的 fs 工具（提示词不算隔离，这个开关才算）。
	 */
	bash: true,
	/**
	 * 成员因为**基础设施失败**（模型流抛错 / provider 报错）卡住时，自动重试几次。
	 *
	 * 只对基础设施失败重试：`maxSteps` 耗尽**不重试** —— 那是模型真的在绕圈，重试等于
	 * 继续烧钱（REQ-015 §6.4）。
	 */
	retries: 1,
	/** 单个成员一次尝试的墙钟上限（分钟）。超了就 abort，状态判「卡住」。 */
	memberTimeoutMinutes: 20,
	/** 小队状态落不落盘（`<DSH_HOME>/team-workflow/squads/<cwd>.json`）。 */
	persist: true,
};

export const SQUAD_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	boardLimit: (v) => (Number.isInteger(v) && v > 0 ? v : undefined),
	provider: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	model: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	maxSteps: (v) => (Number.isInteger(v) && v > 0 && v <= 200 ? v : undefined),
	bash: (v) => (typeof v === "boolean" ? v : undefined),
	retries: (v) => (Number.isInteger(v) && v >= 0 && v <= 5 ? v : undefined),
	// 允许小数：1 分钟是最小整数粒度，而超时路径要能在自检里用几十毫秒跑到（REQ-015 §6.4）
	memberTimeoutMinutes: (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 24 * 60 ? v : undefined),
	persist: (v) => (typeof v === "boolean" ? v : undefined),
};

/** 成员状态。三个就够：在跑 / 完成 / 卡住 —— 「待派」没有了，派成员就是当场把它跑起来。 */
export const MEMBER_STATUS = ["在跑", "完成", "卡住"];

/** 每个成员留多少条转录事件（面板「看转录」看的就是它）。内存护栏。 */
export const TRANSCRIPT_LIMIT = 200;

/** 单条转录正文的上限（字符）。光限条数不够：一条 assistant 消息可以有几十 KB。 */
export const TRANSCRIPT_TEXT_MAX = 8000;

/** 单个字段的长度上限（内存护栏）。 */
export const MAX_NAME = 40;
export const MAX_TEXT = 1000;
export const MAX_BOARD_TEXT = 2000;

// ── 纯函数部分（可单测，不依赖进程、不依赖 ctx） ─────────────────────────────

/** 建一个空状态（`Map<ownerSessionId, Map<名, Squad>>`）。 */
export function createState() {
	return new Map();
}

/**
 * 收敛用户输入的一行文本：去首尾空白、把连续空白（含换行）压成一个空格、截断。
 * 名字会进 Map 键、也会打印给人看，所以不允许多行。
 */
function oneLine(raw, max) {
	const s = String(raw ?? "").replace(/\s+/g, " ").trim();
	if (s === "") return { ok: false, detail: "不能为空" };
	if (s.length > max) return { ok: false, detail: `太长（${s.length} 字符 > ${max}）` };
	return { ok: true, value: s };
}

/** 多行文本（任务、结论、黑板条目）：保留换行，只去首尾空白 + 截断。 */
function multiLine(raw, max) {
	const s = String(raw ?? "").trim();
	if (s === "") return { ok: false, detail: "不能为空" };
	if (s.length > max) return { ok: false, detail: `太长（${s.length} 字符 > ${max}）` };
	return { ok: true, value: s };
}

/** 取所有者自己的小队表（没有就建一张空的，但不写回 —— 读路径不该有副作用）。 */
function ownedSquads(state, ownerId) {
	return state.get(ownerId) ?? new Map();
}

/** 所有者视角：按名字找自己的小队。 */
export function findSquad(state, ownerId, name) {
	return ownedSquads(state, ownerId).get(name);
}

/**
 * 授权：这次工具调用能动哪个小队。
 *
 * 返回 `{ok:true, squad}` 或 `{ok:false, detail}`。
 *
 * C 之后**只有所有者**会调这些工具：成员不是 dsh agent，没有工具可调 —— 它那一侧的
 * 动作（写黑板、改自己那一行）发生在自己的 loop 里，由小队执行器直接落库（见
 * `startMember`）。所以这里没有「成员分支」：`callerId` 就是所有者会话 id，
 * 小队只对它开放（多小队之间互相隔离就靠这一条）。
 */
export function authorize(state, callerId, name) {
	if (typeof callerId !== "string" || callerId === "") {
		return { ok: false, detail: "拿不到调用方的会话 id（dsh 的 exec.agent.id 没读到）—— 这不该发生，请报告" };
	}
	const wanted = typeof name === "string" ? name.trim() : "";
	// 「不点名」只对 `squad_status`（看全部）有意义，而它压根不走这个函数。
	// 所以这里直接拒 —— 曾经这里给所有者返回了一个 `{ok:true}` 但**没有 `squad`**
	// 的成功，调用方（派成员/改行/写黑板/收队）一解引用就是 TypeError：
	// 传 `squad: "   "` 就能触发（schema 的 `required` 挡不住空串）。
	if (wanted === "") {
		return { ok: false, detail: "要指定小队名（只有 `squad_status` 允许不填）" };
	}
	const squad = findSquad(state, callerId, wanted);
	if (!squad) {
		return { ok: false, detail: `没有小队「${wanted}」（小队只对创建它的会话开放）` };
	}
	return { ok: true, squad };
}

/** 建队。所有者视角。 */
export function newSquad(state, ownerId, { name, objective, note, cwd }) {
	if (typeof ownerId !== "string" || ownerId === "") {
		return { ok: false, detail: "拿不到调用方的会话 id —— 这不该发生，请报告" };
	}
	const n = oneLine(name, MAX_NAME);
	if (!n.ok) return { ok: false, detail: `小队名${n.detail}` };
	const o = multiLine(objective, MAX_TEXT);
	if (!o.ok) return { ok: false, detail: `目标${o.detail}` };
	let noteValue;
	if (note !== undefined && note !== null && String(note).trim() !== "") {
		const t = multiLine(note, MAX_TEXT);
		if (!t.ok) return { ok: false, detail: `说明${t.detail}` };
		noteValue = t.value;
	}
	const squads = ownedSquads(state, ownerId);
	if (squads.has(n.value)) {
		return { ok: false, detail: `你已经有小队「${n.value}」了（换一个名字，或先用 squad_status 看它）` };
	}
	const squad = {
		name: n.value,
		objective: o.value,
		note: noteValue,
		owner: ownerId,
		// 落盘按 cwd 分文件（重启后会话 id 会变，只有它是稳定的）。REQ-015 §6.2
		cwd: typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : undefined,
		adoptedFrom: undefined,
		createdAt: Date.now(),
		members: new Map(),
		board: [],
		closed: undefined,
	};
	// 只在真的建成功时才写回（读路径无副作用）。
	const next = new Map(squads);
	next.set(squad.name, squad);
	state.set(ownerId, next);
	return { ok: true, squad };
}

/**
 * 路径类的字段：**只去首尾空白**，不压内部空白 —— `oneLine` 会把连续空白压成一个空格，
 * 而路径里可以有两个连续空格，那样就把用户给的路径改坏了。
 */
function pathLine(raw, max = MAX_TEXT) {
	const s = String(raw ?? "").trim();
	if (s === "") return { ok: false, detail: "不能为空" };
	if (s.length > max) return { ok: false, detail: `太长（${s.length} 字符 > ${max}）` };
	return { ok: true, value: s };
}

/**
 * 加成员（所有者视角）。`worktree` **必填**：成员的一切文件操作都被钉在这棵 worktree 里
 * （`squad-tools.js` 的 `resolveInside`），没有它成员连读都读不了。
 */
export function addMember(state, squad, { label, role, task, worktree }) {
	if (squad.closed) return { ok: false, detail: closedDetail(squad) };
	const l = oneLine(label, MAX_NAME);
	if (!l.ok) return { ok: false, detail: `成员名${l.detail}` };
	const r = oneLine(role, MAX_NAME);
	if (!r.ok) return { ok: false, detail: `角色${r.detail}` };
	const t = multiLine(task, MAX_TEXT);
	if (!t.ok) return { ok: false, detail: `任务${t.detail}` };
	const w = pathLine(worktree);
	if (!w.ok) return { ok: false, detail: `worktree${w.detail}（成员的文件操作全钉在它里面）` };
	if (squad.members.has(l.value)) {
		return { ok: false, detail: `「${squad.name}」里已经有成员「${l.value}」了（要重跑就再调一次 squad_spawn，它会复用这一行）` };
	}
	squad.members.set(l.value, {
		label: l.value,
		role: r.value,
		task: t.value,
		worktree: w.value,
		status: "在跑",
		note: undefined,
		updatedAt: Date.now(),
		// REQ-015：用量与耗时是**累计**的（重试/续聊都往上加），attempts 是跑过几次
		usage: {},
		attempts: 0,
		startedAt: undefined,
		endedAt: undefined,
		durationMs: 0,
		// 运行时字段：不进快照（`running` 里是 AbortController，`transcript` 走单独的路由）。
		transcript: [],
		running: undefined,
		// 直投的待投队列与续聊的消息历史：**不落盘**（重启后队列与历史都没有意义）
		inbox: [],
		history: undefined,
	});
	return { ok: true, member: squad.members.get(l.value) };
}

/**
 * 改成员一行（所有者视角；成员自己没有工具，改不到）。
 *
 * 能改：角色 / 任务 / 状态 / 一句结论 / worktree。**不能改成员名**（它是 Map 的键，
 * 也是黑板上的作者名 —— 改名等于换一个人，那就重派一个）。
 * 状态与结论平时由成员的 loop 自己维护（跑完写「完成」、卡住写原因），
 * 这里给主 agent 留一个手动覆盖的口子。
 */
export function updateMember(squad, label, patch) {
	if (squad.closed) return { ok: false, detail: closedDetail(squad) };
	const l = oneLine(label, MAX_NAME);
	if (!l.ok) return { ok: false, detail: `成员名${l.detail}` };
	const member = squad.members.get(l.value);
	if (!member) {
		const names = [...squad.members.keys()];
		return {
			ok: false,
			detail: names.length === 0 ? `「${squad.name}」里还没有成员` : `「${squad.name}」里没有成员「${l.value}」（有：${names.join(" / ")}）`,
		};
	}
	if (patch.status !== undefined && patch.status !== null && String(patch.status).trim() !== "") {
		const s = oneLine(patch.status, MAX_NAME);
		if (!s.ok) return { ok: false, detail: `状态${s.detail}` };
		if (!MEMBER_STATUS.includes(s.value)) {
			return { ok: false, detail: `状态只能是 ${MEMBER_STATUS.join(" / ")} 之一，收到的是「${s.value}」` };
		}
		member.status = s.value;
	}
	if (patch.note !== undefined && patch.note !== null && String(patch.note).trim() !== "") {
		const n = multiLine(patch.note, MAX_TEXT);
		if (!n.ok) return { ok: false, detail: `结论${n.detail}` };
		member.note = n.value;
	}
	if (patch.role !== undefined && patch.role !== null && String(patch.role).trim() !== "") {
		const r = oneLine(patch.role, MAX_NAME);
		if (!r.ok) return { ok: false, detail: `角色${r.detail}` };
		member.role = r.value;
	}
	if (patch.task !== undefined && patch.task !== null && String(patch.task).trim() !== "") {
		const t = multiLine(patch.task, MAX_TEXT);
		if (!t.ok) return { ok: false, detail: `任务${t.detail}` };
		member.task = t.value;
	}
	if (patch.worktree !== undefined && patch.worktree !== null && String(patch.worktree).trim() !== "") {
		const w = pathLine(patch.worktree);
		if (!w.ok) return { ok: false, detail: `worktree${w.detail}` };
		member.worktree = w.value;
	}
	member.updatedAt = Date.now();
	return { ok: true, member };
}

/**
 * 往黑板追加一条。`from` 由调用方**自动判定**后传进来（主 agent 那一侧是「主 agent」，
 * 成员那一侧由小队执行器传它的成员名），工具层不暴露这个参数 —— 少一个能撒谎的入口。
 */
export function appendBoard(squad, { from, text }, limit = SQUAD_DEFAULTS.boardLimit) {
	if (squad.closed) return { ok: false, detail: closedDetail(squad) };
	const t = multiLine(text, MAX_BOARD_TEXT);
	if (!t.ok) return { ok: false, detail: `黑板内容${t.detail}` };
	const entry = { at: Date.now(), from: String(from ?? "?"), text: t.value };
	squad.board.push(entry);
	// 内存护栏：超了丢最旧的（不是限流，是别把进程撑爆）。
	let dropped = 0;
	while (squad.board.length > limit) {
		squad.board.shift();
		dropped += 1;
	}
	return { ok: true, entry, dropped };
}

/** 收队之后一切写操作都用这句拒（只读是「关」的全部意义，否则 `closed` 只是个标签）。 */
function closedDetail(squad) {
	return `小队「${squad.name}」已经收队了（只读：名册与黑板留着能看，但不能再改）`;
}

/** 关队（所有者视角）。成员与黑板留在内存里，直到会话销毁。 */
export function closeSquad(squad, reason) {
	if (squad.closed) return { ok: false, detail: `小队「${squad.name}」早就关了` };
	let r;
	if (reason !== undefined && reason !== null && String(reason).trim() !== "") {
		const t = multiLine(reason, MAX_TEXT);
		if (!t.ok) return { ok: false, detail: `理由${t.detail}` };
		r = t.value;
	}
	squad.closed = { at: Date.now(), reason: r };
	return { ok: true, squad };
}

// ── 快照与渲染（一条数据路径，两个渲染器） ───────────────────────────────────

/**
 * 一个小队 → **无损 JSON**。所有可选字段用 `null` 或干脆不出现，绝不放 `undefined`
 * （面板把这份数据 JSON 化后走 HTTP，`undefined` 会当场变成「字段凭空消失」）。
 */
function squadView(ownerId, squad) {
	// 小队合计 = 各成员之和。**只算不快照成字段**：两份真相迟早对不上。
	const total = {};
	for (const m of squad.members.values()) {
		for (const [key, value] of Object.entries(m.usage ?? {})) {
			if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
		}
	}
	return {
		name: squad.name,
		objective: squad.objective,
		note: squad.note ?? null,
		owner: ownerId,
		adoptedFrom: squad.adoptedFrom ?? null,
		cwd: squad.cwd ?? null,
		usage: total,
		createdAt: squad.createdAt,
		closed: squad.closed ? { at: squad.closed.at, reason: squad.closed.reason ?? null } : null,
		members: [...squad.members.values()].map((m) => ({
			label: m.label,
			role: m.role,
			task: m.task,
			worktree: m.worktree ?? null,
			status: m.status,
			note: m.note ?? null,
			updatedAt: m.updatedAt,
			// REQ-015：面板要看耗时/token/重试次数
			usage: m.usage ?? {},
			attempts: m.attempts ?? 0,
			startedAt: m.startedAt ?? null,
			endedAt: m.endedAt ?? null,
			durationMs: m.durationMs ?? 0,
			inbox: Array.isArray(m.inbox) ? m.inbox.length : 0,
			// 面板要判断「还在跑吗」，但 `running` 本身是 AbortController（不能进 JSON）。
			running: m.running !== undefined,
			// 转录的条数（正文走 `/transcript` 路由，别塞进这份快照里）。
			events: Array.isArray(m.transcript) ? m.transcript.length : 0,
		})),
		board: squad.board.map((e) => ({ at: e.at, from: e.from, text: e.text })),
	};
}

/**
 * 这次调用者能看到的小队 —— 只能是自己建的（成员不是 dsh agent，没有调用方身份，
 * 它的视角在面板的 `/transcript` 里，不在这里）。
 *
 * `name` 给了就只渲染那一个 —— 点名的语义就是「只看它」。不这么做的话，所有者
 * 点 `squad_status({squad:"A"})` 会拿到名下**全部**小队，工具描述与行为对不上。
 * 鉴权在外面做（`authorize`），这里只管渲染。
 */
export function snapshot(state, callerId, name) {
	const only = typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
	const mine = ownedSquads(state, callerId);
	const picked = only === undefined ? [...mine.entries()] : [...mine.entries()].filter(([, s]) => s.name === only);
	return { squads: picked.map(([ownerId, squad]) => squadView(ownerId, squad)), me: callerId };
}

/**
 * **全量**快照：不分调用方，返回进程内所有小队（GUI 面板用）。
 *
 * 为什么面板不能按「当前会话」过滤：中央面板那个槽位（`main`，keyed）**不绑会话**
 * —— `dsh-client-ui-layout` 的注释原话是 "other keys receive no Session binding"，
 * 组件拿不到「用户在哪个会话里」。要么猜一个，要么全给。选全给：每条带上所有者
 * 会话 id，面板自己按它分组、再去 `ctx.sessions` 查标题。用户在哪个会话里都看得见。
 *
 * 安全上与调度器面板同一档：栅栏只放行回环 + 同源，面板**只读**（见 `registerSquadRoutes`）。
 */
export function snapshotAll(state) {
	const squads = [];
	for (const [ownerId, byName] of state) {
		for (const squad of byName.values()) squads.push(squadView(ownerId, squad));
	}
	// 稳定顺序：创建时间，再按名字。否则每次刷新行都在跳，点错人是常事。
	const byName = (a, b) => {
		if (a.name === b.name) return 0;
		return a.name < b.name ? -1 : 1;
	};
	squads.sort((a, b) => a.createdAt - b.createdAt || byName(a, b));
	return { squads, count: squads.length };
}

/** 毫秒 → 人看的耗时。纯函数（面板与工具输出都用它，免得两处各写一份）。 */
export function formatDuration(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

const clock = (ms) => {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 成员一行。`worktree` 打全 —— 主 agent 要按它去审 diff。 */
function renderMember(m) {
	const bits = [`- ${m.label}`, `[${m.role}]`, m.status];
	if (m.running) bits.push("（正在跑）");
	if (m.worktree) bits.push(`worktree=${m.worktree}`);
	if (m.events > 0) bits.push(`转录 ${m.events} 条`);
	if (m.durationMs > 0) bits.push(`耗时 ${formatDuration(m.durationMs)}`);
	if (m.attempts > 1) bits.push(`跑了 ${m.attempts} 次`);
	if (m.inbox > 0) bits.push(`待投 ${m.inbox} 条`);
	const tokens = usageLine(m.usage);
	if (tokens !== "用量未知") bits.push(tokens);
	const lines = [bits.join("  ")];
	lines.push(`    任务：${m.task.replace(/\n/g, "\n    ")}`);
	if (m.note) lines.push(`    最新：${m.note.replace(/\n/g, "\n    ")}`);
	return lines.join("\n");
}

/** 黑板：默认只渲染最后 `tail` 条（全量在快照里，面板可以滚）。 */
function renderBoard(board, tail = 10) {
	if (board.length === 0) return "黑板：还是空的";
	const shown = board.slice(-tail);
	const head = board.length > shown.length ? `黑板（最后 ${shown.length} 条 / 共 ${board.length} 条）：` : `黑板（${board.length} 条）：`;
	return [head, ...shown.map((e) => `  ${clock(e.at)}  ${e.from}：${e.text.replace(/\n/g, "\n      ")}`)].join("\n");
}

/** 把快照渲染成给人看的文本。 */
export function renderSnapshot(snap, { boardTail = 10 } = {}) {
	if (snap.squads.length === 0) {
		return "没有小队。要建一个：`squad_new`（给个名字和目标），然后 `squad_spawn` 派成员进去。";
	}
	const out = [];
	for (const s of snap.squads) {
		const counts = {};
		for (const m of s.members) counts[m.status] = (counts[m.status] ?? 0) + 1;
		const summary = MEMBER_STATUS.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(" / ");
		out.push(`小队「${s.name}」${s.closed ? `（已关：${s.closed.reason ?? "没写理由"}）` : ""}`);
		out.push(`  目标：${s.objective.replace(/\n/g, "\n  ")}`);
		if (s.note) out.push(`  说明：${s.note}`);
		out.push(`  成员 ${s.members.length}${summary ? `（${summary}）` : ""}${s.usage?.totalTokens ? `  合计 ${usageLine(s.usage)}` : ""}`);
		for (const m of s.members) out.push(renderMember(m));
		out.push(renderBoard(s.board, boardTail));
	}
	return out.join("\n");
}

// ── 接线（工具注册 + 会话销毁时清理） ────────────────────────────────────────

/**
 * 取调用方的会话 id。三种取法都是同一个值（REQ-009 §5 第 3 条），
 * 但 dsh 版本之间字段位置动过，所以按「最直接 → 兜底」的顺序取。
 */
function callerIdOf(exec) {
	return exec?.agent?.id ?? exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id;
}

/** 调用方的工作目录。落盘按它分文件（REQ-015 §6.2）。取不到就 undefined。 */
function callerCwdOf(exec) {
	const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? exec?.cwd;
	return typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : undefined;
}

/* ═══════════════════════ 成员：提示词与一轮里看到什么 ═══════════════════════ */

/**
 * 当前沙箱模式对 bash 意味着什么 —— 直接写进成员的提示词。
 *
 * 为什么要按模式说：`danger-full-access` 下 dsh **直接跳过 confine**（REQ-011 §6.4），
 * 那时 bash 能读能写这台机器上的任何东西（包括凭据文件）。这个事实必须让成员知道，
 * 否则它会以为「反正有沙箱兜着」。成员是模型 —— 边界守不守得住，很大程度上取决于
 * 它知不知道边界在哪（以及有没有）。
 */
const BASH_MODE_NOTE = {
	"read-only": "· 这台机器的沙箱是 `read-only`：bash **只能读**，要改文件请用 write / edit。",
	"workspace-write": "· 这台机器的沙箱是 `workspace-write`：bash 只能写工作区里的东西。",
	"danger-full-access":
		"· ⚠ 这台机器的沙箱是 `danger-full-access`：**bash 没有沙箱** —— 命令想干什么就能干什么，" +
		"包括读工作区外面的文件（那里可能有凭据）。边界只能你自己守：只在工作区里操作，不要碰外面的东西。",
};

/**
 * 成员的 system 提示。这是**成员行为的主要杠杆** —— 它不认识 dsh、不认识团队基线，
 * 这些规矩只能在这里说清楚。
 */
export function memberSystemPrompt({ squad, member, bashMode, toolNames }) {
	const names = Array.isArray(toolNames) && toolNames.length > 0 ? toolNames : MEMBER_TOOLS.map((tool) => tool.name);
	const fileTools = names.filter((name) => name !== "board").join(" / ");
	const hasBash = names.includes("bash");
	return [
		`你是小队「${squad.name}」的成员「${member.label}」（角色：${member.role}）。`,
		`小队的目标：${squad.objective}`,
		"",
		"你的工作方式：",
		`· 工作区是 \`${member.worktree}\`。${fileTools} 全都在它里面，路径越界会被直接拒绝。`,
		`· 工具就 ${names.length} 个：${names.join(" / ")}。没有别的（没有别的 agent 可派，也没有审批通道）。`,
		...(hasBash
			? [
					"· bash 在 dsh 的沙箱策略下执行。你**没有审批通道**：被拦下就是做不成 —— 把这件事写进结论，不要绕。",
					...(BASH_MODE_NOTE[bashMode] ? [BASH_MODE_NOTE[bashMode]] : []),
				]
			: []),
		"· 有发现、有结论、卡住了，都用 `board` 写进小队黑板。队里其他人看得见；主 agent 不必当传声筒。",
		"· **不要** git commit / merge / push，也不要碰工作区外面的东西 —— 合并与否由主 agent 决定。",
		"· 先自己看清楚再动手：改一个函数前先 grep 出它的调用方；修根因，不打补丁。",
		"",
		"收工：干完了就在最后一条消息里说清「做成了什么 / 改了哪些文件 / 怎么验证的」，",
		"然后**不要再调工具** —— 不再调工具就等于你收工了，小队会把这条结论记进黑板。",
	].join("\n");
}

/**
 * 成员的第一条 user 消息：任务 + 黑板最近几条。
 *
 * 带黑板是刻意的：多个成员并行时，「别人已经查到了什么」是他们之间唯一的共享内存，
 * 不给就成了各查各的。
 */
export function memberTaskText(squad, member, { tail = 8, each = 500 } = {}) {
	const lines = [`任务：${member.task}`];
	const entries = squad.board.slice(-tail);
	if (entries.length > 0) {
		lines.push("", "── 小队黑板（最近几条，是别的成员写的）──");
		for (const e of entries) {
			const text = e.text.length > each ? `${e.text.slice(0, each)}…` : e.text;
			lines.push(`${e.from}：${text}`);
		}
	}
	return lines.join("\n");
}

/** 把 token 用量压成一行（进状态与黑板，不单独占字段）。 */
export function usageLine(usage) {
	if (!usage || typeof usage !== "object") return "用量未知";
	const parts = [];
	if (typeof usage.inputTokens === "number") parts.push(`in ${usage.inputTokens}`);
	if (typeof usage.outputTokens === "number") parts.push(`out ${usage.outputTokens}`);
	if (typeof usage.cacheReadTokens === "number" && usage.cacheReadTokens > 0) parts.push(`cacheRead ${usage.cacheReadTokens}`);
	return parts.length > 0 ? parts.join(" / ") : "用量未知";
}

/* ═══════════════════════════ HTTP 路由（面板用，只读） ═══════════════════════════ */

export const SQUAD_ROUTE_PREFIX = "/api/team/squad";

/**
 * 注册 `/api/team/squad` 下的路由。返回 disposer。
 *
 * **只有 GET，三个端点**：
 *   · `/options`    → 探活。客户端拿 404 就不注册面板（这就是「可选安装」在 UI 上的落点）
 *   · `/squads`     → 全量快照（`snapshotAll`）
 *   · `/transcript` → 某个成员的转录（`?owner=&squad=&member=`）—— 面板的「看转录」
 *     看的就是它。C 之后成员**不是 dsh 会话**，所以没有 `openSession` 可调；转录是
 *     我们自己的数据，由这个只读路由交出去。
 *
 * 为什么一个写接口都不开：改状态的入口只有那 6 个工具，都在进程内、都要过
 * `authorize()`（谁能动这个队）。HTTP 这边多开一个 POST，就等于多一套「谁能改」的
 * 判断要维护，而面板根本不需要 —— 它只负责看。
 */
export function registerSquadRoutes(scope, { state, config, log = () => {} }) {
	/** 面板渲染一条转录最多看多少字符（转录本身留在内存里，这里只是别把响应撑爆）。 */
	const TRANSCRIPT_VIEW_CHARS = 4000;

	const handler = async (req, res) => {
		// 栅栏放最前面，探活也一样 —— 别让探测本身变成信息泄露。
		if (!isTrustedRequest(req)) {
			log(`拒绝非本机来源的小队请求：${req?.socket?.remoteAddress ?? "?"}`);
			return sendJson(res, 403, { ok: false, error: "只接受本机请求" });
		}
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			const sub = url.pathname.slice(SQUAD_ROUTE_PREFIX.length) || "/";
			const method = (req.method ?? "GET").toUpperCase();

			if (sub === "/options" && method === "GET") {
				return sendJson(res, 200, { ok: true, boardLimit: config.boardLimit, transcript: true, members: true });
			}
			if (sub === "/squads" && method === "GET") {
				return sendJson(res, 200, { ok: true, ...snapshotAll(state) });
			}
			if (sub === "/transcript" && method === "GET") {
				const owner = url.searchParams.get("owner") ?? "";
				const squadName = url.searchParams.get("squad") ?? "";
				const memberLabel = url.searchParams.get("member") ?? "";
				// 小队名只在所有者的表里唯一，所以必须带上 owner 才能定位（快照里每条都有它）。
				const squad = findSquad(state, owner, squadName);
				if (!squad) return sendJson(res, 404, { ok: false, error: `没有小队「${squadName}」` });
				const member = squad.members.get(memberLabel);
				if (!member) return sendJson(res, 404, { ok: false, error: `「${squadName}」里没有成员「${memberLabel}」` });
				const entries = (Array.isArray(member.transcript) ? member.transcript : []).slice(-TRANSCRIPT_LIMIT).map((e) => ({
					at: e.at ?? null,
					role: e.role,
					step: e.step ?? null,
					name: e.name ?? null,
					isError: e.isError === true,
					calls: Array.isArray(e.calls) ? e.calls : [],
					text: typeof e.text === "string" && e.text.length > TRANSCRIPT_VIEW_CHARS ? `${e.text.slice(0, TRANSCRIPT_VIEW_CHARS)}…` : (e.text ?? ""),
				}));
				return sendJson(res, 200, {
					ok: true,
					owner,
					squad: squadName,
					member: { label: member.label, role: member.role, task: member.task, status: member.status, note: member.note ?? null, worktree: member.worktree ?? null, running: member.running !== undefined },
					entries,
				});
			}
			return sendJson(res, 404, { ok: false, error: `没有这条路由：${sub}` });
		} catch (err) {
			log(`小队路由出错：${err?.stack ?? err}`);
			return sendJson(res, 500, { ok: false, error: "内部错误" });
		}
	};
	return scope.webServer.register({ kind: "prefix", path: SQUAD_ROUTE_PREFIX, handler });
}

/**
 * 装上小队工具。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} options
 * @param {object} options.config 已叠好的配置
 * @returns {{enabled: boolean, reason?: string, describe: () => string, dispose: () => void, state: Map}}
 */
export function installSquad(ctx, { config }) {
	if (config.enabled !== true) {
		return {
			enabled: false,
			reason: "配置里关掉了",
			describe: () => "小队：关  （配置里关掉了）",
			dispose: () => {},
			state: createState(),
		};
	}

	const state = createState();
	const boardLimit = config.boardLimit;
	const logger = ctx.logger;
	const log = (msg) => logger?.info?.(`[team] ${msg}`);

	/**
	 * 落盘（REQ-015 §6.2）。按 cwd 一份文件；`load` 时**接管**上一会话的小队
	 * （`owner` 改成当前会话、`adoptedFrom` 留痕），所以授权规则一个字不用改。
	 */
	const store = config.persist === true ? createSquadStore({ dir: path.join(dshHome(), "team-workflow", "squads"), log }) : undefined;
	/** 已经读过盘的 cwd（每个 cwd 只读一次，别把接管做第二遍） */
	const loadedCwds = new Set();

	/** 这个 cwd 下当前内存里的全部小队（写盘时取的是**最新**状态，不是入队那一刻的）。 */
	function squadsIn(cwd) {
		const out = [];
		for (const table of state.values()) {
			for (const squad of table.values()) if (squad.cwd === cwd) out.push(squad);
		}
		return out;
	}

	/** 状态变了就安排一次写（防抖在 store 里）。 */
	function persistSquad(squad) {
		if (!store || typeof squad?.cwd !== "string" || squad.cwd === "") return;
		const cwd = squad.cwd;
		store.save(cwd, () => squadsIn(cwd));
	}

	/** 第一次碰这个 cwd 时把盘上的小队捡回来。 */
	function ensureLoaded(cwd, callerId) {
		if (!store || typeof callerId !== "string" || callerId === "") return;
		const key = workspaceKey(cwd ?? "");
		if (loadedCwds.has(key)) return;
		loadedCwds.add(key);
		let records;
		try {
			records = store.load(cwd ?? "");
		} catch (err) {
			log(`捡回小队失败（${cwd ?? "未知目录"}）：${err?.message ?? err}`);
			return;
		}
		if (records.length === 0) return;
		const table = new Map(ownedSquads(state, callerId));
		let adopted = 0;
		let skipped = 0;
		for (const record of records) {
			const squad = reviveSquad(record, { statuses: MEMBER_STATUS });
			if (squad.name === "") continue;
			if (table.has(squad.name)) {
				skipped += 1;
				continue;
			}
			if (squad.owner !== callerId) {
				squad.adoptedFrom = squad.owner ?? null;
				squad.owner = callerId;
				adopted += 1;
			}
			table.set(squad.name, squad);
		}
		state.set(callerId, table);
		log(`从 ${cwd ?? "未知目录"} 捡回 ${records.length - skipped} 支小队（其中接管 ${adopted} 支）`);
	}

	/** 工具入口统一走它：拿调用方身份，顺带把盘上的小队捡回来。 */
	function actorOf(exec) {
		const id = callerIdOf(exec);
		const cwd = callerCwdOf(exec);
		ensureLoaded(cwd, id);
		return { id, cwd };
	}

	const disposers = [];
	// 会话销毁就清掉它的小队 —— 这是「状态只在当前会话」的落地点。
	// 拿不到 session.id 时不清（宁可不 clean，也不能误清别人的）。
	// 顺序要紧：**先掐掉还在跑的成员**再删状态 —— 否则循环会继续烧模型、继续往一个
	// 没人看的黑板里写（成员在后台跑，用户可能早就把会话关了）。
	const offDisposed = ctx.on?.("session/disposed", (session) => {
		const id = session?.id;
		if (typeof id !== "string" || id === "") return;
		const mine = state.get(id) ?? new Map();
		for (const squad of mine.values()) abortMembers(squad, "会话已结束");
		store?.flush();   // 清状态之前先把盘写实（否则最后几秒的黑板/转录就丢了）
		state.delete(id);
		// **必须把这个 cwd 的「已读过盘」标记也删掉**（2026-10-16 std 测逮到）：
		// 标记留着的话，同一工作目录里**新开的会话**会以为盘已经读过了，于是一个队都看不到；
		// 更糟的是它随后建一个同名的队，会把盘上那支原样覆盖掉（静默丢状态）。
		for (const squad of mine.values()) {
			if (typeof squad.cwd === "string" && squad.cwd !== "") loadedCwds.delete(workspaceKey(squad.cwd));
		}
	});
	if (typeof offDisposed === "function") disposers.push(offDisposed);

	// 输出形状（6 个工具都是「一段文本」），写成工厂避免重复 6 遍。
	const text = () => ({
		schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
		render: (_args, value) => [{ type: "text", text: value.text }],
	});

	// ── 成员循环的接线（C 路：自己发模型请求、自己执行工具） ────────────────────

	/**
	 * 宿主的 dsh-llm 导出（`BlockAssembler` + `createToolResultMessage`）。
	 *
	 * 加载逻辑在 `lib/dsh-exports.js`（`lib/repeat-guard.js` 也用它）—— 那里收着那个
	 * 2026-10-09 真机踩到的坑：`loader.unwrapExports` 按 `__esModule` 语义把命名空间换成
	 * default，只信它就会报「dsh-llm 没导出 BlockAssembler」（REQ-011 §8.1）。
	 * 失败**不缓存** —— 下一次 `squad_spawn` 还应该能重试（换 profile、升级 dsh 都可能修好）。
	 */
	const host = makeHostLoader(ctx);
	async function loadKit() {
		const kit = await host.load("@deepseek-ai/dsh-llm", ["BlockAssembler", "createToolResultMessage"]);
		if (typeof kit.BlockAssembler !== "function" || typeof kit.createToolResultMessage !== "function") {
			throw new Error("dsh-llm 没导出 BlockAssembler / createToolResultMessage");
		}
		return kit;
	}

	/**
	 * bash 用的沙箱策略：取部署的默认策略，把 `workspaceRoot` 换成成员的 worktree。
	 *
	 * 拿不到策略就返回 `undefined`（bash 退回部署默认的工作区根）。这时 fs 工具仍然钉在
	 * worktree 里，但 bash 的写边界只剩沙箱自己的判断 —— 而本机当前是
	 * `danger-full-access`，dsh 在那一档**直接跳过 confine**，所以沙箱在这里本来就不构成
	 * 额外保护（REQ-011 §6.4 已写明，README 也要写）。
	 */
	function policyFor(worktree) {
		// 用 `ctx.get(name)` 而不是直接读 `ctx.sandboxPolicy`：cordis 的 ctx 是访问器代理，
		// 没声明 inject 的属性**读一下就抛** `cannot get property "…" without inject`
		// （本包 `lib/mc-adapter.js:240`、`lib/computer.js:744` 都踩过，已改用 get）。
		const service = ctx.get?.("sandboxPolicy");
		const policy = service?.resolve?.();
		if (!policy || typeof policy !== "object") return undefined;
		return { ...policy, workspaceRoot: worktree };
	}

	/** 掐掉一个队里所有还在跑的成员（收队、会话销毁、插件拆除时都用它）。 */
	function abortMembers(squad, reason) {
		for (const member of squad.members.values()) {
			if (!member.running) continue;
			member.running.abort.abort();
			member.note = reason;
			member.updatedAt = Date.now();
		}
	}

	/** 造一条给成员看的 user 消息。用我们自己循环的形状 —— 不需要宿主的 `createUserMessage`。 */
	function userMessage(text) {
		return { role: "user", content: [{ type: "text", text }] };
	}

	/**
	 * 直投：把一句话投给某个成员（REQ-015 §6.3）。
	 *
	 * 在跑 → 进**待投队列**，循环在下一步边界注入（`takeInbox`）；不在跑 → 留在队列里，
	 * 等它下次跑（续聊或重派）时先投出去。两种都写目标转录 + 一条黑板 —— 直投不是悄悄话，
	 * 队里其他人也该看见协调过程。
	 */
	function deliverSay(squad, { from, to, text }) {
		if (squad.closed) return { ok: false, detail: closedDetail(squad) };
		const wanted = String(to ?? "").replace(/\s+/g, " ").trim();
		const target = squad.members.get(wanted);
		if (!target) {
			const names = [...squad.members.keys()];
			return {
				ok: false,
				detail: names.length === 0 ? `「${squad.name}」里还没有成员` : `「${squad.name}」里没有成员「${wanted}」（有：${names.join(" / ")}）`,
			};
		}
		const t = multiLine(text, MAX_TEXT);
		if (!t.ok) return { ok: false, detail: `消息${t.detail}` };
		const body = `[来自 ${from}] ${t.value}`;
		target.inbox = Array.isArray(target.inbox) ? target.inbox : [];
		target.inbox.push(userMessage(body));
		target.transcript.push({ role: "user", text: body, injected: true, queued: target.running === undefined, at: Date.now() });
		while (target.transcript.length > TRANSCRIPT_LIMIT) target.transcript.shift();
		appendBoard(squad, { from, text: `→ ${target.label}：${t.value}` }, boardLimit);
		persistSquad(squad);
		return { ok: true, queued: target.running === undefined, target };
	}

	/**
	 * 把一个成员跑起来。**故意不 await** —— 工具要立刻返回，成员在后台跑。
	 * 多个成员因此是**真并行**（这就是「一起朝目标推进」），各自往同一块黑板写。
	 */
	/**
	 * 把一个成员跑起来。**故意不 await** —— 工具要立刻返回，成员在后台跑。
	 * 多个成员因此是**真并行**（这就是「一起朝目标推进」），各自往同一块黑板写。
	 *
	 * REQ-015 之后它多管三件事：
	 *  · **续聊**（`resume`）：接着上次的消息历史跑，而不是从零开始；
	 *  · **重试**：只对基础设施失败（`kind === "infra"`）重试，`maxSteps` 耗尽不重试；
	 *  · **超时**：每次尝试一个墙钟上限，超了就 abort。
	 *
	 * @param {object} [options.resume] `{ messages, task }` —— 续聊的种子历史与新任务
	 */
	function startMember(squad, member, { provider, model, resume } = {}) {
		const llm = ctx.get?.("llm");
		if (!llm || typeof llm.stream !== "function") {
			return { ok: false, detail: "宿主没有 llm 服务（stream），成员跑不起来" };
		}
		const outer = new AbortController();
		member.running = { abort: outer, startedAt: Date.now() };
		member.status = "在跑";
		member.note = undefined;
		member.startedAt = Date.now();
		member.updatedAt = Date.now();
		if (!resume) member.transcript = [];   // 续聊保留上次的转录（它是同一件事的延续）
		const env = {
			worktree: member.worktree,
			ctx,
			signal: outer.signal,
			bashPolicy: policyFor(member.worktree),
			board: (boardText) => appendBoard(squad, { from: member.label, text: boardText }, boardLimit),
			// 直投（REQ-015）：成员之间说话。目标在跑就进它的待投队列，否则排队等它下次跑。
			say: (to, text) => deliverSay(squad, { from: member.label, to, text }),
		};
		const { tools, schemas } = memberToolsFor({ bash: config.bash });
		const allowed = new Set(tools.map((tool) => tool.name));
		const onEvent = (event) => {
			// 内存护栏两道：**条数**（只留最后 TRANSCRIPT_LIMIT 条）与**单条正文**
			// （模型能一次吐几十 KB，光限条数挡不住 —— 200 条 × 128KB 就是几十 MB）。
			member.transcript.push({
				...event,
				text: typeof event.text === "string" && event.text.length > TRANSCRIPT_TEXT_MAX ? `${event.text.slice(0, TRANSCRIPT_TEXT_MAX)}…（转录截断）` : event.text,
				at: Date.now(),
			});
			while (member.transcript.length > TRANSCRIPT_LIMIT) member.transcript.shift();
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
			}, config.memberTimeoutMinutes * 60_000);
			// **不要 unref**：这个定时器是这次尝试唯一的终点。unref 之后，一旦事件循环没有别的
			// 待办（自检里就是这样），进程会直接退出 —— 超时永远不会发生。
			const startedAt = Date.now();
			try {
				const kit = await loadKit();
				const result = await runMemberLoop({
					kit,
					stream: (options) => llm.stream(options),
					provider,
					model,
					system: memberSystemPrompt({ squad, member, bashMode: env.bashPolicy?.mode, toolNames: [...allowed] }),
					task,
					messages: seed,
					// 每步边界取待投消息：成员在跑时别人投给它的那几句话
					takeInbox: () => {
						const queued = member.inbox ?? [];
						member.inbox = [];
						return queued;
					},
					// 发给 provider 的是**只有线上字段**的那份（`run` 不出去）
					tools: schemas,
					// 执行器只认给出去的工具：模型幻觉出一个没给它的工具名（比如关掉的 bash）也要拒
					executeTool: (call) =>
						allowed.has(call.name)
							? runMemberTool(call.name, call.arguments, env)
							: { text: `[失败] 这个成员没有 \`${call.name}\` 工具（可用：${[...allowed].join(" / ")}）`, isError: true },
					onEvent,
					signal: controller.signal,
					limits: { ...LOOP_DEFAULTS, maxSteps: config.maxSteps },
				});
				if (timedOut) {
					return { ...result, status: "卡住", kind: "timeout", reason: `超过 ${config.memberTimeoutMinutes} 分钟上限` };
				}
				return result;
			} catch (err) {
				// 走到这里是基础设施层面的失败（llm 服务、loader、执行器崩了）
				if (timedOut) {
					return { status: "卡住", kind: "timeout", reason: `超过 ${config.memberTimeoutMinutes} 分钟上限`, steps: 0, usage: {}, transcript: [], messages: seed ?? [] };
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
			let task = resume?.task ?? memberTaskText(squad, member);
			const extra = queued.map((m) => messageText(m)).filter((t) => t !== "");
			if (extra.length > 0) task = `${task}\n\n── 队里给你的消息 ──\n${extra.join("\n")}`;
			let result;
			for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
				member.attempts = (member.attempts ?? 0) + 1;
				result = await attemptOnce({ seed, task });
				member.usage = addUsage(member.usage ?? {}, result.usage);
				member.updatedAt = Date.now();
				member.history = result.messages;
				persistSquad(squad);
				// 只对基础设施失败重试；被中止 / maxSteps 耗尽 / 收工都不重试
				if (result.status === "完成" || result.kind !== "infra") break;
				if (attempt > config.retries) break;
				member.note = `第 ${attempt} 次因「${result.reason}」中断，正在重试…`;
				seed = result.messages;
				task = `上一次因为「${result.reason}」中断了。请接着做，不要重头再来。`;
			}
			return result;
		})();
		member.promise = loop
			.then((result) => {
				member.status = result.status;
				member.note = `${result.reason}（${result.steps} 步，${usageLine(result.usage)}）`;
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
				const head = result.status === "完成" ? `${member.label} 收工：${result.reason}` : `${member.label} 卡住：${result.reason}`;
				appendBoard(squad, { from: member.label, text: (last ? `${head}\n${last.text}` : head).slice(0, MAX_BOARD_TEXT) }, boardLimit);
				persistSquad(squad);
			})
			.catch((err) => {
				// 走到这里说明是基础设施层面的失败（llm 服务、loader、执行器崩了）——
				// 正常情况下循环自己已经把失败变成「卡住」了。
				member.status = "卡住";
				member.note = `基础设施失败：${err?.message ?? String(err)}`;
				member.updatedAt = Date.now();
				persistSquad(squad);
				log(`成员「${member.label}」跑挂了：${err?.stack ?? err}`);
			})
			.finally(() => {
				member.running = undefined;
				member.endedAt = Date.now();
			});
		return { ok: true };
	}

	disposers.push(
		ctx.tools.register({
			name: "squad_new",
			description:
				"建一个小队：一个目标 + 一份成员名册 + 一块共享黑板。可以同时建多个小队，各自独立。" +
				"典型流程：写代码的成员先用 `worktree_new` 各建一棵 worktree → `squad_new` 建队 → `squad_spawn` 派成员（**当场跑起来**，多个并行）→" +
				"成员自己往黑板写进展 → `squad_update` 改状态/结论 → `squad_close` 收队（会掐掉还在跑的成员）。" +
				"成员**不是** dsh 的子 agent：小队自己驱动它的循环，所以它不出现在会话列表里，也调不到 dsh 的工具。" +
				"状态会落盘到 `<DSH_HOME>/team-workflow/squads/<工作目录>.json`：dsh 重启后，在**同一个工作目录**里开的新会话会把它们捡回来（接管，`owner` 记成新会话）。",
			parameters: toParameterSchema({
				name: { type: "string", required: true, description: "小队名（短，40 字符内），如 `登录改造`。" },
				objective: { type: "string", required: true, description: "这个队要达成什么。写清验收标准，别写「做好一点」。" },
				note: { type: "string", description: "补充说明（可选）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const actor = actorOf(exec);
				const r = newSquad(state, actor.id, { name: args?.name, objective: args?.objective, note: args?.note, cwd: actor.cwd });
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				persistSquad(r.squad);
				return {
					text: `已建小队「${r.squad.name}」。目标：${r.squad.objective}\n接下来：\`squad_spawn\` 派成员（要写代码的成员先 \`worktree_new\` 给它建一棵 worktree）。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_spawn",
			description:
				"派一个成员进小队 —— **当场跑起来**（不 await：它在后台跑，多派几个就是并行）。" +
				"成员不是子 agent：小队自己发模型请求、自己执行工具（read / write / edit / grep / glob / bash / board），所以它不出现在会话列表里，也不占你的上下文。" +
				"`worktree` 必填：成员的一切文件操作都被钉在那棵 worktree 里，越界直接拒绝。" +
				"要写代码的成员先 `worktree_new` 建一棵，把**绝对路径**给它（子代理那套「相对路径会改到主仓库」的坑，在这里被工具层挡住了）。" +
				"同一个成员名再派一次 = 重跑（复用那一行、用新的角色/任务/worktree）；它正在跑时会被拒。只有所有者能派。" +
				"它跑完之后要接着让它干，用 `squad_send`（带历史续跑）；跑着的时候要插话，用 `squad_say`。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "成员名（短，队内唯一），如 `调研-A`。" },
				role: { type: "string", required: true, description: "角色，如 侦察 / 调研 / 实现 / 审查。" },
				task: { type: "string", required: true, description: "这个成员负责什么。写清交付物与边界 —— 它看不到你我这段对话。" },
				worktree: { type: "string", required: true, description: "成员的根目录（绝对路径）。写代码的给 `worktree_new` 那棵；只读调研也得给一个目录当根。" },
				model: { type: "string", description: `档位/模型，默认 \`${config.model}\`（团队网关别名：tier-std / tier-power / tier-max）。` },
				provider: { type: "string", description: `provider，默认 \`${config.provider}\`。` },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const model = String(args?.model ?? config.model ?? "").trim();
				const provider = String(args?.provider ?? config.provider ?? "").trim();
				if (model === "" || provider === "") {
					return { text: "[失败] 没给模型/provider（在参数里传，或改 `team/extensions/squad.json`）" };
				}
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const existing = auth.squad.members.get(label);
				if (existing?.running) {
					return { text: `[失败] 成员「${existing.label}」还在跑。等它收工，或者 \`squad_close\` 收队（那会掐掉它）。` };
				}
				// worktree 必须真的在盘上：它是成员的世界边界，指错了成员一步都走不了。
				// 存**canonical 路径**（realpath）：软链形式的根会让「成员的世界」变成它指向的
				// 地方（而且路径校验里 root 与目标会解析成同一个，等于没有边界）。
				const asked = String(args?.worktree ?? "").trim();
				let worktree = asked;
				let bad;
				try {
					if (!statSync(asked).isDirectory()) bad = "不是目录";
					else worktree = realpathSync(asked);
				} catch {
					bad = "不存在（要写代码就先 `worktree_new` 建一棵）";
				}
				if (bad) return { text: `[失败] worktree ${bad}：${asked}` };
				// 重跑 = 复用同一行（黑板上的作者名不变），换掉角色/任务/worktree。
				const r = existing
					? updateMember(auth.squad, label, { role: args?.role, task: args?.task, worktree })
					: addMember(state, auth.squad, { label, role: args?.role, task: args?.task, worktree });
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				const started = startMember(auth.squad, r.member, { provider, model });
				if (!started.ok) {
					r.member.status = "卡住";
					r.member.note = started.detail;
					persistSquad(auth.squad);
					return { text: `[失败] ${started.detail}` };
				}
				persistSquad(auth.squad);
				return {
					text: `已派「${r.member.label}」（${r.member.role}）进「${auth.squad.name}」，用 ${provider}/${model}，后台跑着。\n它的根目录：${r.member.worktree}\n看进展：\`squad_status\`、黑板，或面板里点开它的转录。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_update",
			description:
				"改成员那一行：状态（在跑 / 完成 / 卡住）、一句结论、角色、任务、worktree。" +
				"状态与结论平时由成员的循环自己维护（跑完写「完成」、卡住写原因），这个是留给你手动覆盖的口子。" +
				"改不了成员名 —— 那是黑板上的作者名，要换人就重派一个。只有所有者能用。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "成员名。" },
				status: { type: "string", description: `新状态：${MEMBER_STATUS.join(" / ")}。` },
				note: { type: "string", description: "一句结论 / 卡在哪。会显示在 `squad_status` 里。" },
				role: { type: "string", description: "改角色（它正在跑就只影响下一次）。" },
				task: { type: "string", description: "改任务（它正在跑就只影响下一次）。" },
				worktree: { type: "string", description: "改根目录（**正在跑的成员改不了** —— 记录会和它实际用的目录对不上）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const wanted = String(args?.worktree ?? "").trim();
				const current = auth.squad.members.get(label);
				if (current?.running && wanted !== "" && wanted !== current.worktree) {
					return { text: "[失败] 它正在跑，改 worktree 会让记录和它实际在用的目录对不上 —— 先等它收工。" };
				}
				const r = updateMember(auth.squad, label, {
					status: args?.status,
					note: args?.note,
					role: args?.role,
					task: args?.task,
					worktree: args?.worktree,
				});
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				persistSquad(auth.squad);
				return { text: `「${auth.squad.name}」的「${r.member.label}」现在是：${r.member.status}${r.member.note ? ` —— ${r.member.note}` : ""}。` };
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_board",
			description:
				"往小队的共享黑板追加一条（你以「主 agent」的身份写）。" +
				"成员那边有它自己的 `board` 工具，写的也是这块黑板 —— 所以进展、发现、结论都往这里汇，" +
				"不用谁当传声筒。成员的收工结论会自动记进黑板，你通常只需要读。" +
				"写事实与结论，别写「继续努力」这种没有信息量的话。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				text: { type: "string", required: true, description: "要记的内容（最多 2000 字符）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const r = appendBoard(auth.squad, { from: "主 agent", text: args?.text }, boardLimit);
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				persistSquad(auth.squad);
				const drop = r.dropped > 0 ? `\n（黑板超过 ${boardLimit} 条，丢了最旧的 ${r.dropped} 条）` : "";
				return { text: `已记到「${auth.squad.name}」的黑板（主 agent）。${drop}` };
			},
		}),
	);


	disposers.push(
		ctx.tools.register({
			name: "squad_send",
			description:
				"给一个**已经跑完**的成员追加消息，让它接着干（不是重跑）。" +
				"它会带着上次的消息历史继续 —— 比重新派一个成员便宜得多（不用重新读一遍文件）。" +
				"它正在跑时会被拒（在跑就用 `squad_say`，那会把消息投进它下一步）。" +
				"dsh 重启过的话历史没了，这时退化成「原任务 + 上次结论」再接着做。只有所有者能用。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "成员名。" },
				text: { type: "string", required: true, description: "要它接着做的事（越具体越好）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const member = auth.squad.members.get(label);
				if (!member) {
					const names = [...auth.squad.members.keys()];
					return { text: `[失败] 「${auth.squad.name}」里没有成员「${label}」（有：${names.join(" / ") || "一个都没有"}）` };
				}
				if (auth.squad.closed) {
					return { text: `[失败] ${closedDetail(auth.squad)}` };
				}
				if (member.running) {
					return { text: `[失败] 「${member.label}」正在跑。要给它加话就用 \`squad_say\`（会投进它下一步），或者等它收工。` };
				}
				const t = multiLine(args?.text, MAX_TEXT);
				if (!t.ok) return { text: `[失败] 消息${t.detail}` };
				const hadHistory = Array.isArray(member.history) && member.history.length > 0;
				// 有历史就接着跑；没有（重启过）就用「原任务 + 上次结论」兜底。
				// 兜底的结论取**转录里最后一条 assistant 正文**（转录是落盘的），
				// 而不是 `member.note` —— note 只有步数与用量，接不上活。
				let lastSaid;
				for (let i = member.transcript.length - 1; i >= 0; i -= 1) {
					const e = member.transcript[i];
					if (e.role === "assistant" && typeof e.text === "string" && e.text.trim() !== "") {
						lastSaid = e.text;
						break;
					}
				}
				const seed = hadHistory
					? member.history
					: [
							{ role: "user", content: [{ type: "text", text: member.task }] },
							...((lastSaid ?? member.note)
								? [{ role: "assistant", content: [{ type: "text", text: `上次的结果：${lastSaid ?? member.note}` }] }]
								: []),
						];
				const started = startMember(auth.squad, member, {
					provider: config.provider,
					model: config.model,
					resume: { messages: seed, task: t.value },
				});
				if (!started.ok) return { text: `[失败] ${started.detail}` };
				persistSquad(auth.squad);
				return {
					text: `已让「${member.label}」接着干（${hadHistory ? "带着上次的历史" : "重启过、没有历史，用原任务+上次结论兜底"}），后台跑着。看进展：\`squad_status\` 或面板里的转录。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_say",
			description:
				"给某个成员投一句话（你以「主 agent」的身份）。" +
				"它正在跑 → 这句话会在它**下一步**作为一条消息进去（不用打断它）；" +
				"它已经收工 → 排队，等它下次被 `squad_send` 续聊或重派时先投。" +
				"两种都会记进它的转录和黑板。成员之间也能互相投（它们有 `say` 工具）。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				to: { type: "string", required: true, description: "投给哪个成员。" },
				text: { type: "string", required: true, description: "要说的内容（最多 1000 字符）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const r = deliverSay(auth.squad, { from: "主 agent", to: args?.to, text: args?.text });
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				return {
					text: r.queued
						? `「${r.target.label}」已经收工，这句话排在它的待投队列里（下次续聊/重派时先投给它）。`
						: `已投给正在跑的「${r.target.label}」——它下一步就会看到。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_status",
			description:
				"看小队：目标、每个成员的角色/任务/状态/根目录/转录条数、黑板最近若干条。" +
				"不填 `squad` 就看自己名下所有小队。要读某个成员具体干了什么，去面板点开它的转录" +
				"（工具这边只能看到条数 —— 转录可能很长，不往你的上下文里灌）。" +
				"状态在进程内存里（同时落盘，见 `squad_new`），别的进程读不到 —— 看状态只能用这个工具或 GUI 面板。" +
				"成员行会显示耗时、token 用量、跑过几次。",
			parameters: toParameterSchema({
				squad: { type: "string", description: "小队名（不填 = 全部）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const caller = actorOf(exec).id;
				if (typeof caller !== "string" || caller === "") {
					return { text: "[失败] 拿不到调用方的会话 id（dsh 的 exec.agent.id 没读到）" };
				}
				const wanted = typeof args?.squad === "string" ? args.squad.trim() : "";
				if (wanted !== "") {
					const auth = authorize(state, caller, wanted);
					if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				}
				return { text: renderSnapshot(snapshot(state, caller, wanted)) };
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_close",
			description:
				"关掉一个小队（宣布这事完了）。成员与黑板留在内存里还能看，直到会话销毁。只有所有者能关。" +
				"**还在跑的成员会被当场掐掉**（不会继续烧模型）。关之前确认：目标真达成了、该合的分支都合了。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				reason: { type: "string", description: "为什么关（一句话）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const running = [...auth.squad.members.values()].filter((m) => m.running).length;
				// 先掐循环、再落 `closed`：收队之后所有写操作都会被拒（包括成员写黑板）。
				abortMembers(auth.squad, "被收队中止");
				const r = closeSquad(auth.squad, args?.reason);
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				const open = [...auth.squad.members.values()].filter((m) => m.status !== "完成").length;
				const cut = running > 0 ? `\n（掐掉了 ${running} 个还在跑的成员）` : "";
				const warn = open > 0 ? `\n（注意：还有 ${open} 个成员不是「完成」状态）` : "";
				return { text: `已关掉小队「${auth.squad.name}」。${cut}${warn}` };
			},
		}),
	);

	// 面板路由：`webServer` 只在 web profile 有（dsh-web-app），headless 下静默跳过 ——
	// 没有面板，工具照常。**不进顶层 inject**：当前 profile 缺一个服务会让整个插件
	// 静默不激活（连团队基线一起没），所以在这里模块内条件激活。
	let routes = 0;
	ctx.inject?.(["webServer"], (webScope) => {
		const dispose = registerSquadRoutes(webScope, { state, config, log });
		if (typeof dispose === "function") disposers.push(dispose);
		routes = 1;
		log(`HTTP 路由已挂载：${SQUAD_ROUTE_PREFIX}`);
	});

	return {
		enabled: true,
		describe: () =>
			`小队：开  （8 个工具：new / spawn / update / board / status / close / send / say；成员 ${config.provider}/${config.model}，最多 ${config.maxSteps} 步，重试 ${config.retries} 次，单次上限 ${config.memberTimeoutMinutes} 分钟${store ? "，落盘" : "，不落盘"}；面板${routes > 0 ? "已挂" : "未挂"}）`,
		state,
		dispose: () => {
			// 先掐掉还在跑的成员，再拆工具、清状态 —— 否则循环会继续往一个正在被拆掉的
			// 上下文里写（插件拆除 ≠ 会话结束，成员可能还在后台跑）。
			for (const squads of state.values()) {
				for (const squad of squads.values()) abortMembers(squad, "插件被拆了");
			}
			const flushing = store?.dispose();   // flush 之后再清状态：否则最后一段黑板/转录写不进盘
			state.clear();
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 已经没了 */
				}
			}
			return flushing;
		},
	};
}
