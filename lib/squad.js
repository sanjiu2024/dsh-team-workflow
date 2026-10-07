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
 * ── 四条设计决定（都有出处，详见 REQ-009 §5/§6） ──────────────────────────
 *  1. **状态只在当前会话**（主 agent 选的）：`Map<ownerSessionId, Map<名, Squad>>`，
 *     靠 `ctx.on("session/disposed", …)` 在会话销毁时清掉。
 *     `ctx.effect` 的 dispose 是**插件拆除**、不是会话结束（`lib/audit.js:91` 是
 *     按 session id 存 Map 的先例），所以只能这么落。
 *  2. **成员的身份是认证、不是自报**：dsh 里父方拿到的 `subagentId` **就是**子会话的
 *     session id（`subagentId = childId = sessionId`，REQ-009 §5 第 12 条），
 *     所以「这一行是哪个成员写的」可以按 `exec.agent.id` 精确对上。
 *  3. **成员也能调这些工具**：子会话确实拿得到本包注册的工具（实测，REQ-009 §5 第 11 条），
 *     所以黑板是**真的共享**——成员自己写，不用主 agent 当传声筒。
 *  4. **权限按「所有者 / 成员」分**：成员只能看自己所在小队、写黑板、改自己那一行；
 *     建队、加人、关队只有所有者能做。多小队之间互相隔离也靠这条。
 *
 * ── 不做什么 ────────────────────────────────────────────────────────────
 *  · **不落盘**：进程内、会话级，会话结束就没了（所以没有 `$DSH_HOME/...json`）。
 *  · **不设成员上限**（主 agent 选的）：`squad_status` 会显示人数，那是信息不是闸门。
 *  · **不创建子会话、不选档位**：成员的创建仍由主 agent 调 `subagent_std/power/max`，
 *    本模块只登记结果。也不自动合并代码（worktree 那条规矩不变）。
 *  · **不做成本闸门**：不数 token、不掐轮数。
 * 唯一的内存护栏是 `boardLimit` 与单条文本长度上限 —— 否则一个成员循环写黑板就是
 * 无界增长（这不是「限流」，是别把 dsh 进程撑爆）。
 *
 * ── 与客户端面板的关系 ──────────────────────────────────────────────────
 * `snapshot()` / `snapshotAll()` 把状态转成**无损 JSON**（只有 string/number/
 * boolean/null/数组/对象，绝不放 `undefined`），`renderSnapshot()` 把同一份快照渲染成
 * 人看的文本 —— 一条数据路径、两个渲染器，工具输出与面板不会各说各话。
 * 面板走 HTTP（`/api/team/squad`，见 `registerSquadRoutes`），**只读**。
 */
import { toParameterSchema } from "./util.js";
import { isTrustedRequest, sendJson } from "./api-http.js";

export const SQUAD_DEFAULTS = {
	enabled: true,
	/** 黑板最多留多少条（超了丢最旧的）。内存护栏，不是限流。 */
	boardLimit: 500,
};

export const SQUAD_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	boardLimit: (v) => (Number.isInteger(v) && v > 0 ? v : undefined),
};

/** 成员状态。四个就够：还没派 / 在跑 / 完成 / 卡住。 */
export const MEMBER_STATUS = ["待派", "在跑", "完成", "卡住"];

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
 * 成员视角：按 `agentId` 反查「我属于哪个小队」。
 * 因为 agent id == 子会话 session id，这是认证而不是自报名字（见文件头第 2 条）。
 * 同一个 agent 被塞进两个小队时返回第一个命中的 —— `addMember` 已经拦了这种绑定。
 */
export function squadOfMember(state, agentId) {
	if (typeof agentId !== "string" || agentId === "") return undefined;
	for (const [ownerId, squads] of state) {
		for (const squad of squads.values()) {
			for (const member of squad.members.values()) {
				if (member.agentId === agentId) return { ownerId, squad };
			}
		}
	}
	return undefined;
}

/**
 * 授权：这次工具调用是谁、能动哪个小队。
 *
 * 返回 `{ok:true, ownerId, squad, asOwner, member?}` 或 `{ok:false, detail}`。
 * 规则：所有者能用全部动作；成员只能用自己那一支的「看/写黑板/改自己」。
 */
