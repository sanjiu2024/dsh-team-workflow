/**
 * magic-context 配置落地（REQ-003）。
 *
 * 背景：mc 的执行阈值（`execute_threshold_percentage`，默认 65）与 dsh 自带压缩
 * 阈值（`compactThresholdRatio`，默认 0.25）必须拉开 —— 否则 dsh 先动手、把地板
 * 压回低位，mc 的 63% 主动线永远够不到，它排队的操作（实测 26 个 `drop`）永远
 * 不执行。修法见 docs/requirements/REQ-003-mc与dsh压缩阈值冲突.md。
 *
 * 这个模块只做三件事，全部是纯函数（可单测、不碰进程）：
 *   1. 读 mc 配置里的执行阈值（注释安全的扫描器）
 *   2. 把阈值**就地**写进 mc 的 jsonc —— 保留用户已有的键与注释
 *   3. 校验「mc 阈值 < dsh 阈值」这个不变式
 *
 * 为什么不用 JSON.parse + 重写：mc 的配置文件（`~/.config/cortexkit/
 * magic-context.jsonc`）里有人写的注释（说明 historian 为什么这么配），
 * 整份重写会把注释全丢掉。而 mc 的合并语义是「逐键回落默认值」，所以
 * 我们只需要动一个键 —— 文本级就地替换即可，其余字节原样保留。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** mc 读的配置文件（user scope）。bundle 里 configHome()/cortexkit/magic-context.jsonc。 */
export function mcConfigPath(home = os.homedir()) {
	return path.join(home, ".config", "cortexkit", "magic-context.jsonc");
}

/** 我们维护的阈值键名。 */
export const MC_THRESHOLD_KEY = "execute_threshold_percentage";

/**
 * history block 预算键。为什么要一起管：它按
 * `窗口 × (执行阈值/100) × history_budget_percentage` 算（bundle `resolveHistoryBudgetTokensForPi`），
 * **会随执行阈值一起缩小**。阈值从 65 降到 20 时，默认 0.15 会把预算从窗口的 9.75%
 * 压到 3%（≈50K → ≈15K）—— mc 注入历史的能力因此退化。所以要把百分比调上来补偿，
 * 让**绝对预算**保持在同一量级（0.20 × 0.45 = 9% ≈ 改前的 9.75%）。
 */
const MC_HISTORY_BUDGET_KEY = "history_budget_percentage";

/** 本包管理的 mc 配置键（只能是这几种，且值必须是数字）。 */
export const MC_MANAGED_KEYS = [MC_THRESHOLD_KEY, MC_HISTORY_BUDGET_KEY];

/** mc 的 schema 允许范围（低于 20 / 高于 90 都会被它剪掉并回退默认）。 */
export const MC_THRESHOLD_MIN = 20;
export const MC_THRESHOLD_MAX = 90;

/**
 * mc 主动触发线相对执行阈值的固定偏移（bundle 的
 * `PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2`，取 `max(0, 阈值 − 2)`）。
 */
export const MC_PROACTIVE_OFFSET = 2;

// ── JSONC 扫描（注释与字符串安全） ──────────────────────────────────────────

/**
 * 从 `from` 起跳过空白与注释，返回下一个非空白非注释字符的下标。
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function skipTrivia(text, from) {
	let i = from;
	while (i < text.length) {
		const c = text[i];
		// \uFEFF：UTF-8 BOM。Windows 编辑器常写，而 JSON.parse 不容忍它，必须先跳。
		if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\uFEFF") {
			i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		break;
	}
	return i;
}

/**
 * 从 `from`（应当是引号）读一个 JSON 字符串，返回结束引号之后的下标。
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function skipString(text, from) {
	let i = from + 1;
	while (i < text.length) {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === '"') return i + 1;
		i++;
	}
	return i;
}

/**
 * 找一个**顶层**（深度 1）键的**全部**值区间（重复键会出现多个）。
 *
 * 为什么返回全部：JSON 对重复键取**最后一个**。只处理第一个会造成
 * 「改了但没生效」——旧值在 JSON 语义上依然是最终值。
 *
 * 深度定义为：进入最外层 `{` 之后为 1；`{` / `[` 加一，`}` / `]` 减一。
 * 因此嵌套对象里的同名键不会被匹配 —— 这是必须的，否则会把
 * `historian.pi.execute_threshold_percentage` 之类的嵌套键当顶层键改掉。
 *
 * @param {string} text
 * @param {string} key
 * @returns {{valueStart: number, valueEnd: number}[]}
 */
export function findTopLevelKeys(text, key) {
	const found = [];
	let depth = 0;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			const end = skipString(text, i);
			if (depth === 1) {
				let name;
				try {
					name = JSON.parse(text.slice(i, end));
				} catch {
					name = undefined;
				}
				if (name === key) {
					const j = skipTrivia(text, end);
					if (text[j] === ":") {
						const valueStart = skipTrivia(text, j + 1);
						found.push({ valueStart, valueEnd: scanValue(text, valueStart) });
					}
				}
			}
			i = end;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === "{" || c === "[") {
			depth++;
			i++;
			continue;
		}
		if (c === "}" || c === "]") {
			depth--;
			i++;
			continue;
		}
		i++;
	}
	return found;
}

