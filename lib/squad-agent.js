/**
 * 跑一个成员 —— 在一个**普通 dsh 根会话**里跑（REQ-025）。
 *
 * ── 为什么不再自己驱动 ──────────────────────────────────────────────────────
 * 2.0～2.6 成员是「小队自己发模型请求、自己执行工具」（`lib/squad-loop.js` +
 * `lib/squad-tools.js`）。代价是**没有审批通道、没有会话、不进列表**，而且 bash 走的是
 * 我们自己拼的沙箱策略 —— 2026-10-18 起成员跑 `echo hi` 直接 `STATUS_DLL_INIT_FAILED`，
 * 一路红到 REQ-025。
 *
 * 现在换成宿主的原生路径：建一个根会话（`ctx.agents.create`），权限钉在那个会话上，
 * 任务用 `followup` 投进去，等 `whenIdle()`。命令能不能跑、跑在什么档位上，全都由宿主
 * 自己那套负责 —— 这正是修那把钥匙的地方。
 *
 * ── 形状照抄调度器（`lib/scheduler.js:991-1201`）────────────────────────────
 * 建会话 / setup 钉权限并**回读核对** / 投消息 / `whenIdle` 与超时 race / `flush` + `dispose`
 * 逐条同形，连「`pinned` 是正向确认、不是『没记下错』」那条也一起搬过来了。差别只有三处：
 *   1. `cwd` 钉在**成员的 worktree**（调度器钉在任务的工作区）；
 *   2. 权限档从**小队所属会话**取（`squad.owner`），绝不写死 —— 写死 danger-full-access
 *      就是提权，仓库明令禁止；
 *   3. 多一步 `restrict` + 作用域注册（见下）。
 *
 * ── 工具面 ──────────────────────────────────────────────────────────────────
 * 成员拿到的是**宿主的** fs / bash / web 工具（按它的 preset），加上我们作用域注册的
 * `board` / `check` / `say` / `wait` 四个。这四个用 `agentCtx.tools.register` 注册进
 * **这个 agent 自己的层**，身份由闭包给 —— 所以不需要放宽 `authorize`，成员也只能动
 * 自己那一份。反过来 `squad_*` 十个必须 `restrict` 掉：本包是根 ctx 插件，那些工具在
 * **全局层**，任何 preset 的 agent 都看得见，不掐掉成员就能递归建队。
 */
import { randomUUID } from "node:crypto";
import { makeHostLoader } from "./dsh-exports.js";
import {
	decideRunOutcome,
	lastSandboxMode,
	normalizeTurnStartTimeout,
	summarizeEvents,
	waitForTurnStart,
} from "./scheduler.js";
import { addUsage } from "./squad-loop.js";
import { MEMBER_TOOLS, runMemberTool } from "./squad-tools.js";

/**
 * 成员**不许**看见的小队工具（全局注册，任何 preset 都看得见）。
 *
 * 全部十个都掐掉，不只是 `squad_new/spawn/close` 那三个：其余七个都要 `authorize`，
 * 而成员会话不是小队所有者 —— 留着只会让模型调到一个必然报「没有小队」的工具，
 * 白烧一轮。成员要写黑板 / 勾验收走的是下面作用域注册的 `board` / `check`。
 */
export const MEMBER_DENY_TOOLS = [
	"squad_new",
	"squad_spawn",
	"squad_close",
	"squad_update",
	"squad_board",
	"squad_status",
	"squad_send",
	"squad_say",
	"squad_stop",
	"squad_review",
];

/** 作用域注册给成员的那几个（名字与 `lib/squad-tools.js` 的 `MEMBER_TOOLS` 一致）。 */
export const MEMBER_SCOPED_TOOLS = ["board", "check", "say", "wait"];

const MINUTE_MS = 60 * 1000;

/**
 * 成员那段 system 提示排在哪：紧跟在部署 persona 之后（`DEPLOYMENT_PERSONA_SUFFIX: 10200`）。
 * 再往后是 agent instructions / skills 那些 —— 小队规矩属于「这个 agent 是谁」的一部分，
 * 排在它们前面读起来才对。
 */
const MEMBER_PROMPT_ORDER = 10201;

