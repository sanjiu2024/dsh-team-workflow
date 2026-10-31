/**
 * 审批闸门 + 会话级放行 —— REQ-024 步骤 3 抽出。
 *
 * 语义（REQ-002 §1）：首次调用问一次，批准后本会话所有操控工具放行 ——
 * 所以弹窗里必须把「连带放行」写出来，否则「批准一次只读截屏」等于静默放行点击与打字。
 *
 * fail-safe：无审批服务 / 无 agent / 抛错 / 用户拒绝或取消 / 结果不可解析 —— 全部 false。
 * 这里没有「拿不准就放行」的分支，一次都不该有。
 */
import { allowsOutcome } from "./protocol.js";

export function createApprover({ getApprovalService }) {
		const confirmed = new Set();
		async function approve(exec, toolName, reason) {
		const session = exec?.agent?.session;
		if (session !== undefined && confirmed.has(session)) return true;
		const approval = getApprovalService();
		if (approval === undefined || approval === null || typeof approval.request !== "function") return false;
		if (exec?.agent === undefined) return false;
		let outcome;
		try {
			// 会话级授权：批准后本会话所有操控工具放行（产品语义，REQ-002 §1）——
			// 但必须在弹窗里把「连带放行」告知，否则批准一次只读截屏 = 静默放行点击打字（第 3 层 P1）。
			outcome = await approval.request({
				agent: exec.agent,
				toolName,
				reason: `${reason}。【会话级授权】批准后本会话的截屏与所有鼠标/键盘操作均放行，不再逐次询问。`,
				signal: exec.signal,
			});
		} catch {
			return false;
		}
		if (!allowsOutcome(outcome)) return false;
		if (session !== undefined) confirmed.add(session);
		return true;
	}

	return approve;
}
