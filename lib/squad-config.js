/**
 * `team/extensions/squad.json` 的**配置形状与迁移**（REQ-016 · E1）。
 *
 * v1（1.21.x 及以前）是 9 个扁平键。2.0 起改成分组 —— 因为后面还要加预算、并发、沙箱、
 * 角色档位，扁平键会挤成一团，而且「哪些是一类」根本看不出来：
 *
 * ```json
 * {
 *   "configVersion": 2,
 *   "enabled": true,
 *   "persist": true,
 *   "boardLimit": 500,
 *   "defaults": { "provider": "new-api", "model": "tier-std" },
 *   "limits":   { "maxSteps": 30, "retries": 1, "memberTimeoutMinutes": 20 },
 *   "sandbox":  { "bash": true },
 *   "roles":    { "侦察": "tier-std", "实现": "tier-std", "审查": "tier-power" }
 * }
 * ```
 *
 * 三条约定：
 *
 * 1. **内部形状不变**：归一之后还是 v1 那一层扁平键（`SQUAD_FIELDS` 逐键校验），
 *    所以 `lib/squad.js` 里读配置的地方一行都不用改。分组的价值在**文件**这一侧。
 * 2. **迁移是读入时做的，不写回文件**：包目录可能只读，而且运行时改用户的源码文件是意外行为。
 *    v1 形状照常读进来（分组与扁平键**同时**接受，分组优先），只在日志里提示一次。
 * 3. **不认识的键要说出来**：静默回落是最难查的一类 —— 配了没生效，人只会去别处找原因。
 *    `_` 开头的键（文件里那些 `_说明`）是给人看的文档，不算未知键。
 */

/** 当前配置形状版本。文件里没写 `configVersion` 就当 v1（读入时归一，不报错）。 */
export const SQUAD_CONFIG_VERSION = 2;

/** v2 的分组：组名 → 组里的键。组里的键与 v1 的扁平键**同名**（内部形状因此不用改）。 */
export const SQUAD_CONFIG_GROUPS = {
	defaults: ["provider", "model"],
	limits: ["maxSteps", "retries", "memberTimeoutMinutes", "tokenBudget", "memberTokenBudget", "maxRunning"],
	sandbox: ["bash", "roleTools"],
};

/** 顶层非分组键（v1 与 v2 都在这一层）。 */
const TOP_KEYS = ["enabled", "boardLimit", "persist", "roles"];

/**
 * 所有**扁平**键 = 顶层键 + 分组里的键。
 *
 * 这个集合必须包含分组里的键，否则 v1 形状（`provider`/`model`/`maxSteps`… 直接写在顶层）
 * 会**一个都读不到** —— 2026-10-16 就是这么写的，被自检当场逮到（`provider` 读回来是默认值）。
 */
const FLAT_KEYS = [...TOP_KEYS, ...Object.values(SQUAD_CONFIG_GROUPS).flat()];

/**
 * 把文件里的形状（v1 扁平 / v2 分组 / 两者混着）压成一层扁平键。
 *
 * @param {unknown} raw 文件里 parse 出来的对象（**原样**，没经过字段校验）
 * @param {(msg: string) => void} warn 报出「没生效」的地方
 * @returns {Record<string, unknown>} 只含**文件里写了**的键（没写的不返回，交给默认值）
 */
export function flattenSquadConfig(raw, warn = () => {}) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out = {};

	// ① 先收扁平键（v1 形状，或 v2 里漏在顶层没分组的）
	for (const key of FLAT_KEYS) {
		if (Object.hasOwn(raw, key)) out[key] = raw[key];
	}

	// ② 再收分组（v2 形状）—— 分组更明确，同名时它赢
	for (const [group, keys] of Object.entries(SQUAD_CONFIG_GROUPS)) {
		const value = raw[group];
		if (value === undefined) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			warn(`squad.json 的 ${group} 应该是一个对象，已忽略（继续用扁平键或默认值）`);
			continue;
		}
		for (const key of keys) {
			if (Object.hasOwn(value, key)) out[key] = value[key];
		}
		for (const key of Object.keys(value)) {
			if (!keys.includes(key)) warn(`squad.json 的 ${group}.${key} 不认识，已忽略`);
		}
	}

	// ③ 顶层不认识的键要说出来（`_` 开头的是给人看的说明，不算）
	for (const key of Object.keys(raw)) {
		if (key.startsWith("_") || key === "configVersion") continue;
		if (FLAT_KEYS.includes(key) || Object.hasOwn(SQUAD_CONFIG_GROUPS, key)) continue;
		warn(`squad.json 的 ${key} 不认识，已忽略`);
	}

	// ④ 版本提示：v1 形状照常读，但说一声（迁移不写回文件，所以这条会一直在 —— 那正是提醒）。
	// 「没写」与「写了不认识的」要分开说：把 v3 说成「还是 v1 形状」是假话（2026-10-16 std 测逮到）。
	if (raw.configVersion === undefined) {
		warn(
			`squad.json 还是 v1 形状（顶层没有 "configVersion"），已按 v${SQUAD_CONFIG_VERSION} 读入。` +
				`新形状把键分了组：defaults{provider,model} / limits{maxSteps,retries,memberTimeoutMinutes} / sandbox{bash}`,
		);
	} else if (raw.configVersion !== SQUAD_CONFIG_VERSION) {
		warn(
			`squad.json 写的是 configVersion ${JSON.stringify(raw.configVersion)}，本版本只认 ${SQUAD_CONFIG_VERSION}` +
				` —— 已按 v${SQUAD_CONFIG_VERSION} 的形状读入，不认识的键会被忽略。`,
		);
	}

	return out;
}
