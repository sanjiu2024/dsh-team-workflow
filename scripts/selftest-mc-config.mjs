#!/usr/bin/env node
/**
 * 自检：magic-context 与 dsh 压缩阈值的协调（REQ-003）。
 *
 * 三段：
 *   1. JSONC 扫描器（注释与字符串安全的顶层键定位 / 就地改写）
 *   2. 阈值不变式（mc 必须低于 dsh，且留余量、在 mc 的允许范围内）
 *   3. **仓库自身的一致性**：本包发出去的两个阈值真满足不变式
 *      （改错了这里，全团队就会回到「dsh 一天压 83 次、mc 永远不动」）
 *
 * 为什么必须有第 3 段：这个 bug 的形态是「两个配置各自都合法、合起来才错」。
 * 单看 mc 的 65% 没问题、单看 dsh 的 25% 也没问题，凑一起就让 mc 空转。
 * 只有把两个值放在一条断言里比，才能在改坏时立刻红。
 *
 *   node scripts/selftest-mc-config.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const {
	MC_PROACTIVE_OFFSET,
	MC_THRESHOLD_KEY,
	MC_THRESHOLD_MAX,
	MC_THRESHOLD_MIN,
	checkThresholdInvariant,
	findTopLevelKey,
	mcConfigPath,
	MC_MANAGED_KEYS,
	findTopLevelKeys,
	readTemplateSettings,
	readTemplateThreshold,
	planMcApply,
	readThreshold,
	rootObjectStart,
	upsertSettings,
	upsertThreshold,
} = await import(new URL("lib/mc-config.js", ROOT).href);

/** JSON.parse 包一层：坏文件时说的是哪份文件，而不是裸 SyntaxError */
function parseJson(text, what) {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`${what} 解析失败：${err?.message ?? err}`);
	}
}

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── 1. JSONC 扫描器 ─────────────────────────────────────────────────────────

check("findTopLevelKey：找到顶层键的值区间", () => {
	const t = `{\n  "execute_threshold_percentage": 20,\n  "b": 1\n}`;
	const span = findTopLevelKey(t, MC_THRESHOLD_KEY);
	assert.ok(span, "必须找得到");
	assert.equal(t.slice(span.valueStart, span.valueEnd), "20");
});

check("findTopLevelKey：**不**匹配嵌套键（否则会改错 mc 的 per-model 配置）", () => {
	const t = `{\n  "models": {\n    "execute_threshold_percentage": 55\n  }\n}`;
	assert.equal(findTopLevelKey(t, MC_THRESHOLD_KEY), null, "嵌套同名键不能被当成顶层键");
});

check("findTopLevelKey：字符串里的同名内容不算键", () => {
	const t = `{\n  "note": "execute_threshold_percentage: 99",\n  "x": 1\n}`;
	assert.equal(findTopLevelKey(t, MC_THRESHOLD_KEY), null, "字符串里的文本不是键");
});

check("findTopLevelKey：注释里的同名内容不算键", () => {
	const t = `{\n  // "execute_threshold_percentage": 30\n  "x": 1\n}`;
	assert.equal(findTopLevelKey(t, MC_THRESHOLD_KEY), null, "注释里的不是键");
	const t2 = `{\n  /* "execute_threshold_percentage": 30,\n     more */\n  "x": 1\n}`;
	assert.equal(findTopLevelKey(t2, MC_THRESHOLD_KEY), null, "块注释里的不是键");
});

check("findTopLevelKey：字符串里的转义引号不打断扫描", () => {
	const t = `{\n  "a": "he said \\"x\\" ok",\n  "execute_threshold_percentage": 21\n}`;
	const span = findTopLevelKey(t, MC_THRESHOLD_KEY);
	assert.ok(span, "转义引号不该让扫描器错位");
	assert.equal(t.slice(span.valueStart, span.valueEnd), "21");
});

