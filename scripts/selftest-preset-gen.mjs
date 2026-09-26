#!/usr/bin/env node
/**
 * 自检：team 预设生成 / 阈值校验 / 生效值回读。
 *
 * 盯的是原来那个 bug 的三层，以及它的后果：
 *   1. `/thrift` 改的阈值必须落到**真在跑**的那两行（agent.cordis.yml 里的
 *      compaction-basic / tool-result-pruner），而不是 profile patch ——
 *      预设是整份 entry list、没有 patch 层，profile patch 够不到它。
 *   2. 键名必须是插件认的（thresholdChars/headChars/tailChars），不是 overlay 的
 *      （pruneThresholdChars…）；写错键插件会直接 throw。
 *   3. 非法组合（head+标记+tail > threshold、retainRatio ≥ thresholdRatio）
 *      必须在**写出之前**被拦住 —— 这两个插件的 config 是加载期解析的，
 *      坏配置会让整个 dsh 起不来，而用户只是敲了一条 /thrift。
 *   4. `/thrift show` 显示的必须是真预设里的值；读不到就说读不到，不许拿
 *      默认值冒充「生效中」。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	PRUNE_MARKER,
	THRIFT_KEYS,
	generateTeamPreset,
	readEffectiveThrift,
	resolveThriftConfig,
} from "../lib/preset-gen.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * 找 dsh 自带的 standard 预设。找不到就跳过依赖它的那几节，
 * 并**明说跳过了什么** —— 不能只印「全部通过」。
 */
function findStandardPreset() {
	const roots = [
		process.env.DSH_MODULES,
		"C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai",
		path.join(os.homedir(), ".dsh", "profiles", "tauri", "node_modules", "@deepseek-ai"),
	].filter(Boolean);
	for (const root of roots) {
		const file = path.join(root, "dsh-agent-presets", "presets", "standard", "agent.cordis.yml");
		if (fs.existsSync(file)) return file;
	}
	return null;
}

// ── 1. 阈值换算与校验（纯函数，不依赖任何外部文件）──────────────────────────

{
	// 团队设置：窗口 128000，reserve 32768 → 0.744；keepRecent 20000 → 0.15625
	const cfg = resolveThriftConfig(
		{ compaction: { contextWindow: 128000, reserveTokens: 32768, keepRecentTokens: 20000 } },
		{},
	);
	assert.equal(cfg.thresholdRatio, 0.744, "thresholdRatio 没按 1 - reserve/window 算");
	assert.equal(cfg.retainRatio, 0.1563, "retainRatio 没按 keepRecent/window 算");
	// 没给 overlay 时，裁剪三值 = dsh 出厂默认（不是我们自己编的数）
	assert.equal(cfg.thresholdChars, 8192, "没给 overlay 时应保持出厂 8192");
	assert.equal(cfg.headChars, 4096, "没给 overlay 时应保持出厂 4096");
	assert.equal(cfg.tailChars, 1024, "没给 overlay 时应保持出厂 1024");
	console.log("✓ 阈值换算 + 出厂默认");
}

{
	// overlay 覆盖裁剪值要真的生效
	const cfg = resolveThriftConfig({ compaction: {} }, { pruneThresholdChars: 40000 });
	assert.equal(cfg.thresholdChars, 40000, "overlay 的 pruneThresholdChars 没生效");
	console.log("✓ overlay 覆盖生效");
}

