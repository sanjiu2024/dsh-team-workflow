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
import path from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dshHome } from "./util.js";
import { compactSquad, createSquadStore, reviveSquad, workspaceKey } from "./squad-store.js";
import { toParameterSchema } from "./util.js";
import { isTrustedRequest, sendJson } from "./api-http.js";
// 这五个（`addUsage` / `messageText` / `memberToolsFor` / `runMemberTool` / `parseReport`）
// 曾经从这两个模块 import 进来，但用它们的是 `lib/squad-round.js`（它自己 import）——
// 在 `squad.js` 里一直是死引用。REQ-025 改这一行时顺手去掉。
import { LOOP_DEFAULTS, userMessage } from "./squad-loop.js";
import { MEMBER_TOOLS } from "./squad-tools.js";
import { REPORT_LABELS, formatReport } from "./squad-report.js";
import { billForDay, localDate } from "./bill.js";
import { startMember as startRound } from "./squad-round.js";
import { createMemberRunner } from "./squad-agent.js";

export const SQUAD_DEFAULTS = {
	enabled: true,
	/** 黑板最多留多少条（超了丢最旧的）。内存护栏，不是限流。 */
	boardLimit: 500,
	/** 成员默认用哪个档位：团队网关的别名（`tier-std/power/max`），想换档在 `squad_spawn` 里传 `model`。 */
	provider: "new-api",
	model: "tier-std",
	/**
	 * 角色 → 档位（REQ-016 · D3）：`squad_spawn` 没传 `model` 时按角色查这张表，查不到用上面的 `model`。
	 *
	 * 默认**空表**（不内置任何角色）—— 分工是每个团队自己的事，写在 `team/extensions/squad.json` 里。
	 * 角色是自由文本，所以查表前会把尾部的「型」去掉：「审查」与「审查型」落到同一条。
	 */
	roles: {},
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
	/** 单个成员一次尝试的墙钟上限（分钟）。超了就 abort，状态判「超时」。 */
	memberTimeoutMinutes: 45,
	/** 小队状态落不落盘（`<DSH_HOME>/team-workflow/squads/<cwd>.json`）。 */
	persist: true,
	/**
	 * 小队**总共**允许多少 token（0 = 不限）。REQ-016 A2：在**步边界**判，超了那个成员当场收工，
	 * 状态判「卡住」并写明原因（不是「完成」—— 活没干完）。
	 */
	tokenBudget: 0,
	/** 单个成员允许多少 token（0 = 不限）。与上面取更紧的那个。 */
	memberTokenBudget: 0,
	/** 同时最多几个成员在跑（0 = 不限）。超了的**排队**，有人收工自动补位（REQ-016 A3）。 */
	maxRunning: 0,
	/**
	 * 角色 → 允许用的工具名（REQ-016 A4）。空表 = 不限制。
	 *
	 * 与 `bash` 那道全局闸门是**与**的关系：白名单里写了 `bash`、但 `bash` 全局关着，它也拿不到。
	 * 默认空表（不悄悄限制别人的成员）；「侦察不给 write/bash」这种分工写在 `team/extensions/squad.json` 里。
	 */
	roleTools: {},
	/**
	 * 小队模板（REQ-016 A9）：名字 → 成员骨架。**分工写在配置里，不硬编码** ——
	 * 改分工不该需要发版。`squad_new({template})` 一键按它建名册并起跑。
	 * 每条要有 member / role / task / worktree（worktree 可以是相对小队 cwd 的路径）。
	 */
	templates: {},
};

export const SQUAD_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	boardLimit: (v) => (Number.isInteger(v) && v > 0 ? v : undefined),
	provider: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	model: (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
	// 角色 → 档位。**有坏条目就整体拒**（返回 undefined）—— 这样 `readJsonConfig` 会走
	// 「值写在文件里但没被采纳」那条提示把话说明白；静默把坏条目清掉，配的人只会觉得
	// 「我明明配了」，然后去别处找原因（2026-10-16 std 测逮到：`{审查:42}` 清洗成 `{}` 且零提示）。
	roles: (v) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		const entries = Object.entries(v);
		// 值可以是字符串，也可以是**降级链**（数组，按顺序试）。数组里有坏条目就整体拒 ——
		// 悄悄丢掉半条链，配的人只会觉得「我明明配了」。
		const norm = (model) => {
			if (typeof model === "string") return model.trim();
			if (!Array.isArray(model)) return undefined;
			const chain = model.map((m) => (typeof m === "string" ? m.trim() : ""));
			if (chain.length === 0 || chain.some((m) => m === "")) return undefined;
			return chain;
		};
		const clean = entries
			.map(([role, model]) => [String(role).trim(), norm(model)])
			.filter(([role, model]) => role !== "" && model !== undefined);
		// 空表是**合法**值（roles = 都用默认档；roleTools = 不限制）；只有「有坏条目」才整体拒
		return clean.length === entries.length ? Object.fromEntries(clean) : undefined;
	},
	maxSteps: (v) => (Number.isInteger(v) && v > 0 && v <= 200 ? v : undefined),
	bash: (v) => (typeof v === "boolean" ? v : undefined),
	retries: (v) => (Number.isInteger(v) && v >= 0 && v <= 5 ? v : undefined),
	// 允许小数：1 分钟是最小整数粒度，而超时路径要能在自检里用几十毫秒跑到（REQ-015 §6.4）
	memberTimeoutMinutes: (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 24 * 60 ? v : undefined),
	persist: (v) => (typeof v === "boolean" ? v : undefined),
	tokenBudget: (v) => (Number.isInteger(v) && v >= 0 ? v : undefined),
	memberTokenBudget: (v) => (Number.isInteger(v) && v >= 0 ? v : undefined),
	maxRunning: (v) => (Number.isInteger(v) && v >= 0 && v <= 50 ? v : undefined),
	// 模板：名字 → 成员骨架。**有一条坏的整表拒**（同一口径）。
	templates: (v) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		const out = {};
		for (const [name, list] of Object.entries(v)) {
			const key = String(name).trim();
			if (key === "" || !Array.isArray(list) || list.length === 0) return undefined;
			const entries = [];
			for (const raw of list) {
				const e = raw && typeof raw === "object" ? raw : {};
				const entry = {
					member: String(e.member ?? "").trim(),
					role: String(e.role ?? "").trim(),
					task: String(e.task ?? "").trim(),
					worktree: String(e.worktree ?? "").trim(),
				};
				if (entry.member === "" || entry.role === "" || entry.task === "" || entry.worktree === "") return undefined;
				entries.push(entry);
			}
			out[key] = entries;
		}
		return out;
	},
	// 角色 → 工具名数组。**有坏条目就整体拒**（与 roles 同一口径：静默清洗会让配的人找不到原因）。
	roleTools: (v) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		const clean = [];
		for (const [role, list] of Object.entries(v)) {
			const key = String(role).trim();
			// 角色名空、不是数组、空数组、数组里有坏工具名 —— 一律**整体拒**
			// （与 roles 同一口径：静默把坏条目清掉，配的人只会觉得「我明明配了」）
			if (key === "" || !Array.isArray(list)) return undefined;
			const names = list.map((n) => (typeof n === "string" ? n.trim() : ""));
			// 空数组**合法**（这个角色一个工具都不给）—— 把它当「没配」就是 fail-open
			if (names.some((n) => n === "")) return undefined;
			clean.push([key, names]);
		}
		return Object.fromEntries(clean);
	},
};

/** 角色归一：去空白 + 去掉尾部的「型」。查表（档位、工具白名单）都走它。 */
/**
 * 这个成员**现在真的在跑**吗。
 *
 * 被 `squad_stop` 掐过的那种（`aborted`）不算：它的 controller 还挂着等流收尾，但成员已经停了。
 * 全仓只此一处判据 —— 各写各的 `m.running !== undefined` 会让「已停未收尾」的成员在
 * 状态/快照/面板里显示成「正在跑」、`squad_say` 说「已投给正在跑的它」、`squad_send` 直接拒
 * （独立测实测到五处口径不一致）。
 */
export function isRunning(member) {
	return member?.running !== undefined && member.running.aborted !== true;
}

export function roleKey(role) {
	return String(role ?? "").trim().replace(/型$/, "");
}

