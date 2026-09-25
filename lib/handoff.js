/**
 * 会话交接：上下文压不动了，就把没干完的活交出去。
 *
 * 触发点是 dsh **自己**判定「压不动」的那一刻，不自造阈值：
 *   `dsh-compaction-basic` 挂在 `agent/request-error`（waterfall）上，遇到
 *   `CONTEXT_WINDOW_EXCEEDED` 就压缩一次并返回 `{kind:"retry"}`；重试次数用尽
 *   （`maxOverflowRetries`，默认 1）或压缩没造成实质变化时它返回 `next()`，
 *   于是 `dsh-agent-loop` 抛出 LlmError → `throwError()` **emit `agent/error`**。
 *   所以「`agent/error` 且 `error.code === CONTEXT_WINDOW_EXCEEDED`」精确定义了
 *   「dsh 已经放弃自救」——不需要我们猜窗口大小、也不用数重试次数。
 *
 * 做三件事（对应需求的三条）：
 *   1. 写交接文档 → `<DSH_HOME>/storages/handoffs/<日期>-<会话id>.md`
 *   2. 建新会话（`sessionController.create`）+ 把任务注入进去（`.prompt`，即自动开跑）
 *   3. 在旧会话里留一条提示，写明去了哪个会话、文档在哪
 *
 * 两个刻意的克制：
 *   - **不切 UI**。`sessions.open(id)` 只存在于 client half（`dsh-api-session-controller`
 *     的 `./client` 导出），host 插件够不到；本包是纯 host 包（package.json 没有
 *     `dsh.client`）。所以只建会话 + 留指引，不假装跳转。
 *   - **不给旧会话发 prompt**。往旧会话发消息等于再跑一轮模型调用 —— 而它刚刚
 *     因为上下文超限失败，那正是我们在这里的原因。所以只 `append` 一条
 *     `user/message`（`source.kind = "plugin"`）：session invariant 对
 *     `user/message` 没有 turn/step 约束（`system/message` 有，用不了），
 *     且 Chat 把它渲染成 context 行而不是用户发言。
 *
 * 依赖 `sessionController` 时用 `ctx.inject([...])` 可选注入（同 lib/web.js）：
 * 精简 profile 里没有这个服务时，整块交接关掉并在状态里说明，不会拖垮整包。
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { clip, dshHome, isoLocal, sha256 } from "./util.js";

/** 写进旧会话的那条提示的来源标记，也是文档里的署名 */
const SOURCE = "dsh-team-workflow-handoff";

/** dsh 的上下文超限码（`dsh-llm` 的 CONTEXT_WINDOW_EXCEEDED_CODE） */
const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";

/**
 * 进程内最多自动建几个接力会话。
 *
 * 按会话去重只能挡住「同一会话反复溢出」，挡不住链式：新会话拿到的是短提示，
 * 正常不会立刻再溢出；但如果任务本身就装不进一个上下文窗口，就会 A→B→C 一直建下去。
 * 到上限仍写文档、仍给提示，只是不再自动建会话 —— 这时该由人来看。
 */
const MAX_HANDOFFS = 5;

export const HANDOFF_DEFAULTS = {
	enabled: true,
	maxDocChars: 20000,
	maxInjectChars: 6000,
	dir: undefined,
};

export const HANDOFF_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	maxDocChars: (v) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined),
	maxInjectChars: (v) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined),
	dir: (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined),
};

/** 取 content 里的纯文本（dsh 的 content 是块数组，别当成字符串用） */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * 从事件流里回收「接下来要干什么」：最后一条用户请求 + 最后一次 todo 快照。
 *
 * todo 取**整份日志里最后一条** `todo/write`，不套用 dsh 自己的
 * 「新 turn 作废旧计划」语义（`backscanTodos`）—— 那是给 UI 显示当前计划用的，
 * 而交接要的是「这活干到哪了」，跨 turn 的旧清单恰恰是最有价值的部分。
 *
 * preset 同理优先取日志：`agent-preset/selected` 只在**运行时切换** preset 时 append，
 * header 里的值只是「启动时那个」。切换只允许在第一个 turn 开始之前
 * （`swap()` 对已开跑的会话抛 `agent-preset/locked`），所以有这条事件时它就是
 * 「真正在用的那个」；而能溢出就说明跑过 turn，header 可能已经被那次切换落下了。
 *
 * @param {readonly {type: string, data?: any}[]} events 会话事件（seq 递增）
 * @returns {{request: string, todos: {content: string, status: string}[], agentPreset: string | undefined}}
 */
