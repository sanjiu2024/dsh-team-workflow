/**
 * team 预设的生成与校验（纯文本进、纯文本出，好单独自检）。
 *
 * 为什么值得单独一处：team 预设是 dsh 挂载 agent 的入口，写坏一个键整个 dsh
 * 起不来 —— 裁剪器的 `resolveConfig` 对未知键和非法组合都**直接 throw**。
 *
 * 这也是原来 `/thrift` 那条路的病根：它把阈值写进 profile patch，目标是
 * row `dsh-team-workflow`、键名 `pruneThresholdChars` 那一套，而真在跑的
 * 两行在**预设里**（`agent.cordis.yml` 的 compaction group，host 那三行被
 * dsh-web-app `disabled: true` 了），键名是 `thresholdChars/headChars/tailChars`。
 * 预设是整份 entry list、没有 patch 层，profile patch 够不到它 ——
 * 于是那条命令静默无效，还在 `/thrift show` 里显示一个假的"生效配置"。
 *
 * 现在统一从这里生成预设，落点就是真在跑的那两行。
 */

/** 裁剪器插在工具结果中间的标记；校验 headChars+标记+tailChars ≤ thresholdChars 要用它的字符数 */
export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

/**
 * overlay 的键名 → 真插件认的键名。
 * 两套名字不同，照 overlay 的名字写进插件配置，插件会 throw（未知键）。
 */
export const THRIFT_KEYS = {
	compactThresholdRatio: "thresholdRatio",
	pruneThresholdChars: "thresholdChars",
	pruneHeadChars: "headChars",
	pruneTailChars: "tailChars",
};

/** standard 预设里 compaction-basic 那两行（它没有 config 块） */
const COMPACTOR_ROW = "    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'";

/** standard 预设里 tool-result-pruner 那一整块，含出厂默认值 */
const PRUNER_ROW = [
	"    - id: tool-result-pruner",
	"      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
	"      config:",
	"        thresholdChars: 8192",
	"        headChars: 4096",
	"        tailChars: 1024",
].join("\n");

/** 出厂默认：标准预设里 pruner 那三行 */
const PRUNER_DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

const PERSONA_MARKER = "      You are a coding agent powered by the {{model}} model.";

/**
 * 把团队设置与 thrift overlay 合成真插件要的数值，并照插件自己的规则校验。
 *
 * 校验不是形式主义：这两个插件的 config 是**加载期**解析的，非法组合会让
 * 整个 dsh 起不来，而用户改阈值只用一条 `/thrift` 命令。宁可在这里报错。
 *
 * @param settings - team/agent-settings.json 的内容
 * @param overlay - ~/.dsh/team-workflow/thrift.json（用户用 /thrift 改的）
 * @returns 两行插件各自的最终 config 值
 */
export function resolveThriftConfig(settings = {}, overlay = {}) {
	const compaction = settings.compaction ?? {};
	const contextWindow = compaction.contextWindow ?? 128000;
	const reserveTokens = compaction.reserveTokens ?? 32768;
	const keepRecentTokens = compaction.keepRecentTokens ?? 20000;

	const baseThreshold = Number((1 - reserveTokens / contextWindow).toFixed(4));
	const retainRatio = Number((keepRecentTokens / contextWindow).toFixed(4));
	const thresholdRatio = overlay.compactThresholdRatio ?? baseThreshold;

	// compaction-basic 的 assertRatio 同时管 thresholdRatio 与 retainRatio（范围都是 (0, 1]），
	// 所以这一处检查就盖住了两个值 —— 包括 `/thrift compact 2` 或手改 overlay 写进来的 2 / "abc"。
	// 少这一条就会出现「chars 三值拦住了、ratio 没拦住」的门：预设挂载期才报错，dsh 起不来。
	for (const [name, value] of [
		["thresholdRatio", thresholdRatio],
		["retainRatio", retainRatio],
	]) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
			throw new Error(
				`压缩配置不合法：${name} (${JSON.stringify(value)}) 必须是 (0, 1] 内的数；` +
					"插件会直接抛错，dsh 起不来",
			);
		}
	}

	// compaction-basic 的 validateRatioRetention —— retainRatio 必须小于 thresholdRatio
	if (!(retainRatio < thresholdRatio)) {
		throw new Error(
			`压缩配置不合法：retainRatio (${retainRatio}) 必须小于 thresholdRatio (${thresholdRatio})；` +
				"插件会直接抛错，dsh 起不来",
		);
	}

	const thresholdChars = overlay.pruneThresholdChars ?? PRUNER_DEFAULTS.thresholdChars;
	const headChars = overlay.pruneHeadChars ?? PRUNER_DEFAULTS.headChars;
	const tailChars = overlay.pruneTailChars ?? PRUNER_DEFAULTS.tailChars;
	for (const [name, value, min] of [
		["thresholdChars", thresholdChars, 1],
		["headChars", headChars, 0],
		["tailChars", tailChars, 0],
	]) {
		if (!Number.isInteger(value) || value < min) {
			throw new Error(`裁剪配置不合法：${name} 必须是 ≥ ${min} 的整数（收到 ${JSON.stringify(value)}）`);
		}
	}
	// pruner: headChars + marker + tailChars > thresholdChars 会 throw
	const emitted = headChars + Array.from(PRUNE_MARKER).length + tailChars;
	if (emitted > thresholdChars) {
		throw new Error(
			`裁剪配置不合法：headChars + 标记 + tailChars (${emitted}) 超过 thresholdChars (${thresholdChars})；` +
				"插件会直接抛错，dsh 起不来",
		);
	}

	return { thresholdRatio, retainRatio, thresholdChars, headChars, tailChars };
}