check("findTopLevelKey：值里含花括号也不会截断", () => {
	const t = `{\n  "a": { "b": [1, 2] },\n  "execute_threshold_percentage": 22\n}`;
	const span = findTopLevelKey(t, MC_THRESHOLD_KEY);
	assert.equal(t.slice(span.valueStart, span.valueEnd), "22");
});

check("readThreshold：读得到 / 读不到回 null", () => {
	assert.equal(readThreshold(`{ "execute_threshold_percentage": 20 }`), 20);
	assert.equal(readThreshold(`{ /* c */ "execute_threshold_percentage" : 35 }`), 35);
	assert.equal(readThreshold(`{ "x": 1 }`), null, "没这个键要回 null");
	assert.equal(readThreshold(`{ "execute_threshold_percentage": "20" }`), 20, "数字字符串也认（mc 会自己校验）");
	assert.equal(readThreshold(`{ "execute_threshold_percentage": "abc" }`), null);
});

check("upsertThreshold：没有该键时插入，且**保留其它字节**（注释/用户键）", () => {
	const t = `{\n  // 用户注释\n  "historian": {\n    "pi": { "model": "new-api/tier-std" }\n  }\n}`;
	const out = upsertThreshold(t, 20);
	assert.equal(readThreshold(out), 20);
	assert.ok(out.includes("// 用户注释"), "注释必须保留");
	assert.ok(out.includes("new-api/tier-std"), "用户键必须保留");
	// 原内容整体还在（只多插了一行）
	assert.ok(out.includes(`"historian": {`), "historian 块要在");
	assert.ok(!out.includes(",}"), "不能产生尾逗号（jsonc-parser 默认不容忍）");
});

check("upsertThreshold：已有该键时**就地替换**，不重复插入", () => {
	const t = `{\n  "execute_threshold_percentage": 65,\n  "x": 1\n}`;
	const out = upsertThreshold(t, 20);
	assert.equal(readThreshold(out), 20);
	assert.equal(out.split(MC_THRESHOLD_KEY).length - 1, 1, "不能出现两次这个键");
	assert.ok(out.includes(`"x": 1`), "其它键保留");
});

check("upsertThreshold：空对象 `{}` 不产生尾逗号", () => {
	const out = upsertThreshold("{}", 20);
	assert.equal(readThreshold(out), 20);
	assert.ok(!out.includes(",}"), `空对象插入后不能有尾逗号，实际：${out}`);
	const parsed = parseJson(out, "upsertThreshold 的结果");
	assert.equal(typeof parsed, "object", "结果必须是合法 JSON 对象");
});

check("upsertThreshold：幂等（连写两次结果一致）", () => {
	const t = `{\n  "a": 1\n}`;
	const once = upsertThreshold(t, 20);
	const twice = upsertThreshold(once, 20);
	assert.equal(twice, once, "重复 apply 不应继续改动文件");
});

check("upsertThreshold：不是对象时明确报错，不静默写坏", () => {
	assert.throws(() => upsertThreshold("[1,2]", 20), /根不是 JSON 对象/);
});

// ── 2. 阈值不变式 ───────────────────────────────────────────────────────────

check("不变式：mc 20% < dsh 25% 通过", () => {
	assert.equal(checkThresholdInvariant(20, 25).ok, true);
});

check("不变式：mc ≥ dsh 必须判失败（这就是 REQ-003 的 bug 本身）", () => {
	const r = checkThresholdInvariant(65, 25);
	assert.equal(r.ok, false);
	assert.match(r.reason, /dsh 会先动手/, "理由要说清后果");
});

check("不变式：余量不足要判失败（两边可能同时动手）", () => {
	assert.equal(checkThresholdInvariant(24, 25).ok, false, "只差 1 个点太近");
	assert.equal(checkThresholdInvariant(23, 25).ok, true, "差 2 个点可以");
});

