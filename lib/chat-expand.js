/**
 * `dsh-team patch` —— 让思考链与工具行默认展开。
 *
 * 为什么只能改安装树：这两处的展开态是组件内的 `useState(false)`
 * （`ReasoningRow` / `ToolRow` / `BashRow`），dsh 没有暴露任何配置入口，
 * 组件也没从包里导出，slot 接管只能粗粒度重写整个消息节点。
 * 所以直接改 `@deepseek-ai/dsh-client-ui-{chat,tool}/lib/client.js`。
 *
 * 这个模块只管「纯文本怎么变」+「备份/还原」，发现路径与落盘由调用方驱动，
 * 这样补丁逻辑可以在 fixture 上单测，不用真的碰安装树。
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

/**
 * 要打的目标：每个组件一个。
 *
 * `name` 用来在 bundle 里定位 `function <name>(`，必须是文件里唯一的
 * —— 上游改名或拆文件时这里会立刻报「找不到」，不会静默失效。
 * 只打「思考链 + 工具行」；CompactionItem / SystemPromptRow / 设置面板
 * 那些行不动（用户要的就是这两类）。
 */
export const TARGETS = [
	{
		pkg: "@deepseek-ai/dsh-client-ui-chat",
		name: "ReasoningRow",
		label: "思考链",
	},
	{
		pkg: "@deepseek-ai/dsh-client-ui-tool",
		name: "ToolRow",
		label: "工具行（通用）",
	},
	{
		pkg: "@deepseek-ai/dsh-client-ui-tool",
		name: "BashRow",
		label: "工具行（终端）",
	},
];

/** 未打补丁的形态；`open`/`expanded` 之类的变量名不一，所以整体正则。 */
const UNPATCHED = /const \[(\w+), (\w+)\] = \(0, react\.useState\)\(false\);/;
const PATCHED = /const \[(\w+), (\w+)\] = \(0, react\.useState\)\(true\);/;

/**
 * 取一个组件函数体的窗口：从 `function <name>(` 到下一个顶层 `function`。
 * 只用来把 `useState` 查找限制在这一个组件里，避免误改别的行。
 */
function bodyWindow(text, name) {
	const anchor = new RegExp(`\\n\\t*function ${name}\\s*\\(`);
	// 只取首个命中，所以锚点必须全文件唯一；重名了就宁可不改（报 missing），
	// 也不能猜一个改错。
	const first = anchor.exec(text);
	if (first === null) return null;
	if (anchor.test(text.slice(first.index + 1))) return null;
	const start = first.index;
	const rest = text.slice(start);
	const next = /\n\t{2}function /.exec(rest.slice(1));
	const end = next === null ? text.length : start + 1 + next.index;
	return { start, end, body: text.slice(start, end) };
}

/**
 * 对一段 bundle 文本算出补丁结果。
 * 纯函数：不改文件，只回答「该不该改、改成什么」。
 *
 * @param text - bundle 原文
 * @param target - TARGETS 里的一项
 * @returns `{ status, text }`；status 是 `patched`（已改）/ `already`（本来就展开）/
 *          `missing`（找不到这个组件，上游可能改名了）/ `unexpected`（组件还在但没有那个 useState）
 */
export function patchBundle(text, target) {
	const window = bodyWindow(text, target.name);
	if (window === null) return { status: "missing", text };

	if (PATCHED.test(window.body)) return { status: "already", text };

	if (!UNPATCHED.test(window.body)) return { status: "unexpected", text };

	// String.replace 只换第一处命中，同文件里别的行不受影响
	const body = window.body.replace(UNPATCHED, (line) => line.replace(")(false)", ")(true)"));
	return { status: "patched", text: text.slice(0, window.start) + body + text.slice(window.end) };
}

const sha1 = (buffer) => createHash("sha1").update(buffer).digest("hex");

/**
 * 找出这台机器上真正会被加载的那几份 client.js。
 *
 * 不猜路径：每个 profile 用 `createRequire` 解析包名，拿到的就是该 profile
 * 实际会 require 到的那一份（pnpm 软链会解析成真身）。多个 profile 指向
 * 同一份时按 realpath 去重。
 *
 * @param profilesRoot - `~/.dsh/profiles`
 * @returns `{ pkg, file, profiles }[]`
 */
export function discoverBundles(profilesRoot) {
	const found = new Map();
	let profiles = [];
	try {
		profiles = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
	// 顶层 node_modules 是 pnpm workspace 的共享软链层，本身不是一个 profile。
	// 共享层不做 package.json 前置：createRequire 只把它当初始目录用，不需要该文件存在，
	// 而真机恰好只有共享层有 @deepseek-ai（profile 里是空的转派）。
	for (const name of [...profiles, ""]) {
		const dir = name === "" ? profilesRoot : path.join(profilesRoot, name);
		if (name !== "" && !fs.existsSync(path.join(dir, "package.json"))) continue;
		for (const target of TARGETS) {
			let pkgFile;
			try {
				pkgFile = createRequire(path.join(dir, "package.json")).resolve(`${target.pkg}/package.json`);
			} catch {
				continue;
			}
			const file = path.join(path.dirname(pkgFile), "lib", "client.js");
			if (!fs.existsSync(file)) continue;
			const real = fs.realpathSync.native(file);
			const entry = found.get(real) ?? { pkg: target.pkg, file: real, profiles: new Set() };
			if (name !== "") entry.profiles.add(name);
			found.set(real, entry);
		}
	}
	return [...found.values()].map((entry) => ({ ...entry, profiles: [...entry.profiles] }));
}

/** 语法检查：补丁写完必须还能解析，否则一切白搭。 */
function syntaxOk(file) {
	const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	return result.status === 0 ? null : (result.stderr ?? "").trim().split("\n").slice(0, 3).join(" ");
}

/** 缓存目录：备份 + manifest 都在这，restore 靠它回滚。 */
const cacheDirOf = (dshHome) => path.join(dshHome, "team-workflow", "patch-cache");

function readManifest(cacheDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf8"));
	} catch {
		return {};
	}
}

