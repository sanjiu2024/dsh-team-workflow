import { makeHostLoader } from "./dsh-exports.js";
import { repeatPeriod } from "./repeat-guard-core.js";

export const REPEAT_GUARD_DEFAULTS = {
	enabled: true,
	/** C · 思考体量护栏：一次流式调用里 reasoning 累计超过这个字符数就判空转 */
	maxReasoningChars: 20000,
	/** D · 中断后自动接一句提示（把「静默掐掉」变成「掐掉并说明原因」） */
	nudge: true,
	/** 同一会话最多自动提示几次；用完只静默中断，避免「提示 → 又绕 → 再提示」的新循环 */
	maxNudgesPerSession: 3,
};

export const REPEAT_GUARD_FIELDS = {
	enabled: (value) => (typeof value === "boolean" ? value : undefined),
	maxReasoningChars: (value) => (typeof value === "number" && value > 0 ? Math.floor(value) : undefined),
	nudge: (value) => (typeof value === "boolean" ? value : undefined),
	maxNudgesPerSession: (value) => (typeof value === "number" && value >= 0 ? Math.floor(value) : undefined),
};

const nudgeText = (reason) =>
	`检测到你在思考里绕圈（${reason}），已经中断这一轮。请直接给结论，或换一个策略 —— 不要重复同一思路。`;

/**
 * Install the loop guards on the model stream.
 *
 * 两层，都挂在 `llm/stream`（与 REQ-013 同一个钩子）：
 *   · 逐字重复 —— 同一段 ≥16 字符连续 4 次（REQ-013）
 *   · 思考体量 —— 一次流式调用里 reasoning 累计超 `maxReasoningChars`（REQ-014 C）
 * 命中后取消当前 turn；预算内再补一句提示（REQ-014 D）。
 */
export function installRepeatGuard(ctx, config = REPEAT_GUARD_DEFAULTS) {
	if (!config.enabled) return { enabled: false, dispose() {} };

	const host = makeHostLoader(ctx);
	/** sessionId → 已提示次数（只在本进程内存里） */
	const nudges = new Map();

	/**
	 * 只对 **AgentLoop 自己发起的**请求生效。
	 *
	 * 为什么必须门禁（2026-10-09 std 测逮到的真问题）：压缩
	 * （`dsh-compaction-basic/lib/index.js:319,323`）与会话标题
	 * （`dsh-session-title-llm/lib/index.js:212,226`）都带**同一个 sessionId** 走 `llm/stream`
	 * —— 只看 sessionId 就会拿辅助调用的输出去取消**真人那一轮**，还往对话里塞一条提示。
	 * `purpose` 是同步可判的快筛（普通对话请求不设它），`isAgentLoopRequest` 是权威标记
	 * （`dsh-llm/lib/index.js:386` 的 WeakSet，标记点在 `dsh-agent-loop/lib/index.js:1269`）。
	 * 预加载失败就退化成「只靠 purpose 快筛」——宁可少拦，不可错杀真人 turn。
	 */
	let isLoopRequest;
	void host.load("@deepseek-ai/dsh-llm", ["isAgentLoopRequest"])
		.then((kit) => { isLoopRequest = kit.isAgentLoopRequest; })
		.catch(() => {});

	// 会话销毁就把它的计数删掉：这张表只增不减的话，长跑进程里每个会话都会留一个数
	const offDisposed = ctx.on?.("session/disposed", (session) => {
		if (session?.id !== undefined) nudges.delete(session.id);
	});

	const activation = ctx.inject(["agents"], (scope) => {
		scope.on("llm/stream", (options, next) => {
			if (options?.purpose !== undefined) return next();                 // 压缩/会话标题等辅助调用
			if (typeof isLoopRequest === "function" && !isLoopRequest(options)) return next();
			const sessionId = options?.sessionId;
			const agent = typeof sessionId === "string" && sessionId !== ""
				? scope.agents.get(sessionId)
				: undefined;
			if (!agent || typeof agent.cancel !== "function") return next();
			return guardStream(next(), {
				agentForSession: () => agent,
				limits: config,
				nudgeMessage: async (reason) => {
					if (config.nudge === false) return undefined;
					const used = nudges.get(sessionId) ?? 0;
					if (used >= config.maxNudgesPerSession) return undefined;
					// 先占位再 await：并发两条流同时命中时，读-改-写跨 await 会丢更新（都读到 used）
					nudges.set(sessionId, used + 1);
					try {
						const { createUserMessage } = await host.load("@deepseek-ai/dsh-llm", ["createUserMessage"]);
						if (typeof createUserMessage !== "function") throw new Error("宿主没导出 createUserMessage");
						return createUserMessage({ content: [{ type: "text", text: nudgeText(reason) }], source: { kind: "user" } });
					} catch (err) {
						// 造不出提示只该退化成「静默中断」，不该把中断本身弄失败，也不该白扣一次预算
						nudges.set(sessionId, Math.max(0, (nudges.get(sessionId) ?? 1) - 1));
						scope.logger?.warn?.(`[team:repeat-guard] 造不出中断提示，只中断：${err?.message ?? err}`);
						return undefined;
					}
				},
				log: (message) => scope.logger?.warn?.(`[team:repeat-guard] ${message}`),
			});
		}, { global: true });
	});
	return {
		enabled: true,
		dispose: () => {
			offDisposed?.();
			nudges.clear();
			activation.dispose();
		},
		/** 自检/面板要看「这个会话提示过几次」 */
		nudgeCount: (sessionId) => nudges.get(sessionId) ?? 0,
	};
}