{
	// 这两条是「坏配置会让 dsh 起不来」的守门人，必须真的会抛
	assert.throws(
		() => resolveThriftConfig({ compaction: {} }, { pruneThresholdChars: 1000, pruneHeadChars: 4096, pruneTailChars: 1024 }),
		/超过 thresholdChars/,
		"headChars+标记+tailChars 超阈值时必须拒绝（插件加载期会 throw）",
	);
	assert.throws(
		() => resolveThriftConfig({ compaction: { contextWindow: 128000, reserveTokens: 115200, keepRecentTokens: 25600 } }, {}),
		/必须小于 thresholdRatio/,
		"retainRatio ≥ thresholdRatio 时必须拒绝（compaction-basic 会 throw）",
	);
	assert.throws(
		() => resolveThriftConfig({ compaction: {} }, { pruneHeadChars: -1 }),
		/必须是 ≥ 0 的整数/,
		"负数头长必须拒绝",
	);
	assert.throws(
		() => resolveThriftConfig({ compaction: {} }, { pruneThresholdChars: 1.5 }),
		/必须是 ≥ 1 的整数/,
		"小数阈值必须拒绝（插件只收整数）",
	);
	// ratio 的 (0,1] 是插件同一条 assertRatio 管的 —— `/thrift compact 2` 与手改 overlay 都能写进来
	assert.throws(
		() => resolveThriftConfig({ compaction: {} }, { compactThresholdRatio: 2 }),
		/\(0, 1\] 内的数/,
		"thresholdRatio 超出 (0,1] 必须拒绝（compaction-basic 加载期会 throw）",
	);
	assert.throws(
		() => resolveThriftConfig({ compaction: {} }, { compactThresholdRatio: "abc" }),
		/\(0, 1\] 内的数/,
		"thresholdRatio 不是数字必须拒绝",
	);
	assert.throws(
		() => resolveThriftConfig({ compaction: {} }, { compactThresholdRatio: 0 }),
		/\(0, 1\] 内的数/,
		"thresholdRatio 为 0 必须拒绝",
	);
	console.log("✓ 非法配置一律在写出前拦住");
}

{
	// 标记长度是插件自己算的；我们算错就等于校验失效
	assert.equal(Array.from(PRUNE_MARKER).length, 39, "PRUNE_MARKER 字符数变了，校验公式要跟着改");
	console.log("✓ PRUNE_MARKER 长度与校验公式一致");
}

// ── 2. overlay 键名 → 插件键名（写错就是原来那个 bug）───────────────────────

{
	assert.equal(THRIFT_KEYS.pruneThresholdChars, "thresholdChars");
	assert.equal(THRIFT_KEYS.pruneHeadChars, "headChars");
	assert.equal(THRIFT_KEYS.pruneTailChars, "tailChars");
	assert.equal(THRIFT_KEYS.compactThresholdRatio, "thresholdRatio");
	console.log("✓ overlay 键名映射到插件真键名");
}

// ── 3. 拿真 standard 预设生成（生成逻辑必须动到真在跑的那两行）─────────────

const presetPath = findStandardPreset();
if (!presetPath) {
	console.log("… 跳过预设生成检查：找不到 dsh 自带的 standard 预设（设 DSH_MODULES 可指定）");
	console.log("\n仅通过第 1~2 节（纯函数）✓");
	console.log("⚠️ 未验证：生成出来的预设是否真改到 compaction-basic / tool-result-pruner 两行、");
	console.log("   是否与 standard 逐字可还原、回读是否读得准 —— 需要 dsh 安装树。");
	process.exit(0);
}

const pristine = fs.readFileSync(presetPath, "utf8");
// 格式坏了要报清楚是哪个文件，而不是抛一个裸的 SyntaxError
let teamSettings;
try {
	teamSettings = JSON.parse(fs.readFileSync(path.join(ROOT, "team", "agent-settings.json"), "utf8"));
} catch (error) {
	throw new Error(`读不了 team/agent-settings.json：${error.message}`);
}

