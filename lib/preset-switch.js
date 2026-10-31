/**
 * 会话级「换模式」（REQ-030 方案 B：换模式并继续）。
 *
 * 为什么不是原地换：宿主 `AgentPresetRegistry.select()` 在会话已经开始过之后直接抛
 * `agent-preset/locked`（`dsh-agent-preset-registry/lib/index.js:753-770`）——
 * preset 决定工具面与 persona，中途换会让同一份 transcript 的前后两半属于两套工具。
 * fork 出来的会话继承 `turnBoundary.lastTurn > 0`，同样被拒。
 *
 * 所以「换模式」= 开一个新会话（`create` 是**唯一**能带 `agentPreset` 的入口，
 * `dsh-api-session-controller/lib/index.js:693-703`），把旧会话的事实写成一份交接，
 * 预填进新会话的输入框，**由用户按发送**（不自动开跑），然后归档旧会话。
 *
 * 预填而不是自动发送：交接里可能含敏感内容（凭据、靶标），自动跑等于替用户按下回车；
 * 也避免"换模式"被误当成"让新会话立刻开工"。
 */
import * as rewind from "./purge/rewind.js";

const service = (ctx, name) => {
	try {
		return ctx?.get?.(name) ?? ctx?.[name];
	} catch {
		return undefined;
	}
};

const errorText = (error) => String(error?.message ?? error ?? "未知错误");

/**
 * 列出可切换的模式。
 *
 * @returns {Promise<Array<{id: string, name: string, description: string, isDefault: boolean}>>}
 */
export async function listPresets(ctx) {
	const presets = service(ctx, "agentPresets");
	if (!presets || typeof presets.list !== "function") return [];
	try {
		const rows = await presets.list();
		return (Array.isArray(rows) ? rows : []).map((row) => {
			const value = row?.config ?? row?.definition?.config ?? row;
			return {
				id: String(value?.id ?? ""),
				name: String(value?.name ?? value?.id ?? ""),
				description: String(value?.description ?? ""),
				isDefault: value?.isDefault === true || value?.default === true,
			};
		}).filter((row) => row.id);
	} catch {
		return [];
	}
}

/** 取会话当前模式（读投影；读不到就空串）。 */
export async function currentPresetOf(ctx, sessionId) {
	const controller = service(ctx, "sessionController");
	try {
		const info = await controller?.inspect?.(sessionId);
		return String(info?.agentPreset ?? info?.preset ?? "");
	} catch {
		return "";
	}
}

/** 一条事件的纯文本（只取 text 块，工具调用不算）。 */
function textOfEvent(event) {
	const data = event?.data;
	const content = data?.content ?? data?.message?.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") parts.push(block);
		else if (block && (block.type === "text" || typeof block.text === "string")) parts.push(String(block.text ?? ""));
	}
	return parts.join("\n").trim();
}

/** 人打的用户消息（插件注入的润色稿不算）。 */
function isHumanUser(event) {
	if (event?.type !== "user/message") return false;
	const kind = event?.data?.source?.kind;
	if (kind && kind !== "user") return false;
	return textOfEvent(event) !== "";
}