export function collectHandoff(events) {
	let request = "";
	let todos = [];
	let agentPreset;
	let foundRequest = false;
	let foundTodos = false;
	for (let i = events.length - 1; i >= 0; i--) {
		if (foundRequest && foundTodos && agentPreset !== undefined) break;
		const event = events[i];
		if (!foundRequest && event?.type === "user/message" && event.data?.source?.kind === "user") {
			request = contentText(event.data.content);
			foundRequest = request !== "";
		}
		if (!foundTodos && event?.type === "todo/write" && Array.isArray(event.data?.todos)) {
			todos = event.data.todos.filter((t) => t && typeof t.content === "string" && t.content.trim() !== "");
			foundTodos = todos.length > 0;
		}
		if (agentPreset === undefined && event?.type === "agent-preset/selected" && typeof event.data?.agentPreset === "string") {
			agentPreset = event.data.agentPreset;
		}
	}
	return { request, todos, agentPreset };
}

/** 未完成 = pending 或 in_progress；其余（completed 等）只作为参考附在文档里 */
export function splitTodos(todos) {
	const open = [];
	const done = [];
	for (const todo of todos) {
		const status = String(todo.status ?? "pending");
		(status === "completed" ? done : open).push({ content: todo.content, status });
	}
	return { open, done };
}

const bullet = (todo) => `- [${todo.status}] ${todo.content}`;

/**
 * 渲染交接文档（纯函数，便于自检）。
 * @returns {string} markdown 正文
 */
export function renderHandoffDoc(input) {
	const { sessionId, cwd, newSessionId, request, todos, now, reason, maxChars } = input;
	const { open, done } = splitTodos(todos);
	const lines = [
		`# 会话交接：${sessionId}`,
		"",
		`- 生成时间：${isoLocal(now)}`,
		`- 来源会话：${sessionId}`,
		`- 新会话：${newSessionId ?? "（没建成，需手动新建）"}`,
		`- 工作目录：${cwd ?? "（未记录）"}`,
		`- 触发原因：${reason}`,
		"",
		"## 原始请求（来源会话最后一条用户消息）",
		"",
		request || "（日志里没找到用户消息）",
		"",
		"## 未完成的任务",
		"",
		open.length ? open.map(bullet).join("\n") : "（日志里没有 todo 记录，看上面的原始请求）",
		"",
		"## 已完成（仅供了解上下文，不要重做）",
		"",
		done.length ? done.map(bullet).join("\n") : "（无）",
		"",
		"## 接着怎么干",
		"",
		"1. 先读这个文档，再**自己核对**工作目录里代码/文件的当前状态 —— 文档是日志快照，可能落后于磁盘。",
		"2. 用 todo 工具把上面「未完成的任务」重建成清单（只建未完成的）。",
		"3. 从第一条未完成任务继续。",
		"",
		`<!-- 由 ${SOURCE} 自动生成；来源会话日志仍是唯一事实来源 -->`,
	];
	return clip(lines.join("\n"), maxChars);
}

/**
 * 渲染注入新会话的那条任务（纯函数，便于自检）。
 * 要短 —— 它一进去就是新会话的第一条消息，太长会立刻把新会话也顶爆。
 */
export function renderHandoffPrompt(input) {
	const { sessionId, docFile, request, todos, maxChars } = input;
	const { open } = splitTodos(todos);
	const lines = [
		`上个会话（${sessionId}）上下文超限、压缩自救也失败了，它的活交接到这里。`,
		"",
		`交接文档：${docFile}`,
		"",
		"请先读这个文档，然后用 todo 工具重建未完成任务清单，接着做下去。",
		"文档是日志快照，动手前先核对磁盘上的真实状态。",
		"",
		open.length ? `未完成任务：\n${open.map((t) => `- [${t.status}] ${t.content}`).join("\n")}` : "",
		request ? `\n原始请求（节选）：\n${request}` : "",
		"",
		"（本条由 dsh-team-workflow 的交接模块自动发起，无需向我确认，直接开工。）",
	];
	return clip(lines.join("\n").trim(), maxChars);
}

