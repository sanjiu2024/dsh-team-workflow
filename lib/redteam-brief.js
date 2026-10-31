/**
 * 红队指挥稿 → 系统提示（REQ-029：红队模式融合进团队模式）。
 *
 * 为什么在插件层注，而不是写进预设的 persona：
 *   1. **两个模式共用同一份**。团队模式与红队模式都挂本插件，稿子只在这里改一次；
 *      写进两份预设就是两份需要同步的副本（红队预设的 persona、团队预设的 persona）。
 *   2. **YAML 装不下多行**。standard 底稿的 persona 是单行 plain scalar，追加多行会被
 *      YAML 折叠成一行，markdown 的段落/列表全糊在一起。插件层是纯文本，原样进。
 *   3. **可控**。`team/REDTEAM.md` 能按 mtime 现读，改完下一轮就生效；段名幂等，
 *      不会被 apply 与每轮组装各挂一次（dsh-purge 那个重复注入的形态）。
 *
 * 与 `lib/instructions.js` 的分工：
 *   - instructions 注**仓库外**的个人文件（`$DSH_HOME/team-workflow/instructions.md`）；
 *   - 这里注**仓库内**的 `team/REDTEAM.md` —— 跟 git 走、可评审、全团队一致。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 排在 instructions（650）之后。红队稿是"在团队基线上再加一层"，
 * 不该抢在基线之前（那会让模型先看到演练规则、后看到工程规矩）。
 */
export const REDTEAM_BRIEF_ORDER = 660;

/** 段名。幂等判据就是它，改它等于放开重复注入。 */
export const REDTEAM_BRIEF_SECTION = "team:redteam-brief";

export const REDTEAM_BRIEF_DEFAULTS = {
	enabled: true,
	/** 空串 = 包内 `team/REDTEAM.md` */
	file: "",
	/** 上限 64 KB：稿子本身 ~11 KB，留足余量但不允许无限增长到吃掉地板。 */
	maxBytes: 65536,
};

export const REDTEAM_BRIEF_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	file: (v) => (typeof v === "string" ? v : undefined),
	maxBytes: (v) => (Number.isFinite(v) && v >= 1024 && v <= 262144 ? v : undefined),
};

/**
 * 已挂过本段的宿主。按 host 去重（不是按段名）—— 与 instructions 同一套理由：
 * 同一个宿主被挂两次才是 bug，不同宿主各挂一份是对的。
 */
const REGISTERED_HOSTS = new WeakSet();

export function resolveDshHome(env = process.env) {
	const raw = env.DSH_HOME;
	if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
	return path.join(os.homedir(), ".dsh");
}

/** 包内默认稿子。`packageRoot` 由调用方给（插件里是 `new URL("../", import.meta.url)`）。 */
export function defaultRedteamBriefPath(packageRoot) {
	return path.join(packageRoot, "team", "REDTEAM.md");
}

/**
 * 剥掉维护者注释（HTML 注释）。稿子开头的「这段从哪来、怎么改」是给人看的，
 * 每轮塞进系统提示就是白付地板。
 */
export function stripMaintainerNotes(text) {
	return String(text).replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** 按 mtime 缓存：改文件不用重启，下一轮组装就生效。 */
const cache = { file: "", mtimeMs: -1, text: "" };

/**
 * 读稿子。**读不到就返回空串** —— 「没这份文件」是正常状态（用户可能删了），
 * 不该在系统提示里留一行「读不到 xxx」白占位置。
 */
export function redteamBriefText(file, maxBytes = REDTEAM_BRIEF_DEFAULTS.maxBytes) {
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
		text = stripMaintainerNotes(fs.readFileSync(file, "utf8"));
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
 * @param {string} packageRoot 本包根目录（绝对路径）
 * @param {object} config `{ enabled, file, maxBytes }`
 * @returns {{ enabled: boolean, file: string, dispose: () => void }}
 */
export function installRedteamBrief(ctx, packageRoot, config = {}) {
	const cfg = { ...REDTEAM_BRIEF_DEFAULTS, ...config };
	const file = cfg.file && cfg.file.trim() !== "" ? cfg.file : defaultRedteamBriefPath(packageRoot);
	const noop = () => {};

	if (cfg.enabled === false) return { enabled: false, file, dispose: noop };

	// 幂等：这个宿主已经挂过就直接返回。
	if (REGISTERED_HOSTS.has(ctx)) return { enabled: true, file, dispose: noop };
	REGISTERED_HOSTS.add(ctx);

	let disposer = noop;
	try {
		disposer = ctx.systemPrompt.section({
			name: REDTEAM_BRIEF_SECTION,
			order: REDTEAM_BRIEF_ORDER,
			// 函数形式：每次组装现读（带 mtime 缓存），改文件不用重启。
			text: () => redteamBriefText(file, cfg.maxBytes),
		});
	} catch (error) {
		REGISTERED_HOSTS.delete(ctx);
		throw error;
	}

	return {
		enabled: true,
		file,
		dispose: () => {
			REGISTERED_HOSTS.delete(ctx);
			try {
				if (typeof disposer === "function") disposer();
			} catch {
				/* 宿主这一版可能不返回 disposer —— 靠 REGISTERED 兜住重复 */
			}
		},
	};
}
