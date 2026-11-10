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
/**
 * 确定性折叠后端的行（REQ-018 ①）。切后端 = 换这两行的 `name`，config 块照旧写 basic 的键
 * —— 折叠引擎是 `BasicCompactionEngine` 的子类，schema 继承，所以 `thresholdRatio` /
 * `retainRatio` / `auto` 这些键对它同样有效。
 *
 * 名字是包名 + 子路径：宿主加载器用裸 `import()` 解析（`cordis-plugin-loader:223`），
 * 从 profile 的 node_modules 找得到本包（它 symlink 在那儿），所以 `exports` 里要有这一条。
 */
const COMPACTOR_ROW_FOLD = [
	"              - id: compaction-fold",
	"                name: 'dsh-team-workflow/compaction-fold'",
].join("\n");

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
	// 压缩后端可能是 basic，也可能是本包的折叠后端（REQ-018 ①）—— 换后端只换这一行的 id 与 name，
	// config 的键是同一套（折叠引擎是 `BasicCompactionEngine` 的子类，schema 继承）。
	// 两行都得试：只认 basic 的话，切到折叠后这里回读成空，`dsh-team thrift show` 就瞎了
	// （自检里「rc.x 生成的预设回读不出生效值」那条逮到的就是这个）。
	readRow("compaction-basic", [THRIFT_KEYS.compactThresholdRatio, "retainRatio"]);
	readRow("compaction-fold", [THRIFT_KEYS.compactThresholdRatio, "retainRatio"]);
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
/**
 * 模式标识：让「团队模式」在系统提示里看得见（顺带也是「预设真生效了吗」的判据）。
 *
 * 「每轮一个新智能体」那条规矩就写在这儿：上下文（文件、记忆、AGENTS、REQ）**都还在**，
 * 但**身份**是新的 —— 不继承上一轮的自我要求，先把这一轮当新问题横向看一眼。
 * 为什么不是「清空上下文」：2026-10-30 用户明确要的是「别的东西都在，让他横向思考而不是向下」。
 */
const RC2_MODE_MARKER =
	" 当前模式：团队模式。每一轮对话都是一个新的你：文件、记忆、约定都还在，但别把上一轮的自我要求当成本轮的前提 —— 先横向看一眼有没有更简单的走法，再决定要不要沿原路往下钻。";
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
 * （这条 legacy 路只服务 RC2 之前的布局，`compactionBackend` 那个键**不**作用在它身上 ——
 * 换后端是 RC2 布局的能力，写在这里免得将来有人以为它跟着走）
 * 末尾那行模式标识。其余逐字照抄 —— 所以这份生成的预设不会因为 dsh 升级而失真，
 * 每次 install/thrift apply 都是照着**当前**出厂文件重算的。
 *
 * @param pristine - standard.patch.yml 的原文
 * @param options - `{ settings, overlay }`
 * @returns `{ text, changed }`；`changed` 是改动条数
 * @throws 生成或自检失败时抛（自检失败绝不能让调用方写出坏预设）
 */