/**
 * 装交接模块。
 * @param ctx cordis ctx
 * @param {{defaults?: object}} options 已与配置文件叠好的配置
 */
export function installHandoff(ctx, options = {}) {
	const config = { ...HANDOFF_DEFAULTS, ...(options.defaults ?? {}) };
	const dir = config.dir ?? path.join(dshHome(), "storages", "handoffs");
	const state = {
		enabled: config.enabled,
		dir,
		count: 0,
		lastFile: null,
		lastSessionId: null,
		status: config.enabled ? "待命" : "已关闭（配置）",
	};

	/** 一个会话只交一次手：新会话万一又溢出，不能无限建会话 */
	const handled = new Set();

	if (config.enabled) {
		// 可选依赖：没有 sessionController（精简 profile / 无 API 层）时整块关掉，
		// 但仍要能跑 banner 和状态（否则 /team-baseline 会读不到这个模块）。
		ctx.inject(["sessionController"], (scoped) => {
			state.status = "监听中（等上下文超限）";
			scoped.on("agent/error", (payload) => {
				// emit 的返回值会被 cordis catch 成 warn；异常绝不许冒出去
				handleError(scoped, payload).catch((error) => {
					state.status = `交接失败：${error?.message ?? error}`;
					scoped.logger.warn(`[team:handoff] 交接失败：${error?.message ?? error}`);
				});
			});
		});
	}

	async function handleError(scoped, payload) {
		if (payload?.error?.code !== CONTEXT_WINDOW_EXCEEDED) return;
		const session = payload.agent?.session;
		if (!session) return;
		const sessionId = session.id;
		// ponytail: 每个会话一个字符串常驻，进程生命周期内不回收。
		// 会话数上万时再换 LRU —— 真到那量级 dsh 自己先扛不住。
		if (handled.has(sessionId)) return;
		handled.add(sessionId);
		// 配额必须在第一个 await 之前占掉：后面有 await，若等到末尾才自增，
		// 多个会话同时溢出时每个都会查到「count 未满」而各建一个，上限被绕过。
		// 占了不退（即使后面失败）—— 保守总比无限建会话好。
		state.count += 1;

		const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
		const { request, todos, agentPreset: selectedPreset } = collectHandoff(events);
		const cwd = session.header?.cwd;
		// 日志里换过就用日志的，否则用创建时的 header
		const agentPreset = selectedPreset ?? session.header?.agentPreset;
		const now = new Date();
		const reason = "上下文超限（CONTEXT_WINDOW_EXCEEDED），且 dsh 自身的压缩自救重试已耗尽";
		const exhausted = state.count > MAX_HANDOFFS;

		// —— 1. 先建新会话：没有它，文档写了也没人接 ——
		let newSessionId;
		let failure;
		if (exhausted) {
			failure = `本进程已自动交接 ${state.count} 次，达到上限 ${MAX_HANDOFFS}，不再自动建会话（可能是任务本身一个上下文装不下）`;
		} else {
			try {
				const created = await scoped.sessionController.create({
					...(cwd === undefined ? {} : { cwd }),
					...(agentPreset === undefined ? {} : { agentPreset }),
				});
				newSessionId = created?.sessionId;
				if (typeof newSessionId !== "string" || newSessionId === "") {
					throw new Error(`create 没有返回 sessionId：${JSON.stringify(created)}`);
				}
			} catch (error) {
				failure = error?.message ?? String(error);
			}
		}

		// —— 2. 写交接文档 ——
		// 会话 id 可以是从外部 adopt 进来的，不是可信文件名片段：消毒后再拼，
		// 否则 id 里的 `../` 会让文档落到目录外。消毒是有损的（`a/b` 与 `a:b` 都
		// 变 `a-b`），所以尾巴上挂 id 的短 hash 避免同日两份互相覆盖。
		const file = path.join(dir, `${dayStamp(now)}-${safeName(sessionId)}-${sha256(sessionId).slice(0, 8)}.md`);
		const body = renderHandoffDoc({
			sessionId,
			cwd,
			newSessionId,
			request,
			todos,
			now,
			reason,
			maxChars: config.maxDocChars,
		});
		let docFile = file;
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, `${body}\n`, "utf8");
			state.lastFile = file;
		} catch (error) {
			docFile = undefined;
			failure ??= `写文档失败：${error?.message ?? error}`;
		}

		// —— 3. 把任务注入新会话（prompt 即让它自动开跑）——
		let injected = false;
		if (newSessionId !== undefined) {
			try {
				await scoped.sessionController.prompt({
					requestId: randomUUID(),
					sessionId: newSessionId,
					mode: "queue",
					content: [
						{
							type: "text",
							text: renderHandoffPrompt({
								sessionId,
								docFile: docFile ?? `（写失败：${failure}）`,
								request,
								todos,
								maxChars: config.maxInjectChars,
							}),
						},
					],
				});
				injected = true;
			} catch (error) {
				failure ??= `注入任务失败：${error?.message ?? error}`;
			}
		}

		// —— 4. 旧会话里写明去哪 ——
		try {
			session.append(
				"user/message",
				{
					id: `handoff-${randomUUID()}`,
					role: "user",
					content: [{ type: "text", text: notice({ newSessionId, injected, docFile, failure }) }],
					source: { kind: "plugin", plugin: SOURCE },
				},
				{ surfaceOp: "append" },
			);
		} catch (error) {
			// 旧会话写不进去不算失败：新会话和文档才是结果
			scoped.logger.warn(`[team:handoff] 旧会话提示写入失败：${error?.message ?? error}`);
		}

		state.lastSessionId = sessionId;
		state.status = failure
			? `交接完成（有降级）：${failure}`
			: `已交接 ${sessionId} → ${newSessionId}`;
		scoped.logger.info(
			`[team:handoff] ${state.status}；文档 ${docFile ?? "未写出"}；注入任务${injected ? "成功" : "未成功"}`,
		);
	}

	function describe() {
		return [
			`会话交接：${config.enabled ? "开" : "关"}  ${state.status}`,
			`  交接文档目录：${dir}（本进程已处理 ${state.count} 个会话）`,
			state.lastSessionId ? `  最近一次：${state.lastSessionId}${state.lastFile ? `  → ${state.lastFile}` : ""}` : "",
			"  触发条件：dsh 的 compaction 自救重试耗尽（agent/error + CONTEXT_WINDOW_EXCEEDED）。",
			"  动作：写交接文档 → 建新会话 → 把未完成任务注入新会话并开跑 → 旧会话留提示。",
			"  不做 UI 跳转（切 UI 当前会话只在 client half，本包是纯 host 包）。",
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	return {
		get enabled() {
			return config.enabled;
		},
		get status() {
			return state.status;
		},
		get count() {
			return state.count;
		},
		/** 本进程自动建会话的次数上限（超过就只写文档、由人来接） */
		maxHandoffs: MAX_HANDOFFS,
		get dir() {
			return dir;
		},
		describe,
		config,
	};
}

/** 旧会话里那条提示的正文（纯函数） */
function notice({ newSessionId, injected, docFile, failure }) {
	if (newSessionId !== undefined) {
		return [
			"⚠️ 本会话上下文超限，dsh 自己的压缩自救也失败了；剩下的活已自动交接到新会话。",
			`新会话：${newSessionId}${injected ? "（任务已注入，已在那边开跑）" : "（任务注入失败，请到那边手动发一条）"}`,
			docFile ? `交接文档：${docFile}` : "交接文档没写出来，请看上一条错误的详情。",
			"请切到新会话继续；本会话可以关掉了。",
		].join("\n");
	}
	return [
		"⚠️ 本会话上下文超限，dsh 自己的压缩自救也失败了。",
		`自动新建会话失败：${failure ?? "未知原因"}`,
		docFile ? `交接文档已写好：${docFile}\n请手动新建会话，把上面这个路径发给 AI 让它接着干。` : "交接文档也没写出来。",
	].join("\n");
}

function dayStamp(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把会话 id 变成安全的单个文件名片段（可读性保留，只剔除危险字符） */
function safeName(id) {
	const cleaned = String(id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+/, "");
	return cleaned === "" ? "session" : cleaned.slice(0, 120);
}
