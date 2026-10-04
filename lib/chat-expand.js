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
		// rc.x 把 BashRow 拆成「分发器 + StartedBashRow」，持有展开态的是后者。
		// 两个名字都留着：老版本按前面的命中，rc.x 按后面那个。
		altName: "StartedBashRow",
		label: "工具行（终端）",
	},
];

/**
 * 先按 `name` 找窗口，找不到再试 `altName`（上游重构换过组件名时用）；
 * 两个都在时**优先挑窗口里真有展开态的那个** —— rc.x 的 `BashRow` 还在，
 * 但只剩分发，状态在 `StartedBashRow` 里，光看名字会挑错。
 * 都没有 → null（报 missing，让用户看见「上游又改了」，而不是静默失效）。
 */
function findWindow(text, target) {
	const candidates = [target.name, target.altName]
		.filter((name) => typeof name === "string")
		.map((name) => bodyWindow(text, name))
		.filter((window) => window !== null);
	for (const window of candidates) {
		if (
			PATCHED.test(window.body) ||
			UNPATCHED.test(window.body) ||
			CALL_PATCHED.test(window.body) ||
			CALL_UNPATCHED.test(window.body)
		) {
			return window;
		}
	}
	return candidates[0] ?? null;
}

/** 未打补丁的形态；`open`/`expanded` 之类的变量名不一，所以整体正则。 */
const UNPATCHED = /const \[(\w+), (\w+)\] = \(0, react\.useState\)\(false\);/;
const PATCHED = /const \[(\w+), (\w+)\] = \(0, react\.useState\)\(true\);/;

// ── dsh 0.2.0-rc.x 的形态：状态被抽进共享 hook ────────────────────────────
//
// 上游把 `ReasoningRow` / `ToolRow` / `BashRow` 重构了：
//   · 组件改成 `const X = (0, react.memo)(function X(...) {`
//   · 折叠状态抽成 `useDisclosure(version = 0)`（定义在 chat bundle，
//     以 prop 传给 tool bundle 里的 ToolRow / BashRow）
//   · 组件体内**一个 `useState(false)` 都没有了**
// 所以 rc.x 要改两处：hook 的初始值 + 三个组件各自的调用点。
const HOOK_DEF_UNPATCHED = "function useDisclosure(version = 0) {";
const HOOK_DEF_PATCHED = "function useDisclosure(version = 0, defaultOpen = false) {";
const HOOK_STATE_UNPATCHED =
	"const [expandedVersion, setExpandedVersion] = (0, react.useState)(null);";
const HOOK_STATE_PATCHED =
	"const [expandedVersion, setExpandedVersion] = (0, react.useState)(defaultOpen ? version : null);";
/**
 * hook 的**现状**查询。patchDisclosureHook 是 apply 用的（返回 patched 表示
 * 「打算改」），status 必须单独判 —— 拿 apply 的返回值当现状会一路显示「已打补丁」。
 */
export function disclosureHookStatus(text) {
	if (text.includes(HOOK_DEF_PATCHED)) return "patched";
	if (text.includes(HOOK_DEF_UNPATCHED)) return "unpatched";
	return "missing";
}

/** rc.x 的调用点：`const { expanded, toggle } = useDisclosure();`（解构名不一） */
const CALL_UNPATCHED = /(const \{[^}]*\} = useDisclosure)\(\);/;
const CALL_PATCHED = /(const \{[^}]*\} = useDisclosure)\(0, true\);/;

/** hook 定义所在的那份 bundle（ToolRow/BashRow 是从这里以 prop 拿到的） */
export const HOOK_TARGET = {
	pkg: "@deepseek-ai/dsh-client-ui-chat",
	label: "展开默认值（useDisclosure）",
};

/**
 * 取一个组件函数体的窗口：从 `function <name>(` 到下一个顶层 `function`/`const`。
 * 只用来把状态查找限制在这一个组件里，避免误改别的行。
 *
 * rc.x 的组件是 `\n\t\tconst X = (0, react.memo)(function X(` —— `function`
 * 不在行首，所以锚点不能要求行首；结束点也要把 `const` 声明算上，否则窗口
 * 会一路跨过后面那些同样是 memo 包装的组件。
 */
function bodyWindow(text, name) {
	const anchor = new RegExp(`function ${name}\\s*\\(`);
	// 只取首个命中，所以锚点必须全文件唯一；重名了就宁可不改（报 missing），
	// 也不能猜一个改错。
	const first = anchor.exec(text);
	if (first === null) return null;
	if (anchor.test(text.slice(first.index + 1))) return null;
	const start = first.index;
	const rest = text.slice(start);
	const next = /\n\t{2}(?:function|const) /.exec(rest.slice(1));
	const end = next === null ? text.length : start + 1 + next.index;
	return { start, end, body: text.slice(start, end) };
}

/**
 * 给共享 hook 加上 `defaultOpen`：初始 `expandedVersion` 直接取 `version`，
 * 于是 `expanded = expandedVersion === version` 为真；toggle 逻辑不用动。
 *
 * @param text - bundle 原文
 * @returns `{ status, text }`；status 见 patchBundle
 */