export function generateRc2TeamPreset(pristine, { settings = {}, overlay = {}, redteamTools = true } = {}) {
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
				"# 底稿是 dsh 自带的 standard 预设，只加/改这几处：压缩后端与阈值、",
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
	// 后端选择：**默认就是确定性折叠后端**（REQ-018 ①，不调模型、逐字选择保留什么、丢了明说）；
	// 显式写 `compactionBackend: "basic"` 才用回宿主的 compaction-basic。
	// **这个键不属于 `compaction` 块** —— 那块的键会原样写进插件 config，
	// 而插件对未知键是直接抛错的（整个 dsh 起不来）。
	const useBasic = settings.compactionBackend === "basic";
	const compactorRow = useBasic ? RC2_COMPACTOR : COMPACTOR_ROW_FOLD;
	if (compaction || !useBasic) {
		const block = [
			compactorRow,
			"                config:",
			`                  thresholdRatio: ${cfg.thresholdRatio}`,
			`                  retainRatio: ${cfg.retainRatio}`,
			`                  auto: ${compaction?.enabled === false ? "false" : "true"}`,
		].join("\n");
		patches.push(patchRow(text, RC2_COMPACTOR, block, "compaction 那一行"));
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
	//
	// ── 2026-11-10 改了：现在**打开**（REQ-036）────────────────────────────
	// 上面那条「关掉当信号」的取舍被推翻了。原因：用户要把 subagent 派给不同模型
	// （他的中转站有 26 个：claude-haiku-5-5 / glm-5.3-flash / qwen3.8-flash / kimi-k3 …），
	// 钉死三档就等于每次都得改配置文件重启。
	//
	// 为什么打开是零风险：`modelSelectionSettings: true` 只表示「这个工具**支持**选模型」——
	// 它多出 `list_subagent_models` 工具和 `provider`/`model`/`reasoning_effort` 三个参数，
	// 而**真正的开关**是另一个服务（`subagentModelSelection.enabled`，默认 **false**）。
	// 默认关着时：不传就用这里的 `agentOptions`，行为和以前一模一样。
	// 见 `dsh-tool-subagent/lib/model-selection-settings.js:45-51`。
	// （`allowModelSelection` 在 `subagents` 声明之后取 —— 这里只是注释。）
	const subagents = settings.subagents ?? {};
	const tierTools = subagents.tierTools;
	const tierProvider = subagents.provider;
	// 每档可以有自己的 provider（2026-11-10 加）：`tierTools` 是「档位 → 模型名」的平表，
	// 但不同档想用不同网关时就没地方写了 —— 而 `subagent_power` 正是因为只写模型名、
	// provider 被钉成 `opencode-go`、那个模型在那边不存在才整个坏掉的
	// （`pi-ai provider "opencode-go" has no configured model "gpt-6.1-sol"`）。
	// 现在 `tierProviders: { power: "tumianyue-api" }` 可以单独覆盖，不写就还用上面的默认。
	const tierProviders = subagents.tierProviders ?? {};
	/** 三档工具行是否声明「支持选模型」。真正的开关在 `subagentModelSelection.enabled`。 */
	const allowModelSelection = subagents.allowModelSelection === true;
	if (allowModelSelection) {
		throw new Error(
			"subagents.allowModelSelection 不能再开：档位工具行一旦开 modelSelectionSettings，" +
				"就会和标准预设里主 subagent 那个撞 list_subagent_models（固定名字），" +
				"表现是**新建会话全部失败**（2026-11-10 实测）。" +
				"要选模型请用主 subagent 工具 —— 它本来就开着，也能传 provider/model。" +
				"把 team/agent-settings.json 里的 allowModelSelection 删掉或设为 false。",
		);
	}
	/** 哪个档位拿到「可以选模型」的那个工具。只能一个 —— 见下面生成处的事故注释。 */
	const selectionTier = typeof subagents.modelSelectionTier === "string" ? subagents.modelSelectionTier : "std";
	// `toolLessTiers` 里的档位**一个工具都不给**。为什么：审查档（power）按团队规范只
	// 「凭材料判断」，不给它读文件/跑命令的能力 —— 它一旦能自己探索，就会顺着仓库扫到超时
	// （上游 42 次实测：最慢一次 108 轮、跑满 30 分钟被砍）。
	//
	// ── 0.2.1 起换了做法（REQ-022，2026-10-18）──────────────────────────────
	// 原来给那条工具行加 `toolFilter: { allow: [] }`。0.2.1 把 `toolFilter` 与 `persona`
	// **废弃**了：`dsh-tool-subagent/lib/index.js:355` 在挂载期直接抛
	// `tool-subagent: toolFilter is no longer supported; configure persona and tool plugins
	// in an Agent Preset and select it with agentPreset (spawn only)` —— 整份预设被判非法，
	// **新会话直接建不起来**（2026-10-18 实测报错原文）。
	// 它给的替代就是字面意思：另开一份**没有工具行**的预设，档位行用 `agentPreset` 指过去。
	// 注意 `Config` schema **不拦**这两个键（实测喂进去全部通过），所以只有真挂载才测得出。
	const toolLess = Array.isArray(subagents.toolLessTiers) ? subagents.toolLessTiers : [];
	if (tierTools && typeof tierTools === "object" && tierProvider) {
		const rows = Object.entries(tierTools).map(([tier, model]) =>
			[
				`              - id: tool-subagent-${tier}`,
				"                name: '@deepseek-ai/dsh-tool-subagent'",
				"                config:",
				"                  provider: spawn",
				`                  toolName: subagent_${tier}`,
				"                  backgroundMode: continuable",
				...toolLess.includes(tier) ? [`                  agentPreset: ${toolLessPresetId(tier)}`] : [],
				// ⚠️ **只能给一个档位开**（2026-11-10 实测事故）。
				//
				// `modelSelectionSettings: true` 会让该工具实例注册一个**固定名字**的
				// `list_subagent_models`（`dsh-tool-subagent/lib/index.js:174`）。同一个 Agent 的
				// tools registry 里挂两个都开着的实例 → 重名直接抛 →
				// `failed to create session: Error: tool "list_subagent_models" is already
				// registered in this scope`，**新建会话全部失败**。
				//
				// 11-10 我三档全开，用户重启后建不了会话。标准预设只有一个 `subagent` 开着，
				// 所以这条路以前从没被走过。
				//
				// **结论：档位行永远不开这个开关。** 不是「只给 std 开」—— 因为标准预设里
				// 主 `subagent` 那个**已经开着且关不掉**，再给任何档位开就是两个。
				// 换句话说：宿主只允许一个「能选模型」的工具实例，而那个位置被主 `subagent`
				// 占着。档位工具保持钉死 —— 它们存在的意义本来就是「调用哪个工具 = 选了哪一档」。
				//
				// 选模型的能力走主 `subagent`：它同样能传 provider/model/reasoning_effort，
				// 还能继承父会话上下文。白名单（下面 `subagents.modelSelection`）是给它读的。
				//
				// 配置里如果写了 `allowModelSelection: true`，生成时**直接抛**（见下）——
				// 不能让一个「配了但不起作用」的开关留着骗人。
				"                  agentOptions:",
				`                    provider: ${tierProviders[tier] ?? tierProvider}`,
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
		// 6. 无工具档位各自一份子预设（0.2.1 起 toolFilter 没了，见上面那段注释）
		const toolLessRows = toolLess.filter((tier) => Object.hasOwn(tierTools, tier));
		if (toolLessRows.length > 0) {
			const block = toolLessRows.map(toolLessPresetBlock).join("\n");
			patches.push(patchAppend(text, block));
			text = patches.at(-1).text;
		}
	}

	// 7. 宿主层的后端：**驱动自动压缩的一方在宿主层**，看不到预设作用域里的服务。
	//    2026-10-19 实测：预设里那个隔离组里的 compaction-fold，agent 一次都没用到 ——
	//    桌面里跑的一直是宿主层那份 compaction-basic（会话日志里三次摘要都是模型写的散文，
	//    没有一次带 fold 的「用户原话（逐字）」签名）。把同一个后端插到宿主层后，fold 立刻出手。
	//    预设内部那份**保留**（隔离作用域，供该预设自己的 /compact 用）；宿主层这份才是 agent 用的。
	//    两件事必须一起做：① 插入宿主层后端；② 关掉自带的 basic，否则两个 provider 抢同一个服务名。
	{
		const rows = useBasic
			? [
					"    - id: compaction-basic",
					"      name: '@deepseek-ai/dsh-compaction-basic'",
					"      config:",
					`        thresholdRatio: ${cfg.thresholdRatio}`,
					`        retainRatio: ${cfg.retainRatio}`,
					`        auto: ${compaction?.enabled === false ? "false" : "true"}`,
				]
			: [
					"- insert:",
					"    - id: compaction-team",
					"      name: 'dsh-team-workflow/compaction-fold'",
					"      config:",
					`        thresholdRatio: ${cfg.thresholdRatio}`,
					`        retainRatio: ${cfg.retainRatio}`,
					`        auto: ${compaction?.enabled === false ? "false" : "true"}`,
					"- id: compaction-basic",
					"  disabled: true",
				];
		const appended = patchAppend(text, rows.join("\n"));
		patches.push(appended);
		text = appended.text;
	}

	// 9. 把 MCP server 挂成插件行（`settings.mcp` 里一台一条）。
	//
	//    为什么用 `dsh-mcp-client` 而不是别的路：它就是宿主自带的那个客户端（`dsh-mcp-client`），
	//    走 `ctx.tools.register` 注册 —— MCP 的工具与原生工具在同一条链上，模型看到的名字是
	//    `mcp__<serverName>__<tool>`。
	//
	//    **三件必须写死的事**（2026-10-30 本机实测出来的，别改）：
	//    ① `failOnStartupError: false` —— 设 true 时 server 起不来会让整个插件激活失败，
	//       而插件激活失败 = 整份预设被判非法 = **新会话建不起来**。一台 server 挂掉不该
	//       连坐整个会话能力。
	//    ② `command` 可以写 `npx`：宿主的 stdio transport 用的是 `cross-spawn`（不是原生
	//       `spawn`），它在 Windows 上会自己找到 `npx.cmd`。而原生 spawn 对 `.cmd` 直接
	//       报 EINVAL —— 所以千万别在这里改写成绝对路径的 `npx.cmd`。
	//    ③ 新起进程会**换一套环境**：SDK 只继承白名单（APPDATA/PATH/USERPROFILE/…），
	//       不继承 HTTP_PROXY 之类。要代理就在 `env` 里显式给。
	//
	//    代价要认：server 的每个工具声明都会进**每次调用**的地板。本机实测
	//    `chrome-devtools-mcp@1.12.0` = 32 个工具 / 29661 字符 ≈ 9.3k token，
	//    `server-filesystem@2.1.0` = 14 个 / 12569 字符 ≈ 3.9k token。**没有工具白名单**
	//    （Config 里只有 transport/serverName/command/args/env/cwd/toolCallTimeoutMs/
	//    failOnStartupError/maxInstructionBytes/reconnect，没有 include/exclude），
	//    所以挂一台的固定开销就是它全部工具的量 —— 只挂真的会用、且工具数少的。
	{
		const servers = Array.isArray(settings.mcp) ? settings.mcp : [];
		const rows = [];
		for (const s of servers) {
			if (!s || typeof s !== "object") continue;
			const serverName = String(s.serverName ?? s.name ?? "").trim();
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
				throw new Error(`mcp：serverName 必须是 [A-Za-z0-9_-]{1,32}，收到「${serverName}」`);
			}
			const id = `mcp-${serverName.replace(/[^A-Za-z0-9_-]/g, "-")}`;
			const line = [`    - id: ${id}`, "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", `        serverName: ${serverName}`];
			if (s.url) {
				line.push("        transport: streamable-http", `        url: ${s.url}`);
				const headers = s.headers && typeof s.headers === "object" ? Object.entries(s.headers) : [];
				if (headers.length > 0) {
					line.push("        headers:");
					for (const [k, v] of headers) line.push(`          ${k}: '${String(v).replace(/'/g, "''")}'`);
				}
			} else {
				line.push("        transport: stdio", `        command: ${s.command ?? "npx"}`);
				const args = Array.isArray(s.args) ? s.args : [];
				if (args.length > 0) {
					line.push(`        args: [${args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(", ")}]`);
				}
				const env = s.env && typeof s.env === "object" ? Object.entries(s.env) : [];
				if (env.length > 0) {
					line.push("        env:");
					for (const [k, v] of env) line.push(`          ${k}: '${String(v).replace(/'/g, "''")}'`);
				}
			}
			// ①②：起不来不连坐、也不因为它是 .cmd 就改写法
			line.push("        failOnStartupError: false");
			rows.push(line.join("\n"));
		}
		if (rows.length > 0) {
			patches.push(patchAppend(text, rows.join("\n\n")));
			text = patches.at(-1).text;
		}
	}

	// 红队演练台工具面（REQ-029：红队模式已融合进团队模式）。
	//
	// 只加**工具行**，不加 persona —— 指挥稿在插件层由 lib/redteam-brief.js 从
	// team/REDTEAM.md 注入，两个模式共用同一份；预设里再抄一遍就是双份，
	// 每轮多付约 3k token 的地板（2026-10-31 实测过双份注入的代价）。
	if (redteamTools) {
		patches.push(
			patchAppend(
				text,
				[
					"# 红队演练台工具面（REQ-029：红队模式已融合进团队模式）",
					"- insert:",
					"    - id: redteam-tools",
					"      name: dsh-team-workflow/purge/redteam/tools",
				].join("\n"),
			),
		);
		text = patches.at(-1).text;
	}

	// 自检：逐条撤回去必须逐字节等于出厂文件
	let restored = text;
	for (const patch of patches.toReversed()) restored = patch.undo(restored);
	if (restored !== pristine) {
		throw new Error("预设自检失败：除已知那几处外还有其他改动，不要装");
	}



	// ── 子代理的模型白名单（REQ-036，2026-11-10）────────────────────────────
	//
	// 三档工具行开了 `modelSelectionSettings: true` 只解决「工具支不支持选模型」；
	// **能不能真选**由另一个服务决定 —— `subagent-model-selection-settings`
	// （`dsh-web-app/cordis.patch.yml:65` 注册，默认 `enabled: false` + 空白名单）。
	//
	// 这里用 patch 语义**覆盖**那一行的 config（同 id 的顶层条目覆盖前面的）。
	// 白名单空了 `enabled: true` 会直接抛（`model-selection-settings.js:59`），所以两项一起写。
	//
	// 为什么不靠用户在 Plugins 页点：那样每台机器都要手点一遍，且换机器就忘。
	// 写进预设 = 全员一致 + 有历史可查。
	const modelSelection = subagents.modelSelection;
	// 注意条件里**没有** allowModelSelection：白名单是给**主 subagent** 用的
	// （标准预设那一行本来就开着 modelSelectionSettings，它才是默认入口）。
	// allowModelSelection 只控制「要不要给档位工具行也开」—— 而那个因为
	// list_subagent_models 固定名会撞，已经确认不能开。
	if (modelSelection?.enabled === true) {
		const routes = Array.isArray(modelSelection.allowedModels) ? modelSelection.allowedModels : [];
		if (routes.length === 0) {
			throw new Error("subagents.modelSelection.enabled 为 true 但 allowedModels 是空的：开了选择却一个模型都不给，等于每次调用都报错");
		}
		const body = [
			"# 子代理可选模型白名单（REQ-036）。覆盖 dsh-web-app 那一行的空默认值。",
			"- id: subagent-model-selection-settings",
			"  config:",
			"    enabled: true",
			"    allowedModels:",
			...routes.map((route) => `      - provider: ${route.provider}\n        model: ${route.model}`),
		].join("\n");
		patches.push(patchAppend(text, body));
		text = patches.at(-1).text;
	}

	return { text, changed: patches.length };
}

/** 在末尾追加一段，并留下能原样剪掉的 undo（新增整块预设用）。 */
function patchAppend(text, block) {
	const suffix = text.endsWith("\n") ? "" : "\n";
	const added = `${suffix}${block}\n`;
	return {
		text: text + added,
		undo: (s) => (s.endsWith(added) ? s.slice(0, -added.length) : s),
	};
}

/** 无工具档位的预设 id（`team` 主预设的变体） */
export function toolLessPresetId(tier) {
	return `${TEAM_PRESET_ID}-${tier}`;
}

/** 无工具档位的 persona：说清它没有工具，别假装能读文件 */
const TOOL_LESS_PERSONA =
	"你是团队里的「判」这一档：只凭交给你的材料判断，没有任何工具可用 —— 不要假装能读文件或跑命令。";

/**
 * 无工具档位的子预设。**里面一行 tool-/skill-/command- 都没有** —— 这就是「不给工具」。
 *
 * 为什么另开一份预设而不是给那条工具行加过滤：0.2.1 的 `dsh-tool-subagent` 挂载期直接拒绝
 * `toolFilter` / `persona`（`lib/index.js:355`），整份预设被判非法、新会话建不起来；
 * 它给的替代是「persona 与工具都由预设决定，用 `agentPreset` 选」（同处报错原文）。
 */
function toolLessPresetBlock(tier) {
	const id = toolLessPresetId(tier);
	return [
		"- insert:",
		`    - id: preset-${id}`,
		"      name: '@deepseek-ai/dsh-agent-preset'",
		"      config:",
		`        id: ${id}`,
		`        name: 团队模式·${tier}（无工具）`,
		"        description: 团队预设的无工具变体：只凭材料判断，没有任何工具。",
		"        order: 20",
		"        plugins:",
		"          - id: persona",
		"            name: '@deepseek-ai/dsh-persona'",
		"            config:",
		`              prefix: ${TOOL_LESS_PERSONA}`,
		"          - id: agent-instructions",
		"            name: '@deepseek-ai/dsh-agent-instructions'",
		"            config:",
		"              maxBytes: 65536",
		"          - id: compaction",
		"            name: cordis:group",
		"            group: true",
		"            isolate:",
		"              compaction: true",
		"            config:",
		"              - id: compaction-basic",
		"                name: '@deepseek-ai/dsh-compaction-basic'",
		"              - id: command-compact",
		"                name: '@deepseek-ai/dsh-command-compact'",
	].join("\n");
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
export function generateTeamPreset(pristine, { settings = {}, overlay = {}, redteamTools = true } = {}) {
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

	// 8. 摘掉 `fs-observation-policy` 那一行。
	//
	//    它是什么：宿主自带的「改文件之前必须先读过、读过之后文件不能再变、会话恢复后还得重读」
	//    策略（`FS_NOT_OBSERVED` / `FS_STALE_VERSION`，官方 README 原话「resumed sessions must
	//    read targets again because observations are not persisted」）。
	//
	//    为什么摘：它把每个文件读两遍 —— 改之前读一遍拿观测态，改完再读一遍核对，
	//    而模型本来就该读。2026-10-30 用户实测体感就是「前面刚看过一遍，写完过后又会再看一遍」。
	//    代价说清：并发写保护也一起没了（`FM_*` 那条仍在 dsh-fs 里，只是少了观测态这一层）。
	//    想留就把它写回预设 —— 这不是永久删除，只是团队预设不带它。
	{
		const block = [
			"    - id: fs-observation-policy",
			"      name: '@deepseek-ai/dsh-fs-observation-policy'",
		].join("\n");
		const at = text.indexOf(`${block}\n`);
		if (at > 0) {
			const before = text;
			text = text.slice(0, at) + text.slice(at + `${block}\n`.length);
			patches.push({ what: "摘掉 observation policy 行", before, text });
		}
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

	// 红队演练台工具面（REQ-029：红队模式已融合进团队模式）。
	//
	// 只加**工具行**，不加 persona —— 指挥稿在插件层由 lib/redteam-brief.js 从
	// team/REDTEAM.md 注入，两个模式共用同一份；预设里再抄一遍就是双份，
	// 每轮多付约 3k token 的地板（2026-10-31 实测过双份注入的代价）。
	if (redteamTools) {
		patches.push(
			patchAppend(
				text,
				[
					"# 红队演练台工具面（REQ-029：红队模式已融合进团队模式）",
					"- insert:",
					"    - id: redteam-tools",
					"      name: dsh-team-workflow/purge/redteam/tools",
				].join("\n"),
			),
		);
		text = patches.at(-1).text;
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

// ── 编排模式预设（REQ-034）──

/**
 * 两个编排模式的元数据。
 *
 * 为什么做成两个**预设**而不是一个提示词开关：ralph 与 workflow 的工具面互斥
 * （ralph 常驻一个「目标 → 子代理 → 交接」的循环，workflow 写脚本扇出多个子代理），
 * 塞进同一个预设里模型会混用；而宿主禁止会话中途换 preset
 * （`agent-preset/locked`，见 `lib/preset-switch.js` 头部），所以「切换」只能是
 * 「开新会话」—— 这正是 REQ-030 已经验证过的路径，不另造一套。
 */
export const MODE_PRESETS = {
	ralph: {
		id: "ralph",
		name: "Ralph 循环",
		description: "一个目标反复迭代：每轮开一个干净子代理，只带目标与上一轮交接。",
	},
	workflow: {
		id: "workflow",
		name: "Workflow 编排",
		description: "写 JS 脚本扇出多个子代理，带阶段与结构化结果。",
	},
};

/**
 * 出厂 standard 里 `tool-workflow` 那一行（14 空格缩进，与 `workflow-ptc` 同层）。
 *
 * 只匹配这一行的**两行**：`workflow-ptc` 要留着 —— 它提供 `workflowEngine` 服务，
 * `tool-ralph` 的 inject 里就有它（`dsh-tool-ralph/lib/index.js` 的 `inject`）。
 */
const RC2_TOOL_WORKFLOW_BLOCK = [
	"              - id: tool-workflow",
	"                name: '@deepseek-ai/dsh-tool-workflow'",
].join("\n");

/** ralph 工具行：同缩进、同位置，只换 id 与包名。 */
const RC2_TOOL_RALPH_BLOCK = [
	"              - id: tool-ralph",
	"                name: '@deepseek-ai/dsh-tool-ralph'",
].join("\n");

/**
 * 出厂 standard → 某个编排模式的预设。纯函数。
 *
 * 与团队预设的差别只有两处：`tool-workflow` 行换成 `tool-ralph`（ralph 模式），
 * 以及 preset 声明的 id/name/description。其余逐字照抄团队预设 —— 所以两个模式
 * 自动继承压缩阈值、档位工具行、红队工具，不必各维护一份。
 *
 * workflow 模式在工具行上**与团队预设相同**（standard 本来就有 `tool-workflow`），
 * 差别只在声明与 persona 里的模式标识：它存在的意义是「一个显式选择」，
 * 而不是另一种工具面。
 *
 * @param pristine - standard.patch.yml 的原文
 * @param options - `{ mode, settings, overlay, redteamTools }`
 * @returns `{ text, changed }`
 * @throws 未知 mode、或 standard 里找不到工具行/声明块时抛（宁可失败也不写出坏预设）
 */
export function generateModePreset(pristine, { mode, settings = {}, overlay = {}, redteamTools = true } = {}) {
	const meta = MODE_PRESETS[mode];
	if (!meta) {
		throw new Error(`generateModePreset：未知模式 "${mode}"（已知：${Object.keys(MODE_PRESETS).join(", ")}）`);
	}
	const base = generateRc2TeamPreset(pristine, { settings, overlay, redteamTools });
	let text = base.text;
	let changed = base.changed;
	/** 本函数自己的改动也要能原样撤回去 —— 与 generateRc2TeamPreset 内部的自检同一条规矩。 */
	const undos = [];

	if (mode === "ralph") {
		const patch = patchRow(text, RC2_TOOL_WORKFLOW_BLOCK, RC2_TOOL_RALPH_BLOCK, "tool-workflow 行");
		text = patch.text;
		undos.push(patch.undo);
		changed += 1;
	}

	{
		// 外层 entry id（`- id: preset-team`）**必须一起换**：三个 bundle 装进同一个
		// profile 时，cordis 的 entry id 要唯一 —— 三个都叫 preset-team 的话，
		// 后加载的把前面的顶掉，表现就是「团队模式不见了」（2026-11-01 实测踩到）。
		const plain = [
			"    - id: preset-team",
			"      name: '@deepseek-ai/dsh-agent-preset'",
			"      config:",
			`        id: ${TEAM_PRESET_ID}`,
			`        name: ${TEAM_PRESET_NAME}`,
			`        description: '${TEAM_PRESET_DESCRIPTION}'`,
		].join("\n");
		const block = [
			`    - id: preset-${meta.id}`,
			"      name: '@deepseek-ai/dsh-agent-preset'",
			"      config:",
			`        id: ${meta.id}`,
			`        name: ${meta.name}`,
			`        description: '${meta.description}'`,
		].join("\n");
		const patch = patchRow(text, plain, block, "preset 声明（entry id / config id / name / description）");
		text = patch.text;
		undos.push(patch.undo);
		changed += 1;
	}

	// 自检：撤回本函数的两处改动必须逐字节等于团队预设 —— 否则说明
	// patchRow 的替换不止命中了目标那一段（例如同样的 id 行出现了两次）。
	let restored = text;
	for (const undo of undos.toReversed()) restored = undo(restored);
	if (restored !== base.text) {
		throw new Error(`模式预设自检失败（${mode}）：除了工具行与声明块之外还有其他改动，不要装`);
	}

	return { text, changed };
}