export function authorize(state, callerId, name) {
	if (typeof callerId !== "string" || callerId === "") {
		return { ok: false, detail: "拿不到调用方的会话 id（dsh 的 exec.agent.id 没读到）—— 这不该发生，请报告" };
	}
	const wanted = typeof name === "string" ? name.trim() : "";
	// 「不点名」只对 `squad_status`（看全部）有意义，而它压根不走这个函数。
	// 所以这里直接拒 —— 曾经这里给所有者返回了一个 `{ok:true}` 但**没有 `squad`**
	// 的成功，调用方（加人/改行/写黑板/关队）一解引用就是 TypeError：
	// 传 `squad: "   "` 就能触发（schema 的 `required` 挡不住空串）。
	if (wanted === "") {
		return { ok: false, detail: "要指定小队名（只有 `squad_status` 允许不填）" };
	}
	// 所有者：先看自己的表。
	const squad = findSquad(state, callerId, wanted);
	if (squad) return { ok: true, ownerId: callerId, squad, asOwner: true };
	// 成员：按 id 反查。
	const hit = squadOfMember(state, callerId);
	if (hit) {
		if (hit.squad.name !== wanted) {
			return { ok: false, detail: `你不是小队「${wanted}」的成员（你属于「${hit.squad.name}」）` };
		}
		const member = [...hit.squad.members.values()].find((m) => m.agentId === callerId);
		return { ok: true, ownerId: hit.ownerId, squad: hit.squad, asOwner: false, member };
	}
	return { ok: false, detail: `没有小队「${wanted}」（小队只对创建它的会话和队内成员开放）` };
}

