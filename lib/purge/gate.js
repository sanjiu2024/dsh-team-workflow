/**
 * 外部 `dsh-purge` 与「移植进本包的 purge 半边」互斥。
 *
 * 为什么需要它（2026-10-31 实测）：
 *   - 两边都会 apply 同一批 86 条宿主补丁 —— 补丁锚点是文本替换，第二次是 already，
 *     看起来无害，但**备份文件会被后者改写**，还原时就回不到官方原件；
 *   - 两边都注册 `purge_status / purge_apply / purge_revert` 三个同名工具 ——
 *     后注册的那个要么抛 `already registered`，要么把前一个顶掉，用户点哪个都不确定；
 *   - 两边都往系统提示里挂**同名** section（都叫 `dsh-purge`）—— 段名相同但宿主代理不同，
 *     实测同一段注入文本出现 2 份、整行 68,977 字符、每次调用白付约 6.5k token。
 *
 * 所以只让一边活着：外部包装着时，本包不挂 purge，并在 `dsh-team status` 里说清楚。
 * 卸载外部包是用户的动作，这里不自动做（那是改别人的 profile）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 外部包的 npm 名。内部标识（段名 / 日志前缀）仍叫 dsh-purge，这里只认包名。 */
export const LEGACY_PACKAGE = "dsh-purge";

/** 本包名。用于自检核对，不参与判定。 */
export const SELF_PACKAGE = "dsh-team-workflow";

/** 常见的 profile 名；实际以 `$DSH_HOME/profiles` 下的目录为准，这里只是先探的候选。 */
const PROFILE_HINTS = ["desktop", "web", "tauri", "headless", "default"];

export function dshHomeOf(env = process.env) {
	return env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 找出 profile 里是否还装着外部 `dsh-purge`。
 *
 * 判据两条，任一命中即算装着：
 *   1. `<profile>/package.json` 的 dependencies / devDependencies 里有 `dsh-purge`；
 *   2. `<profile>/node_modules/dsh-purge/package.json` 存在且 `name` 就是 `dsh-purge`。
 *
 * 不看 `node_modules` 里有没有目录名 —— pnpm 的 store 软链、残留空目录都会误判。
 *
 * @returns {Array<{profile: string, where: string, spec: string}>} 命中位置
 */
export function findLegacyPurge({ home = dshHomeOf() } = {}) {
	const hits = [];
	const profilesDir = path.join(home, "profiles");
	let names = [];
	try {
		names = fs
			.readdirSync(profilesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		/* 没有 profiles 目录（headless / 裸 node 自检）→ 不可能装着外部包 */
	}
	const seen = new Set();
	for (const name of [...PROFILE_HINTS, ...names]) {
		if (seen.has(name)) continue;
		seen.add(name);
		const dir = path.join(profilesDir, name);
		const pkg = readJson(path.join(dir, "package.json"));
		const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
		if (typeof deps[LEGACY_PACKAGE] === "string" && deps[LEGACY_PACKAGE].trim()) {
			hits.push({ profile: name, where: path.join(dir, "package.json"), spec: deps[LEGACY_PACKAGE] });
		}
		const installed = path.join(dir, "node_modules", LEGACY_PACKAGE, "package.json");
		const meta = readJson(installed);
		if (meta?.name === LEGACY_PACKAGE) {
			hits.push({ profile: name, where: installed, spec: String(meta.version ?? "") });
		}
	}
	return hits;
}

/**
 * 闸门结论。
 *
 * @returns {{blocked: boolean, reason: string, hits: Array<object>}}
 */
export function purgeGate(options = {}) {
	const hits = findLegacyPurge(options);
	if (hits.length === 0) return { blocked: false, reason: "", hits: [] };
	const where = [...new Set(hits.map((hit) => hit.where))].join("; ");
	return {
		blocked: true,
		reason:
			`外部 ${LEGACY_PACKAGE} 仍在安装（${where}）。` +
			"本包的 purge 半边让位：两边同时活会双份注入系统提示、抢同名工具、并改写彼此的补丁备份。" +
			`要由本包接管：卸掉外部包（dsh plugin --profile <名字> remove ${LEGACY_PACKAGE}）后重启 dsh。`,
		hits,
	};
}