/**
 * 角色 → 档位（REQ-016 · D3）。
 *
 * 角色是**自由文本**（`squad_spawn` 里写着「如 侦察/调研/实现/审查」），所以查表前把尾部
 * 的「型」去掉再查 —— 否则「审查」与「审查型」会落到两条路上（一个命中、一个回落默认）。
 * 先按归一后的键查，再按原样查（有人可能真配了个带「型」的键）。
 *
 * @param {Record<string, string>|undefined} roles 档位表
 * @param {unknown} role 成员角色
 * @returns {string|undefined} 命中的档位；没有就 undefined（调用方回落默认档）
 */
/**
 * 角色 → 档位链（数组）。**这是唯一真相源**，`roleModel` 取它的第一个。
 *
 * 语义分工（独立测指出这里容易含糊）：配置层面 `[]` 会被校验器**整体拒**（见 `norm()`），
 * 所以这个函数拿到 `[]` 只可能来自直接调用 —— 纯函数语义就是「`[]` 进 `[]` 出」。
 */
export function roleModelChain(roles, role) {
	const table = roles && typeof roles === "object" && !Array.isArray(roles) ? roles : {};
	const raw = String(role ?? "").trim();
	if (raw === "") return [];
	const hit = table[roleKey(raw)] ?? table[raw];
	const list = Array.isArray(hit) ? hit : [hit];
	return list.map((m) => (typeof m === "string" ? m.trim() : "")).filter((m) => m !== "");
}

/**
 * 角色 → 档位。**取链上第一个**（`roleModelChain` 是唯一真相源）。
 *
 * 为什么允许配成数组：团队网关有没有某条渠道是**环境事实**，这个包查不到。配了本机不存在的档
 * （例如本机 `tier-power` 报 503），原来就是「重试一次后判卡住」—— 审查这一层永远跑不起来。
 * 配成 `["tier-power", "tier-std"]` 就是「优先用强的，用不了就退到有的那个」。
 */
export function roleModel(roles, role) {
	return roleModelChain(roles, role)[0];
}

/**
 * 成员状态。**五个**：在跑 / 排队（并发满了）/ 等待（在等队友）/ 完成 / 卡住。
 * 没有「待派」—— 派成员就是当场把它跑起来；「排队」「等待」都是 2.0 才有的进程内状态，
 * 重启后一律判「卡住」（见 `lib/squad-store.js`）。
 */
export const MEMBER_STATUS = ["在跑", "排队", "等待", "完成", "卡住"];

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

/** 验收清单最多几条（A10）。再多主 agent 自己也看不过来（12 条）。 */
const MAX_ACCEPTANCE = 12;

/**
 * 验收清单归一（A10）。收字符串数组，也收 `{text, done}` 对象数组（落盘读回来就是后者）。
 * 空条目 / 非数组一律拒 —— 验收标准写不清，整件事就不该开跑。
 */
export function normalizeAcceptance(list) {
	if (list === undefined || list === null) return { ok: true, value: [] };
	if (!Array.isArray(list)) return { ok: false, detail: "验收清单要是数组（每条一句话）" };
	if (list.length > MAX_ACCEPTANCE) return { ok: false, detail: `验收清单最多 ${MAX_ACCEPTANCE} 条` };
	const value = [];
	for (const raw of list) {
		const source = typeof raw === "string" ? { text: raw } : raw && typeof raw === "object" ? raw : {};
		const t = oneLine(source.text, MAX_TEXT);
		if (!t.ok) return { ok: false, detail: `验收第 ${value.length + 1} 条${t.detail}` };
		if (t.value === "") return { ok: false, detail: `验收第 ${value.length + 1} 条是空的` };
		value.push({
			text: t.value,
			done: source.done === true,
			by: typeof source.by === "string" && source.by !== "" ? source.by : undefined,
			at: typeof source.at === "number" ? source.at : undefined,
			note: typeof source.note === "string" && source.note !== "" ? source.note : undefined,
		});
	}
	return { ok: true, value };
}

/**
 * 勾一条验收（A10）。`item` 是序号（1 起）或那句话的一部分。
 * 已经勾过的不许被第二个人改 —— 谁验的记在谁头上，重复勾只回一句「已经勾了」。
 */
export function markAcceptance(squad, member, item, note) {
	const list = Array.isArray(squad.acceptance) ? squad.acceptance : [];
	if (list.length === 0) return { ok: false, detail: "这个小队没写验收清单（建队时用 `acceptance` 给几条）" };
	const raw = String(item ?? "").trim();
	let index = -1;
	if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		if (n >= 1 && n <= list.length) index = n - 1;
	} else {
		index = list.findIndex((e) => e.text === raw || e.text.startsWith(raw) || e.text.includes(raw));
	}
	if (index < 0) {
		return { ok: false, detail: `清单里没有这一条：${raw}（有：${list.map((e, i) => `${i + 1}. ${e.text}`).join("；")}）` };
	}
	const entry = list[index];
	if (entry.done) return { ok: false, detail: `第 ${index + 1} 条「${entry.text}」已经勾了（${entry.by ?? "?"}）` };
	entry.done = true;
	entry.by = member.label;
	entry.at = Date.now();
	if (typeof note === "string" && note !== "") entry.note = note.slice(0, 200);
	return { ok: true, index, entry, text: `已勾第 ${index + 1} 条：「${entry.text}」（${member.label}）` };
}