{
	// 只给 settings、不给 overlay：只有 compaction-basic 一行被改，裁剪保持出厂
	const gen = generateTeamPreset(pristine, { settings: teamSettings });
	assert.equal(gen.changed, 1, `只该改 compaction-basic 一行，实际改了 ${gen.changed} 处`);

	const live = readEffectiveThrift(gen.text);
	// 断言的是**团队设置里声明的值真被写进预设**，不是某个写死的数字。
	// 以前这里写死 0.9/0.2 —— 那是「缺 contextWindow 时算出来的错误值」，
	// 把一个 bug 锁在了测试里（它一直绿着，而压缩一直不触发）。
	const expectRatio = teamSettings.compaction.compactThresholdRatio;
	const expectRetain = Number((teamSettings.compaction.keepRecentTokens / teamSettings.compaction.contextWindow).toFixed(4));
	assert.equal(live.thresholdRatio, expectRatio, "团队声明的阈值比没写进预设");
	assert.equal(live.retainRatio, expectRetain, "retainRatio 没按真实窗口换算");
	// 关键回归：阈值必须**够得着**真实上下文，否则压缩等于关着。
	// 2026-09-26 实测最大地板 343,453，而当时阈值是 460,800 → 从未触发。
	const thresholdTokens = teamSettings.compaction.contextWindow * live.thresholdRatio;
	assert.ok(
		thresholdTokens <= 400_000,
		`阈值 ${Math.round(thresholdTokens)} tokens 太高 —— 实测最大地板 343,453，这样压缩永远不触发`,
	);
	assert.ok(live.retainRatio < live.thresholdRatio, "retainRatio 必须小于 thresholdRatio（插件会抛错）");
	// 关键：没给裁剪 overlay 时**不许**动裁剪器
	assert.equal(live.thresholdChars, 8192, "没给裁剪 overlay 时不该改 thresholdChars");
	assert.equal(live.headChars, 4096, "没给裁剪 overlay 时不该改 headChars");
	assert.equal(live.tailChars, 1024, "没给裁剪 overlay 时不该改 tailChars");

	// 生成物必须能逐字还原成 standard —— 这是「预设没被改坏」最直接的证据
	assert.ok(gen.text.includes("    - id: compaction-basic"), "生成物丢了 compaction-basic 行");
	assert.notEqual(gen.text, pristine, "生成物和 standard 一样，说明什么都没改");
	console.log("✓ 生成预设：改到真在跑的行，且不碰不该碰的");
}

{
	// 给了裁剪 overlay：必须落到 tool-result-pruner 那一行，且用插件认的键名
	const gen = generateTeamPreset(pristine, { settings: teamSettings, overlay: { pruneThresholdChars: 40000 } });
	const lines = gen.text.split("\n");
	const at = lines.findIndex((l) => l.includes("tool-result-pruner"));
	assert.ok(at >= 0, "生成物里找不到 tool-result-pruner 行");
	const block = lines.slice(at, at + 6).join("\n");
	assert.match(block, /thresholdChars: 40000/, "裁剪阈值没写进 pruner 行的 config");
	assert.match(block, /headChars: 4096/, "pruner 行丢了 headChars");
	assert.match(block, /tailChars: 1024/, "pruner 行丢了 tailChars");
	// 绝不能出现 overlay 那套键名 —— 插件对未知键直接 throw
	assert.doesNotMatch(gen.text, /pruneThresholdChars|pruneHeadChars|pruneTailChars/, "预设里混进了 overlay 键名（插件会 throw）");
	assert.doesNotMatch(gen.text, /tool-result-pruner[\s\S]{0,200}compactThresholdRatio/, "把 compaction 的键写到 pruner 行里了");

	const live = readEffectiveThrift(gen.text);
	assert.equal(live.thresholdChars, 40000, "回读到的 thresholdChars 不是 40000");
	console.log("✓ 裁剪 overlay 落进 pruner 行，用的是插件认的键名");
}

{
	// persona 也要一起进去，且三者同时改时互不覆盖（曾经在这里把前一处改动静默吃掉）
	const gen = generateTeamPreset(pristine, {
		settings: { ...teamSettings, persona: "你是团队助手。" },
		overlay: { pruneThresholdChars: 40000 },
	});
	assert.equal(gen.changed, 3, `settings+overlay+persona 该改 3 处，实际 ${gen.changed}`);
	assert.match(gen.text, /你是团队助手。/, "persona 没写进去");
	const live = readEffectiveThrift(gen.text);
	assert.equal(live.thresholdChars, 40000, "同时改多处时裁剪覆盖丢了（改动互相覆盖了）");
	assert.equal(live.thresholdRatio, teamSettings.compaction.compactThresholdRatio, "同时改多处时压缩阈值丢了");
	console.log("✓ 多处改动互不覆盖");
}

{
	// standard 预设结构变了要报错，不能瞎改
	assert.throws(
		() => generateTeamPreset("没这段内容", { settings: teamSettings }),
		/没找到/,
		"standard 结构变了却没报错",
	);
	console.log("✓ 找不到目标行时报错而非静默");
}

{
	assert.throws(
		() => generateTeamPreset(pristine, { settings: teamSettings, overlay: { pruneThresholdChars: 1000, pruneHeadChars: 4096, pruneTailChars: 1024 } }),
		/超过 thresholdChars/,
		"生成阶段没拦住坏 overlay（写出去 dsh 就起不来了）",
	);
	console.log("✓ 生成阶段拦住会让 dsh 起不来的 overlay");
}