/** 命中后取消 + （有预算时）提示。 */
async function stop(agent, reason, { nudgeMessage, log }) {
	log(reason);
	agent.cancel({ kind: "hook", reason }, { keepInbox: true });
	const message = await nudgeMessage(reason);
	// 取消之后再投递：唤醒输入会排在下一轮，等被中止的活动收敛到 idle 时运行
	if (message) agent.followup?.(message);
}

export async function* guardStream(stream, {
	agentForSession,
	limits = REPEAT_GUARD_DEFAULTS,
	nudgeMessage = async () => undefined,
	log = () => {},
}) {
	const blockTypes = new Map();
	const buffers = new Map();
	const maxReasoningChars = limits.maxReasoningChars ?? REPEAT_GUARD_DEFAULTS.maxReasoningChars;
	let reasoningChars = 0;

	try {
		for await (const chunk of stream) {
			let hit;
			if (chunk?.type === "block-start") {
				blockTypes.set(chunk.index, chunk.blockType);
				buffers.set(chunk.index, []);
			} else if (chunk?.type === "text-delta" || chunk?.type === "reasoning-delta") {
				const expected = chunk.type === "text-delta" ? "text" : "reasoning";
				const blockType = blockTypes.get(chunk.index);
				if (blockType === expected && typeof chunk.text === "string" && chunk.text !== "") {
					if (expected === "reasoning") {
						reasoningChars += chunk.text.length;
						if (reasoningChars > maxReasoningChars) {
							hit = { reason: `思考累计 ${reasoningChars} 字符，超过上限 ${maxReasoningChars}` };
						}
					}
					const buffer = buffers.get(chunk.index) ?? [];
					for (let index = 0; index < chunk.text.length; index += 1) buffer.push(chunk.text[index]);
					if (buffer.length > 512) buffer.splice(0, buffer.length - 512);
					buffers.set(chunk.index, buffer);
					if (!hit) {
						const period = repeatPeriod(buffer);
						if (period !== 0) {
							const kind = expected === "reasoning" ? "思考" : "正文";
							hit = { reason: `${kind}连续重复输出（周期 ${period} 字符，连续 4 次）` };
						}
					}
				}
			} else if (chunk?.type === "block-end") {
				blockTypes.delete(chunk.index);
				buffers.delete(chunk.index);
			}
			if (hit) {
				const agent = agentForSession();
				if (agent && typeof agent.cancel === "function") {
					await stop(agent, hit.reason, { nudgeMessage, log });
					return;
				}
			}
			yield chunk;
		}
	} finally {
		blockTypes.clear();
		buffers.clear();
	}
}
