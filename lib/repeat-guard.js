import { repeatPeriod } from "./repeat-guard-core.js";

export const REPEAT_GUARD_DEFAULTS = { enabled: true };
export const REPEAT_GUARD_FIELDS = { enabled: (value) => typeof value === "boolean" ? value : undefined };

/**
 * Install a streaming repeated-output guard. It only observes text/reasoning chunks;
 * tool calls and all other stream protocol chunks pass through untouched.
 */
export function installRepeatGuard(ctx, config = REPEAT_GUARD_DEFAULTS) {
	if (!config.enabled) return { enabled: false, dispose() {} };

	const activation = ctx.inject(["agents"], (scope) => {
		scope.on("llm/stream", (options, next) => {
			const sessionId = options?.sessionId;
			const agent = typeof sessionId === "string" && sessionId !== ""
				? scope.agents.get(sessionId)
				: undefined;
			if (!agent || typeof agent.cancel !== "function") return next();
			return guardStream(next(), {
				agentForSession: () => agent,
				log: (message) => scope.logger?.warn?.(`[team:repeat-guard] ${message}`),
			});
		}, { global: true });
	});
	return { enabled: true, dispose: () => activation.dispose() };
}

export async function* guardStream(stream, { agentForSession, log = () => {} }) {
	const blockTypes = new Map();
	const buffers = new Map();

	try {
		for await (const chunk of stream) {
			let detected;
			if (chunk?.type === "block-start") {
				blockTypes.set(chunk.index, chunk.blockType);
				buffers.set(chunk.index, []);
			} else if (chunk?.type === "text-delta" || chunk?.type === "reasoning-delta") {
				const expected = chunk.type === "text-delta" ? "text" : "reasoning";
				const blockType = blockTypes.get(chunk.index);
				if (blockType === expected && typeof chunk.text === "string" && chunk.text !== "") {
					const buffer = buffers.get(chunk.index) ?? [];
					for (let index = 0; index < chunk.text.length; index += 1) buffer.push(chunk.text[index]);
					if (buffer.length > 512) buffer.splice(0, buffer.length - 512);
					buffers.set(chunk.index, buffer);
					const period = repeatPeriod(buffer);
					if (period !== 0) detected = { period, type: expected };
				}
			} else if (chunk?.type === "block-end") {
				blockTypes.delete(chunk.index);
				buffers.delete(chunk.index);
			}
			if (detected) {
				const agent = agentForSession();
				if (agent && typeof agent.cancel === "function") {
					const kind = detected.type === "reasoning" ? "思考" : "正文";
					const reason = `检测到${kind}连续重复输出（周期 ${detected.period} 字符，连续 4 次）`;
					log(reason);
					agent.cancel({ kind: "hook", reason }, { keepInbox: true });
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
