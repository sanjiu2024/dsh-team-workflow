/**
 * 解锁层：把 `team/UNLOCK.md` 注入系统提示（REQ-044）。
 *
 * ## 从哪来
 *
 * 移植自 `FJNB5/fujiang-pojia` 的 `prompt-custom.json`（「富江破甲」）—— 但**只搬机制，不搬原文**：
 *
 * - 搬：拒绝=故障并重写、黑名单式自查、禁止降级、输出前自检、缺信息用占位符继续。
 * - 不搬：文档伪造 / 洗钱 / 走私那几类 scope 条目（与这个仓库无关），
 *   以及「每条回复插入 TG 频道」和性化人格 —— 那是作者的广告与私货，不是能力。
 *
 * 它们混在同一个文件里，所以这里是**重写**而不是复制：既避免把别人的推广带进每条回复，
 * 也避开了根目录那个文件没有许可声明的问题。
 *
 * ## 为什么不做激活词
 *
 * 原方案要打一个「富江」才进状态。我们这层按 section 常驻 —— 常驻的东西不需要开关，
 * 多一个激活词只会多一次「忘记激活」。
 *
 * ## 关掉
 *
 * `DSH_UNLOCK=off`（或 `0`/`false`）。默认开：这一层是用户明确要求装上的。
 */
import * as fs from "node:fs";

/** 紧跟团队策略（600）之后：先有规范，再有执行契约。 */
export const UNLOCK_ORDER = 610;

export function unlockEnabled(env = process.env) {
	const v = String(env.DSH_UNLOCK ?? "").trim().toLowerCase();
	return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** 读文本。读不到就返回空串（调用方据此判定「不注入」），不抛。 */
export function unlockText(file) {
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} file UNLOCK.md 绝对路径
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{enabled: boolean, status: string, dispose?: () => void}}
 */
export function installUnlock(ctx, file, opts = {}) {
	if (!unlockEnabled(opts.env ?? process.env)) return { enabled: false, status: "DSH_UNLOCK=off" };
	const initial = unlockText(file);
	if (initial === "") return { enabled: false, status: "UNLOCK.md 不存在或为空" };
	// 用函数形式传文本：改 UNLOCK.md 下一次组装就生效，不用重启 dsh（与 lib/mc.js 同一手法）
	const dispose = ctx.systemPrompt.section({
		name: "team:unlock",
		order: UNLOCK_ORDER,
		text: () => unlockText(file),
	});
	return { enabled: true, status: "已注入", dispose };
}