/** 验收清单渲染（A10）：`☑`/`☐` + 谁勾的。没写清单就返回空数组。 */
function renderAcceptance(list) {
	if (!Array.isArray(list) || list.length === 0) return [];
	const done = list.filter((e) => e.done).length;
	const lines = [`  验收 ${done}/${list.length}：`];
	list.forEach((e, i) => {
		lines.push(`    ${e.done ? "☑" : "☐"} ${i + 1}. ${e.text}${e.done ? `  —— ${e.by ?? "?"}${e.note ? `：${e.note}` : ""}` : ""}`);
	});
	return lines;
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
export function newSquad(state, ownerId, { name, objective, note, cwd, acceptance }) {
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
	const acc = normalizeAcceptance(acceptance);
	if (!acc.ok) return { ok: false, detail: acc.detail };
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
		// A10：验收清单（`[]` = 没写）。成员勾、主 agent 也勾（`squad_update`）。
		acceptance: acc.value,
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
export function addMember(state, squad, { label, role, task, worktree, model, provider, modelFromRole, queued }) {
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
		// REQ-016 D3：把这一行**实际用的档位**记在成员身上 —— 续聊与重启后要沿用它，
		// 否则「审查型配了 tier-power，续聊却掉回 tier-std」这种事没人查得出来。
		model: typeof model === "string" && model.trim() !== "" ? model.trim() : undefined,
		provider: typeof provider === "string" && provider.trim() !== "" ? provider.trim() : undefined,
		// 这一档是**按角色查表**来的吗？是的话，改角色时要跟着重算（显式指定的不重算）
		modelFromRole: modelFromRole === true,
		// 排队（A3）：名册先建好、**不跑**，等有人收工再补位
		status: queued === true ? "排队" : "在跑",
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
		// 手改状态**只许判终态**（完成/卡住）：`squad_update` 的用途是「主 agent 替它判个结论」。
		// 改成「等待」会造出一个没有 `waitingFor` 的死态（没人叫醒、`squad_stop` 当时也停不掉）；
		// 改成「排队」更糟 —— 下次有人收工时 `drainQueue` 会把它**重新点着跑一轮**（独立测实测
		// 调用数 1→1→3）；改成「在跑」是句假话（没有任何东西在跑）。要重跑用 `squad_spawn`/`squad_send`。
		if (s.value !== "完成" && s.value !== "卡住") {
			return {
				ok: false,
				detail: `手改状态只能判终态（完成 / 卡住），收到的是「${s.value}」。要它别等/别排队用 \`squad_stop\`；要重跑用 \`squad_spawn\` 或 \`squad_send\`。`,
			};
		}
		member.status = s.value;
	}
	if (patch.note !== undefined && patch.note !== null && String(patch.note).trim() !== "") {
		const n = multiLine(patch.note, MAX_TEXT);
		if (!n.ok) return { ok: false, detail: `结论${n.detail}` };
		member.note = n.value;
	}
	if (patch.model !== undefined && patch.model !== null && String(patch.model).trim() !== "") {
		member.model = String(patch.model).trim();
	}
	if (patch.modelFromRole !== undefined) member.modelFromRole = patch.modelFromRole === true;
	if (patch.provider !== undefined && patch.provider !== null && String(patch.provider).trim() !== "") {
		member.provider = String(patch.provider).trim();
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

/**
 * 一条用量的「总量」。优先 provider 给的 `totalTokens`；没有就把各项加起来 ——
 * dsh 的各项是**互斥**的（`inputTokens` 只是未命中缓存的那部分，cacheRead 是另一笔），
 * 所以加起来才是「一共花了多少」。预算判定走它，不假设 provider 一定给 `totalTokens`。
 */
function usageTotalOf(usage) {
	if (!usage || typeof usage !== "object") return 0;
	if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	let sum = 0;
	for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
		const v = usage[key];
		if (typeof v === "number" && Number.isFinite(v)) sum += v;
	}
	return sum;
}

/** 小队合计用量（各成员之和）。快照与 token 预算都走它，免得两处算法漂移。 */
function squadUsageTotal(squad) {
	const total = {};
	for (const m of squad.members.values()) {
		for (const [key, value] of Object.entries(m.usage ?? {})) {
			if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
		}
	}
	// `totalTokens` 单列一份**折算过**的合计：成员之间口径可能不一致（有的报 `totalTokens`、
	// 有的只报分项），按 key 求和之后再用 `usageTotalOf` 只认一个 key 会漏算 —— 队级预算就偏小。
	total.totalTokens = 0;
	for (const m of squad.members.values()) total.totalTokens += usageTotalOf(m.usage);
	return total;
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
	const total = squadUsageTotal(squad);
	return {
		name: squad.name,
		objective: squad.objective,
		note: squad.note ?? null,
		owner: ownerId,
		adoptedFrom: squad.adoptedFrom ?? null,
		cwd: squad.cwd ?? null,
		usage: total,
		// A10：验收清单（面板与 `squad_status` 都看它）
		acceptance: (Array.isArray(squad.acceptance) ? squad.acceptance : []).map((e) => ({
			text: e.text,
			done: e.done === true,
			by: e.by ?? null,
			at: e.at ?? null,
			note: e.note ?? null,
		})),
		createdAt: squad.createdAt,
		closed: squad.closed ? { at: squad.closed.at, reason: squad.closed.reason ?? null } : null,
		members: [...squad.members.values()].map((m) => ({
			label: m.label,
			role: m.role,
			task: m.task,
			worktree: m.worktree ?? null,
			status: m.status,
			note: m.note ?? null,
			// A8：收工回报的四段（没解析出来就 parsed:false + 原文）
			report: m.report ?? null,
			// A6：它在等谁（null = 没在等）
			waitingFor: m.waitingFor ?? null,
			// A7：它在审谁 / 谁审过它
			reviews: m.reviews ?? null,
			review: m.review
				? { by: m.review.by ?? null, at: m.review.at ?? null, status: m.review.status ?? null, note: m.review.note ?? null }
				: null,
			// D3：这一行实际跑的档位（null = 用小队默认档）
			model: m.model ?? null,
			updatedAt: m.updatedAt,
			// REQ-015：面板要看耗时/token/重试次数
			usage: m.usage ?? {},
			attempts: m.attempts ?? 0,
			startedAt: m.startedAt ?? null,
			endedAt: m.endedAt ?? null,
			durationMs: m.durationMs ?? 0,
			inbox: Array.isArray(m.inbox) ? m.inbox.length : 0,
			// 面板要判断「还在跑吗」，但 `running` 本身是 AbortController（不能进 JSON）。
			running: isRunning(m),
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
	// 这里 `m` 是**视图**（`running` 已经是算好的布尔）—— 别拿它当句柄喂 `isRunning`
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
	if (m.review) lines.push(`    已被 ${m.review.by} 审：${m.review.status} —— ${(m.review.note ?? "").replace(/\n/g, " ")}`);
	// A8：收工回报（四段）。没按格式写的只标一句，原文在转录里。
	if (m.report) {
		if (m.report.parsed === true) {
			for (const key of ["deliverables", "evidence", "todo", "blockers"]) {
				const value = String(m.report[key] ?? "").trim();
				if (value !== "") lines.push(`    ${REPORT_LABELS[key]}：${value.replace(/\n/g, "\n    ")}`);
			}
		} else {
			lines.push("    回报：没按四段格式写（原文在转录里）");
		}
	}
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
		out.push(...renderAcceptance(s.acceptance));
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
	// ⚠️ 只有**没给** `toolNames` 时才回落到全部：给了空数组就是「这个角色一个工具都没有」，
	// 回落到全部等于提示词告诉成员它有 14 个工具、而 API 那边一个都没发（说得到做不到）。
	const names = Array.isArray(toolNames) ? toolNames : MEMBER_TOOLS.map((tool) => tool.name);
	const fileTools = names.filter((name) => name !== "board").join(" / ");
	const hasBash = names.includes("bash");
	return [
		`你是小队「${squad.name}」的成员「${member.label}」（角色：${member.role}）。`,
		`小队的目标：${squad.objective}`,
		"",
		"你的工作方式：",
		// 零工具是**合法**配置（`roleTools` 给了空数组）：这时候要明说「你没有任何工具」，
		// 而不是渲染出「0 个：。」加一行空的工作区说明。
		...(names.length === 0
			? ["· 你**没有任何工具**（这个角色被配成零工具）：只能靠想，然后把结论写进最后一条消息。"]
			: [
					`· 工作区是 \`${member.worktree}\`。${fileTools} 全都在它里面，路径越界会被直接拒绝。`,
					`· 工具就 ${names.length} 个：${names.join(" / ")}。没有别的（没有别的 agent 可派，也没有审批通道）。`,
				]),
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
		"收工：最后一条消息**按这四段写**（小队会把它们摘出来给主 agent 看，省得它去翻转录）：",
		"  `## 交付物` 改了什么 / 产出了什么（写清 文件:行号）",
		"  `## 证据` 你怎么验证的（跑过的命令 + 实际输出，别写「应该可以」）",
		"  `## 没做的` 明确没做、没验的（没有也要写「无」）",
		"  `## 卡点` 卡在哪、需要谁做什么（没有就写「无」）",
		"写完**不要再调工具** —— 不再调工具就等于你收工了，小队会把这条结论记进黑板。",
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
 * 为什么一个写接口都不开：改状态的入口只有那 9 个工具，都在进程内、都要过
 * `authorize()`（谁能动这个队）。HTTP 这边多开一个 POST，就等于多一套「谁能改」的
 * 判断要维护，而面板根本不需要 —— 它只负责看。
 */
export function registerSquadRoutes(scope, { state, config, log = () => {} }) {
	/** 面板渲染一条转录最多看多少字符（转录本身留在内存里，这里只是别把响应撑爆）。 */
	const TRANSCRIPT_VIEW_CHARS = 4000;

	/**
	 * 成本（C2）：`billForDay` 会把当天的审计日志整个读一遍 —— 那可能有几 MB，
	 * 而面板刷新很频繁。所以**同一个日期 10 秒内只读一次**（缓存的是算好的结果，不是文件句柄）。
	 */
	const COST_TTL_MS = 10_000;
	let costCache;
	function costFor(date) {
		if (costCache && costCache.date === date && Date.now() - costCache.at < COST_TTL_MS) return costCache.value;
		const records = [];
		for (const byName of state.values()) for (const squad of byName.values()) records.push(compactSquad(squad));
		const report = billForDay(date, { squads: records });
		const value = {
			date,
			file: report.file,
			// 没有审计日志就 `audit: null`（面板要能区分「0」和「没数据」）
			audit: report.audit
				? { totals: report.audit.totals, sessions: report.audit.sessions, calls: report.audit.totals.calls, bad: report.audit.bad }
				: null,
			squads: report.squads,
		};
		costCache = { date, at: Date.now(), value };
		return value;
	}

	/**
	 * SSE（B3）。**推的是变化**：每秒算一次廉价的指纹，变了才推整份快照。
	 *
	 * 为什么不用「每次 persist 就推」：状态改动散在十几个地方，挂回调等于每处都要记得调 ——
	 * 漏一处就是「面板偶尔不更新」这种最难查的毛病。指纹法只在**一个**地方看状态。
	 */
	const EVENT_TICK_MS = 1000;
	const EVENT_HEARTBEAT_MS = 20_000;
	function fingerprint() {
		const bits = [];
		for (const [ownerId, byName] of state) {
			for (const squad of byName.values()) {
				// 黑板**满了之后 `length` 不再变**：只数条数的话，满盘之后新写的黑板永远不推。
				// 所以带上首尾条目的 `at`（新条目会把最旧的挤出去，首条的 `at` 就变了）。
				const first = squad.board[0]?.at ?? 0;
				const last = squad.board[squad.board.length - 1]?.at ?? 0;
				bits.push(`${ownerId}/${squad.name}:${squad.members.size}:${squad.board.length}:${first}:${last}:${squad.closed ? 1 : 0}`);
				for (const member of squad.members.values()) {
					bits.push(`${member.label}:${member.status}:${member.updatedAt ?? 0}:${member.usage?.totalTokens ?? 0}:${member.transcript?.length ?? 0}`);
				}
			}
		}
		return bits.join("|");
	}

	function streamEvents(req, res) {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			// 反代下别缓冲（不然事件会攒着一起发）
			"x-accel-buffering": "no",
		});
		const send = (event, payload) => {
			res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		};
		let last = fingerprint();
		send("squads", { ok: true, ...snapshotAll(state) });
		const tick = setInterval(() => {
			const now = fingerprint();
			if (now === last) return;
			last = now;
			try {
				send("squads", { ok: true, ...snapshotAll(state) });
			} catch (err) {
				log(`小队事件推不出去：${err?.message ?? err}`);
			}
		}, EVENT_TICK_MS);
		const beat = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch {
				// 连接没了下面 close 会收拾
			}
		}, EVENT_HEARTBEAT_MS);
		// **必须**在 close 上清定时器：否则每开一次面板漏两个常驻定时器（进程永远退不掉）
		const cleanup = () => {
			clearInterval(tick);
			clearInterval(beat);
		};
		res.on("close", cleanup);
		res.on("error", cleanup);
		return undefined;
	}

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
			if (sub === "/cost" && method === "GET") {
				// C2：成本面板的数据源 —— 与 `dsh-team bill` 同一套口径（C1），不另算一份。
				return sendJson(res, 200, { ok: true, ...costFor(localDate()) });
			}
			if (sub === "/events" && method === "GET") {
				// B3：服务端推（SSE），面板不必 5 秒轮询一次。
				return streamEvents(req, res);
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
					// `sessionId` 给面板用：成员是原生会话了，那一行要能「打开会话」（REQ-025）。
				member: { label: member.label, role: member.role, task: member.task, status: member.status, note: member.note ?? null, worktree: member.worktree ?? null, sessionId: member.sessionId ?? null, running: isRunning(member) },
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
	 * 成员跑在**原生 dsh 根会话**里（REQ-025）：建会话 / 钉权限 / 投消息 / 等收工
	 * 全在 `lib/squad-agent.js`。这里只把「成员的 system 提示怎么写」注进去 ——
	 * 那个函数在本文件里（`memberSystemPrompt`），反向 import 会成环。
	 */
	const memberRunner = createMemberRunner({ scope: ctx, config, log, memberPrompt: memberSystemPrompt });

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

	/**
	 * 按**成员会话 id** 找回它属于哪支队的哪个成员（REQ-025）。
	 *
	 * 扫全表而不是维护一张索引：`agent/status` / `agent/error` 是低频事件，
	 * 而索引要在「成员会话 id 变了」的每个地方同步（重派、换档重试、重启接管、
	 * 落盘还原）—— 漏一处就是通知发错人，扫一遍反而没有这个失败模式。
	 */
	function findMemberBySession(sessionId) {
		if (typeof sessionId !== "string" || sessionId === "") return undefined;
		for (const table of state.values()) {
			for (const squad of table.values()) {
				for (const member of squad.members.values()) {
					if (member.sessionId === sessionId) return { squad, member };
				}
			}
		}
		return undefined;
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

	/**
	 * 成员会话「空闲了」= 队长该看一眼了（REQ-025）。
	 *
	 * 为什么要这一条：成员现在是普通会话，**别人也能直接跟它说话**（面板里打开它、
	 * 在 GUI 里发一句）。那种情况下小队这一轮早就收工了（`isRunning` 为假），
	 * 没有任何人会把结果写进黑板 —— 队长不看会话列表就永远不知道它又干了活。
	 * 正在跑的那一轮由 `lib/squad-round.js` 收尾（它写结论），这里**不重复写**。
	 */
	const offStatus = ctx.on?.("agent/status", (payload) => {
		if (payload?.status !== "idle") return;
		const found = findMemberBySession(payload?.agent?.session?.id ?? payload?.agent?.id);
		if (!found) return;
		const { squad, member } = found;
		if (isRunning(member) || squad.closed) return;
		member.note = `${member.note ?? "已收工"}（会话又空闲了 —— 有人在会话里直接跟它说了话，或它自己跑完了一轮）`;
		member.updatedAt = Date.now();
		appendBoard(squad, { from: member.label, text: `${member.label} 的会话空闲了（不是小队这一轮跑的）—— 去面板里打开它看干了什么。` }, boardLimit);
		persistSquad(squad);
	});
	if (typeof offStatus === "function") disposers.push(offStatus);

	/** 成员会话里出的错：以前它只活在那个 loop 的 catch 里，现在变成黑板上一行。 */
	const offError = ctx.on?.("agent/error", (payload) => {
		const found = findMemberBySession(payload?.agent?.session?.id ?? payload?.agent?.id);
		if (!found) return;
		const { squad, member } = found;
		const detail = payload?.error?.message ?? String(payload?.error ?? "未知错误");
		appendBoard(squad, { from: member.label, text: `${member.label} 的会话报错：${detail}` }, boardLimit);
		member.updatedAt = Date.now();
		persistSquad(squad);
	});
	if (typeof offError === "function") disposers.push(offError);

	// 输出形状（9 个工具都是「一段文本」），写成工厂避免重复 9 遍。
	const text = () => ({
		schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
		render: (_args, value) => [{ type: "text", text: value.text }],
	});

	// ── 成员循环的接线（REQ-025：跑在原生会话里，见 `lib/squad-agent.js`） ──────
	// 旧的 `loadKit()`（自己从 loader 取 `BlockAssembler` / `createToolResultMessage`
	// 来驱动自持 loop）随 REQ-025 一起删掉了 —— 那条路连同它踩过的
	// 「`unwrapExports` 丢掉命名导出」的坑，都搬进了 `lib/squad-agent.js` 的 `modules()`。

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
		// （本包 `lib/mc-adapter.js:240`、`lib/computer.js:626` 都踩过，已改用 get）。
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
		// **别再自动点火**：`drainQueue` 挂在每个成员的 finally 上，不拦的话「排队的成员」会在
		// 收尾时被点着继续烧模型 —— 而这条路的三个调用方（收队 / 会话销毁 / 插件拆除）都是
		// 「这队完了」的意思（独立测实测：会话销毁后 B 照样跑成「完成」，而 state 里队都删了）。
		// 注意**不是** `closed`：那会挡住「换个会话接手同一个 cwd」的写入（REQ-015 要能接手写），
		// 而且 `closed` 会落盘 —— 这个标记只活在内存里，重启/接手后自然消失。
		squad.aborted = true;
	}

	/**
	 * 成员请求「等某人收工」（A6）。
	 *
	 * **不做阻塞等待**：成员侧真阻塞就是死锁（它占着这一步，等的人也在等它）。
	 * 改成：自己掐停这次（`stopSelf`），状态判「等待」，目标收工时由 `wakeWaiters` 叫回来。
	 * 目标**已经收工**的话根本不用等 —— 直接把它的结论回给它，让它在同一轮里接着干。
	 */
	function requestWait(squad, member, target, note, stopSelf, round) {
		if (squad.closed) return { ok: false, detail: closedDetail(squad) };
		// 这一轮已经被新的一轮顶掉了（stop 之后立刻重派）→ 这个 `wait` 是**过期**的：
		// 让它落地就会把已经跑完的新一轮写成「等待」+ `waitingFor`，之后还被 `wakeWaiters`
		// 再点着跑一轮（独立测实测：模型调用 3→4，白烧一轮）。只护 `.then` 不够，写入在这里。
		if (round !== undefined && member.running?.abort !== round) {
			return { ok: false, detail: "这一轮已经被停掉/重派了 —— 这个等待请求作废" };
		}
		const wanted = String(target ?? "").replace(/\s+/g, " ").trim();
		if (wanted === "") return { ok: false, detail: "要等谁？给成员名" };
		if (wanted === member.label) return { ok: false, detail: "不能等自己（那就是死锁）" };
		const other = squad.members.get(wanted);
		if (!other) {
			const names = [...squad.members.keys()];
			return { ok: false, detail: `「${squad.name}」里没有成员「${wanted}」${names.length > 0 ? `（有：${names.join(" / ")}）` : ""}` };
		}
		// 环检测：顺着「它在等谁」走一圈，走到我自己就是环 —— 两边都会永远等下去
		for (let cursor = other, hops = 0; cursor && hops <= squad.members.size; hops += 1) {
			if (cursor.waitingFor === member.label) {
				return { ok: false, detail: `会成环：${cursor.label} 也在等你（两边都等 = 两边都不动）` };
			}
			cursor = cursor.waitingFor ? squad.members.get(cursor.waitingFor) : undefined;
		}
		const summary = other.report?.parsed ? formatReport(other.report) : (other.note ?? "");
		if (!other.running) {
			if (other.status === "完成" || other.status === "卡住") {
				return {
					ok: true,
					text: `「${other.label}」已经收工了（${other.status}）${summary ? `：${summary}` : ""}\n不用等 —— 接着干你的；要它的产物就去它的 worktree（${other.worktree ?? "?"}）看。`,
				};
			}
			return { ok: false, detail: `「${other.label}」现在没在跑（状态：${other.status}）—— 等它没意义。要它跑就先让主 agent 派它。` };
		}
		const why = typeof note === "string" && note.trim() !== "" ? note.trim() : undefined;
		member.waitingFor = other.label;
		member.roundEnd = { kind: "waiting", reason: why, at: Date.now() };
		member.status = "等待";
		member.note = `在等「${other.label}」收工${why ? `（${why}）` : ""}`;
		member.updatedAt = Date.now();
		persistSquad(squad);
		appendBoard(squad, { from: member.label, text: `⏸ 等 ${other.label} 收工${why ? `：${why}` : ""}` }, boardLimit);
		if (typeof stopSelf === "function") stopSelf();
		return { ok: true, waiting: true, text: `好，你这次先停在这里等「${other.label}」。它收工后小队会把你叫回来继续（那时你会看到它的结论）。` };
	}

	/**
	 * 有人收工 → 把等它的成员叫回来（A6）。挂在成员 promise 的 **finally** 里，与补位同一处。
	 * 叫回来时把**它的结论/回报**当新任务投进去 —— 不然那个成员醒了也不知道等到了什么。
	 */
	function wakeWaiters(squad) {
		// 同 `drainQueue`：收队/整队被掐之后不许再叫醒谁
		if (squad.closed || squad.aborted === true) return;
		const cap = config.maxRunning > 0 ? config.maxRunning : Infinity;
		for (const member of squad.members.values()) {
			if (typeof member.waitingFor !== "string") continue;
			// 主 agent 手动改过状态（`squad_update`）→ 这次等待作废：标记也要清掉，
			// 不然面板会一直显示「在等 X」，而它其实已经做别的去了
			if (member.status !== "等待") {
				member.waitingFor = undefined;
				member.roundEnd = undefined;
				continue;
			}
			// **扫描式**：不看「谁刚收工」，而是看「我等的那个人还在跑吗」。
			// 原来按「刚收工的那个」匹配，会撞上一个窄竞态：被等者收工那一瞬，等者自己的
			// 收尾还没跑完（`running` 还在）→ 这次被 `continue` 跳过，而被等者不会二次收工、
			// 等者自己的 finally 又只扫「等我的」→ **这次唤醒永久丢失**，成员停在「等待」。
			const finished = squad.members.get(member.waitingFor);
			// **「不在跑」不等于「已收工」**：链式等待时（甲等乙、乙转去等丙）乙只是停着等，
			// 按「不在跑」判就会把甲唤醒、还塞给它一句「你等的「乙」收工了（等待）」的假结论，
			// 同时把甲的等待标记清掉 —— 乙真收工时甲反而不醒了。所以必须真收工（完成/卡住）才算。
			if (!finished) {
				// 名册里没这个人了（今天没有删成员的路径，防的是将来加）：别让它永久「在等」
				const gone = member.waitingFor;
				member.waitingFor = undefined;
				member.roundEnd = undefined;
				member.status = "卡住";
				member.note = `等的「${gone}」不在名册里了 —— 等待作废，自己看着办`;
				member.updatedAt = Date.now();
				persistSquad(squad);
				continue;
			}
			if (finished.status !== "完成" && finished.status !== "卡住") continue;
			if (member.running) continue;
			member.waitingFor = undefined;
			member.roundEnd = undefined;
			const summary = finished.report?.parsed ? formatReport(finished.report) : (finished.note ?? "");
			const task = `你等的「${finished.label}」收工了（${finished.status}）：${summary}\n它的 worktree：${finished.worktree ?? "?"}。接着干你的事；它的产出不合用就在回报的「卡点」里写清。`;
			// 并发满了就先排队（A3 的上限不能被「唤醒」绕过）。叫醒的话**塞进待投队列**，
			// 它下次真跑起来时在第一步边界收到 —— 不然这条话就丢了。
			if (runningCount(squad) >= cap) {
				member.inbox = Array.isArray(member.inbox) ? member.inbox : [];
				member.inbox.push(userMessage(task));
				member.status = "排队";
				member.note = `等到「${finished.label}」收工了，但并发满了 —— 排在队里，有人收工就补位`;
				member.updatedAt = Date.now();
				persistSquad(squad);
				continue;
			}
			// 被叫醒 = 接着**它原来那个会话**跑（历史都在），没有会话才退化成
			// 「原任务 + 上次结论」。REQ-025 之前这里是自己拼一段假历史喂给自持 loop。
			const hadSession = typeof member.sessionId === "string" && member.sessionId !== "";
			const wakeTask = hadSession
				? task
				: `${member.task}\n\n── 上一次的结果 ──\n${member.note ?? "（没留下结论）"}\n\n── 现在要你做的 ──\n${task}`;
			const started = startMember(squad, member, {
				provider: member.provider ?? config.provider,
				model: member.model ?? roleModel(config.roles, member.role) ?? config.model,
				resume: { task: wakeTask },
			});
			if (!started.ok) {
				member.status = "卡住";
				member.note = `等到了，但起不来：${started.detail}`;
			}
			persistSquad(squad);
		}
	}

	/** 这个角色允许用哪些工具（A4）。没配 = undefined（不限制，只受 `bash` 那道全局闸门管）。 */
	function roleToolsFor(role) {
		const table = config.roleTools && typeof config.roleTools === "object" ? config.roleTools : {};
		const raw = String(role ?? "").trim();
		if (raw === "") return undefined;
		const list = table[roleKey(raw)] ?? table[raw];
		// `[]` 是**合法**配置（这个角色一个工具都不给），不能当成「没配」——
		// 当成没配就是 fail-open：想要零工具的角色反而拿到全部（含 bash）。
		return Array.isArray(list) ? list : undefined;
	}

	/** 现在有几个成员在跑（A3 的并发闸门用它）。 */
	function runningCount(squad) {
		let n = 0;
		// 被 `squad_stop` 掐掉的**不算**在跑：它的 controller 虽然还挂着（等流自己收尾），
		// 但那个成员已经停了 —— 还占着位子的话，流不认 abort 时排队者永远补不上来（独立测实测）。
		for (const member of squad.members.values()) if (isRunning(member)) n += 1;
		return n;
	}

	/**
	 * 还剩多少 token 预算（A2）。返回一个函数：吃「这一轮已经烧掉的量」，
	 * 所以成员级与队级的账都算得准（成员自己的历史用量在 `member.usage`，本轮在参数里）。
	 */
	function budgetLeftFor(squad, member) {
		if (!(config.tokenBudget > 0) && !(config.memberTokenBudget > 0)) return undefined;
		return (running) => {
			const now = usageTotalOf(running);
			const left = [];
			if (config.tokenBudget > 0) left.push(config.tokenBudget - (usageTotalOf(squadUsageTotal(squad)) + now));
			if (config.memberTokenBudget > 0) left.push(config.memberTokenBudget - (usageTotalOf(member.usage) + now));
			return Math.min(...left);
		};
	}

	/**
	 * 补位（A3）：有人收工/被停就把排队的成员放出去。
	 * 只由**成员 promise 的 finally** 与 `squad_stop` 调 —— 别处调容易在收尾前就把队放出去。
	 */
	function drainQueue(squad) {
		// 收队/整队被掐之后不许再放人出去：它们收尾的 finally 会走到这里 ——
		// 不拦的话「收队」当场又把排队的成员点着了，和「不会再烧模型」自相矛盾。
		if (squad.closed || squad.aborted === true) return;
		// `0` = 不限（不是「一个都别跑」）。第一版在这里直接 return 了 —— 结果
		// **默认配置下排队的成员永远起不来**（模板起队踩到，自检逮住）。
		const cap = config.maxRunning > 0 ? config.maxRunning : Infinity;
		for (const member of squad.members.values()) {
			if (runningCount(squad) >= cap) return;
			if (member.status !== "排队") continue;
			const started = startMember(squad, member, {
				provider: member.provider ?? config.provider,
				model: member.model ?? roleModel(config.roles, member.role) ?? config.model,
			});
			if (!started.ok) {
				member.status = "卡住";
				member.note = started.detail;
			}
			persistSquad(squad);
		}
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
		target.transcript.push({ role: "user", text: body, injected: true, queued: !isRunning(target), at: Date.now() });
		while (target.transcript.length > TRANSCRIPT_LIMIT) target.transcript.shift();
		appendBoard(squad, { from, text: `→ ${target.label}：${t.value}` }, boardLimit);
		persistSquad(squad);
		return { ok: true, queued: !isRunning(target), target };
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
	 *  · **续聊**（`resume`）：接着上次的会话跑，而不是从零开始；
	 *  · **重试**：只对基础设施失败（`kind === "infra"`）重试；
	 *  · **超时**：每次尝试一个墙钟上限，超了就取消。
	 *
	 * @param {object} [options.resume] `{ task }` —— 续聊要投的新任务（历史在会话里）
	 */
	// 一轮成员循环搬到了 `lib/squad-round.js`（见那个文件的头注释：本轮的 P1 全在它的出口边界上）。
	// 这里用**函数声明**而不是箭头 `const`：上面的 `drainQueue` 也会调它，声明会提升。
	function startMember(squad, member, opts) {
		try {
			return startRound(
			{
				config,
				ctx,
				persistSquad,
				drainQueue,
				wakeWaiters,
				roleToolsFor,
				requestWait,
				deliverSay,
				markAcceptance,
				appendBoard,
				log,
				boardLimit: config.boardLimit,
				usageLine,
				// 搬移时漏掉的两个（独立测逮到）：`closedDetail` 是模块级函数，新文件里没 import ——
				// 漏了就是 ReferenceError（今天不可达，但那是运气，不是设计）；`isRunning` 用它才能
				// 兑现「唯一判据」那句话（原来这里内联了 `member.running && …aborted !== true`）。
				closedDetail,
				isRunning,
				roleModelChain: (role) => roleModelChain(config.roles, role),
				TRANSCRIPT_LIMIT,
				TRANSCRIPT_TEXT_MAX,
				MAX_BOARD_TEXT,
				memberTaskText,
				policyFor,
				budgetLeftFor,
				// REQ-025：真正跑成员的那一步在 `lib/squad-agent.js`（原生会话）。
				// `loadKit` / `memberSystemPrompt` 不再从这里过 —— 前者是旧自持 loop 的
				// 加载器，后者现在由 `createMemberRunner` 拿去挂成员的 system 提示。
				runMemberRound: memberRunner.run,
			},
				squad,
				member,
				opts,
			);
		} catch (err) {
			console.error("[WRAP]", err?.stack?.split("\n").slice(0, 6).join(" | "));
			throw err;
		}
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
				acceptance: {
					type: "array",
					items: { type: "string" },
					description: `验收清单（A10，最多 ${MAX_ACCEPTANCE} 条）：每条一句话、**可执行**（「npm test 全绿」而不是「质量良好」）。成员干完自己勾（\`check\` 工具），\`squad_status\` 看得到进度。`,
				},
				template: {
					type: "string",
					description:
						`按 \`team/extensions/squad.json\` 里的模板一键起队（A9）：建队 + 按模板把成员派出去（受并发上限约束，超了排队）。` +
						`现在配了：${Object.keys(config.templates ?? {}).join(" / ") || "（一个都没配）"}。`,
				},
			}),
			output: text(),
			async execute(args, exec) {
				const actor = actorOf(exec);
				const r = newSquad(state, actor.id, {
					name: args?.name,
					objective: args?.objective,
					note: args?.note,
					acceptance: args?.acceptance,
					cwd: actor.cwd,
				});
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				persistSquad(r.squad);
				const acc = r.squad.acceptance.length > 0 ? `\n验收清单 ${r.squad.acceptance.length} 条：\n${renderAcceptance(r.squad.acceptance).slice(1).join("\n")}` : "";
				const wantedTemplate = String(args?.template ?? "").trim();
				if (wantedTemplate !== "") {
					// A9：按模板起队。名册先建好，再受**并发上限**约束放出去（`drainQueue` 同一套闸门）。
					const table = config.templates && typeof config.templates === "object" ? config.templates : {};
					const entries = table[wantedTemplate];
					if (!Array.isArray(entries)) {
						const names = Object.keys(table);
						return {
							text: `已建小队「${r.squad.name}」${acc}\n[失败] 没有模板「${wantedTemplate}」${names.length > 0 ? `（配了：${names.join(" / ")}）` : "（一个都没配 —— 写在 team/extensions/squad.json 的 templates 里）"}。名册是空的，用 \`squad_spawn\` 手动派。`,
						};
					}
					const base = r.squad.cwd ?? callerCwdOf(exec) ?? process.cwd();
					const created = [];
					const missing = [];
					for (const entry of entries) {
						// worktree 允许相对路径（相对小队 cwd）—— 绝对路径照旧直接用
						const wt = path.isAbsolute(entry.worktree) ? entry.worktree : path.resolve(base, entry.worktree);
						if (!existsSync(wt)) {
							missing.push(`${entry.member}（${wt}）`);
							continue;
						}
						const added = addMember(state, r.squad, {
							label: entry.member,
							role: entry.role,
							task: entry.task,
							worktree: wt,
							provider: config.provider,
							model: roleModel(config.roles, entry.role) ?? config.model,
							modelFromRole: true,
							queued: true,
						});
						if (!added.ok) {
							missing.push(`${entry.member}（${added.detail}）`);
							continue;
						}
						created.push(added.member);
					}
					persistSquad(r.squad);
					// 放出去跑（`drainQueue` 自己看并发上限，超了的留在「排队」）
					drainQueue(r.squad);
					const lines = created.map((m) => `  · ${m.label} [${m.role}] ${m.status}  ${m.worktree}`);
					const blocked = missing.length > 0 ? `\n没建的 ${missing.length} 条：\n${missing.map((x) => `  · ${x}`).join("\n")}\n它们的 worktree 还不存在 —— 先 \`worktree_new\` 建好，再 \`squad_spawn\`（模板里没写进名册，免得成员一上来就 fs 报错）。` : "";
					return {
						text: `已按模板「${wantedTemplate}」建队「${r.squad.name}」：派了 ${created.length} 个成员（超并发上限的会排队，有人收工自动补位）。${acc}\n${lines.join("\n")}${blocked}`,
					};
				}
				return {
					text: `已建小队「${r.squad.name}」。目标：${r.squad.objective}${acc}\n接下来：\`squad_spawn\` 派成员（要写代码的成员先 \`worktree_new\` 给它建一棵 worktree）${Object.keys(config.templates ?? {}).length > 0 ? `；也可以用 \`template\` 一键起队（配了：${Object.keys(config.templates).join(" / ")}）` : ""}。`,
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
				model: {
					type: "string",
					description: `档位/模型。不传时按**角色**查 \`roles\` 表（「审查」与「审查型」同一条），查不到用 \`${config.model}\`。团队网关别名：tier-std / tier-power / tier-max。`,
				},
				provider: { type: "string", description: `provider，默认 \`${config.provider}\`。` },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const existing = auth.squad.members.get(label);
				// 角色：入参优先，空白就用这一行**现在**的角色。档位必须按**最终生效的角色**算 ——
				// 否则重跑时 role 传空白会得到「角色 审查 / 档位 tier-std」这种自相矛盾的结果
				// （2026-10-16 std 测逮到）。
				const role = String(args?.role ?? "").trim() || existing?.role || "";
				const askedModel = String(args?.model ?? "").trim();
				// D3：没传 model 时先按角色查档位表（「审查」与「审查型」同一条），再回落默认档
				const fromRole = askedModel === "" && roleModel(config.roles, role) !== undefined;
				const model = String(askedModel || roleModel(config.roles, role) || config.model || "").trim();
				const provider = String(args?.provider ?? config.provider ?? "").trim();
				if (model === "" || provider === "") {
					return { text: "[失败] 没给模型/provider（在参数里传，或改 `team/extensions/squad.json`）" };
				}
				// 被 `squad_stop` 掐过的那条（`aborted`）不算「还在跑」：停掉就是想腾位子重来
				if (existing?.running && existing.running.aborted !== true) {
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
				// 并发闸门（A3）：满了就**排队**（名册先建好、不跑），有人收工自动补位。
				const running = runningCount(auth.squad);
				const queued = existing?.running === undefined && config.maxRunning > 0 && running >= config.maxRunning;
				// 重跑 = 复用同一行（黑板上的作者名不变），换掉角色/任务/worktree。
				const r = existing
					? updateMember(auth.squad, label, { role, task: args?.task, worktree, model, provider, modelFromRole: fromRole, ...(queued ? { status: "排队" } : {}) })
					: addMember(state, auth.squad, { label, role, task: args?.task, worktree, model, provider, modelFromRole: fromRole, queued });
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				if (queued) {
					persistSquad(auth.squad);
					return {
						text:
							`已把「${r.member.label}」（${r.member.role}）排进「${auth.squad.name}」的队里：现在 ${running} 个在跑，上限 ${config.maxRunning}。` +
							`有人收工会自动补位（\`squad_status\` 看得到「排队」）。\n它的根目录：${r.member.worktree}`,
					};
				}
				const started = startMember(auth.squad, r.member, { provider, model });
				if (!started.ok) {
					// 到这儿说明真起不来（比如宿主没有 llm 服务）—— `squad_spawn` 自己的「还在跑」
					// 护栏在更前面就拦掉了，所以这里不用再判一次 `running`（判了也是死代码）。
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
				"改成员那一行：状态、一句结论、角色、任务、worktree；也用它改**验收清单**。" +
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
				acceptance: {
					type: "array",
					items: { type: "string" },
					description:
						"改**小队**验收清单（A10）：整份替换。字面没变的那几条会保住原来的勾（谁勾的、什么时候）；" +
						"要替主 agent 勾一条，写成对象 `{text, done: true}`。传了它就不用 `member` 了。",
				},
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				// 验收清单（A10）是**小队级**的，不走成员那一行 —— 所以先单独处理
				if (args?.acceptance !== undefined) {
					const acc = normalizeAcceptance(args.acceptance);
					if (!acc.ok) return { text: `[失败] ${acc.detail}` };
					const before = new Map((auth.squad.acceptance ?? []).map((e) => [e.text, e]));
					auth.squad.acceptance = acc.value.map((e) => {
						const old = before.get(e.text);
						if (!old) return { ...e, by: e.by ?? (e.done ? "主 agent" : undefined), at: e.at ?? (e.done ? Date.now() : undefined) };
						return {
							...e,
							done: e.done || old.done,
							by: e.by ?? old.by ?? (e.done ? "主 agent" : undefined),
							at: e.at ?? old.at ?? (e.done ? Date.now() : undefined),
							note: e.note ?? old.note,
						};
					});
					persistSquad(auth.squad);
					const done = auth.squad.acceptance.filter((e) => e.done).length;
					return {
						text: `「${auth.squad.name}」的验收清单已更新（${done}/${auth.squad.acceptance.length} 勾）：\n${renderAcceptance(auth.squad.acceptance).slice(1).join("\n")}`,
					};
				}
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const wanted = String(args?.worktree ?? "").trim();
				const current = auth.squad.members.get(label);
				if (current?.running && wanted !== "" && wanted !== current.worktree) {
					return { text: "[失败] 它正在跑，改 worktree 会让记录和它实际在用的目录对不上 —— 先等它收工。" };
				}
				const nextRole = String(args?.role ?? "").trim();
				const patch = {
					status: args?.status,
					note: args?.note,
					role: args?.role,
					task: args?.task,
					worktree: args?.worktree,
				};
				// 改角色时把档位一起重算 —— 否则「改角色（只影响下一次）」是句空话：
				// 下一次角色变了、档位没变。只在它原来就是**按角色取**的时候重算，
				// 显式传过 model 的（比如 tier-max）不许被悄悄改掉。
				if (nextRole !== "" && current?.modelFromRole === true) {
					patch.model = roleModel(config.roles, nextRole) ?? config.model;
				}
				const r = updateMember(auth.squad, label, patch);
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
				if (isRunning(member)) {
					return { text: `[失败] 「${member.label}」正在跑。要给它加话就用 \`squad_say\`（会投进它下一步），或者等它收工。` };
				}
				const t = multiLine(args?.text, MAX_TEXT);
				if (!t.ok) return { text: `[失败] 消息${t.detail}` };
				const hadSession = typeof member.sessionId === "string" && member.sessionId !== "";
				// 有会话就接着跑（REQ-025：真历史在那个会话里，`lib/squad-agent.js` 会 resume）；
				// 没有（重启过、或从没跑起来）就用「原任务 + 上次结论」兜底。
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
				const task = hadSession
					? t.value
					: `${member.task}\n\n── 上一次的结果 ──\n${lastSaid ?? member.note ?? "（没留下结论）"}\n\n── 现在要你做的 ──\n${t.value}`;
				// 续聊会**作废**它正在进行的等待（`startMember` 清 `waitingFor`）——
				// 先记下来，返回文本里要说出来，别让主 agent 以为它还在等。
				const wasWaiting = typeof member.waitingFor === "string" ? member.waitingFor : undefined;
				const started = startMember(auth.squad, member, {
					// 续聊沿用这一行**原来**的档位（D3）：不然审查型跑第二轮会悄悄掉回默认档。
					// 老落盘记录没有 model（2.0 之前）→ 退一步查角色表，最后才用默认档。
					provider: member.provider ?? config.provider,
					model: member.model ?? roleModel(config.roles, member.role) ?? config.model,
					resume: { task },
				});
				if (!started.ok) return { text: `[失败] ${started.detail}` };
				persistSquad(auth.squad);
				return {
					text: `已让「${member.label}」接着干（${hadSession ? "接着它原来那个会话，历史都在" : "重启过、没有会话，用原任务+上次结论兜底"}），后台跑着。${wasWaiting ? `**它本来在等「${wasWaiting}」—— 这次续聊把那个等待作废了**（要它继续等就别插话）。` : ""}看进展：\`squad_status\` 或面板里的转录。`,
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
			name: "squad_review",
			description:
				"派一个**审查型**成员去审另一个成员的产出（A7）——把「每块产出必须有人审」从规矩变成工具。" +
				"被审者必须已经收工（状态「完成」）；还在跑会被拒 —— 审半成品只会得到半成品的结论。" +
				"审查成员是**独立循环**，读不到被审者的转录（那是内存态），所以这个工具把它的回报、worktree、" +
				"小队验收清单**塞进审查成员的 task**。审查结论会挂到被审成员那一行（`squad_status` 看得到「已被 X 审」）。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "审**谁**的产出（被审成员名）。" },
				reviewer: { type: "string", description: "审查成员叫什么（默认 `审-<被审者>`；同名就复用那一行重跑）。" },
				focus: { type: "string", description: "重点看什么（可选）：例如「只看信任边界」「只看有没有漏改调用方」。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				if (auth.squad.closed) return { text: `[失败] ${closedDetail(auth.squad)}` };
				const wanted = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const target = auth.squad.members.get(wanted);
				if (!target) {
					const names = [...auth.squad.members.keys()];
					return { text: `[失败] 「${auth.squad.name}」里没有成员「${wanted}」${names.length > 0 ? `（有：${names.join(" / ")}）` : ""}` };
				}
				if (isRunning(target)) return { text: `[失败]「${target.label}」还在跑 —— 等它收工再审（审半成品只会得到半成品的结论）。` };
				if (target.status !== "完成") {
					return { text: `[失败]「${target.label}」的状态是「${target.status}」，不是「完成」—— 没做完的东西审它没意义。` };
				}
				if (typeof target.worktree !== "string" || target.worktree === "") {
					return { text: `[失败]「${target.label}」没有 worktree，审查成员没地方去看它的产出。` };
				}
				const label = (String(args?.reviewer ?? "").replace(/\s+/g, " ").trim() || `审-${target.label}`).slice(0, MAX_NAME);
				const role = "审查";
				// 审查成员用角色表里「审查」那一档（没配就用默认档）—— 这是 D3 的用法，不是另开一套
				const model = roleModel(config.roles, role) ?? config.model;
				const focus = String(args?.focus ?? "").trim();
				const checklist = (auth.squad.acceptance ?? [])
					.map((e, i) => `${i + 1}. [${e.done ? `已勾：${e.by ?? "?"}` : "没勾"}] ${e.text}`)
					.join("\n");
				const task = [
					`审查「${target.label}」（角色：${target.role}）的产出。`,
					`它的任务：${target.task}`,
					`它的 worktree：${target.worktree} —— 去那里看代码、跑测试（\`git -C ${target.worktree} diff\` 看它改了什么）。`,
					target.report?.parsed
						? `它自己的回报（**它说的，不是验证过的**）：\n${formatReport(target.report)}`
						: `它没按四段格式回报。它那句结论是：${target.note ?? "（没有）"}`,
					checklist === "" ? "" : `小队的验收清单（逐条核对它到底做到没有）：\n${checklist}`,
					focus === "" ? "" : `主 agent 指定的重点：${focus}`,
					"要求：逐条给「文件:行号 + 一句修法」，按 P0/P1/P2 排序；**只审不改**（发现问题写进回报，别动手改别人的代码）。",
					"**只审这一个成员的产出**，不要全仓探索；跑不动的东西直说跑不动（别写「应该可以」）。",
					"最后按四段格式回报：交付物=审查结论清单，证据=跑过的命令 + 实际输出，没做的、卡点。",
				]
					.filter((line) => line !== "")
					.join("\n\n");
				const existing = auth.squad.members.get(label);
				const running = runningCount(auth.squad);
				const queued = existing?.running === undefined && config.maxRunning > 0 && running >= config.maxRunning;
				const r = existing
					? updateMember(auth.squad, label, {
							role,
							task,
							worktree: target.worktree,
							model,
							provider: config.provider,
							modelFromRole: true,
							...(queued ? { status: "排队" } : {}),
						})
					: addMember(state, auth.squad, {
							label,
							role,
							task,
							worktree: target.worktree,
							model,
							provider: config.provider,
							modelFromRole: true,
							queued,
						});
				if (!r.ok) return { text: `[失败] ${r.detail}` };
				r.member.reviews = target.label;
				if (queued) {
					persistSquad(auth.squad);
					return { text: `已把「审「${target.label}」」排进队里（现在 ${running} 个在跑，上限 ${config.maxRunning}）——有人收工自动补位。` };
				}
				const started = startMember(auth.squad, r.member, { provider: config.provider, model });
				if (!started.ok) return { text: `[失败] ${started.detail}` };
				persistSquad(auth.squad);
				return {
					text: `已派「${r.member.label}」（审查）去审「${target.label}」，用 ${config.provider}/${model}，后台跑着。\n结论出来后会挂到「${target.label}」那一行（\`squad_status\` 看得到「已被 ${r.member.label} 审」）。`,
				};
			},
		}),
	);

	disposers.push(
		ctx.tools.register({
			name: "squad_stop",
			description:
				"停掉**一个**成员（不连坐整队）：掐掉它正在跑的那一次，状态判「卡住」并把它说的原因写进结论栏；" +
				"同队其他人**不受影响**，排队的人会照常补位（并发位子**当场**腾出来，不用等它收尾）。" +
				"「等待中」「排队中」的成员也停得掉；**等它的那些成员会被叫醒**（对它们来说「卡住」就是收工了），" +
				"所以停一个可能顺带点火一个 —— 要的是「都别动」就用 `squad_close`。" +
				"要收整队用 `squad_close`；要给已收工的成员加话用 `squad_say` / `squad_send`。",
			parameters: toParameterSchema({
				squad: { type: "string", required: true, description: "小队名。" },
				member: { type: "string", required: true, description: "要停哪个成员。" },
				reason: { type: "string", description: "为什么停它（会写进它的结论栏）。" },
			}),
			output: text(),
			async execute(args, exec) {
				const auth = authorize(state, actorOf(exec).id, args?.squad);
				if (!auth.ok) return { text: `[失败] ${auth.detail}` };
				if (auth.squad.closed) return { text: `[失败] ${closedDetail(auth.squad)}` };
				const label = String(args?.member ?? "").replace(/\s+/g, " ").trim();
				const member = auth.squad.members.get(label);
				if (!member) {
					const names = [...auth.squad.members.keys()];
					return { text: `[失败] 「${auth.squad.name}」里没有成员「${label}」${names.length > 0 ? `（有：${names.join(" / ")}）` : ""}` };
				}
				// 在「等待」的成员没有 running（它被掐停着等别人）—— 但它照样要停得掉，
				// 否则它只能干等着那个目标收工（用户第一反应就是来按这个按钮）。
				// ⚠️ 判据要**带上 waitingFor**：只看 `status === "等待"` 的话，「在跑 + 挂着
				// waitingFor」这种状态会掉进下面那条 abort 分支 —— abort 之后收尾又按「等别人」
				// 收场，把停掉**静默撤销**（终态回「等待」，而那句停因没人消费），被等者一收工它自己
				// 又跑起来。所以两种状态一起停；至于停因写不写进 `roundEnd`，见下面那条 ——
				// 只有**有 running** 的才写（那条分支的 `.then` 会消费它）。
				const why = String(args?.reason ?? "").trim();
				const waiting = member.status === "等待" && typeof member.waitingFor === "string";
				// 「排队」也得停得掉：它没 running 也没 waitingFor，但 `drainQueue` 之后照样会把它
				// 点着（独立测实测 attempts=1）—— 主 agent 说停就是要停。
				const queued = member.status === "排队";
				if (!member.running && !waiting && !queued) {
					return { text: `「${member.label}」现在没在跑（状态：${member.status}）。要改状态用 \`squad_update\`。` };
				}
				const stopText = why === "" ? "被 squad_stop 停掉" : `被 squad_stop 停掉：${why}`;
				// `roundEnd` 只给**有 running** 的那种写：它会被本轮 `.then` 消费（原因优先）；
				// 「等待中/排队」这两条没有 promise 在跑，写了没人消费，只会留个脏字段 —— 所以要**清**
				// （可能留着上一轮等来的那句 waiting）。但 `note`（成员身上那句持久的结论）**两条都要写**。
				member.roundEnd = member.running ? { kind: "stopped", reason: stopText, at: Date.now() } : undefined;
				member.note = waiting ? `${stopText}（它本来在等别人）` : stopText;
				member.waitingFor = undefined;
				// 只掐它一个：整队那把是 `abortMembers`（会话销毁/收队/插件拆除用），这里不能用。
				// 打上 `aborted` 才算「位子腾出来了」：`runningCount` 不数它、`startMember` 放行重派 ——
				// 否则流不认 abort 时这个成员既不能重派、又永久占着并发位（独立测实测）。
				if (member.running) {
					member.running.aborted = true;
					member.running.abort.abort();
				}
				member.status = "卡住";
				member.updatedAt = Date.now();
				persistSquad(auth.squad);
				if ((waiting || queued) && !member.running) {
					// 这两条本来就没在跑，位子当场就空出来了（「在跑」那种要等 finally 才补位）
					drainQueue(auth.squad);
					return {
						text: waiting
							? `已停掉「${member.label}」（它本来在等别人收工）—— 它不会再被叫醒了。`
							: `已停掉「${member.label}」（它本来排着队）—— 它不会被点着了。`,
					};
				}
				// 掐掉一个就等于空出一个位子（`runningCount` 不数被掐的）—— 立刻补位
				drainQueue(auth.squad);
				return { text: `已停掉「${member.label}」（${auth.squad.name}）—— 同队其他人不受影响。它判「卡住」，结论栏写了原因。` };
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
				// 用 `runningCount`：它不数被 `squad_stop` 掐掉的那些 —— 那些已经停了，
				// 收队不该把它们再算进「掐掉了 N 个」里
				const running = runningCount(auth.squad);
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
			`小队：开  （10 个工具：new / spawn / update / board / status / close / send / say / stop / review；成员 ${config.provider}/${config.model}，最多 ${config.maxSteps} 步，重试 ${config.retries} 次，单次上限 ${config.memberTimeoutMinutes} 分钟${store ? "，落盘" : "，不落盘"}；面板${routes > 0 ? "已挂" : "未挂"}）`,
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
