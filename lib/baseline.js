/**
 * 把 team/RULES.md 注入系统提示。
 *
 * 挂在 SECTION_ORDERS.TEAM_POLICY（600）上 —— 核心留的团队策略槽位，
 * 排在 persona / 工具说明之后、sandbox 与审批策略之前。
 *
 * 文本按 mtime 缓存：改 RULES.md 不用重启 dsh，下一次组装就生效。
 */
import * as fs from "node:fs";

/** 与内核 SECTION_ORDERS.TEAM_POLICY 一致 */
export const TEAM_POLICY_ORDER = 600;

export function rulesText(file) {
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch (err) {
		return `（读不到团队规范 ${file}：${err?.message ?? err}）`;
	}
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} file RULES.md 绝对路径
 * @returns {() => void} disposer
 */
export function installBaseline(ctx, file) {
	const text = rulesText(file);
	return ctx.systemPrompt.section({
		name: "team:baseline",
		order: TEAM_POLICY_ORDER,
		text,
	});
}