check("不变式：超出 mc 的允许范围要判失败（会被 mc 剪掉回退默认）", () => {
	assert.equal(checkThresholdInvariant(MC_THRESHOLD_MIN - 1, 90).ok, false, `低于 ${MC_THRESHOLD_MIN}%`);
	assert.equal(checkThresholdInvariant(MC_THRESHOLD_MAX + 1, 95).ok, false, `高于 ${MC_THRESHOLD_MAX}%`);
});

check("不变式：非数字输入不判通过（不能靠 NaN 比较蒙过去）", () => {
	assert.equal(checkThresholdInvariant(Number.NaN, 25).ok, false);
	assert.equal(checkThresholdInvariant(20, Number.NaN).ok, false);
	assert.equal(checkThresholdInvariant(undefined, undefined).ok, false);
});

check("主动线 = 执行阈值 − 2（bundle 的 PROACTIVE_TRIGGER_OFFSET_PERCENTAGE）", () => {
	assert.equal(MC_PROACTIVE_OFFSET, 2, "mc 改了偏移量的话，注释与文档都要跟着改");
});

// ── 1b. 第 1/3 层审查报出的缺陷（都真出现过，逐条钉住） ──────────────────

check("P1：根不是对象时**拒绝**，不能把键插进数组/注释里", () => {
	// 修前：indexOf("{") 只找第一个花括号，会静默写出坏 JSON 却报成功
	assert.throws(() => upsertThreshold("[{\"a\":1}]", 20), /根不是 JSON 对象/, "数组根必须拒绝");
	assert.throws(() => upsertThreshold("", 20), /根不是 JSON 对象/, "空文件必须拒绝");
	assert.throws(() => upsertThreshold("// just a comment", 20), /根不是 JSON 对象/, "纯注释必须拒绝");
	// 注释里有 { 时，键必须插进**根对象**、不能插进注释
	const out = upsertThreshold("// 见 { config }\n{\"a\":1}", 20);
	assert.ok(out.startsWith("// 见 { config }"), "注释原样保留");
	assert.equal(readThreshold(out), 20, "键要真的写进去");
	assert.ok(JSON.parse(out.replace(/^\/\/[^\n]*\n/, "")), "结果是合法 JSON");
});

check("P1：rootObjectStart 跳过 BOM 与注释后定位根 `{`", () => {
	assert.equal(rootObjectStart("{\"a\":1}"), 0);
	assert.equal(rootObjectStart("\uFEFF{\"a\":1}"), 1, "BOM 要跳过");
	assert.equal(rootObjectStart("// c\n{\"a\":1}"), 5, "行注释要跳过");
	assert.equal(rootObjectStart("/* c */ {\"a\":1}"), 8, "块注释要跳过");
});

check("P1：值后的行内注释必须保留（修前会被一起抹掉）", () => {
	const out = upsertThreshold("{\"execute_threshold_percentage\": 20 /* 为何是 20 */}", 30);
	assert.equal(readThreshold(out), 30, "值要改到");
	assert.ok(out.includes("/* 为何是 20 */"), "行内注释不能被删，实际：" + out);
});

check("P2：重复键 → 全部改成目标值（JSON 取最后一个，只改第一个会「改了但没生效」）", () => {
	const dup = "{\"execute_threshold_percentage\": 65, \"x\":1, \"execute_threshold_percentage\": 70}";
	assert.equal(readThreshold(dup), 70, "读要取最后一个（与 JSON 语义一致）");
	const out = upsertThreshold(dup, 20);
	assert.equal(readThreshold(out), 20, "写完后生效值必须是 20");
	assert.equal(findTopLevelKeys(out, "execute_threshold_percentage").length, 2, "两处都要在位（不做去重，避免破坏用户结构）");
});

check("P2：空值读成 null（Number('') === 0 会误报「已设置 0%」）", () => {
	assert.equal(readThreshold("{\"execute_threshold_percentage\": }"), null);
	assert.equal(readThreshold("{\"execute_threshold_percentage\": \"\"}"), null);
	assert.equal(readThreshold("{\"execute_threshold_percentage\": \"abc\"}"), null);
});