/**
 * 反过来：从生成好的预设里把真正生效的数值读出来。
 *
 * 存在的理由和导出 THRIFT_KEYS 一样：预设的格式是这里定义的，读它也得在同一处，
 * 否则 `/thrift show` 会继续说另一套值（那正是原来的 bug）。
 *
 * @param text - agent.cordis.yml 的内容
 * @returns 读到的数值；格式对不上返回 undefined（宁可不说，也不说错）
 */
export function readEffectiveThrift(text) {
	const out = {};
	// 从行 id 起手，只在那一行自己的 config 块里找（缩进比 id 深）。
	// 不这么锚的话，将来加个 modelPolicies 之类的嵌套块，同名的键会把它盖掉。
	const readRow = (rowId, keys) => {
		const lines = text.split("\n");
		const at = lines.findIndex((line) => line.trim() === `- id: ${rowId}`);
		if (at < 0) return;
		const rowIndent = /^\s*/.exec(lines[at])[0].length;
		// 先找到这一行自己的 config:，再只认它**直接子键**那一层。
		// 只按「比 id 深」扫是不够的：加个 modelPolicies 之类的嵌套块，里层同名的键
		// （缩进更深）会盖掉外层真值 —— 刚才实测确实会盖掉。
		let configIndent = null;
		for (let i = at + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "") continue;
			const indent = /^\s*/.exec(line)[0].length;
			if (indent <= rowIndent) return; // 出了这一行
			if (configIndent === null) {
				if (line.trim() === "config:") configIndent = indent;
				continue;
			}
			if (indent <= configIndent) return; // 出了 config 块
			if (indent !== configIndent + 2) continue; // 嵌套结构，不是本行的直接子键
			const m = /^\s*([A-Za-z]+):\s*(\d+\.?\d*)\s*$/.exec(line);
			if (m && keys.includes(m[1])) out[m[1]] = Number(m[2]);
		}
	};
	readRow("compaction-basic", [THRIFT_KEYS.compactThresholdRatio, "retainRatio"]);
	readRow("tool-result-pruner", [
		THRIFT_KEYS.pruneThresholdChars,
		THRIFT_KEYS.pruneHeadChars,
		THRIFT_KEYS.pruneTailChars,
	]);
	return Object.keys(out).length === 5 ? out : undefined;
}

/** 换掉一段原文，并留下能原样换回去的 undo。找不到就报错，别瞎改。 */function patchRow(text, plain, block, what) {
	if (!text.includes(plain)) {
		throw new Error(`standard 预设里没找到${what}，预设结构变了？`);
	}
	return {
		text: text.replace(plain, () => block),
		undo: (s) => s.replace(block, () => plain),
	};
}

/**
 * standard 预设 → team 预设。纯函数，便于自检撤得回去。
 *
 * @param pristine - standard 预设的原文
 * @param options - `{ settings, overlay }`
 * @returns `{ text, changed }`；`changed` 是每条改动的说明
 * @throws 生成或自检失败时抛（自检失败绝不能让调用方写出坏预设）
 */
export function generateTeamPreset(pristine, { settings = {}, overlay = {} } = {}) {
	const cfg = resolveThriftConfig(settings, overlay);
	const patches = [];
	let text = pristine;

	// compaction-basic：只有 settings 里有 compaction 才动它，否则保持 standard 默认。
	// 保留 dsh 自带压缩作保险：historian 万一不触发，还得有东西拦住上下文撑爆。
	const compaction = settings.compaction;
	if (compaction) {
		const patch = patchRow(
			text,
			COMPACTOR_ROW,
			[
				"    - id: compaction-basic",
				"      name: '@deepseek-ai/dsh-compaction-basic'",
				"      config:",
				`        thresholdRatio: ${cfg.thresholdRatio}`,
				`        retainRatio: ${cfg.retainRatio}`,
				`        auto: ${compaction.enabled === false ? "false" : "true"}`,
			].join("\n"),
			"compaction-basic 行",
		);
		patches.push(patch);
		text = patch.text;
	}

	// tool-result-pruner：只有 overlay 真给了裁剪键才动，否则保持 standard 默认。
	const hasPruneOverride = ["pruneThresholdChars", "pruneHeadChars", "pruneTailChars"].some(
		(key) => overlay[key] !== undefined,
	);
	if (hasPruneOverride) {
		const patch = patchRow(
			text,
			PRUNER_ROW,
			[
				"    - id: tool-result-pruner",
				"      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
				"      config:",
				`        ${THRIFT_KEYS.pruneThresholdChars}: ${cfg.thresholdChars}`,
				`        ${THRIFT_KEYS.pruneHeadChars}: ${cfg.headChars}`,
				`        ${THRIFT_KEYS.pruneTailChars}: ${cfg.tailChars}`,
			].join("\n"),
			"tool-result-pruner 行",
		);
		patches.push(patch);
		text = patch.text;
	}

	const persona = settings.persona;
	if (persona) {
		const patch = patchRow(
			text,
			PERSONA_MARKER,
			`      ${persona.replace(/\n/g, "\n      ")}`.trimEnd(),
			"persona 那行",
		);
		patches.push(patch);
		text = patch.text;
	}

	// 自检：把改动逐条撤回去，必须逐字节等于 standard。
	// 这是没有图形界面时能真正验证「预设没被改坏」的最直接的断言。
	let restored = text;
	for (const patch of patches.toReversed()) restored = patch.undo(restored);
	if (restored !== pristine) {
		throw new Error("预设自检失败：除已知那几处外还有其他改动，不要装");
	}

	return { text, changed: patches.length };
}
