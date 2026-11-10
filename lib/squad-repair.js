#!/usr/bin/env node
/**
 * 小队失败分类与定向修复（REQ-042）。
 *
 * ## 为什么
 *
 * 成员卡住之后，现在只留一句「卡住 + 原因」，重派还是**同一句话**再试一遍 ——
 * 也就是 AGENTS.md 里那条「3 轮还没过就停下来质疑方案」的纪律，一直靠人记得。
 * 记不住的时候，就是拿同样的条件打同样的墙。
 *
 * 依据 arXiv 2611.08947（More with Less）：把失败**路由到定向修复**，而不是盲目重试 ——
 * 它那套 orchestrator 靠 verdict 分流，token 反而少 52%。
 *
 * ## 边界
 *
 * 这里**不改状态机**，只产出一条建议：分类 + 下一步该改什么。谁用、怎么用由调用方决定。
 * 判断只依据失败文本，不猜意图 —— 认不出来就直说认不出来，别硬套一个类别。
 */

/** 失败类型 → 下一步该怎么改任务。顺序有意义：先匹配更具体的。 */
const RULES = [
	{
		kind: "test-failed",
		re: /(测试|test).{0,12}(失败|不通过|红|failed|fail)|assert(ion)?\s*(error|failed)|\d+\s*(failing|failed)/i,
		hint: "先读失败的断言与它指向的文件，改**被断言的那一处**；不要改测试来迁就实现，也不要重跑等它自己变绿。",
	},
	{
		kind: "missing-file",
		re: /(ENOENT|no such file|not found|找不到|不存在|cannot find module)/i,
		hint: "路径错了：先 `glob` 确认目标文件真实存在并拿到绝对路径，再改任务里的路径；不要猜第二个相似名字。",
	},
	{
		kind: "permission",
		re: /(EACCES|EPERM|permission denied|拒绝访问|无权限|not authorized|403)/i,
		hint: "权限问题：确认沙箱档位与实际用户，改配置而不是改代码；如果是系统路径，换到工作区里的等价位置。",
	},
	{
		kind: "timeout",
		re: /(timeout|timed out|超时|ETIMEDOUT|deadline exceeded)/i,
		hint: "拆小：把任务切成能单独验收的两三块，一次只做一块；耗时命令加超时并放到后台。",
	},
	{
		kind: "compile",
		re: /(SyntaxError|TS\d{4}|Unexpected token|语法错误|Cannot find name)/i,
		hint: "语法/类型错误：先跑一次 `node --check` 或类型检查拿到第一条错误，只修第一条；连锁错误通常由它引起。",
	},
	{
		kind: "network",
		re: /(ECONNREFUSED|ECONNRESET|ENOTFOUND|getaddrinfo|代理|proxy|502|503)/i,
		hint: "网络不通：先确认是不是本机代理造成的（`env -u HTTP_PROXY curl`），换直连或换端点，别在同一地址上重试。",
	},
	{
		kind: "steps-exhausted",
		re: /(步数|steps?\s*(用尽|exhausted|limit)|max steps)/i,
		hint: "步数用尽：任务太大。先写清「已经做到哪一步」再派，或者拆成两个成员并行做。",
	},
	{
		kind: "ambiguous",
		re: /(歧义|ambiguous|不确定|unclear|需要确认)/i,
		hint: "需求没写清：先问一句（或先写 REQ 复述），不要替用户选一个方向做下去。",
	},
];

/**
 * 给一句失败原因分类。认不出来就返回 `unknown`，**不硬套**。
 *
 * @param {string} reason
 * @returns {{kind: string, hint: string|null}}
 */
export function classifyFailure(reason) {
	const text = typeof reason === "string" ? reason : "";
	if (text.trim() === "") return { kind: "unknown", hint: null };
	for (const rule of RULES) {
		if (rule.re.test(text)) return { kind: rule.kind, hint: rule.hint };
	}
	return { kind: "unknown", hint: null };
}

/**
 * 拼一条「重派时该说的话」。分类不出来就返回空串 —— 调用方原样重派即可，
 * 而不是收到一句没用的废话。
 *
 * @param {string} reason
 * @returns {string}
 */
export function repairDirective(reason) {
	const { kind, hint } = classifyFailure(reason);
	if (!hint) return "";
	return `[${kind}] ${hint}`;
}