check("P0：planMcApply 在文件不存在时**必须**给出计划（否则 apply 会假报成功）", () => {
	const settings = { execute_threshold_percentage: 20, history_budget_percentage: 0.45 };
	// 这是 CLI 里 before=模板 的场景：照抄模板比大小会得到空计划 → 报「已是目标值」却不写文件
	const plan = planMcApply({ existed: false, before: "{\"execute_threshold_percentage\": 20, \"history_budget_percentage\": 0.45}", settings });
	assert.equal(plan.length, 2, "文件不存在时两个键都必须进计划，实际 " + plan.length);
	assert.deepEqual(plan.map((x) => x.key).sort(), ["execute_threshold_percentage", "history_budget_percentage"]);
	assert.ok(plan.every((x) => x.from === null), "不存在的键 from 应为 null");
});

check("P0：planMcApply 在值已达标时给出空计划（幂等，不重复写盘）", () => {
	const before = "{\"execute_threshold_percentage\": 20, \"history_budget_percentage\": 0.45}";
	const plan = planMcApply({ existed: true, before, settings: { execute_threshold_percentage: 20, history_budget_percentage: 0.45 } });
	assert.deepEqual(plan, [], "已达标就该空计划");
});

check("P0：planMcApply 只报真正要变的键", () => {
	const before = "{\"execute_threshold_percentage\": 65}";
	const plan = planMcApply({ existed: true, before, settings: { execute_threshold_percentage: 20, history_budget_percentage: 0.45 } });
	assert.deepEqual(plan.map((x) => x.key), ["execute_threshold_percentage", "history_budget_percentage"]);
	assert.equal(plan[0].from, 65, "要报出旧值供命令行显示");
	assert.equal(plan[1].from, null, "缺的键 from 为 null");
});

// ── 2b. 多键一起写（补偿键靠它） ─────────────────────────────────────────

check("upsertSettings：一次写多个键，且保留注释与用户键", () => {
	const t = `{
  // 用户注释
  "historian": { "pi": { "model": "x/y" } }
}`;
	const out = upsertSettings(t, { execute_threshold_percentage: 20, history_budget_percentage: 0.45 });
	assert.equal(readThreshold(out), 20);
	assert.equal(readThreshold(out, "history_budget_percentage"), 0.45);
	assert.ok(out.includes("// 用户注释"), "注释保留");
	assert.ok(out.includes("x/y"), "用户键保留");
	assert.equal(out.split("execute_threshold_percentage").length - 1, 1, "键只出现一次");
	assert.equal(out.split("history_budget_percentage").length - 1, 1, "键只出现一次");
});

check("upsertSettings：幂等（连写两次结果一致）", () => {
	const once = upsertSettings("{}", { execute_threshold_percentage: 20, history_budget_percentage: 0.45 });
	const twice = upsertSettings(once, { execute_threshold_percentage: 20, history_budget_percentage: 0.45 });
	assert.equal(twice, once, "重复 apply 不该继续改动");
});

check("upsertSettings：未定义的键跳过，不写 undefined 进配置", () => {
	const out = upsertSettings("{}", { execute_threshold_percentage: 20 });
	assert.ok(!out.includes("undefined"), `不能写入 undefined：${out}`);
	assert.ok(!out.includes("history_budget_percentage"), "没给的键不写");
});