export function patchDisclosureHook(text) {
	if (!text.includes(HOOK_DEF_UNPATCHED)) {
		return { status: text.includes(HOOK_DEF_PATCHED) ? "already" : "missing", text };
	}
	if (!text.includes(HOOK_STATE_UNPATCHED)) return { status: "unexpected", text };
	const out = text
		.replace(HOOK_DEF_UNPATCHED, () => HOOK_DEF_PATCHED)
		.replace(HOOK_STATE_UNPATCHED, () => HOOK_STATE_PATCHED);
	return { status: "patched", text: out };
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
	const window = findWindow(text, target);
	if (window === null) return { status: "missing", text };

	// 形态一（0.1.x）：组件自己持有 useState
	if (PATCHED.test(window.body)) return { status: "already", text };
	if (UNPATCHED.test(window.body)) {
		// String.replace 只换第一处命中，同文件里别的行不受影响
		const body = window.body.replace(UNPATCHED, (line) => line.replace(")(false)", ")(true)"));
		return { status: "patched", text: text.slice(0, window.start) + body + text.slice(window.end) };
	}

	// 形态二（rc.x）：状态在共享 hook 里，组件只调 useDisclosure()
	if (CALL_PATCHED.test(window.body)) return { status: "already", text };
	if (CALL_UNPATCHED.test(window.body)) {
		const body = window.body.replace(CALL_UNPATCHED, (_match, head) => `${head}(0, true);`);
		return { status: "patched", text: text.slice(0, window.start) + body + text.slice(window.end) };
	}

	return { status: "unexpected", text };
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
 * @param installRoots - dsh 安装树里的目录（web profile 的 `@deepseek-ai/*`
 *   是从安装树解析的，profile 的 node_modules 里没有 —— 不补这一步，
 *   `dsh-team patch` 在 web profile 上直接报「找不到 dsh 客户端 bundle」）
 * @returns `{ pkg, file, profiles }[]`
 */
export function discoverBundles(profilesRoot, installRoots = []) {
	const found = new Map();
	let profiles = [];
	try {
		profiles = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		profiles = [];
	}
	// 顶层 node_modules 是 pnpm workspace 的共享软链层，本身不是一个 profile。
	// 共享层不做 package.json 前置：createRequire 只把它当初始目录用，不需要该文件存在，
	// 而真机恰好只有共享层有 @deepseek-ai（profile 里是空的转派）。
	for (const name of [...profiles, ""]) {
		const dir = name === "" ? profilesRoot : path.join(profilesRoot, name);
		if (name !== "" && !fs.existsSync(path.join(dir, "package.json"))) continue;
		collectTargets(dir, name, found);
	}
	for (const root of installRoots) collectTargets(root, INSTALL_LABEL, found);
	return [...found.values()].map((entry) => ({ ...entry, profiles: [...entry.profiles] }));
}

/** 安装树来源的标记（用来在 `--status` 里说清这份是从哪儿找着的） */
export const INSTALL_LABEL = "（安装树）";

/** 从一个目录出发解析三个目标；按 realpath 去重，同一份只留一条。 */
function collectTargets(dir, label, found) {
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
		if (label !== "") entry.profiles.add(label);
		found.set(real, entry);
	}
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
export function applyPatch({ dshHome, profilesRoot = path.join(dshHome, "profiles"), installRoots = [], dryRun = false } = {}) {
	const cacheDir = cacheDirOf(dshHome);
	const manifest = readManifest(cacheDir);
	const bundles = discoverBundles(profilesRoot, installRoots);
	if (bundles.length === 0) {
		return [{ status: "no-bundles", label: "找不到 dsh 客户端 bundle", file: profilesRoot }];
	}

	const lines = [];
	let touched = false;
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
		// rc.x：三个组件都调那一份共享 hook，所以 hook 自己也要改一次（否则
		// 调用点传了 defaultOpen 也没有形参接，等于白改）
		if (bundle.pkg === HOOK_TARGET.pkg) {
			const result = patchDisclosureHook(text);
			// 旧形态下压根没有这个 hook —— 那不是「找不到组件」，不报给用户
			if (result.status !== "missing") {
				headers.push({ label: HOOK_TARGET.label, status: result.status });
				if (result.status === "patched") {
					text = result.text;
					changed = true;
				}
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
		touched = true;
	}

	// 全部 already 时就别碰 manifest：否则「patch 不写盘」这句话不成立
	if (!dryRun && touched) writeManifest(cacheDir, manifest);
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
	let touched = false;
	for (const [key, entry] of entries) {
		if (!fs.existsSync(entry.file)) {
			lines.push({ file: entry.file, status: "gone" });
			delete manifest[key];
			touched = true;
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
		if (problem === null) {
			delete manifest[key];
			touched = true;
		}
	}

	if (!dryRun && touched) writeManifest(cacheDir, manifest);
	return lines;
}

/** 现状：每个目标当前是打了还是没打。 */
export function patchStatus({ dshHome, profilesRoot = path.join(dshHome, "profiles"), installRoots = [] } = {}) {
	const bundles = discoverBundles(profilesRoot, installRoots);
	if (bundles.length === 0) return [];
	return bundles.map((bundle) => {
		const text = fs.readFileSync(bundle.file, "utf8");
		const targets = TARGETS.filter((t) => t.pkg === bundle.pkg).map((t) => {
			const window = findWindow(text, t);
			if (window === null) return { label: t.label, status: "missing" };
			if (PATCHED.test(window.body)) return { label: t.label, status: "patched" };
			if (UNPATCHED.test(window.body)) return { label: t.label, status: "unpatched" };
			// rc.x：形态是「调共享 hook」，所以看调用点。hook 自己那一行另报。
			if (CALL_PATCHED.test(window.body)) return { label: t.label, status: "patched" };
			if (CALL_UNPATCHED.test(window.body)) return { label: t.label, status: "unpatched" };
			return { label: t.label, status: "unexpected" };
		});
		if (bundle.pkg === HOOK_TARGET.pkg) {
			const hook = { status: disclosureHookStatus(text) };
			// 旧形态没有这个 hook（missing）——不是问题，别报成「找不到组件」
			if (hook.status !== "missing") {
				targets.push({
					label: HOOK_TARGET.label,
					status: hook.status,
				});
			}
		}
		return { file: bundle.file, profiles: bundle.profiles, targets };
	});
}
