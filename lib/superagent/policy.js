/**
 * Superagent 的 Policy：**谁能让 agent 干活**。
 *
 * 移植自 `dsh-superagent-prototype/src/core/model.ts` 的 `Decision` 语义
 * （`ignore | accept | reopen | stop | unavailable`），但只保留单 Source（GitHub）
 * 需要的那部分 —— 上游为「GitHub + 飞书 + 多线程 + 人机协作」设计，这里不要那层。
 *
 * ## 三条设计原则（都来自 2026-11-08 的计划审查）
 *
 * 1. **fail-closed**：策略为空 = 谁都不能触发。默认配置必须是「什么都不干」，
 *    而不是「什么都能干」—— 这个组件会给一个 danger-full-access 的会话喂 prompt，
 *    而 prompt 来自 issue 正文，是不可信输入。
 * 2. **显式触发词**：不是每条评论都算任务。授权人说一句「LGTM」不该起一个会话，
 *    更不该动代码。只有正文里出现触发词（默认 `/agent`）才进候选。
 * 3. **纯函数**：不碰网络、不碰磁盘、不看时钟。输入输出都是普通对象，
 *    所以能被单测、能被回放、能在面板里「试算」而不产生副作用。
 *
 * @module dsh-team-workflow/superagent/policy
 */

/** 默认触发词。可被 `policy.trigger` 覆盖。 */
export const DEFAULT_TRIGGER = "/agent";

/** 这些 `author_association` 才算「仓库成员」。`CONTRIBUTOR` / `NONE` 不算。 */
export const TRUSTED_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

/** 停机词：出现它就结束当前 Ticket，而不是开新的。 */
export const STOP_WORD = "/agent stop";

/**
 * 判定结果。
 *
 * `reason` 是给人看的，也是写进审计日志的那一句 —— 判定被拒时**必须能解释为什么**，
 * 否则面板上「为什么这条没跑」就无从查起。
 *
 * @typedef {object} Decision
 * @property {"ignore" | "accept" | "reopen" | "stop" | "unavailable"} kind
 * @property {string} reason
 */

/**
 * 一条待判定的事件（GitHub 评论）。字段名对齐 `gh api` 的返回，少做一层映射。
 *
 * @typedef {object} CommentEvent
 * @property {string} repo             `owner/name`
 * @property {number} issueNumber
 * @property {string} commentId        幂等键：同一条评论只处理一次
 * @property {string} author           GitHub login
 * @property {string} authorAssociation `OWNER` / `MEMBER` / `COLLABORATOR` / `CONTRIBUTOR` / `NONE`
 * @property {string} body
 */

/**
 * @typedef {object} Policy
 * @property {string[]} [repos]        允许的 `owner/name` 列表；空 = 全拒
 * @property {string[]} [actors]       允许的 GitHub login 列表；空 = 全拒
 * @property {string} [trigger]        触发词，默认 `/agent`
 * @property {"off" | "observe" | "auto"} [acceptMode]
 *   `off` 全停；`observe` 只记账不执行；`auto` 真执行。默认 `off`。
 */

/** @returns {Policy} 规范化后的策略；未知字段丢弃，缺省值补齐。 */
export function normalizePolicy(raw) {
	const value = raw !== null && typeof raw === "object" ? raw : {};
	const list = (input) =>
		Array.isArray(input) ? input.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
	const mode = ["off", "observe", "auto"].includes(value.acceptMode) ? value.acceptMode : "off";
	return {
		repos: list(value.repos),
		actors: list(value.actors),
		trigger: typeof value.trigger === "string" && value.trigger.trim() !== "" ? value.trigger.trim() : DEFAULT_TRIGGER,
		acceptMode: mode,
	};
}

/** 正文里是否出现触发词（按词边界，避免 `/agentic` 误命中）。 */
function hasTrigger(body, trigger) {
	if (typeof body !== "string" || body === "") return false;
	// 转义正则元字符：触发词是配置项，可能是 `/run` 这种带斜杠的
	const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// 前后不能紧邻标识符字符 —— `/agent` 要命中「/agent 修一下」，不命中「/agentic」
	return new RegExp(`(^|[^\\w/-])${escaped}(?![\\w-])`, "m").test(body);
}

/** 正文里是否要求停机（触发词 + `stop`）。 */
function isStop(body, trigger) {
	if (typeof body !== "string" || body === "") return false;
	const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w/-])${escaped}\\s+stop\\b`, "i").test(body);
}

/**
 * 判定一条评论该不该触发工作。
 *
 * 顺序即优先级，前面的先拒：
 * `acceptMode` → 仓库 → 作者 → 触发词 → 停机词 → 接受。
 *
 * **为什么不看 `createdAt`**：游标推进是 Source 的事（评论 id 高水位），
 * Policy 只看「这条能不能干」。把时间判断混进来会让纯函数依赖时钟，没法回放。
 *
 * @param {CommentEvent} event
 * @param {Policy} policy 已经过 {@link normalizePolicy} 的策略
 * @returns {Decision}
 */
export function decide(event, policy) {
	const p = normalizePolicy(policy);
	const e = event !== null && typeof event === "object" ? event : {};

	if (p.acceptMode === "off") {
		return { kind: "unavailable", reason: "策略未启用（acceptMode=off）：谁都不能触发" };
	}
	if (typeof e.repo !== "string" || !p.repos.includes(e.repo)) {
		return { kind: "ignore", reason: `仓库不在白名单：${e.repo ?? "(缺失)"}` };
	}
	if (typeof e.author !== "string" || e.author === "") {
		return { kind: "ignore", reason: "作者缺失" };
	}
	// 两道都要过：login 在白名单 **且** 是仓库成员。
	// 只看 login 的话，名单里某人被移出组织后仍然能触发；
	// 只看 association 的话，任何一个 MEMBER 都能触发（范围太大）。
	if (!p.actors.includes(e.author)) {
		return { kind: "ignore", reason: `作者不在名单：${e.author}` };
	}
	if (!TRUSTED_ASSOCIATIONS.includes(e.authorAssociation)) {
		return { kind: "ignore", reason: `作者不是仓库成员：${e.author} (${e.authorAssociation ?? "NONE"})` };
	}
	if (isStop(e.body, p.trigger)) {
		return { kind: "stop", reason: `${e.author} 要求停机` };
	}
	if (!hasTrigger(e.body, p.trigger)) {
		return { kind: "ignore", reason: `没有触发词 ${p.trigger}（普通评论不当任务）` };
	}
	return { kind: "accept", reason: `${e.author} 在 ${e.repo}#${e.issueNumber} 触发` };
}

/**
 * 把触发词之后的正文切出来，作为交给 agent 的任务描述。
 *
 * 只取**第一次**出现触发词之后的部分：正文里可能引用了别人的 `/agent`（引用块），
 * 那种不该被当成本次任务。
 *
 * @param {string} body
 * @param {string} trigger
 * @returns {string} 去掉触发词与首尾空白的任务描述；找不到返回空串
 */
export function extractInstruction(body, trigger = DEFAULT_TRIGGER) {
	if (typeof body !== "string") return "";
	const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|[^\\w/-])${escaped}(?![\\w-])\\s*`, "m").exec(body);
	if (!match) return "";
	return body.slice(match.index + match[0].length).trim();
}