function writeManifest(cacheDir, manifest) {
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(path.join(cacheDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * 打补丁：逐目标改文本，第一次改之前留原始备份，写完做语法检查，挂了就回滚。
 *
 * @param options.dshHome - 备份落点（`~/.dsh`）
 * @param options.profilesRoot - 默认 `<dshHome>/profiles`
 * @param options.dryRun - 只算不写
 * @returns 每个目标一行结果，供 CLI 打印
 */
export function applyPatch({ dshHome, profilesRoot = path.join(dshHome, "profiles"), dryRun = false } = {}) {
	const cacheDir = cacheDirOf(dshHome);
	const manifest = readManifest(cacheDir);
	const bundles = discoverBundles(profilesRoot);
	if (bundles.length === 0) {
		return [{ status: "no-bundles", label: "找不到 dsh 客户端 bundle", file: profilesRoot }];
	}

	const lines = [];
	for (const bundle of bundles) {
		const file = bundle.file;
		const original = fs.readFileSync(file);
		let text = original.toString("utf8");
		let changed = false;
		const headers = [];

		for (const target of TARGETS.filter((t) => t.pkg === bundle.pkg)) {
			const result = patchBundle(text, target);
			headers.push({ label: target.label, status: result.status });
			if (result.status === "patched") {
				text = result.text;
				changed = true;
			}
		}

		lines.push({ file, profiles: bundle.profiles, headers, changed, dryRun });

		if (!changed || dryRun) continue;

		// 备份必须等于「这次要打的原文」，否则就是陈的：dsh 升级把同路径的 client.js
		// 换成了新版本时，旧备份已经是上一版原貌，留着它会让 restore 把客户端
		// 降级回旧版本。自校验比额外记一本账可靠。
		const key = sha1(Buffer.from(file));
		const backup = path.join(cacheDir, key, "client.js");
		if (!fs.existsSync(backup) || !fs.readFileSync(backup).equals(original)) {
			fs.mkdirSync(path.dirname(backup), { recursive: true });
			fs.writeFileSync(backup, original);
		}

		fs.writeFileSync(file, text);
		const problem = syntaxOk(file);
		if (problem !== null) {
			fs.writeFileSync(file, original);
			lines.at(-1).changed = false;
			lines.at(-1).error = problem;
			continue;
		}
		manifest[key] = { file, backup, originalSha: sha1(original), patchedSha: sha1(fs.readFileSync(file)) };
	}

	if (!dryRun) writeManifest(cacheDir, manifest);
	return lines;
}

/**
 * 还原：只还原「当前内容还等于我们当时写进去的版本」的文件。
 * 用户自己又动过或 dsh 升级换过文件，就跳过并报告——不猜、不覆盖。
 */
export function restorePatch({ dshHome, dryRun = false } = {}) {
	const cacheDir = cacheDirOf(dshHome);
	const manifest = readManifest(cacheDir);
	const entries = Object.entries(manifest);
	if (entries.length === 0) return [];

	const lines = [];
	for (const [key, entry] of entries) {
		if (!fs.existsSync(entry.file)) {
			lines.push({ file: entry.file, status: "gone" });
			delete manifest[key];
			continue;
		}
		if (sha1(fs.readFileSync(entry.file)) !== entry.patchedSha) {
			lines.push({ file: entry.file, status: "modified" });
			continue;
		}
		if (dryRun) {
			lines.push({ file: entry.file, status: "would-restore" });
			continue;
		}
		// 备份丢了就跳过，不半途崩掉（崩在这里会让 manifest 来不及写回，
		// 下次仍然找不回这份备份）
		let pristine;
		try {
			pristine = fs.readFileSync(entry.backup);
		} catch (error) {
			lines.push({ file: entry.file, status: "backup-missing", error: error.message });
			continue;
		}
		fs.writeFileSync(entry.file, pristine);
		const problem = syntaxOk(entry.file);
		lines.push({ file: entry.file, status: problem === null ? "restored" : "broken", error: problem });
		if (problem === null) delete manifest[key];
	}

	if (!dryRun) writeManifest(cacheDir, manifest);
	return lines;
}

/** 现状：每个目标当前是打了还是没打。 */
export function patchStatus({ dshHome, profilesRoot = path.join(dshHome, "profiles") } = {}) {
	const bundles = discoverBundles(profilesRoot);
	if (bundles.length === 0) return [];
	return bundles.map((bundle) => {
		const text = fs.readFileSync(bundle.file, "utf8");
		return {
			file: bundle.file,
			profiles: bundle.profiles,
			targets: TARGETS.filter((t) => t.pkg === bundle.pkg).map((t) => {
				const window = bodyWindow(text, t.name);
				if (window === null) return { label: t.label, status: "missing" };
				if (PATCHED.test(window.body)) return { label: t.label, status: "patched" };
				if (UNPATCHED.test(window.body)) return { label: t.label, status: "unpatched" };
				return { label: t.label, status: "unexpected" };
			}),
		};
	});
}