// ── 4. 回读：必须读真值，且不能被嵌套同名键骗过 ─────────────────────────────

{
	const gen = generateTeamPreset(pristine, { settings: teamSettings });
	const live = readEffectiveThrift(gen.text);
	assert.deepEqual(
		live,
		{
			thresholdRatio: teamSettings.compaction.compactThresholdRatio,
			retainRatio: Number((teamSettings.compaction.keepRecentTokens / teamSettings.compaction.contextWindow).toFixed(4)),
			thresholdChars: 8192,
			headChars: 4096,
			tailChars: 1024,
		},
		"回读的生效值与写出值不一致",
	);

	// 嵌套的同名键（例如将来加 modelPolicies）不能盖掉本行的直接子键。
	// 只按「缩进比 id 深」扫是**不够的** —— 实测里层更深的键确实会盖掉外层。
	const decoyAfter = gen.text.replace(
		"      config:\n        thresholdChars: 8192",
		"      config:\n        thresholdChars: 8192\n        inner:\n          thresholdChars: 99999",
	);
	assert.equal(readEffectiveThrift(decoyAfter).thresholdChars, 8192, "嵌套在后的同名键盖掉了真值");

	const decoyBefore = gen.text.replace(
		"      config:\n        thresholdChars: 8192",
		"      config:\n        modelPolicies:\n          - thresholdChars: 99999\n        thresholdChars: 8192",
	);
	assert.equal(readEffectiveThrift(decoyBefore).thresholdChars, 8192, "嵌套在前的同名键盖掉了真值");

	// 读不出来时要说读不出来，不能瞎给
	assert.equal(readEffectiveThrift("hello"), undefined, "垃圾输入该返回 undefined");
	assert.equal(readEffectiveThrift(pristine), undefined, "standard 原版（compaction-basic 无 config）该返回 undefined");
	console.log("✓ 回读准、抗嵌套诱饵、读不到就说读不到");
}

// ── 5. /thrift show 显示的是真预设里的值 ────────────────────────────────────

{
	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-presetgen-"));
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tempHome;
	try {
		const presetDir = path.join(tempHome, ".agent-presets", "team");
		fs.mkdirSync(presetDir, { recursive: true });
		// 写一份「overlay 想要 40000，但预设里仍是 8192」的状态：
		// /thrift show 必须报 8192（真在跑的），并把 40000 列成「待应用」。
		fs.writeFileSync(path.join(presetDir, "agent.cordis.yml"), generateTeamPreset(pristine, { settings: teamSettings }).text, "utf8");
		const overlayFile = path.join(tempHome, "team-workflow", "thrift.json");
		fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
		fs.writeFileSync(overlayFile, JSON.stringify({ pruneThresholdChars: 40000 }), "utf8");

		const { installThrift } = await import("../lib/thrift.js");
		const ctx = { logger: { info() {}, warn() {}, error() {} }, on: () => () => {} };
		const shown = installThrift(ctx, { defaults: {} }).describe();

		assert.match(shown, /生效中/, "/thrift show 没标出「生效中」那一段");
		assert.match(shown, /pruner 阈值\/头\/尾：8192 \/ 4096 \/ 1024/, "/thrift show 没显示真预设里的裁剪值");
		assert.match(shown, /待应用 overlay/, "/thrift show 没把 overlay 与生效值分开");
		assert.match(shown, /pruneThresholdChars=40000/, "待应用那段没列出 overlay 实际写的键");
		// 不许把 overlay 的值说成生效值
		assert.doesNotMatch(shown, /pruner 阈值\/头\/尾：40000/, "把还没应用的 overlay 值说成了生效值");

		// 没有 overlay 文件时，要说「没有」，不能拿默认值冒充待应用
		fs.rmSync(overlayFile);
		const shown2 = installThrift(ctx, { defaults: {} }).describe();
		assert.match(shown2, /没有 overlay/, "没 overlay 时该明说没有");
		assert.doesNotMatch(shown2, /待应用 overlay/, "没 overlay 却列了待应用");
		console.log("✓ /thrift show 显示真值、区分待应用");
	} finally {
		if (prevHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevHome;
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}

console.log("\n全部通过 ✓");