/**
 * 找一个**顶层**键的第一个值区间；没有则 null。
 * @param {string} text
 * @param {string} key
 * @returns {{valueStart: number, valueEnd: number} | null}
 */
export function findTopLevelKey(text, key) {
	return findTopLevelKeys(text, key)[0] ?? null;
}

/**
 * 从 `from` 扫出一个 JSON 值的结束下标（字符串 / 对象 / 数组 / 字面量）。
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function scanValue(text, from) {
	const c = text[from];
	if (c === '"') return skipString(text, from);
	if (c === "{" || c === "[") {
		const open = c;
		const close = c === "{" ? "}" : "]";
		let depth = 0;
		let i = from;
		while (i < text.length) {
			const ch = text[i];
			if (ch === '"') {
				i = skipString(text, i);
				continue;
			}
			if (ch === "/" && text[i + 1] === "/") {
				while (i < text.length && text[i] !== "\n") i++;
				continue;
			}
			if (ch === "/" && text[i + 1] === "*") {
				i += 2;
				while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
				i += 2;
				continue;
			}
			if (ch === open) depth++;
			else if (ch === close) {
				depth--;
				if (depth === 0) return i + 1;
			}
			i++;
		}
		return i;
	}
	// 数字 / true / false / null：读到分隔符为止。
	// `/` 必须在分隔符集里：否则 `20 /* 为何是 20 */` 的 valueEnd 会吞掉那段注释，
	// 替换时把用户的注释一并抹掉。
	let i = from;
	while (i < text.length && !",}\n\r]/[".includes(text[i])) i++;
	return i;
}

/**
 * 定位**根对象**的 `{`。
 *
 * 为什么不能用 `text.indexOf("{")`：文件开头的注释或字符串里出现 `{` 时
 * （如 `// 见 { config }`），键会被插进注释里 —— 写出无效配置却报成功。
 * 这里用扫描器跳过空白/注释/BOM 后取第一个真 token，并校验它确实是 `{`。
 * @param {string} text
 * @returns {number} 根 `{` 的下标
 */
export function rootObjectStart(text) {
	const start = skipTrivia(text, 0);
	if (text[start] !== "{") {
		throw new Error("mc 配置的根不是 JSON 对象（必须以 `{` 开头）—— 空文件、只有注释、或数组根都会在这里被拦住");
	}
	return start;
}

/**
 * 读 mc 配置里某个键的数值。没有该键、或值不是数字 → null。
 * @param {string} text
 * @param {string} key 默认读执行阈值
 * @returns {number | null}
 */
export function readThreshold(text, key = MC_THRESHOLD_KEY) {
	const spans = findTopLevelKeys(text, key);
	if (spans.length === 0) return null;
	// JSON 对重复键取**最后一个**：读第一个会报出与 mc 实际生效值不同的数。
	const span = spans.at(-1);
	const raw = text.slice(span.valueStart, span.valueEnd).trim();
	// 空值（如 `"k": ,`）必须先拦：Number("") === 0，会误报「已设置 0%」。
	if (raw === "") return null;
	// 值可能是数字字面量（20）或字符串（"20"）—— 后者要把引号剥掉再取值。
	let value = raw;
	if (raw.startsWith('"')) {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	// 空字符串（`"k": ""`）也算未设置：Number("") === 0，会误报「已设置 0%」。
	if (typeof value === "string" && value.trim() === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * 就地写一个受管键：**所有**出现处都改成目标值（重复键时无论谁生效都是对的），
 * 没有则插到根对象开头。其余字节（用户注释、其它键）原样保留。
 * @param {string} text
 * @param {string} key
 * @param {number} value
 * @returns {string}
 */
function upsertOne(text, key, value) {
	let out = text;
	const spans = findTopLevelKeys(out, key);
	if (spans.length > 0) {
		// 从后往前替换：前面的偏移不会因为后面的长度变化而失效。
		for (let i = spans.length - 1; i >= 0; i--) {
			out = out.slice(0, spans[i].valueStart) + String(value) + out.slice(spans[i].valueEnd);
		}
		return out;
	}
	const open = rootObjectStart(out);
	const body = skipTrivia(out, open + 1);
	const empty = out[body] === "}";
	const insert = empty ? `\n  "${key}": ${value}\n` : `\n  "${key}": ${value},`;
	return out.slice(0, open + 1) + insert + out.slice(open + 1);
}

/**
 * 把阈值就地写进 jsonc 文本。
 * @param {string} text
 * @param {number} pct
 * @returns {string}
 */
export function upsertThreshold(text, pct) {
	return upsertOne(text, MC_THRESHOLD_KEY, pct);
}

/**
 * 多个键一起就地改写（本包管理的键全部写一遍）。
 * 与 `upsertThreshold` 一样保注释与其它键，只是循环调用。
 * @param {string} text
 * @param {Record<string, number>} settings 键 → 数值
 * @returns {string}
 */
export function upsertSettings(text, settings) {
	let out = text;
	for (const key of MC_MANAGED_KEYS) {
		const value = settings[key];
		if (value === undefined) continue;
		out = upsertOne(out, key, value);
	}
	return out;
}

/**
 * 决定 mc 配置要改哪些键。
 *
 * CLI 与自检**共用这一个函数** —— 不要把这段逻辑在自检里再写一遍：那样自检测的
 * 是复制品，CLI 真改坏了也不会红（第 1 层审查报的 P0 就是这么漏过去的）。
 *
 * 关键：文件**不存在**时，调用方把 `before` 给的是模板内容（值已经是目标值）。
 * 这时绝不能拿模板当「当前值」比较 —— 否则 plan 恒空，CLI 会报「已是目标值」
 * 却连文件都不创建，mc 仍跑默认 65%（新成员跑 apply 看到 ✓ 但什么都没发生）。
 *
 * @param {{existed: boolean, before: string, settings: Record<string, number>}} args
 * @returns {{key: string, from: number | null, to: number}[]}
 */
export function planMcApply({ existed, before, settings }) {
	const plan = [];
	for (const key of MC_MANAGED_KEYS) {
		const want = settings[key];
		if (want === undefined) continue;
		const from = existed ? readThreshold(before, key) : null;
		if (from !== want) plan.push({ key, from, to: want });
	}
	return plan;
}

/**
 * 校验不变式：mc 执行阈值必须 **严格低于** dsh 压缩阈值，且留够余量。
 *
 * 余量为什么必要：dsh 的压缩判定用的是 token-meter 的**估算值**，与 mc 用的
 * 计费值可能有偏差。实测 2026-09-29 两者吻合（都在 24.4–25.2% 触发），但
 * 留 2 个百分点以上可以避免两边同时动手（那等于白烧一次压缩 LLM 调用）。
 *
 * @param {number} mcPct mc 执行阈值（百分比）
 * @param {number} dshPct dsh 压缩阈值（百分比）
 * @param {number} minMargin 最小余量（百分点）
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkThresholdInvariant(mcPct, dshPct, minMargin = 2) {
	if (!Number.isFinite(mcPct)) return { ok: false, reason: `mc 阈值不是数字：${mcPct}` };
	if (!Number.isFinite(dshPct)) return { ok: false, reason: `dsh 阈值不是数字：${dshPct}` };
	if (mcPct < MC_THRESHOLD_MIN || mcPct > MC_THRESHOLD_MAX) {
		return { ok: false, reason: `mc 阈值 ${mcPct}% 超出 mc 允许范围 ${MC_THRESHOLD_MIN}–${MC_THRESHOLD_MAX}%（超出会被 mc 剪掉、回退默认 65%）` };
	}
	if (mcPct >= dshPct) {
		return {
			ok: false,
			reason: `mc 阈值(${mcPct}%) 不低于 dsh 压缩阈值(${dshPct}%)：dsh 会先动手，mc 排队的操作永远不执行（这正是 REQ-003 修的 bug）`,
		};
	}
	if (dshPct - mcPct < minMargin) {
		return { ok: false, reason: `余量只有 ${(dshPct - mcPct).toFixed(1)} 个百分点，小于 ${minMargin}：两边可能同时动手` };
	}
	return { ok: true };
}

/** 默认的 mc 配置模板（`team/mc-config.template.jsonc` 的内容，供初始化用）。 */
export function templatePath(packageRoot) {
	return path.join(packageRoot, "team", "mc-config.template.jsonc");
}

/** 读我们的模板里的阈值。 */
export function readTemplateThreshold(packageRoot) {
	return readThreshold(fs.readFileSync(templatePath(packageRoot), "utf8"));
}

/**
 * 读模板里**本包管理的全部键**（键 → 数值）。CLI 靠它决定写哪些键。
 * 值为非数字的键一律丢掉（不把脏值写进用户配置）。
 * @param {string} packageRoot
 * @returns {Record<string, number>}
 */
export function readTemplateSettings(packageRoot) {
	const text = fs.readFileSync(templatePath(packageRoot), "utf8");
	const out = {};
	for (const key of MC_MANAGED_KEYS) {
		const span = findTopLevelKey(text, key);
		if (span === null) continue;
		let raw = text.slice(span.valueStart, span.valueEnd).trim();
		if (raw.startsWith('"')) {
			try {
				raw = JSON.parse(raw);
			} catch {
				continue;
			}
		}
		const n = Number(raw);
		if (Number.isFinite(n)) out[key] = n;
	}
	return out;
}