const clip = (text, max) => {
	const value = String(text ?? "").trim();
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n…（已截断，原文 ${value.length} 字符）`;
};

/**
 * 写交接：最近几轮人打的请求 + 最后一条助手结论 + 换模式的事实。
 *
 * 刻意**不**搬全量 transcript：那等于把旧会话整份塞进新会话，token 直接翻倍；
 * 交接要的是「接着干什么」，不是「之前聊过什么」。
 */
export function buildHandoff({ events, fromPreset, toPreset, sourceSessionId, limit = 6 }) {
	const list = Array.isArray(events) ? events : [];
	const requests = [];
	for (let i = list.length - 1; i >= 0 && requests.length < limit; i -= 1) {
		if (isHumanUser(list[i])) requests.unshift(clip(textOfEvent(list[i]), 600));
	}
	let lastAssistant = "";
	for (let i = list.length - 1; i >= 0; i -= 1) {
		if (list[i]?.type === "assistant/message") {
			lastAssistant = clip(textOfEvent(list[i]), 1200);
			if (lastAssistant) break;
		}
	}

	const lines = [
		"（换模式交接 · 由 dsh-team-workflow 生成）",
		"",
		`上一个会话：${sourceSessionId}`,
		`模式：${fromPreset || "(未知)"} → ${toPreset}`,
		"",
		"## 之前提过的请求（由旧到新）",
	];
	if (requests.length === 0) lines.push("（旧会话里没有人打的请求）");
	else for (const [index, text] of requests.entries()) lines.push(`${index + 1}. ${text}`);

	lines.push("", "## 上一步的结论");
	lines.push(lastAssistant || "（旧会话没有留下助手结论）");
	lines.push(
		"",
		"## 接着做",
		"按上面最后一条请求继续；不确定就先说要做什么再动手，不要重复已经完成的步骤。",
	);
	return lines.join("\n");
}

/**
 * 换模式：新建（带新 preset）→ 交接预填 → 归档旧会话。
 *
 * @returns {Promise<{ok: boolean, sessionId?: string, parentId?: string, preset?: string, text?: string, archived?: boolean, error?: string}>}
 */
export async function switchSessionPreset(ctx, { sessionId, presetId } = {}) {
	if (!sessionId) return { ok: false, error: "没有当前会话" };
	const wanted = String(presetId ?? "").trim();
	if (!wanted) return { ok: false, error: "没有指定模式 id" };

	const controller = service(ctx, "sessionController");
	if (!controller || typeof controller.create !== "function") {
		return { ok: false, error: "当前 dsh 没有会话创建接口（sessionController.create）" };
	}
	const presets = service(ctx, "agentPresets");
	if (!presets || typeof presets.resolve !== "function") {
		return { ok: false, error: "当前 dsh 没有预设服务（agentPresets），换模式无从谈起" };
	}

	let resolved;
	try {
		resolved = String((await presets.resolve(wanted)).id ?? wanted);
	} catch (error) {
		return { ok: false, error: `模式 "${wanted}" 不存在：${errorText(error)}` };
	}

	let log;
	try {
		log = await rewind.readSessionLog(ctx, sessionId);
	} catch (error) {
		return { ok: false, error: `读不到会话 ${sessionId}：${errorText(error)}` };
	}

	const fromPreset = await currentPresetOf(ctx, sessionId);
	if (fromPreset === resolved) return { ok: false, error: `已经是「${resolved}」模式，不用换` };

	let created;
	try {
		// inspect 只为拿 workspaceId / cwd（新会话要落同一个地方）。拿不到就走 cwd 兜底。
		let info = null;
		try {
			info = await controller.inspect?.(sessionId);
		} catch {
			info = null;
		}
		const workspaceId = info?.workspaceId ?? info?.workspace?.id;
		const cwd = info?.cwd ?? log?.cwd;
		// 落点：同一个工作区优先，其次同一个 cwd —— 换模式不该把会话搬到别处。
		const request = { agentPreset: resolved };
		if (workspaceId) request.workspaceId = workspaceId;
		else if (cwd) request.cwd = cwd;
		created = await controller.create(request);
	} catch (error) {
		return { ok: false, error: `新会话建不起来：${errorText(error)}` };
	}

	const childId = created?.sessionId ?? "";
	if (!childId) return { ok: false, error: "新会话没有返回 sessionId" };

	const text = buildHandoff({
		events: log?.events,
		fromPreset,
		toPreset: resolved,
		sourceSessionId: sessionId,
	});
	// 预填到新会话输入框：用户按发送才开跑（理由见文件头）。
	rewind.rememberDraft(childId, text, sessionId);

	let archived = false;
	try {
		archived = await rewind.hideRewoundSource(ctx, sessionId);
	} catch {
		/* 旧会话没归档住不挡新会话使用 */
	}

	return {
		ok: true,
		sessionId: childId,
		parentId: sessionId,
		preset: String(created?.agentPreset ?? resolved),
		text,
		archived,
	};
}