/** 工具返回值的输出形状（与 `lib/squad.js` 的 `text()` 逐字同形，宿主注册表会校验它）。 */
const textOutput = () => ({
	schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
	render: (_args, value) => [{ type: "text", text: value.text }],
});

/** 一条消息的纯文本（`user/message` 的 data 本身就是消息，`assistant/message` 的在 `data.message`）。 */
function contentText(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function contentCalls(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((block) => block?.type === "tool-call")
		.map((block) => ({ id: block.id, name: block.name }));
}

/**
 * 会话事件 → 面板与 `squad_send` 要的那种转录（`{role, text, …}`）。
 *
 * **只认宿主真有的那几种事件**（`SessionEventMap`，2026-10-19 对着
 * `dsh-agent-preset-registry/lib/typert.host.js:745` 抄的）：
 * `user/message` 的 data 是消息本身，`assistant/message` / `tool/result` 的 data 是
 * `{turn, step, message}`，工具名要靠 `tool/call` 先记下来。
 * 认不出来的事件直接跳过 —— 转录是给人看的，不是日志的镜像。
 */
export function transcriptFromEvents(events) {
	const out = [];
	const nameOfCall = new Map();
	for (const event of events ?? []) {
		const type = event?.type;
		if (type === "user/message") {
			const text = contentText(event.data);
			if (text.trim() !== "") out.push({ role: "user", text });
			continue;
		}
		if (type === "assistant/message") {
			const message = event.data?.message;
			out.push({
				role: "assistant",
				text: contentText(message),
				calls: contentCalls(message),
				step: event.data?.step,
			});
			continue;
		}
		if (type === "tool/call") {
			nameOfCall.set(event.data?.callId, event.data?.name);
			continue;
		}
		if (type === "tool/result") {
			out.push({
				role: "tool",
				name: nameOfCall.get(event.data?.message?.toolCallId),
				text: contentText(event.data?.message),
				isError: event.data?.error !== undefined,
				step: event.data?.step,
			});
		}
	}
	return out;
}

/**
 * 建一个「跑成员」的入口。
 *
 * 依赖 `scope` 上已注入的：`agents` / `sessions` / `agentPresets`。`scope` 就是本插件的
 * 根 ctx（与 `lib/scheduler.js` 的 `createExecutor` 同一个意思）。
 *
 * @param {object} options
 * @param {object} options.scope 根 ctx
 * @param {object} options.config 小队配置（`memberTimeoutMinutes` 用它）
 * @param {(msg: string) => void} [options.log]
 * @param {(input: {squad: object, member: object, bashMode?: string, toolNames?: string[]}) => string} options.memberPrompt
 *   成员的 system 提示生成器（`lib/squad.js` 的 `memberSystemPrompt`）。注入而不是 import：
 *   两个文件互相 import 会成环。
 */
export function createMemberRunner({ scope, config, log = () => {}, memberPrompt }) {
	const host = makeHostLoader(scope);
	/** 懒加载的动态模块：`@deepseek-ai/*` 从本包解析不到，只能走 loader（从 profile 解析）。 */
	let runtime;

	async function modules() {
		if (runtime !== undefined) return runtime;
		const [llm, approval, sandbox] = await Promise.all([
			host.load("@deepseek-ai/dsh-llm", ["createUserMessage"]),
			host.load("@deepseek-ai/dsh-user-approval", ["setApprovalPolicy"]),
			host.load("@deepseek-ai/dsh-sandbox-policy", ["setSandboxMode"]),
		]);
		const { createUserMessage } = llm;
		const { setApprovalPolicy } = approval;
		const { setSandboxMode } = sandbox;
		if (typeof createUserMessage !== "function") throw new Error("SQUAD_RUNTIME_EXPORT_MISSING: createUserMessage");
		if (typeof setApprovalPolicy !== "function") throw new Error("SQUAD_RUNTIME_EXPORT_MISSING: setApprovalPolicy");
		if (typeof setSandboxMode !== "function") throw new Error("SQUAD_RUNTIME_EXPORT_MISSING: setSandboxMode");
		runtime = { createUserMessage, setApprovalPolicy, setSandboxMode };
		return runtime;
	}

	/**
	 * 服务一律走 `scope.get(name)`。
	 *
	 * **不能写 `scope.agents`**：cordis 的 ctx 是访问器代理，没声明 inject 的服务读一下
	 * 就抛 `cannot get property "…" without inject`，而 `agents` / `agentPresets` 都不在
	 * 本插件顶层的 inject 里（见 `lib/index.js` 那段注释：写进去会让整个插件静默不激活）。
	 */
	const agents = () => scope.get?.("agents");
	const sessions = () => scope.get?.("sessions");
	const agentPresets = () => scope.get?.("agentPresets");

	/**
	 * 小队所属会话（`squad.owner` 就是创建它的那个会话 id）。
	 *
	 * **权限与 preset 都从这里取** —— REQ-025 的硬约束：写死档位就是提权。
	 * 会话已经被销毁时返回 undefined，由调用方 fail-closed。
	 */
	function ownerSessionOf(squad) {
		try {
			return sessions()?.get?.(squad.owner) ?? agents()?.get?.(squad.owner)?.session;
		} catch {
			return undefined;
		}
	}

	/**
	 * 成员该跑在哪个沙箱档位上 = **所属会话生效中的那一档**。
	 *
	 * 两条读法，任一成功即可（与 `lib/scheduler.js` 的 `readPinnedMode` 同一套理由：
	 * 不把「事件在不在日志里」赌成单点）：
	 *   1. `sandboxPolicy.resolve({ session })` —— dsh 官方给的读法，连部署默认值一起算进去；
	 *   2. 会话日志里最后一条 `sandbox/mode`。
	 * 两条都读不到就 **read-only**：读不到档位时按最严的跑，绝不按最松的。
	 */
	function permissionOf(squad) {
		const session = ownerSessionOf(squad);
		try {
			const mode = scope.get?.("sandboxPolicy")?.resolve?.({ session })?.mode;
			if (typeof mode === "string" && mode !== "") return mode;
		} catch {
			/* 没 inject 的服务读一下就抛 —— 这只是第一条路 */
		}
		const fromLog = lastSandboxMode(session);
		return typeof fromLog === "string" && fromLog !== "" ? fromLog : "read-only";
	}

	/** 成员用哪个 preset = 所属会话用的那个（跟随用户配的合成，不自己发明）。 */
	function presetOf(squad) {
		const preset = ownerSessionOf(squad)?.header?.agentPreset;
		return typeof preset === "string" && preset !== "" ? preset : undefined;
	}

	/**
	 * 掐掉成员不该看见的工具，并按配置收窄工具面。
	 *
	 * 三件事合成**一次** `restrict`（多次调用会互相叠加，读起来还以为是三处独立配置）：
	 *   1. `deny` 十个 `squad_*` —— 不掐掉成员能递归建队；
	 *   2. `deny` `bash` / `pwsh` —— 配了 `sandbox.bash: false` 时（那是本包唯一真隔离的开关）；
	 *   3. `allow` 角色的白名单（`sandbox.roleTools`，REQ-016 A4）。
	 *
	 * `restrict` 对**不存在的全局工具名直接抛**，所以名字先拿 `schemas()` 过一遍 ——
	 * 宿主改一次工具名不该让所有成员起不来。`schemas()` 拿不到（假 ctx）时按原样传，
	 * 失败了才记一笔：这条是「不许递归建队」的护栏，不能悄悄没了。
	 */
	function restrictTools(agentCtx, { allowTools, bash }) {
		// 拿不到可见工具清单就**别建会话**：宿主的 `restrict` 对**任一**列表里的未知名字
		// 都直接抛（`dsh-tools/lib/index.js:3003-3004`），没法核对就没法保证护栏挂上了。
		// 2026-10-19 独立审查逮到的 P0：原来这里吞掉异常，于是 `restrict` 失败时成员
		// 照常开跑 —— 最坏是它能递归建队（`squad_*` 没被掐掉）。护栏挂不上就不许跑。
		const schemas = agentCtx?.tools?.schemas?.();
		if (!Array.isArray(schemas)) {
			throw new Error("拿不到工具清单（tools.schemas()），成员的护栏无法核对");
		}
		const known = new Set(schemas.map((s) => s.name));
		const keep = (name) => known.has(name);
		// deny 与 allow **都要**过滤：宿主对未知名字抛。deny 漏一个 = 护栏没了；
		// allow 多一个 = 直接抛。两种都不能发生，所以宁可丢掉认不出的名字。
		const deny = [...MEMBER_DENY_TOOLS, ...(bash === false ? ["bash", "pwsh"] : [])].filter(keep);
		const filter = {};
		if (deny.length > 0) filter.deny = deny;
		// 白名单是**收窄**：`[]` 是合法配置（这个角色一个工具都不给），不能当成「没配」。
		// 白名单里的名字按成员工具的**老名字**写（read / grep / board …），而宿主那边
		// 是 fs / fs-search 那套 —— 认不出来的名字直接丢掉，别拿它去 `restrict` 撞抛。
		if (Array.isArray(allowTools)) filter.allow = allowTools.filter(keep);
		// 一个都认不出来（deny 空 + 没配白名单）= 本来就没有要掐的东西，不必空 restrict
		// （宿主对空 filter 也抛）。
		if (filter.deny === undefined && filter.allow === undefined) return;
		// **不吞异常**：挂不上就让 `setup` 抛 → 本轮不执行（调用方已经把 setupError 备好了）。
		agentCtx.tools.restrict(filter);
	}

	/** 把 `board` / `check` / `say` / `wait` 注册进**这个成员自己的层**（身份由闭包给）。 */
	function registerMemberTools(agentCtx, env, allowTools) {
		for (const definition of MEMBER_TOOLS) {
			if (!MEMBER_SCOPED_TOOLS.includes(definition.name)) continue;
			// 作用域注册**不受 `restrict` 管**（那是设计：子 agent 的过滤不该削掉它自己
			// 回答问题的机械），所以角色白名单要在这里单独再过一遍 —— 否则配了
			// 「只读角色」的成员照样能写黑板/直投。
			if (Array.isArray(allowTools) && !allowTools.includes(definition.name)) continue;
			agentCtx.tools.register({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				output: textOutput(),
				execute: (args) => runMemberTool(definition.name, args ?? {}, env),
			});
		}
	}

	/**
	 * 把「你是谁、边界在哪、收工怎么写」写进成员的 system 提示（作用域注册，只对它自己）。
	 *
	 * 工具清单取 `schemas()` —— **限制与作用域注册之后**的那份，所以提示词里那个
	 * 「工具就 N 个」与模型真拿到的完全一致。取不到就不写工具那一行（`memberPrompt`
	 * 自己会回落到全部名单），不编一个数字出来。
	 */
	function registerMemberPrompt(agentCtx, squad, member, bashMode) {
		let toolNames;
		try {
			const schemas = agentCtx?.tools?.schemas?.();
			if (Array.isArray(schemas)) toolNames = schemas.map((s) => s.name);
		} catch {
			/* 拿不到就不给名单 */
		}
		let text;
		try {
			text = memberPrompt({ squad, member, bashMode, toolNames });
		} catch (err) {
			log(`成员「${member.label}」的 system 提示没生成出来：${err?.message ?? err}`);
			return;
		}
		if (typeof text !== "string" || text === "") return;
		try {
			agentCtx.systemPrompt.section({ name: "squad:member", order: MEMBER_PROMPT_ORDER, text });
		} catch (err) {
			log(`成员「${member.label}」的 system 提示没挂上：${err?.message ?? err}`);
		}
	}

	/**
	 * 跑一轮成员。**自己不抛** —— 任何失败都变成 `{status: "卡住", kind, reason}`。
	 *
	 * @param {object} options
	 * @param {object} options.squad
	 * @param {object} options.member
	 * @param {object} options.env 作用域工具的执行环境（`{worktree, ctx, signal, bashPolicy, board, wait, check, say}`）
	 * @param {string} options.task 投给成员的任务正文
	 * @param {string} [options.sessionId] 成员**已有**的会话 id（续聊时给；新建时留空，由这里发）
	 * @param {boolean} [options.resume] true = 接着 `sessionId` 那个已落盘的会话跑（`squad_send`）
	 * @param {string} [options.provider]
	 * @param {string} [options.model]
	 * @param {string[]} [options.allowTools] 角色白名单（`sandbox.roleTools`）；`undefined` = 不收窄
	 * @param {boolean} [options.bash] `sandbox.bash`；显式 `false` 时把 bash/pwsh 一起掐掉
	 * @param {AbortSignal} [options.signal] 外部中止（`squad_stop` / 收队 / 会话销毁）
	 * @returns {Promise<{status: "完成"|"卡住", kind: string, reason: string, steps: number, usage: object, transcript: object[], created: boolean, sessionId: string|undefined}>}
	 *   `created` 是「会话真的建/续上了」—— 调用方只在这时才该记下 `sessionId`
	 *   （没建起来就记下来的话，下一轮会拿一个盘上不存在的 id 去 resume）。
	 */
	async function run({ squad, member, env, task, sessionId, resume = false, provider, model, allowTools, bash, budgetLeft, signal }) {
		let created;
		try {
			created = await modules();
		} catch (err) {
			return { status: "卡住", kind: "infra", reason: `拿不到宿主运行期导出：${err?.message ?? err}`, steps: 0, usage: {}, transcript: [], sessionId };
		}
		const { createUserMessage, setApprovalPolicy, setSandboxMode } = created;
		const permission = permissionOf(squad);
		const presetId = presetOf(squad);
		const selection = provider !== undefined && model !== undefined ? { provider, model } : undefined;

		let handle;
		/** setup 里出的错：`agents.create` 不一定透传 setup 的异常，所以自己留一份 */
		let setupError;
		/**
		 * 沙箱**确实**钉上了。判据是**正向**的：只有真的回读到档位一致才算数 ——
		 * 单看 `setupError === undefined` 放行是不够的（宿主漂移让 `setup` 压根没被调用时，
		 * 它也还是 undefined）。这一段与 `lib/scheduler.js:1008-1092` 逐条同形。
		 */
		let pinned = false;
		const setup = async (agentCtx, agentArg) => {
			const agent = agentArg ?? agentCtx?.agent;
			// preset 挂不上不致命（可能就是没装 standard），但要说一声
			try {
				await agentPresets()?.mount?.(agentCtx, presetId);
			} catch (err) {
				log(`成员「${member.label}」挂 preset「${presetId}」失败，按默认继续：${err?.message ?? err}`);
			}
			try {
				// ① 掐掉小队工具（否则成员能递归建队），再把成员自己的四个注册上。
				//    顺序要紧：`restrict` 只过滤**继承来的**工具，作用域注册不受它影响 ——
				//    反过来先注册也不会被误杀，但先掐后注册读起来更清楚。
				restrictTools(agentCtx, { allowTools, bash });
				registerMemberTools(agentCtx, env, allowTools);
				// ①b 成员的 system 提示。**必须走作用域注册**：成员现在是普通根会话，
				//     它那套「你是谁、边界在哪、收工怎么写」只有这里能说进去；
				//     塞进第一条 user 消息是能生效，但那是伪造用户说的话，转录里也分不出来。
				//     工具清单取**限制之后**的真实可见集 —— 提示词说有 N 个工具，就得真有 N 个。
				registerMemberPrompt(agentCtx, squad, member, permission);
				// ② 钉沙箱档位 —— 这是成员能干什么的唯一边界，必须在跑之前生效。
				//    用 setSandboxMode 而不是 permissionPresets.set：预设表是部署配置的
				//    （出厂只有 workspace-write / danger-full-access），`set()` 遇到表里没有的
				//    名字直接抛，而 read-only 恰恰不在出厂表里。沙箱模式本身是固定三值。
				setSandboxMode(agent.session, permission);
				const appliedMode = lastSandboxMode(agent.session) ?? readOverride(agent);
				if (appliedMode !== permission) {
					throw new Error(
						`沙箱档位回读不一致：应为 ${permission}，实际 ${appliedMode ?? "（会话日志里没有 sandbox/mode 事件，宿主 API 可能已漂移）"}`,
					);
				}
				// ③ 再强制无人值守审批：never。必须在 ② 之后 —— 顺序反了会被沙箱档位
				//    连带写入的 approval 覆盖回去。approval 静默不生效同样是致命的：
				//    它会让工具调用**永远卡着**等人点，而成员旁边没有人。
				setApprovalPolicy(agent.session, "never");
				const appliedApproval = readApproval(agent);
				if (appliedApproval !== "never") {
					throw new Error(
						`审批策略回读不一致：应为 never，实际 ${appliedApproval ?? "（会话日志里没有 approval/policy 事件）"}`,
					);
				}
				pinned = true;
			} catch (err) {
				setupError = `准备成员会话失败（沙箱档位「${permission}」/ 工具限制），本轮不执行：${err?.message ?? err}`;
				throw err;
			}
		};

		/** 沙箱档位的第二条读法（dsh 官方 API；不在 inject 里，拿不到就算了）。 */
		function readOverride(agent) {
			try {
				return scope.sandboxPolicy?.overrideOf?.(agent.session);
			} catch {
				return undefined;
			}
		}

		/** 审批策略的读法：会话日志里最后一条 `approval/policy`。 */
		function readApproval(agent) {
			const fromLog = lastPolicy(agent?.session);
			if (fromLog !== undefined) return fromLog;
			try {
				return scope.userApproval?.policyOf?.(agent.session);
			} catch {
				return undefined;
			}
		}

		// ── 建会话 / 续会话 ────────────────────────────────────────────────────
		// `withoutInitiator`：成员会话**不是**当前会话的子会话（REQ-025 §2：不做隐藏会话，
		// 但也不该被算成 delegation 子级）。调度器建会话走的是同一条。
		//
		// **续不上就换一个新 id 新建**，不能拿旧 id 再 create：会话已经落盘了，
		// `create` 会在 `persistence.create` 那里撞「id 已存在」。id 由这里发，
		// 调用方只负责把返回值记下来。
		let usedId = typeof sessionId === "string" && sessionId !== "" ? sessionId : `squad-${randomUUID()}`;
		const makeOptions = () => {
			const options = { setup };
			if (selection !== undefined) options.agentOptions = selection;
			return options;
		};
		const createFresh = () => {
			const meta = { cwd: member.worktree };
			if (presetId !== undefined) meta.agentPreset = presetId;
			return agents().withoutInitiator(() => agents().create({ sessionId: usedId, meta, ...makeOptions() }));
		};
		const resumeExisting = () =>
			agents().withoutInitiator(() => agents().resume({ resumeSessionId: usedId, ...makeOptions() }));

		try {
			if (resume === true && sessionId !== undefined) {
				try {
					handle = await resumeExisting();
				} catch (err) {
					// setup 自己抛的错不许被「续不上就新建」吃掉 —— 那是真错，新建也一样错。
					if (setupError !== undefined) throw err;
					log(`成员「${member.label}」续会话 ${usedId} 失败，改建新会话：${err?.message ?? err}`);
					usedId = `squad-${randomUUID()}`;
					handle = undefined;
				}
			}
			if (handle === undefined) handle = await createFresh();
		} catch (err) {
			return {
				status: "卡住",
				kind: "infra",
				reason: setupError ?? `创建成员会话失败：${err?.message ?? err}`,
				steps: 0,
				usage: {},
				transcript: [],
				created: false,
				sessionId: undefined,
			};
		}
		if (!pinned) {
			const reason = setupError ?? "setup 没有被调用（宿主 API 可能已漂移），沙箱档位未确认";
			await disposeHandle(handle);
			return { status: "卡住", kind: "infra", reason, steps: 0, usage: {}, transcript: [], created: false, sessionId: undefined };
		}
		const liveSessionId = usedId;

		const agent = handle.agent;
		const session = agent.session;
		let timedOut = false;
		let cancelConverged = true;
		let started = true;
		/**
		 * 步数护栏（`limits.maxSteps`）。
		 *
		 * 宿主**没有**步数上限 —— 自持 loop 时代那个 `maxSteps` 随 REQ-025 一起没了。
		 * 少了它，一个钻进死循环的成员会一直烧到墙钟超时（默认 20 分钟），
		 * 那是这个包唯一的「无界循环」防线，所以按会话事件自己数回来：
		 * 每来一条 `assistant/message` 就是一步，超了当场 `cancel`。
		 */
		let overSteps = false;
		let overBudget = false;
		let steps = 0;
		let runningUsage = {};
		const maxSteps = config.maxSteps;
		const offEvent = scope.on?.("session/event", (eventSession, event) => {
			if (eventSession?.id !== session?.id || event?.type !== "assistant/message") return;
			steps += 1;
			if (Number.isFinite(maxSteps) && maxSteps > 0 && steps > maxSteps) {
				overSteps = true;
				cancel("squad member max-steps");
				return;
			}
			// token 预算（A2）：宿主没有「步边界」给我们插，所以**在事件边界**结算 ——
			// 每来一条带 usage 的 assistant 消息就记一笔，超了当场取消。
			// 粒度比自持 loop 粗一点（那是在发下一次请求之前判），但账是真的。
			if (event.data?.usage && typeof event.data.usage === "object") {
				runningUsage = addUsage(runningUsage, event.data.usage);
				const left = typeof budgetLeft === "function" ? budgetLeft(runningUsage) : undefined;
				if (typeof left === "number" && Number.isFinite(left) && left <= 0) {
					overBudget = true;
					cancel("squad member token budget");
				}
			}
		});
		// 外部中止（`squad_stop` / 收队 / 会话销毁）联进原生会话：光靠我们这边的
		// AbortController 是掐不掉宿主的 driver 的 —— 必须真 `cancel`。
		const cancel = (reason) => {
			try {
				agent.cancel({ kind: "hook", reason });
			} catch {
				/* 已经停了就算了 */
			}
		};
		const onAbort = () => cancel("squad member aborted");
		try {
			signal?.addEventListener("abort", onAbort, { once: true });
			// **已经中止了就别投消息**：`addEventListener` 对已经 aborted 的 signal 不会再触发，
			// 而「收队 / 会话销毁发生在建会话途中」正是这个形状 —— 不早退的话会先 `followup`
			// 再 cancel，而 cancel 落在 idle 相位上是空操作，新那一轮照样跑起来。
			// 漏了这条的表现是「收队之后成员还在后台挂着」，且只有 20 分钟的墙钟能收它。
			if (signal?.aborted === true) {
				return { status: "卡住", kind: "aborted", reason: "本轮被中断", steps: 0, usage: {}, transcript: [], created: true, sessionId: liveSessionId };
			}
			await agent.whenIdle();
			// 记下起点：followup 之后再等 idle 才有意义。`whenIdle()` 说的是「当前没有 driver」，
			// 排队的 followup 被取走前它就会立刻兑现 —— 不等 seq 增长的话会读到空事件集，
			// 把跑成功的一轮判成没跑起来。
			const firstSeq = typeof session?.seq === "number" ? session.seq : undefined;
			agent.followup(
				createUserMessage({
					content: [{ type: "text", text: task }],
					source: { kind: "squad", squad: squad.name, member: member.label },
				}),
			);
			const budgetMs = normalizeTurnStartTimeout(undefined);
			started = await waitForTurnStart(session, firstSeq ?? 0, budgetMs);
			if (!started) log(`成员「${member.label}」在 ${budgetMs}ms 内没观察到这一轮启动`);

			const timeoutMs = config.memberTimeoutMinutes * MINUTE_MS;
			let timer;
			const deadline = new Promise((resolve) => {
				// **不要 unref**：这是这一轮唯一的终点。unref 之后，一旦事件循环没有别的
				// 待办（自检里就是这样），进程会直接退出 —— 超时永远不会发生，而
				// 「超时没生效」看起来跟「成员正常跑着」一模一样。
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			});
			const settled = await Promise.race([agent.whenIdle().then(() => "idle"), deadline]);
			clearTimeout(timer);
			if (settled === "timeout") {
				timedOut = true;
				log(`成员「${member.label}」超过 ${config.memberTimeoutMinutes} 分钟，取消这一轮`);
				try {
					agent.cancel({ kind: "hook", reason: "squad member timeout" });
				} catch (err) {
					log(`成员「${member.label}」取消失败：${err?.message ?? err}`);
				}
				let cancelTimer;
				const cancelDeadline = new Promise((resolve) => {
					cancelTimer = setTimeout(() => resolve("stuck"), 10_000);
					cancelTimer.unref?.();
				});
				const cancelSettled = await Promise.race([agent.whenIdle().then(() => "idle"), cancelDeadline]);
				clearTimeout(cancelTimer);
				cancelConverged = cancelSettled === "idle";
			}

			// **只取这一轮的事件**（`firstSeq` 是 followup 之前的序号）：续聊时会话里还有
			// 上一轮的全部事件，全量快照会把上一轮的用量/步数再算一遍。
			const events = session.snapshotEvents(typeof firstSeq === "number" ? firstSeq : 0);
			const summary = summarizeEvents(events);
			const outcome = decideRunOutcome(summary, { timedOut, started, turnStartTimeoutMs: budgetMs });
			const done = outcome.status === "succeeded";
			// `kind` 是给调用方做决策用的机器可读类别（重试只认 `infra`）。
			// 「没观察到 turn/end」按成功算（与 `decideRunOutcome` 一致），但证据不能丢：
			// 那一步在 `reason` 里明说。
			let kind = "infra";
			if (done) kind = "done";
			else if (timedOut) kind = "timeout";
			else if (overBudget) kind = "max-tokens";
			else if (overSteps || (Number.isFinite(maxSteps) && maxSteps > 0 && stepsFromEvents(events) >= maxSteps)) kind = "max-steps";
			else if (outcome.status === "cancelled") kind = "aborted";
			// `max-tokens` 是模型被截断，不是基础设施故障 —— 重试只会再被截断一次
			else if (summary.reason === "max-tokens") kind = "max-tokens";
			let reason;
			if (done) reason = outcome.incomplete ? "收工（没观察到 turn/end）" : "收工";
			else if (kind === "max-tokens" && overBudget) reason = "token 预算用尽（小队/成员上限）";
			else if (kind === "max-steps") reason = `跑了 ${maxSteps} 步还没收工`;
			else if (timedOut) reason = `超过 ${config.memberTimeoutMinutes} 分钟上限，已取消${cancelConverged ? "" : "；取消后 10s 未收敛"}`;
			else reason = `${outcome.error ?? "本轮失败"}${timedOut && !cancelConverged ? "；取消后 10s 未收敛" : ""}`;
			return {
				status: done ? "完成" : "卡住",
				kind,
				reason,
				steps: stepsFromEvents(events),
				usage: usageFromEvents(events),
				transcript: transcriptFromEvents(events),
				created: true,
				sessionId: liveSessionId,
			};
		} catch (err) {
			return { status: "卡住", kind: "infra", reason: `运行异常：${err?.message ?? String(err)}`, steps: 0, usage: {}, transcript: [], created: true, sessionId: liveSessionId };
		} finally {
			signal?.removeEventListener("abort", onAbort);
			offEvent?.();
			// flush 把会话落盘，之后 GUI 里才看得到它（也才能从面板打开）。
			try {
				await sessions().flush(session);
			} catch (err) {
				log(`成员「${member.label}」flush 会话失败：${err?.message ?? err}`);
			}
			// dispose 只拆掉**驱动**，会话本身留在盘上 —— 面板照样打得开，往里发消息
			// 会由宿主的路由把它 resume 起来（这就是 REQ-025 验收里那条「发消息能继续干活」）。
			await disposeHandle(handle);
		}
	}

	return { run, permissionOf, presetOf };
}

/** 会话日志里最后一条 `approval/policy`。 */
function lastPolicy(session) {
	try {
		const events = session?.snapshotEvents?.();
		if (!Array.isArray(events)) return undefined;
		for (let i = events.length - 1; i >= 0; i -= 1) {
			if (events[i]?.type === "approval/policy") return events[i]?.data?.policy;
		}
	} catch {
		/* 读不到就是读不到 */
	}
	return undefined;
}

/**
 * 这一轮烧掉的 token：把会话里每条带 `usage` 的 assistant 消息**累加**。
 *
 * 不是取最后一条：一条 assistant 消息只带那一步的用量，而「这个成员贵不贵」问的是整轮。
 */
function usageFromEvents(events) {
	let usage = {};
	for (const event of events ?? []) {
		if (event?.type === "assistant/message" && event.data?.usage && typeof event.data.usage === "object") {
			usage = addUsage(usage, event.data.usage);
		}
	}
	return usage;
}

/** 这一轮跑了几步 = 模型说了几次话（每条 `assistant/message` 一次）。 */
function stepsFromEvents(events) {
	let steps = 0;
	for (const event of events ?? []) if (event?.type === "assistant/message") steps += 1;
	return steps;
}

/**
 * 收掉一个 handle，不管它的 `dispose()` 是同步还是异步、抛还是拒。
 * 裸调用会让 rejection 逃成 unhandled rejection —— 后台跑的成员最怕的就是这个。
 */
async function disposeHandle(handle) {
	try {
		await handle?.dispose?.();
	} catch {
		/* 收不掉也得继续收尾 */
	}
}