check("history 预算补偿：模板值让**绝对预算**与改前同量级（不是砍预算）", () => {
	const t = readTemplateSettings(fileURLToPath(ROOT));
	const pct = t.execute_threshold_percentage;
	const hist = t.history_budget_percentage;
	assert.ok(Number.isFinite(pct), "模板要有执行阈值");
	assert.ok(Number.isFinite(hist), "模板要有 history_budget_percentage（20% 的配套补偿，删了会让 mc 注入历史的能力退化到 3%）");
	const now = 512000 * (pct / 100) * hist;
	const before = 512000 * 0.65 * 0.15;
	assert.ok(
		now > before * 0.8,
		`history 绝对预算退化太多：${Math.round(now)} vs 改前 ${Math.round(before)}（要求 ≥80%）`,
	);
	assert.ok(hist <= 0.5, `history_budget_percentage 超过 mc 的 schema 上限 0.5：${hist}`);
});

check("history_budget_percentage 是受管键（CLI 才会写它）", () => {
	assert.ok(MC_MANAGED_KEYS.includes("execute_threshold_percentage"));
	assert.ok(MC_MANAGED_KEYS.includes("history_budget_percentage"), "补偿键必须在受管列表里，否则 mc apply 写不进去");
});

// ── 3. 仓库自身一致性（这个 bug 的真防线） ──────────────────────────────────

check("仓库：模板里的 mc 阈值与 agent-settings 的 dsh 阈值真满足不变式", () => {
	const templateFile = new URL("../team/mc-config.template.jsonc", import.meta.url);
	assert.ok(fs.existsSync(templateFile), "缺 team/mc-config.template.jsonc（mc apply 就没东西可写）");
	const mcPct = readTemplateThreshold(fileURLToPath(ROOT));
	assert.ok(mcPct !== null, "模板里必须有 execute_threshold_percentage");
	const settings = parseJson(fs.readFileSync(new URL("../team/agent-settings.json", import.meta.url), "utf8"), "team/agent-settings.json");
	const dshPct = Number(settings.compaction.compactThresholdRatio) * 100;
	assert.ok(Number.isFinite(dshPct), "team/agent-settings.json 缺 compactThresholdRatio");
	const verdict = checkThresholdInvariant(mcPct, dshPct);
	assert.equal(verdict.ok, true, `发出去的配置自相矛盾：${verdict.reason ?? ""}`);
});

check("仓库：模板里的解释注释还在（它解释了为什么必须压到 20%）", () => {
	const text = fs.readFileSync(new URL("../team/mc-config.template.jsonc", import.meta.url), "utf8");
	assert.ok(text.includes("REQ-003"), "模板要指向 REQ-003，否则后人不知道为什么是 20");
	assert.ok(/低于/.test(text) && /dsh/.test(text), "模板要写清「必须低于 dsh」这条不变式");
});

check("仓库：mcConfigPath 落在 mc 真正读的位置", () => {
	const p = mcConfigPath("/home/x");
	assert.equal(p.replace(/\\/g, "/"), "/home/x/.config/cortexkit/magic-context.jsonc");
});

// ── 4. 端到端：在临时 home 上真跑一次改写 ───────────────────────────────────

check("端到端：带注释与用户键的真实配置，改写后 mc 真能读出 20 且用户键不丢", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-config-selftest-"));
	try {
		const file = mcConfigPath(tmp);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`{\n  // 用户注释：historian 为什么这么配\n  "historian": {\n    "pi": { "model": "new-api/tier-std" }\n  }\n}\n`,
			"utf8",
		);
		const before = fs.readFileSync(file, "utf8");
		const after = upsertThreshold(before, 20);
		fs.writeFileSync(file, after, "utf8");
		const reread = fs.readFileSync(file, "utf8");
		assert.equal(readThreshold(reread), 20, "写进去要能读回来");
		assert.ok(reread.includes("用户注释"), "注释保留");
		assert.ok(reread.includes("new-api/tier-std"), "用户键保留");
		// 只多了一行键值
		assert.equal(reread.split("\n").length, before.split("\n").length + 1, "只应多插入一行");
		// 幂等
		assert.equal(upsertThreshold(reread, 20), reread, "再写一次不该变");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：JSONC 就地改写（保注释/防嵌套/防尾逗号）/ 阈值不变式 / 仓库配置自洽");
}
