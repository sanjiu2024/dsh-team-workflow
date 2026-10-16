/**
 * 成员的收工回报（REQ-016 · A8）。
 *
 * 为什么要有固定格式：成员收工时那段话是小队唯一的「交付说明」，但每个成员写法都不一样 ——
 * 主 agent 想汇总就得去读转录（转录还可能被压缩掉）。这里把它压成四段：
 * **交付物 / 证据 / 没做的 / 卡点**。结构化之后 `squad_status`、面板、`squad_review` 都能直接用。
 *
 * **模型自报不可靠**：解析不出来就 `parsed: false` + 原文留着 —— 不编、不猜、不假装有交付物。
 * 这份东西是「成员自己说的」，不是验证过的结论；要验证得派审查成员（`squad_review`）。
 */

/** 四段的键（顺序就是展示顺序）。 */
export const REPORT_FIELDS = ["deliverables", "evidence", "todo", "blockers"];

/** 展示用的中文标签。 */
export const REPORT_LABELS = {
	deliverables: "交付物",
	evidence: "证据",
	todo: "没做的",
	blockers: "卡点",
};

/** 每个键认哪些写法（成员自由发挥时常见的那几种）。 */
const ALIASES = {
	deliverables: ["交付物", "交付", "产出", "做了什么", "改了哪些文件", "改动"],
	evidence: ["证据", "验证", "怎么验证的", "怎么验的", "测试"],
	todo: ["没做的", "没做", "未做", "遗留", "还没做", "待办"],
	blockers: ["卡点", "阻塞", "风险", "问题"],
};

/** 小标题行的识别：`## 交付物` / `**交付物**` / `- 交付物：` / `交付物:` 都认。 */
const HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:[-*+]\s+)?(?:\*\*)?\s*([^\s*：:]{1,12})\s*(?:\*\*)?\s*[：:]?\s*(.*)$/;

/** 标签 → 键（先长后短，免得「没做的」被「做」抢走）。 */
const BY_LABEL = new Map();
for (const key of REPORT_FIELDS) {
	for (const label of ALIASES[key]) BY_LABEL.set(label, key);
}
const LABEL_KEYS = [...BY_LABEL.keys()].sort((a, b) => b.length - a.length);

/** 一行是不是小标题？是就返回 `{ key, rest }`，不是返回 undefined。 */
function headingOf(line) {
	const m = HEADING.exec(line);
	if (!m) return undefined;
	const label = m[1];
	for (const candidate of LABEL_KEYS) {
		if (label === candidate) return { key: BY_LABEL.get(candidate), rest: m[2] ?? "" };
	}
	return undefined;
}

/**
 * 把成员最后一段话解析成四段。
 *
 * 认不出任何一段小标题 → `parsed: false`（原文照留，别硬塞进「交付物」里）。
 * 认出一段就算 `parsed: true`；没认出的那几段留空字符串（**空 ≠ 没有**，是「它没说」）。
 */
export function parseReport(text) {
	const raw = String(text ?? "").trim();
	const report = { parsed: false, raw };
	for (const key of REPORT_FIELDS) report[key] = "";
	if (raw === "") return report;

	let current;
	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		const hit = headingOf(line);
		// 只认**第一次**出现的每个小标题：后面再出现同名标题（比如成员在正文里又写了一遍）不覆盖
		if (hit && report[hit.key] === "" && current !== hit.key) {
			current = hit.key;
			report[hit.key] = hit.rest.trim();
			report.parsed = true;
			continue;
		}
		if (current !== undefined) {
			report[current] = report[current] === "" ? line.trim() : `${report[current]}\n${line.trim()}`;
		}
	}
	for (const key of REPORT_FIELDS) report[key] = report[key].trim();
	return report;
}

/**
 * 一行紧凑摘要（黑板条目、状态行用）。
 * 没解析出来就回原文第一行 —— 宁可丑，也别显示成「什么都没做」。
 */
export function formatReport(report) {
	if (!report || typeof report !== "object") return "";
	if (report.parsed !== true) {
		const first = String(report.raw ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
		return first.trim();
	}
	const parts = [];
	for (const key of REPORT_FIELDS) {
		const value = String(report[key] ?? "").replace(/\s*\n\s*/g, " / ").trim();
		if (value !== "") parts.push(`${REPORT_LABELS[key]}：${value}`);
	}
	return parts.join("｜");
}
