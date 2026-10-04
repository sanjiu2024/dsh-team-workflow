/**
 * 给自检脚本定位 dsh 安装树里的 `@deepseek-ai`。
 *
 * 为什么要有这个文件：以前每个脚本各写一份
 * `C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/`
 * 当默认值 —— 那是打包版桌面端的历史路径。Linux、npx 缓存、源码安装全都不在那儿，
 * 于是这些脚本在别的机器上直接 `ERR_MODULE_NOT_FOUND`，而且因为 `npm test` 是
 * `&&` 链，**断在这儿之后十几个脚本一个都不跑**（2026-10-05 实测：
 * 17 个自检只跑到第 3 个）。
 *
 * 探测顺序与 CLI（`bin/dsh-team.mjs` 的 `whichDsh` / `findRc2StandardPatch`）一致：
 * 环境变量 → PATH 上的 `dsh` 反推 → `$DSH_HOME/profiles/*` 的共享软链层。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 判据用 `dsh-session`：自检真正要 import 的就是这个包，缺了就一定跑不起来。 */
function usable(dir) {
	return fs.existsSync(path.join(dir, "dsh-session"));
}

/** 从某个目录往上找 `<祖先>/node_modules/@deepseek-ai` */
function upFrom(start) {
	let dir = start;
	for (let i = 0; i < 8; i++) {
		const candidate = path.join(dir, "node_modules", "@deepseek-ai");
		if (usable(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** @returns 安装树里的 `@deepseek-ai` 目录；找不到返回 null（调用方要**明说跳过**，别静默通过） */
export function findDshModules() {
	const fromEnv = process.env.DSH_MODULES;
	if (typeof fromEnv === "string" && fromEnv !== "") {
		return usable(fromEnv) ? fromEnv : null;
	}

	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (entry.trim() === "") continue;
		// `dsh` 通常是包管理器 .bin 里的软链，先解析成真身再往上找
		let real = path.join(entry, process.platform === "win32" ? "dsh.cmd" : "dsh");
		if (!fs.existsSync(real)) continue;
		try {
			real = fs.realpathSync(real);
		} catch {
			// 解析不了就用原路径试
		}
		const found = upFrom(path.dirname(real));
		if (found !== null) return found;
	}

	const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
	try {
		for (const name of fs.readdirSync(path.join(home, "profiles"))) {
			const candidate = path.join(home, "profiles", name, "node_modules", "@deepseek-ai");
			if (usable(candidate)) return candidate;
		}
	} catch {
		// 没有 profiles 目录就是没有
	}
	return null;
}

/**
 * 拿不到安装树时的统一退场：**说清跳过了什么**，退出码 0。
 * 只印「全部通过」而不说跳过了哪几节，等于给自己发假合格证。
 */
export function skipWithoutDshModules(scriptName, sections) {
	console.log(`… 跳过 ${scriptName}：找不到 dsh 安装树（设 DSH_MODULES 可指定）`);
	console.log(`⚠️ 未验证：${sections}`);
	process.exit(0);
}
