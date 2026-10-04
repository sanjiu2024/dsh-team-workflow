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
 * ── 为什么必须有 contextWindow（2026-09-26 实测）────────────────────
 * ratio 是**相对于窗口**的比例，不知道窗口多大就算不出正确的 ratio。
 * `agent-settings.json` 的 compaction 里以前没有这个键 → 一律按 128000 算：
 *
 *   baseThreshold = 1 - 12800/128000 = 0.9
 *   tier-std 真实窗口 = 512000 → 实际阈值 460,800 tokens
 *   这两天实测最大地板只有 343,453 → **压缩一次都没触发**
 *
 * 即：缺这一个键，把压缩功能整个关掉了，而且不报任何错；
 * `retainRatio` 也跟着算错（保留量按 0.2 算 → 折叠后还留着 102K）。
 *
 * @param settings - team/agent-settings.json 的内容
 * @param overlay - ~/.dsh/team-workflow/thrift.json（用户用 /thrift 改的）
 * @returns 两行插件各自的最终 config 值
 */
export function resolveThriftConfig(settings = {}, overlay = {}) {
	const compaction = settings.compaction ?? {};
	// 窗口来源：预设里的 `compaction.contextWindow`（以前不存在 → 一律按 128000 算，
	// 见下面注释）。保留默认值是为了兼容没写这个键的用户配置。
	const contextWindow = compaction.contextWindow ?? 128000;
	const reserveTokens = compaction.reserveTokens ?? 32768;
	const keepRecentTokens = compaction.keepRecentTokens ?? 20000;

	// 团队默认阈值写在 team/agent-settings.json 的 compaction 里。
	// 以前只读 overlay，于是团队声明的值**永远不生效**（写了 0.8，实际跑 0.9）。
	const baseThreshold = Number((1 - reserveTokens / contextWindow).toFixed(4));
	const retainRatio = Number((keepRecentTokens / contextWindow).toFixed(4));
	// 优先顺序：用户 /thrift 覆盖 > 团队默认 > 按 reserve 算出来的值
	const thresholdRatio =
		overlay.compactThresholdRatio ?? compaction.compactThresholdRatio ?? baseThreshold;

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

// ── dsh 0.2.0-rc.x 的预设布局：声明行 + **bundle 承载** ──────────────────────
//
// 起点是 dsh 自带的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`：
// 整份文件就是一条 `- insert:`，所以我们只做定点替换，不重排任何结构 ——
// 出厂值变了（加插件、改默认）这里也不用跟，因为我们是照着它现改的。
//
// 为什么必须是 bundle（2026-10-04 实测，别再试 profile patch）────────────
// 把同一条声明塞进 profile 的 cordis.patch.yml 时：行会出现在组合树里、
// `--dump-config` 也看得到，但**预设不会被注册**（plugin_manager 的 roster 里
// 根本没有 `preset-<id>` 那一行）。于是 `default: <那个 id>` 指向不存在的预设，
// 会话退化成「无预设」：
//   · persona / plan-mode 等预设文本全丢（系统提示 20911 → 18070 字）
//   · `tool-fs` 在 host 层被 dsh-web-app 设成 disabled、只由预设提供 →
//     read / write / edit / present / ask_user_question 一起消失
// 换成 bundle 承载后同一份内容：roster 里 `fiberPhase: active`，一切正常。
// dsh 自带的 skill `editing-cordis-compositions` 也是这么说的。

/** 出厂 standard 声明那一行的原文（含它到 order 为止的整块） */
const RC2_DECL_BLOCK = [
	"    - id: preset-standard",
	"      name: '@deepseek-ai/dsh-agent-preset'",
	"      config:",
	"        id: standard",
	"        order: 1",
].join("\n");
const RC2_PERSONA_PREFIX =
	"              prefix: You are a coding agent powered by the {{model}} model.";
/** 模式标识：让「团队模式」在系统提示里看得见（顺带也是「预设真生效了吗」的判据）。 */
const RC2_MODE_MARKER = " 当前模式：团队模式。";
const RC2_COMPACTOR = [
	"              - id: compaction-basic",
	"                name: '@deepseek-ai/dsh-compaction-basic'",
].join("\n");
const RC2_PRUNER = [
	"              - id: tool-result-pruner",
	"                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
	"                config:",
	"                  thresholdChars: 8192",
	"                  headChars: 4096",
	"                  tailChars: 1024",
].join("\n");
/** 自定义 id 没有后端 locale 条目，显示名必须自己带（出厂那几个走 locale）。 */
export const TEAM_PRESET_ID = "team";
export const TEAM_PRESET_NAME = "团队模式";
export const TEAM_PRESET_DESCRIPTION =
	"标准能力 + 团队压缩阈值；dsh 自带压缩退回兜底，magic-context 先动手。";

/**
 * 档位工具行的插入锚点：出厂 standard 里 `tool-subagent` 之后紧跟的那一行。
 *
 * 为什么按行插而不是整块替换：整块替换要求我们把 `tool-subagent` 的 config 逐字
 * 抄一遍，dsh 一升级（改个默认值）就匹配不上、整个生成失败。插在它后面只用得着
 * 这一行名字，稳定得多。
 */
const RC2_SUBAGENT_ANCHOR = "              - id: tool-subagent-fork";

/**
 * 出厂 standard 预设（rc.2）→ 团队预设。纯函数。
 *
 * 与 standard 的差别只有两处：`compaction-basic` 的阈值（团队值），以及 persona
 * 末尾那行模式标识。其余逐字照抄 —— 所以这份生成的预设不会因为 dsh 升级而失真，
 * 每次 install/thrift apply 都是照着**当前**出厂文件重算的。
 *
 * @param pristine - standard.patch.yml 的原文
 * @param options - `{ settings, overlay }`
 * @returns `{ text, changed }`；`changed` 是改动条数
 * @throws 生成或自检失败时抛（自检失败绝不能让调用方写出坏预设）
 */
export function generateRc2TeamPreset(pristine, { settings = {}, overlay = {} } = {}) {
	const cfg = resolveThriftConfig(settings, overlay);
	const patches = [];
	let text = pristine;

	// 0. 文件头注释：出厂那几行写的是 "Agent preset standard"，
	//    照抄进团队预设会让人以为装错了。plain 是从原文里切出来的，所以
	//    出厂怎么改注释都不影响这里的匹配与撤销。
	{
		const headEnd = pristine.indexOf("- insert:");
		const head = headEnd > 0 ? pristine.slice(0, headEnd) : "";
		if (head !== "") {
			const block = [
				"# dsh-team-workflow —— 团队模式预设",
				"# 由 `dsh-team preset install` 生成，别手改（下次 install / thrift apply 会覆盖）。",
				"#",
				"# 底稿是 dsh 自带的 standard 预设，只加/改这几处：compaction-basic 的压缩阈值、",
				"# persona 末尾的模式标识、每档一条的 subagent 工具行（agentOptions 钉住模型）。",
				"# 其余逐字照抄，所以 dsh 升级后重跑一次就同步了。",
				"#",
				"# 承载方式必须是 bundle patch：同一条声明放进 profile 的 cordis.patch.yml",
				"# 时不会被注册成预设（会话会退化成「无预设」），详见 lib/preset-gen.js 的注释。",
				"",
			].join("\n");
			patches.push(patchRow(text, head, block, "文件头注释"));
			text = patches.at(-1).text;
		}
	}

	// 1. 声明本身：id/order 换成 team，并补上显示名与说明
	{
		const block = [
			"    - id: preset-team",
			"      name: '@deepseek-ai/dsh-agent-preset'",
			"      config:",
			`        id: ${TEAM_PRESET_ID}`,
			`        name: ${TEAM_PRESET_NAME}`,
			`        description: '${TEAM_PRESET_DESCRIPTION}'`,
			"        order: 0",
		].join("\n");
		patches.push(patchRow(text, RC2_DECL_BLOCK, block, "preset-standard 声明块"));
		text = patches.at(-1).text;
	}

	// 2. 模式标识
	{
		patches.push(
			patchRow(text, RC2_PERSONA_PREFIX, RC2_PERSONA_PREFIX + RC2_MODE_MARKER, "persona 那行"),
		);
		text = patches.at(-1).text;
	}

	// 3. compaction-basic：与 legacy 生成器同规矩 —— settings 里没有 compaction 就不动它
	const compaction = settings.compaction;
	if (compaction) {
		const block = [
			RC2_COMPACTOR,
			"                config:",
			`                  thresholdRatio: ${cfg.thresholdRatio}`,
			`                  retainRatio: ${cfg.retainRatio}`,
			`                  auto: ${compaction.enabled === false ? "false" : "true"}`,
		].join("\n");
		patches.push(patchRow(text, RC2_COMPACTOR, block, "compaction-basic 行"));
		text = patches.at(-1).text;
	}

	// 4. tool-result-pruner：只有 overlay 真给了裁剪键才动
	const hasPruneOverride = ["pruneThresholdChars", "pruneHeadChars", "pruneTailChars"].some(
		(key) => overlay[key] !== undefined,
	);
	if (hasPruneOverride) {
		const block = [
			"              - id: tool-result-pruner",
			"                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
			"                config:",
			`                  ${THRIFT_KEYS.pruneThresholdChars}: ${cfg.thresholdChars}`,
			`                  ${THRIFT_KEYS.pruneHeadChars}: ${cfg.headChars}`,
			`                  ${THRIFT_KEYS.pruneTailChars}: ${cfg.tailChars}`,
		].join("\n");
		patches.push(patchRow(text, RC2_PRUNER, block, "tool-result-pruner 行"));
		text = patches.at(-1).text;
	}

	// 5. 每档一条独立工具行
	//
	// dsh 的子代理没有「角色」概念（角色是 prompt 里声明的），rc.x 也不读 pi 那套
	// `subagents.agentOverrides`。所以档位只能钉在工具上：挂几条 `subagent` 工具行，
	// 各自的 `agentOptions` 写死 provider + model —— 调用哪个工具就等于选了哪一档。
	// 关掉 `modelSelectionSettings`（不写就是关）：让「传了 provider/model 会报错」
	// 成为明确信号，而不是被静默盖过。
	const subagents = settings.subagents ?? {};
	const tierTools = subagents.tierTools;
	const tierProvider = subagents.provider;
	if (tierTools && typeof tierTools === "object" && tierProvider) {
		const rows = Object.entries(tierTools).map(([tier, model]) =>
			[
				`              - id: tool-subagent-${tier}`,
				"                name: '@deepseek-ai/dsh-tool-subagent'",
				"                config:",
				"                  provider: spawn",
				`                  toolName: subagent_${tier}`,
				"                  backgroundMode: continuable",
				"                  agentOptions:",
				`                    provider: ${tierProvider}`,
				`                    model: ${model}`,
			].join("\n"),
		);
		if (rows.length > 0) {
			// 自己那几行放**前面**、锚点留在后面 —— 插在 fork 行之前，
			// 出厂原有的行位置一律不动（还原自检也才逐字节对得上）
			const block = [...rows, RC2_SUBAGENT_ANCHOR].join("\n");
			patches.push(patchRow(text, RC2_SUBAGENT_ANCHOR, block, "subagent 档位工具行"));
			text = patches.at(-1).text;
		}
	}

	// 自检：逐条撤回去必须逐字节等于出厂文件
	let restored = text;
	for (const patch of patches.toReversed()) restored = patch.undo(restored);
	if (restored !== pristine) {
		throw new Error("预设自检失败：除已知那几处外还有其他改动，不要装");
	}

	return { text, changed: patches.length };
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
