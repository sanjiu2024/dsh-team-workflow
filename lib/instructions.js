/**
 * 把「仓库外的个人指令文件」注入系统提示。
 *
 * 与 `lib/baseline.js` 的分工（两者都要，别合并）：
 *   - baseline 注入 **仓库里** 的 `team/RULES.md` —— 跟着 git 走、全团队共享、评审可控；
 *   - 这里注入 **仓库外** 的个人文件（默认 `<DSH_HOME>/team-workflow/instructions.md`）——
 *     不进 git、不污染别人的工作区，适合放「本机偏好 / 临时约定 / 私人上下文」。
 *
 * 为什么要它（2026-10-31）：这件事以前由第三方插件 dsh-purge 干（`~/.dsh/prompt-inject.md`）。
 * 它的实现有两个实测问题：
 *   ① **注两遍** —— `addPromptSection` 被 `apply()` 和每轮 `prepareAssemble()` 各调一次，
 *      两处宿主代理不同，同名 section 于是在两个宿主上各挂一份。实测 purge 内部日志每次请求
 *      出现 **3 条** `inject.read rawBytes=21803`，会话日志 `type=system/message` 那行
 *      **69,364 字符、同一段出现 2 次** → 每次调用白付约 6.4k token。
 *   ② 它为了「改文件」还把宿主代码打了 86 条补丁（审批/沙箱/围栏/hooks 全放开），
 *      宿主一升级就碎。
 * 所以这里只做「注一段文本」这一件事，并且**按段名幂等**。
 *
 * 幂等的做法与理由：段名记在模块级 Set 里，第二次调用直接返回 noop；dispose 时把名字删回去，
 * 这样 HMR 重载后还能重新挂上。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 排在 `team:baseline`（600）之后、sandbox / 审批策略之前。
 * 用 650 而不是另起一个 700+：700 是 magic-context 那种「换掉整段历史」的段位，
 * 个人指令不该插到那层去。
 */
export const INSTRUCTIONS_ORDER = 650;

/** 段名。幂等判据就是这个字符串，改它等于放开重复注入。 */
export const INSTRUCTIONS_SECTION = "team:instructions";

export const INSTRUCTIONS_DEFAULTS = {
	enabled: true,
	/** 空串 = 用 `defaultInstructionsPath()`（`<DSH_HOME>/team-workflow/instructions.md`） */
	file: "",
	/**
	 * 上限 16 KB。为什么不是无限：这个文件的每一行都会进**每一次调用**的地板。
	 * 16 KB ≈ 4~5k token，已经是「塞一页纸」的量；再大就该写进 team/RULES.md 走评审。
	 */
	maxBytes: 16384,
};

export const INSTRUCTIONS_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	file: (v) => (typeof v === "string" ? v : undefined),
	maxBytes: (v) => (Number.isFinite(v) && v >= 1024 && v <= 65536 ? v : undefined),
};

/**
 * 已挂过本段的**宿主**（按 host 去重，不是按段名）。
 *
 * 为什么按 host：段名是全局的，但「同一段挂到两个不同宿主上」正是 dsh-purge 那个
 * 重复注入的形态 —— 它一次调用里对 `ctx` 和 `ctx.systemPrompt.ctx` 各挂一份。
 * 按 host 记「这个宿主已经有了」，就能拦住同一个宿主被挂两次；
 * 而不同宿主（比如子代理的隔离 ctx）各自挂一份是**对的**，不该被全局名字挡住。
 */
const REGISTERED_HOSTS = new WeakSet();

/** `DSH_HOME` 的落点：环境变量优先，否则 `~/.dsh`（与宿主一致）。 */
export function resolveDshHome(env = process.env) {
	const raw = env.DSH_HOME;
	if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
	return path.join(os.homedir(), ".dsh");
}

export function defaultInstructionsPath(env = process.env) {
	return path.join(resolveDshHome(env), "team-workflow", "instructions.md");
}

/** 按 mtime 缓存：改文件不用重启，下一次组装就生效；没改过就不重读。 */
const cache = { file: "", mtimeMs: -1, text: "" };

/**
 * 读指令文件。**读不到就返回空串**，不抛也不写错误进 prompt ——
 * 「没配」是正常状态，不该在系统提示里留一行「读不到 xxx」白占位置。
 */
export function instructionsText(file, maxBytes = INSTRUCTIONS_DEFAULTS.maxBytes) {
	let st;
	try {
		st = fs.statSync(file);
	} catch {
		cache.file = "";
		cache.mtimeMs = -1;
		cache.text = "";
		return "";
	}
	if (cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.text;
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8").trim();
	} catch {
		text = "";
	}
	if (text.length > maxBytes) {
		text = `${text.slice(0, maxBytes)}\n\n（已按 maxBytes=${maxBytes} 截断，完整内容见 ${file}）`;
	}
	cache.file = file;
	cache.mtimeMs = st.mtimeMs;
	cache.text = text;
	return text;
}

/**
 * 挂上系统提示段。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config `{ enabled, file, maxBytes }`
 * @returns {() => void} disposer
 */
export function installInstructions(ctx, config = {}) {
	const cfg = { ...INSTRUCTIONS_DEFAULTS, ...config };
	if (cfg.enabled === false) return () => {};
	const file = cfg.file && cfg.file.trim() !== "" ? cfg.file : defaultInstructionsPath();

	// 幂等：这个宿主已经挂过就直接返回。这正是 dsh-purge 那个「重复注入」缺的一步。
	if (REGISTERED_HOSTS.has(ctx)) return () => {};
	REGISTERED_HOSTS.add(ctx);

	const disposer = ctx.systemPrompt.section({
		name: INSTRUCTIONS_SECTION,
		order: INSTRUCTIONS_ORDER,
		// 函数形式：每次组装现读（带 mtime 缓存），所以改文件不用重启。
		text: () => instructionsText(file, cfg.maxBytes),
	});

	return () => {
		REGISTERED_HOSTS.delete(ctx);
		try {
			if (typeof disposer === "function") disposer();
		} catch {
			/* 宿主这一版可能不返回 disposer —— 那就靠 REGISTERED 兜住重复 */
		}
	};
}