/** 建队。所有者视角。 */
export function newSquad(state, ownerId, { name, objective, note }) {
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
 * 加成员（所有者视角）。`agentId` 给了就绑定，不给就是「待派」。
 * 跨小队禁止重复绑定同一个 agent —— 否则成员反查自己属于哪个小队会有歧义。
 */
export function addMember(state, squad, { label, role, task, agentId, worktree }) {
	if (squad.closed) return { ok: false, detail: closedDetail(squad) };
	const l = oneLine(label, MAX_NAME);
	if (!l.ok) return { ok: false, detail: `成员名${l.detail}` };
	const r = oneLine(role, MAX_NAME);
	if (!r.ok) return { ok: false, detail: `角色${r.detail}` };
	const t = multiLine(task, MAX_TEXT);
	if (!t.ok) return { ok: false, detail: `任务${t.detail}` };
	if (squad.members.has(l.value)) {
		return { ok: false, detail: `「${squad.name}」里已经有成员「${l.value}」了（要改就用 squad_update）` };
	}
	let id;
	if (agentId !== undefined && agentId !== null && String(agentId).trim() !== "") {
		const a = oneLine(agentId, 80);
		if (!a.ok) return { ok: false, detail: `agent_id${a.detail}` };
		id = a.value;
		const clash = squadOfMember(state, id);
		if (clash) {
			const who = [...clash.squad.members.values()].find((m) => m.agentId === id);
			return { ok: false, detail: `这个 agent_id 已经绑在小队「${clash.squad.name}」的成员「${who.label}」上了` };
		}
	}
	let wt;
	if (worktree !== undefined && worktree !== null && String(worktree).trim() !== "") {
		const w = oneLine(worktree, MAX_TEXT);
		if (!w.ok) return { ok: false, detail: `worktree${w.detail}` };
		wt = w.value;
	}
	squad.members.set(l.value, {
		label: l.value,
		role: r.value,
		task: t.value,
		agentId: id,
		worktree: wt,
		status: id ? "在跑" : "待派",
		note: undefined,
		updatedAt: Date.now(),
	});
	return { ok: true, member: squad.members.get(l.value) };
}

/**
 * 改成员（成员只能改自己那一行，权限在外面判）。
 *
 * 也要 `state`：`agentId` 是可以改的，而**改**同样要拦重复绑定 —— 不拦的话成员能把
 * 自己那行的 id 改成别人（甚至别队的）id，`squadOfMember` 的首命中就变成歧义：
 * 被冒名的人可能被解析到这一行，跨队隔离也跟着破。加人拦了、改人不拦 = 白拦。
 */
export function updateMember(state, squad, label, patch) {
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
	if (patch.agentId !== undefined && patch.agentId !== null && String(patch.agentId).trim() !== "") {
		const a = oneLine(patch.agentId, 80);
		if (!a.ok) return { ok: false, detail: `agent_id${a.detail}` };
		// 改成本行已有的同一个 id = 幂等，放行；绑到别的 agent 身上才拦。
		if (a.value !== member.agentId) {
			const clash = squadOfMember(state, a.value);
			if (clash) {
				const who = [...clash.squad.members.values()].find((m) => m.agentId === a.value);
				return { ok: false, detail: `这个 agent_id 已经绑在小队「${clash.squad.name}」的成员「${who.label}」上了` };
			}
		}
		member.agentId = a.value;
		if (member.status === "待派") member.status = "在跑";
	}
	if (patch.worktree !== undefined && patch.worktree !== null && String(patch.worktree).trim() !== "") {
		const w = oneLine(patch.worktree, MAX_TEXT);
		if (!w.ok) return { ok: false, detail: `worktree${w.detail}` };
		member.worktree = w.value;
	}
	member.updatedAt = Date.now();
	return { ok: true, member };
}

/**
 * 往黑板追加一条。`from` 由调用方**自动判定**后传进来（所有者→「主 agent」，
 * 成员→它的成员名），工具层不暴露这个参数 —— 少一个能撒谎的入口。
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
	return {
		name: squad.name,
		objective: squad.objective,
		note: squad.note ?? null,
		owner: ownerId,
		createdAt: squad.createdAt,
		closed: squad.closed ? { at: squad.closed.at, reason: squad.closed.reason ?? null } : null,
		members: [...squad.members.values()].map((m) => ({
			label: m.label,
			role: m.role,
			task: m.task,
			agentId: m.agentId ?? null,
			worktree: m.worktree ?? null,
			status: m.status,
			note: m.note ?? null,
			updatedAt: m.updatedAt,
		})),
		board: squad.board.map((e) => ({ at: e.at, from: e.from, text: e.text })),
	};
}

/**
 * 这次调用者能看到的小队（所有者看自己建的，成员看自己所在的那个）。
 *
 * `name` 给了就只渲染那一个 —— 点名的语义就是「只看它」。不这么做的话，所有者
 * 点 `squad_status({squad:"A"})` 会拿到名下**全部**小队，工具描述与行为对不上。
 * 鉴权在外面做（`authorize`），这里只管渲染。
 */
export function snapshot(state, callerId, name) {
	const only = typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
	const mine = ownedSquads(state, callerId);
	if (mine.size > 0) {
		const picked = only === undefined ? [...mine.entries()] : [...mine.entries()].filter(([, s]) => s.name === only);
		return { squads: picked.map(([ownerId, squad]) => squadView(ownerId, squad)), asOwner: true, me: callerId };
	}
	const hit = squadOfMember(state, callerId);
	if (hit) return { squads: [squadView(hit.ownerId, hit.squad)], asOwner: false, me: callerId };
	return { squads: [], asOwner: true, me: callerId };
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

const clock = (ms) => {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 成员一行。`agentId` 打全 —— 主 agent 要拿它去 `send_message`。 */
function renderMember(m) {
	const bits = [`- ${m.label}`, `[${m.role}]`, m.status];
	if (m.agentId) bits.push(`id=${m.agentId}`);
	else bits.push("（还没派）");
	if (m.worktree) bits.push(`worktree=${m.worktree}`);
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
		return snap.asOwner
			? "没有小队。要建一个：`squad_new`（给个名字和目标）。"
			: "你既没有建过小队，也不是任何小队的成员。";
	}
	const out = [];
	for (const s of snap.squads) {
		const counts = {};
		for (const m of s.members) counts[m.status] = (counts[m.status] ?? 0) + 1;
		const summary = MEMBER_STATUS.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(" / ");
		out.push(`小队「${s.name}」${s.closed ? `（已关：${s.closed.reason ?? "没写理由"}）` : ""}`);
		out.push(`  目标：${s.objective.replace(/\n/g, "\n  ")}`);
		if (s.note) out.push(`  说明：${s.note}`);
		out.push(`  成员 ${s.members.length}${summary ? `（${summary}）` : ""}`);
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

/* ═══════════════════════════ HTTP 路由（面板用，只读） ═══════════════════════════ */

export const SQUAD_ROUTE_PREFIX = "/api/team/squad";

/**
 * 注册 `/api/team/squad` 下的路由。返回 disposer。
 *
 * **只有 GET，两个端点**：
 *   · `/options` → 探活。客户端拿 404 就不注册面板（这就是「可选安装」在 UI 上的落点）
 *   · `/squads`  → 全量快照（`snapshotAll`）
 *
 * 为什么一个写接口都不开：改状态的入口是那 6 个工具，都在进程内、都要过
 * `authorize()`（谁是所有者、谁是成员）。HTTP 这边多开一个 POST，就等于多一套
 * 「谁能改」的判断要维护，而面板根本不需要 —— 它只负责看和点进会话。
 */
export function registerSquadRoutes(scope, { state, config, log = () => {} }) {
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
				return sendJson(res, 200, { ok: true, boardLimit: config.boardLimit });
			}
			if (sub === "/squads" && method === "GET") {
				return sendJson(res, 200, { ok: true, ...snapshotAll(state) });
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

	const disposers = [];
	// 会话销毁就清掉它的小队 —— 这是「状态只在当前会话」的落地点。
	// 拿不到 session.id 时不清（宁可不 clean，也不能误清别人的）。
	const offDisposed = ctx.on?.("session/disposed", (session) => {
		const id = session?.id;
		if (typeof id === "string" && id !== "") state.delete(id);
	});
	if (typeof offDisposed === "function") disposers.push(offDisposed);

	// 输出形状（6 个工具都是「一段文本」），写成工厂避免重复 6 遍。
	const text = () => ({
		schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
		render: (_args, value) => [{ type: "text", text: value.text }],
	});

	disposers.push(
		ctx.tools.register({
			name: "squad_new",
			description:
				"建一个小队：一个目标 + 一份成员名册 + 一块共享黑板。可以同时建多个小队，各自独立。" +
				"典型流程：`squad_new` 建队 → 用 `subagent_std/power/max` 派成员 → `squad_add` 把返回的 id 绑到成员上 →" +
				"成员自己往黑板写进展（他们也能调这些工具）→ `squad_update` 标记完成/卡住 → `squad_close` 收队。" +
				"写代码的成员各用一棵 worktree（`worktree_new`），把绝对路径写进它的 task 并记进 `squad_add` 的 worktree。" +
				"状态只在当前会话（不落盘），会话结束就没了。",
			parameters: toParameterSchema({
				name: { type: "string", required: true, description: "小队名（短，40 字符内），如 `登录改造`。" },
				objective: { type: "string", required: true, description: "这个队要达成什么。写清验收标准，别写「做好一点」。" },
				note: { type: "string", description: "补充说明（可选）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const r = newSquad(state, callerIdOf(exec), { name: args?.name, objective: args?.objective, note: args?.note });
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				return {
					text: `已建小队「${r.squad.name}」。目标：${r.squad.objective}\n接下来：派成员（\`subagent_std/power/max\`），拿到 id 后用 \`squad_add\` 绑上。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_add",
			description:
				"往小队里加一个成员。成员是子 agent —— 先调 `subagent_std/power/max` 拿到它的 id，再把它交给 `agent_id` 绑上；" +
				"还没派就先不加 `agent_id`（状态是「待派」，派完用 `squad_update` 补）。" +
				"同一个 agent 不能绑进两个小队。只有建队那个会话（所有者）能加人。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "成员名（短，队内唯一），如 `调研-A`。" },
				role: { type: "string", required: true, description: "角色，如 侦察 / 调研 / 实现 / 审查。" },
				task: { type: "string", required: true, description: "这个成员负责什么。写清交付物与边界。" },
				agent_id: { type: "string", description: "子代理的 id（`subagent_*` 返回的那个）。给了就绑定，成员就能写黑板、你也能按 id 找它。" },
				worktree: { type: "string", description: "若它写代码：那棵 worktree 的绝对路径（`worktree_new` 返回的）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const caller = callerIdOf(exec);
				const auth = authorize(state, caller, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				if (!auth.asOwner) return { text: "[失败] 只有建队的会话能加成员（成员只能写黑板、改自己那一行）。" };
				const r = addMember(state, auth.squad, {
					label: args?.member,
					role: args?.role,
					task: args?.task,
					agentId: args?.agent_id,
					worktree: args?.worktree,
				});
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				const m = r.member;
				return {
					text: `已把「${m.label}」（${m.role}）加进「${auth.squad.name}」：${m.status}${m.agentId ? `，id=${m.agentId}` : ""}。\n它自己也能写黑板（\`squad_board\`）和改自己那一行（\`squad_update\`）。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_update",
			description:
				"更新成员：改状态（待派 / 在跑 / 完成 / 卡住）、补 `agent_id`、记一句结论、补 worktree 路径。" +
				"成员可以自己调这个改**自己那一行**（这是他们汇报「我做完了 / 我卡住了」的正常途径）；改别人只有所有者能做。" +
				"`agent_id` 是身份字段，**只有所有者能绑** —— 成员改不了（它决定谁能读写这个小队）。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "成员名。成员自己调时填自己。" },
				status: { type: "string", description: `新状态：${MEMBER_STATUS.join(" / ")}。` },
				note: { type: "string", description: "一句结论 / 卡在哪。会显示在 `squad_status` 里。" },
				agent_id: { type: "string", description: "补上子代理 id（`subagent_*` 返回的那个）。只有所有者能填。" },
				worktree: { type: "string", description: "补上 worktree 绝对路径。" },
			}),
			output: text(),
			async execute(args, exec) {
				const caller = callerIdOf(exec);
				const auth = authorize(state, caller, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				if (!auth.asOwner && auth.member && label !== auth.member.label) {
					return { text: `[失败] 成员只能改自己那一行（你是「${auth.member.label}」）。` };
				}
				// `agent_id` 是**身份字段**，只有所有者能绑：它决定谁能读写这个小队。
				// 放开给成员 = 成员能把自己那行绑到任意 id 上（`addMember` 只查「有没有被
				// 别人占」，查不了「这个 id 是不是真的是你」），等于自己造一个身份。
				// 而成员本来就不需要它：进队时所有者已经把 id 绑好了（`squad_add`）。
				if (!auth.asOwner && args?.agent_id !== undefined && String(args.agent_id).trim() !== "") {
					return { text: "[失败] 只有所有者能绑 `agent_id` —— 成员改不了身份字段（状态和结论随便改）。" };
				}
				const r = updateMember(state, auth.squad, label, {
					status: args?.status,
					note: args?.note,
					agentId: args?.agent_id,
					worktree: args?.worktree,
				});
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				return { text: `「${auth.squad.name}」的「${r.member.label}」现在是：${r.member.status}。` };
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_board",
			description:
				"往小队的共享黑板追加一条。**成员自己就能调**（子会话有这些工具），所以进展直接写这儿，" +
				"不用都回到主 agent 那里转述 —— 这是这块黑板存在的意义。" +
				"作者是自动判定的（所有者显示「主 agent」，成员显示它的成员名），不用填、也不能冒名。" +
				"写事实与结论，别写「继续努力」这种没有信息量的话。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				text: { type: "string", required: true, description: "要记的内容（最多 2000 字符）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const caller = callerIdOf(exec);
				const auth = authorize(state, caller, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const from = auth.asOwner ? "主 agent" : auth.member?.label ?? "成员";
				const r = appendBoard(auth.squad, { from, text: args?.text }, boardLimit);
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				const drop = r.dropped > 0 ? `\n（黑板超过 ${boardLimit} 条，丢了最旧的 ${r.dropped} 条）` : "";
				return { text: `已记到「${auth.squad.name}」的黑板（${from}）。${drop}` };
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_status",
			description:
				"看小队：目标、每个成员的角色/任务/状态/会话 id/worktree、黑板最近若干条。" +
				"不填 `squad` 就看自己能看到的所有小队（所有者看自己建的，成员看自己所在的那个）。" +
				"注意：状态在 dsh 进程内存里，别的进程（命令行）读不到 —— 看状态只能用这个工具或 GUI 面板。",
			parameters: toParameterSchema({
				squad: { type: "string", description: "小队名（不填 = 全部）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const caller = callerIdOf(exec);
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
				"关之前确认：目标真达成了、该合的分支都合了。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				reason: { type: "string", description: "为什么关（一句话）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const caller = callerIdOf(exec);
				const auth = authorize(state, caller, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				if (!auth.asOwner) return { text: "[失败] 只有建队的会话能关队。" };
				const r = closeSquad(auth.squad, args?.reason);
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				const open = [...auth.squad.members.values()].filter((m) => m.status !== "完成").length;
				const warn = open > 0 ? `\n（注意：还有 ${open} 个成员不是「完成」状态）` : "";
				return { text: `已关掉小队「${auth.squad.name}」。${warn}` };
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
		describe: () => `小队：开  （6 个工具：new / add / update / board / status / close；面板${routes > 0 ? "已挂" : "未挂"}）`,
		state,
		dispose: () => {
			state.clear();
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 已经没了 */
				}
			}
		},
	};
}
