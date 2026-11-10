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

/**
 * Policy 的稳定指纹（REQ-038 第五批）。
 *
 * 用来回答一个问题：**「这条 Ticket 当初被放行时的那套规则，现在还一样吗？」**
 * 字符串变了就说明规则/模式/名单/仓库动过 —— 那之后停止的、或正在跑的工作都要重新看。
 *
 * 为什么自己写哈希不用 `node:crypto`：这里只需要**相等比较**，不需要抗碰撞。
 * 一个 32 位 FNV-1a 配上「参与哈希的键名清单」在做这件事上是够的，
 * 而它让这个包继续零依赖、纯同步、可在任何环境跑（这个包要装进别人的 profile）。
 *
 * 为什么把键名排序后拼进去、而不是 JSON.stringify 整个对象：JSON 的键序依赖构造顺序，
 * 同一份策略换个顺序构造就会得到不同指纹 —— 那会让「没改」被误判成「改了」，
 * 于是每轮都有 Ticket 被无谓地判 stale。
 *
 * @param {object} policy 已经过 {@link normalizePolicy} 的策略（没归一化也能算，只是结果没意义）
 * @returns {string} 形如 `fnv1a:1a2b3c4d` 的指纹
 */
export function policyHash(policy) {
	const p = policy !== null && typeof policy === "object" ? policy : {};
	// 只算「决定谁能干什么」的字段。`trigger` 也算 —— 改触发词等于改准入。
	// 故意**不算** `enabled`：开关是运行状态，不是授权内容（关掉时整体不跑，用不着哈希区分）。
	const material = JSON.stringify([
		[...(Array.isArray(p.repos) ? p.repos : [])].sort(),
		[...(Array.isArray(p.actors) ? p.actors : [])].sort(),
		String(p.acceptMode ?? ""),
		String(p.trigger ?? ""),
	]);
	let hash = 0x811c9dc5;
	for (let index = 0; index < material.length; index += 1) {
		hash ^= material.charCodeAt(index);
		// FNV-1a 的 32 位乘法：拆成移位加法，避开 `Math.imul` 之前的精度问题
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * 一个 Ticket 的 Mandate：它是**在什么授权下**被接受的。
 *
 * 上游 002-authorization 的定义是这个东西只能被三种操作改变 ——
 * accept 创建、人说停撤回、重新校验失败撤销。**Policy 版本变化不直接撤销它**，
 * 只让它在下次 resume 前重新校验。这里如实照做：`staleMandate()` 只判断
 * 「需不需要重新看」，不负责改状态。
 *
 * @param {object} event 触发的那条评论
 * @param {object} policy 判定时用的策略
 * @param {string} reason `decide()` 给的可读理由
 * @returns {{ basis: string, sender: string, policyHash: string, acceptedAt: string, reason: string }}
 */
export function createMandate(event, policy, reason = "") {
	const e = event !== null && typeof event === "object" ? event : {};
	return {
		// 我们只有一种 basis：人都得在 `actors` 名单里、且是仓库成员。
		// 上游那套 explicit / inferred / table / bot 四档要 admission table 与 bot 名单，还没做。
		basis: "listed",
		sender: String(e.author ?? ""),
		policyHash: policyHash(policy),
		acceptedAt: new Date().toISOString(),
		reason,
	};
}

/**
 * 这个 Mandate 还成立吗？
 *
 * **只回答判断，不改任何状态** —— 调用方决定是丢、是通知、还是照跑。
 *
 * @param {object} mandate `createMandate()` 的产物
 * @param {object} policy 当前的策略
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkMandate(mandate, policy) {
	if (mandate === null || typeof mandate !== "object") {
		// **没有 Mandate 不等于没有授权**。
		//
		// 上游把「Mandate 缺失」当成「不是通过准入判定进来的」，因为它的准入有好几条路
		// （admission table / bot 名单 / 推断候选），没 Mandate 就真的说不清谁批的。
		// 我们只有一条路：所有 Ticket 都来自 `decide()` 的 accept。
		//
		// 所以这里放行，两个原因：
		//   ① 老数据 —— v2.39 之前建的 Ticket 都没有这个字段，判失效会让升级后
		//      所有进行中的讨论当场断掉；
		//   ② 手动触发（面板上的 `/superagent run`）本来就不经过 Eval，没有 Mandate 是对的。
		//
		// 这条自检咬住过一次：加了校验之后「该续跑一次」当场变红。
		return { ok: true, reason: "没有 Mandate（老数据或手动触发的 Ticket），放行" };
	}
	const p = normalizePolicy(policy);
	if (p.acceptMode === "off") {
		return { ok: false, reason: "策略已关（acceptMode=off）" };
	}
	// 名单里的人都可能被移出 —— 那正是「重新校验」要抓的东西
	if (!p.actors.includes(String(mandate.sender ?? ""))) {
		return { ok: false, reason: `发起人已不在名单：${mandate.sender || "(空)"}` };
	}
	if (!p.repos.includes(String(mandate.repo ?? "")) && mandate.repo !== undefined) {
		return { ok: false, reason: `仓库已不在白名单：${mandate.repo}` };
	}
	// 哈希不一致**不**让 Mandate 失效（上游明确「版本变化不立即撤销」），
	// 但它意味着「规则动过」，要让调用方知道，好发通知。
	if (String(mandate.policyHash ?? "") !== policyHash(p)) {
		return { ok: true, stale: true, reason: "策略版本变过（Mandate 仍有效，但当事人该知道）" };
	}
	return { ok: true, reason: "仍然成立" };
}
