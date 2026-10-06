#!/usr/bin/env node
/**
 * dsh-team CLI。
 *
 *   dsh-team install   [--profile tauri]   把本包装进某个 profile 并重启后生效
 *   dsh-team uninstall [--profile tauri]   移除
 *   dsh-team status    [--profile tauri]   看当前状态
 *   dsh-team preset install [--profile tauri]  生成 team 预设（compaction/subagent 配置）
 *   dsh-team patch   [--dry-run|--restore|--status]  让思考链/工具行默认展开（改安装树）
 *   dsh-team thrift apply   [--profile tauri]  把 ~/.dsh/team-workflow/thrift.json 写进 team 预设
 *   dsh-team mc show                         看 mc 与 dsh 两边的压缩阈值是否拉开了
 *   dsh-team mc apply  [--dry-run]           把 mc 执行阈值写进 ~/.config/cortexkit/magic-context.jsonc
 *   dsh-team skills                         列出本包带的 skills
 *
 * 只做这三件事：调 dsh / pnpm、写 profile 下的 JSON/YAML、打印现状。
 * 不做自我更新（不碰 git），不做全局 shell hook。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applyPatch, patchStatus, restorePatch } from "../lib/chat-expand.js";
import {
	checkThresholdInvariant,
	MC_MANAGED_KEYS,
	MC_PROACTIVE_OFFSET,
	mcConfigPath,
	planMcApply,
	readTemplateSettings,
	readThreshold,
	upsertSettings,
} from "../lib/mc-config.js";
import {
	generateRc2TeamPreset,
	generateTeamPreset,
	readEffectiveThrift,
	resolveThriftConfig,
} from "../lib/preset-gen.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAME = "dsh-team-workflow";
const ROW_ID = "dsh-team-workflow";
const SKILLS_ROW_ID = "dsh-team-workflow-skills";
const PRESET_ID = "team";
/** 团队预设 bundle 的包名（rc.x 布局：预设声明必须由 bundle 承载） */
const PRESET_BUNDLE_NAME = "dsh-team-presets";
/** 上游 magic-context 版本。升级前先跑 mc check 确认注册面没变。 */
const MC_VERSION = "0.43.0";

const pkg = readJson(path.join(PKG_ROOT, "package.json"));
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");

// —— 参数 ——

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const [key, inline] = arg.slice(2).split("=");
			if (inline !== undefined) flags[key] = inline;
			else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
			else flags[key] = true;
		} else positional.push(arg);
	}
	return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const profile = typeof flags.profile === "string" ? flags.profile : "tauri";
const profileDir = path.join(dshHome, "profiles", profile);

/**
 * 布尔开关只看「写没写」，不看写了什么值。
 * 否则 `--dry-run=false`、`--status=yes` 会掉进 `=== true` 的比较里、被当成没给，
 * 于是本该只看一眼的命令真的去改安装树了。
 */
const has = (name) => name in flags;

const dryRun = has("dry-run");

function fail(message, code = 1) {
	console.error(`✗ ${message}`);
	process.exit(code);
}

function ok(message) {
	console.log(`✓ ${message}`);
}

/** 读一个 JSON 文件。文件不在就返回 fallback；格式坏了就报清楚是哪个文件，
 * 而不是抛一个裸的 SyntaxError。 */
function readJson(file, fallback) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (fallback !== undefined && error.code === "ENOENT") return fallback;
		fail(`读不了 ${file}：${error.message}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		fail(`解析不了 ${file}：${error.message}`);
	}
}

function requireProfile() {
	if (!fs.existsSync(path.join(profileDir, "package.json"))) {
		fail(`profile "${profile}" 不存在：${profileDir}`);
	}
}

/** Windows 下 shell 转发不会自己加引号：路径带空格时 pnpm 会把一个包名拆成三个 */
function quote(value) {
	return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** 跑一条命令；dry-run 时只打印。cwd 默认为当前目录。 */
function run(command, args, options = {}) {
	const pretty = [command, ...args].map(quote).join(" ");
	if (dryRun) {
		console.log(`[dry-run] ${pretty}`);
		return { status: 0 };
	}
	console.log(`$ ${pretty}`);
	const { env, ...rest } = options;
	return spawnSync(pretty, {
		stdio: "inherit",
		shell: true,
		...rest,
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
}

function readProfilePkg() {
	requireProfile();
	return readJson(path.join(profileDir, "package.json"));
}

/** 取 SKILL.md 的 description；ponytail 那批用的是折叠块标量 `description: >` */
function skillDescription(text) {
	const lines = text.split(/\r?\n/);
	const at = lines.findIndex((line) => /^description:/.test(line));
	if (at < 0) return "";
	const inline = lines[at].slice("description:".length).trim();
	if (inline && inline !== ">" && inline !== "|" && inline !== ">-" && inline !== "|-") {
		return inline.replace(/^['"](.*)['"]$/, "$1");
	}
	const block = [];
	for (let i = at + 1; i < lines.length; i++) {
		if (lines[i].trim() === "") {
			block.push("");
			continue;
		}
		if (!/^\s/.test(lines[i])) break;
		block.push(lines[i].trim());
	}
	return block.join(" ").trim();
}

// —— 子命令 ——

function cmdInstall() {
	requireProfile();
	const pkgFile = path.join(profileDir, "package.json");
	const before = readJson(pkgFile);
	const deps = before.dependencies ?? {};
	const bundles = before.dsh?.profile?.bundles ?? [];
	const spec = `link:${PKG_ROOT}`;

	// 不能走 `dsh plugin add link:<路径>`：dsh.cmd 是批处理，`%*` 转发会重解析，
	// 路径里的空格被 pnpm 拆成多个包名。直接写 profile 的 package.json —— 
	// JSON 字符串值不过 shell，空格安全。
	const next = {
		...before,
		dependencies: { ...deps, [PKG_NAME]: spec },
		dsh: {
			...before.dsh,
			profile: {
				...before.dsh?.profile,
				bundles: bundles.includes(PKG_NAME) ? bundles : [...bundles, PKG_NAME],
			},
		},
	};

	if (dryRun) {
		console.log(`[dry-run] 写 ${pkgFile}`);
		console.log(`[dry-run]   dependencies[${PKG_NAME}] = ${spec}`);
		console.log(`[dry-run]   dsh.profile.bundles += ${PKG_NAME}`);
	} else {
		fs.writeFileSync(pkgFile, `${JSON.stringify(next, null, 2)}\n`);
		console.log(`$ 写 ${pkgFile}`);
	}

	// 不带 args：让 pnpm 从 profile 自己的 package.json 装，链接天然带空格也安全
	const result = run("dsh", ["plugin", "--profile", profile, "install"]);
	if (result.status !== 0) fail(`pnpm install 失败（退出码 ${result.status}）`);

	const linked = path.join(profileDir, "node_modules", PKG_NAME);
	if (!fs.existsSync(linked)) fail(`装完了但 ${linked} 不存在；检查上面的 pnpm 输出`);
	ok(`已装进 profile "${profile}"（${linked}）；重启 dsh 后生效`);
	console.log("  重启后可用 /team-baseline 自检。");
}

function cmdUninstall() {
	requireProfile();
	const pkgFile = path.join(profileDir, "package.json");
	const before = readJson(pkgFile);
	const deps = { ...(before.dependencies ?? {}) };
	delete deps[PKG_NAME];
	const bundles = (before.dsh?.profile?.bundles ?? []).filter((b) => b !== PKG_NAME);

	if (dryRun) {
		console.log(`[dry-run] 从 ${pkgFile} 移除 ${PKG_NAME}（dependencies + bundles）`);
	} else {
		fs.writeFileSync(
			pkgFile,
			`${JSON.stringify({ ...before, dependencies: deps, dsh: { ...before.dsh, profile: { ...before.dsh?.profile, bundles } } }, null, 2)}\n`,
		);
		console.log(`$ 写 ${pkgFile}`);
	}
	const result = run("dsh", ["plugin", "--profile", profile, "install"]);
	if (result.status !== 0) fail(`pnpm install 失败（退出码 ${result.status}）`);
	ok(`已从 profile "${profile}" 移除 ${PKG_NAME}`);
}

function cmdStatus() {
	const profilePkg = readProfilePkg();
	const bundles = profilePkg.dsh?.profile?.bundles ?? [];
	const deps = profilePkg.dependencies ?? {};
	const inBundles = bundles.includes(PKG_NAME);
	// 我们的两行是 bundle 补丁插入的，不在 bundles 列表里，落在 profile 的 patch 结果上
	const patchFile = path.join(profileDir, "cordis.patch.yml");
	const patchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";

	const skills = fs.existsSync(path.join(PKG_ROOT, "skills"))
		? fs.readdirSync(path.join(PKG_ROOT, "skills")).filter((n) => fs.existsSync(path.join(PKG_ROOT, "skills", n, "SKILL.md")))
		: [];

	console.log(`${PKG_NAME} ${pkg.version}`);
	console.log(`  包位置      ${PKG_ROOT}`);
	console.log(`  profile     ${profile}  (${profileDir})`);
	console.log(`  已装依赖    ${deps[PKG_NAME] ?? "否"}`);
	console.log(`  注册为 bundle ${inBundles ? "是" : "否"}`);
	console.log(`  用户 patch  ${fs.existsSync(patchFile) ? patchFile : "（无）"}`);
	if (patchText.includes(ROW_ID)) console.log(`  用户 patch 引用了 ${ROW_ID}`);
	console.log(`  团队规范    ${fs.existsSync(path.join(PKG_ROOT, "team", "RULES.md")) ? "有" : "缺"}`);
	console.log(`  skills      ${skills.length} 个：${skills.join(", ")}`);
	console.log(`  rtk         ${fs.existsSync(path.join(PKG_ROOT, "tools", "rtk.exe")) ? "已随包" : "未随包（回退 PATH）"}`);
	console.log(`  pi-lens     ${findLens() ?? "未找到（lens 功能会自己关掉）"}`);
	// 预设落点按布局分：rc.x 是 bundle 包，0.1.x 是目录
	const presetDir = path.join(dshHome, ".agent-presets", PRESET_ID);
	const bundlePatch = path.join(teamBundleDir(), "cordis.patch.yml");
	let presetWhere = "未生成";
	if (fs.existsSync(bundlePatch)) presetWhere = `${teamBundleDir()}（rc.x bundle）`;
	else if (fs.existsSync(path.join(presetDir, "preset.yml"))) presetWhere = `${presetDir}（0.1.x 目录）`;
	console.log(`  team 预设   ${presetWhere}`);
	const patchText2 = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
	if (new RegExp(`default:\\s*${PRESET_ID}\\b`).test(patchText2)) console.log(`  默认预设    ${PRESET_ID}`);
	console.log();
	console.log(`  定时任务    ${schedulerOn() ? "开" : "关（默认）"}  ${path.join(PKG_ROOT, "team", "extensions", "scheduler.json")}`);
	console.log(`  bundle 补丁插入的行：${SKILLS_ROW_ID}（skills） + ${ROW_ID}（插件本体）`);
}

/** 调度器开没开 —— 只读包内那份配置，不碰 profile */
function schedulerOn() {
	const file = path.join(PKG_ROOT, "team", "extensions", "scheduler.json");
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")).enabled === true;
	} catch {
		return false;
	}
}

function findLens() {
	const candidates = [
		path.join(PKG_ROOT, "vendor", "pi-lens"),
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-lens"),
		path.join(os.homedir(), ".pi", "npm", "node_modules", "pi-lens"),
	];
	return candidates.find((dir) => fs.existsSync(path.join(dir, "dist", "mcp", "analyze-cli.js"))) ?? null;
}

/** 找一份【可拷贝】的 pi-lens 源：vendor 自己不能当源（拷到自己身上） */
function findLensSource() {
	const candidates = [
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-lens"),
		path.join(os.homedir(), ".pi", "npm", "node_modules", "pi-lens"),
	];
	return candidates.find((dir) => fs.existsSync(path.join(dir, "dist", "mcp", "analyze-cli.js"))) ?? null;
}

function cmdSkills() {	const dir = path.join(PKG_ROOT, "skills");
	if (!fs.existsSync(dir)) fail("包里没有 skills/");
	for (const name of fs.readdirSync(dir)) {
		const file = path.join(dir, name, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		const description = skillDescription(fs.readFileSync(file, "utf8"));
		console.log(`/${name.padEnd(24)} ${description.slice(0, 90)}`);
	}
}

/**
 * dsh 0.2.0-rc.x：预设不再是目录，而是 profile 树里的一行
 * `@deepseek-ai/dsh-agent-preset` 声明，**由 bundle patch 承载**。
 * 出厂 standard 就在 dsh-web-app 这个 bundle 里，是个 patch 文件。
 *
 * 为什么不能放进 profile 的 cordis.patch.yml（2026-10-04 实测，别再试）：
 * 那样行会出现在组合树里、`--dump-config` 也看得到，但**预设不会被注册**；
 * `default: <那个 id>` 指向不存在的预设，会话退化成「无预设」——
 * persona/plan-mode 等预设文本全丢（系统提示 20911 → 18070 字），
 * 且 host 层被 disabled、只由预设提供的 `tool-fs`（read/write/edit）等一起消失。
 */
function findRc2StandardPatch() {
	const seeds = [];
	const dshBin = whichDsh();
	if (dshBin) seeds.push(path.dirname(dshBin));
	seeds.push(path.join(profileDir, "node_modules", ".bin"));
	for (const seed of seeds) {
		let dir = path.resolve(seed);
		for (let i = 0; i < 8; i++) {
			const file = path.join(dir, "node_modules", "@deepseek-ai", "dsh-web-app", "presets", "standard.patch.yml");
			if (fs.existsSync(file)) return file;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

/** PATH 上找 dsh —— 拿它反推安装树（profile 的 node_modules 里没有 @deepseek-ai/*） */
function whichDsh() {
	const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir.trim() === "") continue;
		for (const name of names) {
			const file = path.join(dir, name);
			if (!fs.existsSync(file)) continue;
			try {
				return fs.realpathSync(file);
			} catch {
				return file;
			}
		}
	}
	return null;
}

/** 团队预设 bundle 的落点：放 DSH_HOME 下（无空格，且不往仓库里拉二进制/生成物） */
function teamBundleDir() {
	return path.join(dshHome, "team-workflow", "preset-team");
}

/**
 * dsh 安装树里能解析出 `@deepseek-ai/*` 的目录。
 *
 * 为什么需要：web profile 的客户端 bundle 不在 profile 的 node_modules 里
 * （那是空的，只有本插件），而是从安装树解析的 —— 只扫 profile 的话，
 * `dsh-team patch` 会报「找不到 dsh 客户端 bundle」，思考链/工具行就永远不会展开。
 */
function dshInstallRoots() {
	const roots = [];
	const bin = whichDsh();
	if (bin) roots.push(path.dirname(bin));
	return roots;
}

/** 生成并写下 bundle 包；返回生成结果（dry-run 时只打印） */
function writeTeamPresetBundle(standardPatch) {
	const pristine = fs.readFileSync(standardPatch, "utf8");
	let generated;
	try {
		generated = generateRc2TeamPreset(pristine, {
			settings: readTeamSettings(),
			overlay: readThriftOverlay(),
		});
	} catch (error) {
		// 不合法就在这里死：写进去 dsh 加载期会直接抛错，比现在报错严重得多
		fail(`预设生成失败：${error.message}`);
	}
	if (generated.changed === 0) {
		console.log("  警告：team/agent-settings.json 里没有 compaction，阈值保持 standard 默认");
	}

	const dir = teamBundleDir();
	if (dryRun) {
		console.log(`[dry-run] 写 ${dir}/{package.json, lib/index.js, cordis.patch.yml}`);
		return generated;
	}
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: PRESET_BUNDLE_NAME,
				version: pkg.version,
				private: true,
				description: "团队模式 agent 预设（由 dsh-team preset install 生成，勿手改）",
				type: "module",
				main: "./lib/index.js",
				exports: { ".": "./lib/index.js" },
				dsh: { bundle: { patch: "./cordis.patch.yml" } },
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(
		path.join(dir, "lib", "index.js"),
		`export const name = ${JSON.stringify(PRESET_BUNDLE_NAME)};\n`,
	);
	fs.writeFileSync(path.join(dir, "cordis.patch.yml"), generated.text, "utf8");
	console.log(`$ 写 ${dir}`);
	return generated;
}

/** 把 bundle 挂进 profile（dependencies + bundles + pnpm）；已装过就只更新内容 */
function installTeamPresetBundle() {
	const before = readProfilePkg();
	const deps = before.dependencies ?? {};
	const bundles = before.dsh?.profile?.bundles ?? [];
	const next = {
		...before,
		dependencies: { ...deps, [PRESET_BUNDLE_NAME]: `link:${teamBundleDir()}` },
		dsh: {
			...before.dsh,
			profile: {
				...before.dsh?.profile,
				bundles: bundles.includes(PRESET_BUNDLE_NAME) ? bundles : [...bundles, PRESET_BUNDLE_NAME],
			},
		},
	};
	if (dryRun) {
		console.log(`[dry-run] 写 ${path.join(profileDir, "package.json")}（dependencies + bundles 加 ${PRESET_BUNDLE_NAME}）`);
	} else if (JSON.stringify(next) !== JSON.stringify(before)) {
		fs.writeFileSync(path.join(profileDir, "package.json"), `${JSON.stringify(next, null, 2)}\n`);
		console.log(`$ 写 ${path.join(profileDir, "package.json")}`);
	}
	const result = run("dsh", ["plugin", "--profile", profile, "install"]);
	if (result.status !== 0) fail(`pnpm install 失败（退出码 ${result.status}）`);
	const linked = path.join(profileDir, "node_modules", PRESET_BUNDLE_NAME);
	if (!dryRun && !fs.existsSync(linked)) fail(`装完了但 ${linked} 不存在；检查上面的 pnpm 输出`);
}

/**
 * 把 registry 的 default 切到 team（写 profile patch，带备份、幂等）。
 *
 * 默认预设是**设置字段**（客户端读 `agent-preset-registry` 命名空间），
 * 而它的回落值就是这一行 config.default —— 所以写这里等价于在界面上设默认，
 * 但不需要人点。
 */
/** profile patch 里的 `agent-preset-registry.config.default` 是不是团队预设 */
function isDefaultPreset() {
	const file = path.join(profileDir, "cordis.patch.yml");
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	return new RegExp(`default:\\s*${PRESET_ID}\\b`).test(text);
}

function setDefaultPreset() {
	const file = path.join(profileDir, "cordis.patch.yml");
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (isDefaultPreset()) {
		ok(`默认预设已经是 ${PRESET_ID}`);
		return;
	}
	if (/^\s*- id:\s*agent-preset-registry\s*$/m.test(text)) {
		console.log(
			`  注意：${file} 里已有一条 agent-preset-registry，没替你动 —— 请手动把 config.default 设为 ${PRESET_ID}`,
		);
		return;
	}
	const block = [
		"",
		"# —— 默认预设（由 dsh-team preset install --default 写入）——",
		"- id: agent-preset-registry",
		"  name: '@deepseek-ai/dsh-agent-preset-registry'",
		"  config:",
		`    default: ${PRESET_ID}`,
		"",
	].join("\n");
	if (dryRun) {
		console.log(`[dry-run] 往 ${file} 追加 default: ${PRESET_ID}`);
		return;
	}
	// 只在第一次真写前留原件：保留「用户自己那一版」，别被我们覆盖掉
	if (text !== "" && !fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
	fs.writeFileSync(file, `${text.replace(/\s*$/, "")}\n${block}`);
	ok(`已把默认预设切成 ${PRESET_ID}${fs.existsSync(`${file}.bak`) ? `（原件 ${file}.bak）` : ""}`);
}

/** team 预设 = standard 预设 + 团队 compaction 阈值 + 模式标识 */
function cmdPresetInstall() {
	const rc2 = findRc2StandardPatch();
	if (rc2) {
		console.log(`预设布局：0.2.0-rc.x（声明行 + bundle 承载）\n  底稿：${rc2}`);
		const generated = writeTeamPresetBundle(rc2);
		installTeamPresetBundle();
		ok(`团队预设已就位：${teamBundleDir()} → profile "${profile}"`);
		if (generated.changed > 0) console.log(`  已应用 ${generated.changed} 处团队设置。`);
		if (has("default")) setDefaultPreset();
		else if (isDefaultPreset()) ok(`默认预设已经是 ${PRESET_ID}`);
		else console.log("  想让它成为新会话的默认：dsh-team preset install --default");
		console.log("  重启 dsh 后生效（预设是加载期挂载的）；重启后用 plugin_manager list_plugins 能看到 preset-team。");
		return;
	}

	// 旧布局（0.1.x）：$DSH_HOME/.agent-presets/<id>/ 目录
	const standard = findStandardPreset();
	if (!standard) fail("找不到 standard 预设（新旧两种布局都没找到）");
	const dest = path.join(dshHome, ".agent-presets", PRESET_ID);
	const pristine = fs.readFileSync(path.join(standard, "agent.cordis.yml"), "utf8");

	// 生成逻辑在 lib/preset-gen.js：纯文本进、纯文本出，好单独自检。
	// 它内部会做两件必须做的事 —— 把阈值写到真在跑的那两行，且照插件自己的规则校验；
	// 不合法的值在这里就拦住，否则 dsh 加载期会直接抛错起不来。
	let generated;
	try {
		generated = generateTeamPreset(pristine, { settings: readTeamSettings(), overlay: readThriftOverlay() });
	} catch (error) {
		fail(`预设生成失败：${error.message}`);
	}
	if (generated.changed === 0) {
		console.log("  警告：team/agent-settings.json 里没有 compaction，预设阀值保持 standard 默认");
	}

	fs.mkdirSync(dest, { recursive: true });
	fs.writeFileSync(path.join(dest, "agent.cordis.yml"), generated.text, "utf8");
	fs.writeFileSync(
		path.join(dest, "preset.yml"),
		["name: 团队模式", "description: 标准能力 + 团队压缩阈值。", "order: 0", ""].join("\n"),
		"utf8",
	);
	ok(`team 预设已写到 ${dest}`);
	if (generated.changed > 0) console.log(`  已应用 ${generated.changed} 处团队设置（含 thrift overlay 里的阈值）。`);
	console.log("  在 dsh 里把 agent-presets.default 改成 team，或在空会话里切换预设。");
	console.log("  注意：预设切换只在空会话生效。");
}

function findStandardPreset() {
	const roots = [
		path.join(PKG_ROOT, "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets"),
		path.join(dshHome, "profiles", profile, "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets"),
		path.join(os.homedir(), "AppData", "Roaming", "dsh-tauri", "dependencies", "dsh", "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets"),
	];
	for (const root of roots) {
		const dir = path.join(root, "standard");
		if (fs.existsSync(path.join(dir, "agent.cordis.yml"))) return dir;
	}
	return null;
}

function readTeamSettings() {
	// 文件不在时保持旧行为：安静地返回空设置，让 preset install 走「没有 compaction」的警告分支。
	return readJson(path.join(PKG_ROOT, "team", "agent-settings.json"), {});
}

/**
 * dsh **真正生效**的压缩阈值，换算成窗口百分比。
 *
 * 必须与 preset-gen 同源同优先序：用户 `/thrift compact` 写的 overlay **优先于**
 * 团队默认（`lib/preset-gen.js` 的 `resolveThriftConfig`：overlay > settings > 按 reserve 推导）。
 * 只看团队默认值会造成「mc show 显示 25%、mc apply 按 25% 校验，但实际跑的是别的数」——
 * 那正是 REQ-003 要修的 mc 空转，会被静默复现（第 2 层审查指出）。
 *
 * @returns {number | null} 百分比；读不到关键值返回 null（不拿 null 比大小）
 */
function dshCompactionPct() {
	let effective;
	try {
		// 复用与 preset install / thrift apply 完全同一条解析路径，不另写一套优先序。
		effective = resolveThriftConfig(readTeamSettings(), readThriftOverlay());
	} catch {
		// 配置非法（ratio 超出 (0,1]）：这里不该抛 —— mc show/apply 只是要拿个数比较，
		// 配置有问题该由 preset install 报错。
		return null;
	}
	const ratio = effective?.thresholdRatio;
	if (!Number.isFinite(ratio) || ratio <= 0) return null;
	return ratio * 100;
}

/** 读 thrift overlay（`/thrift` 写的那个文件）；坏 JSON 当成空，别把预设生成拖下水 */
function readThriftOverlay() {
	const file = path.join(dshHome, "team-workflow", "thrift.json");
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

/**
 * 把 thrift overlay 变成**真实生效**的预设。
 *
 * 为什么是重生成整份预设而不是写 profile patch：真在跑的两行在预设里
 * （`agent.cordis.yml` 的 compaction group；host 那边三行被 dsh-web-app
 * `disabled: true` 了），而预设是整份 entry list、**没有 patch 层** ——
 * 原来的实现往 profile patch 写，目标 row 和键名又都不对，所以静默无效。
 * 这里走和 `preset install` 完全同一条生成/校验路径，不另开一套。
 */
function cmdThriftApply() {
	const overlay = readThriftOverlay();
	const overlayFile = path.join(dshHome, "team-workflow", "thrift.json");
	if (Object.keys(overlay).length === 0) {
		ok(`${overlayFile} 不存在、不是 JSON 或没有可覆盖的键，保持默认，不改预设`);
		return;
	}

	// rc.x：预设是 bundle patch，所以「应用阈值」= 照当前出厂底稿重生成整份
	const rc2 = findRc2StandardPatch();
	if (rc2) {
		const bundlePatch = path.join(teamBundleDir(), "cordis.patch.yml");
		if (!fs.existsSync(bundlePatch)) {
			fail(`团队预设 bundle 还没生成（${bundlePatch}）：先跑 dsh-team preset install`);
		}
		const before = fs.readFileSync(bundlePatch, "utf8");
		// writeTeamPresetBundle 内部照插件规则校验，不合法直接 fail —— 不写坏预设
		const generated = writeTeamPresetBundle(rc2);
		const after = readEffectiveThrift(generated.text);
		if (dryRun) {
			// 回读不到就别印 undefined —— 那和显示假生效值是同一个毛病
			console.log(
				after ? `[dry-run] 将会生效：${JSON.stringify(after)}` : "[dry-run] 回读不到生效值（预设形状变了？先跑 preset install）",
			);
			return;
		}
		if (before === generated.text) {
			ok("预设已经是这个值，无需修改");
			return;
		}
		if (after) console.log(`  生效值：${JSON.stringify(after)}`);
		console.log("  重启 dsh 后生效（预设是加载期挂载的），或切一次预设。");
		return;
	}

	// 旧布局（0.1.x）：$DSH_HOME/.agent-presets/<id>/ 目录
	const overlayForLegacy = overlay;
	const standard = findStandardPreset();
	if (!standard) fail("找不到 standard 预设（新旧两种布局都没找到）");
	const presetFile = path.join(dshHome, ".agent-presets", PRESET_ID, "agent.cordis.yml");
	if (!fs.existsSync(presetFile)) {
		fail(`team 预设还没生成（${presetFile}）：先跑 dsh-team preset install`);
	}

	const pristine = fs.readFileSync(path.join(standard, "agent.cordis.yml"), "utf8");
	let generated;
	try {
		generated = generateTeamPreset(pristine, { settings: readTeamSettings(), overlay: overlayForLegacy });
	} catch (error) {
		// 不合法就在这里死：写进去 dsh 加载期会直接抛错，比现在报错严重得多
		fail(`拒绝写入：${error.message}`);
	}

	const before = fs.readFileSync(presetFile, "utf8");
	const after = readEffectiveThrift(generated.text);
	if (dryRun) {
		console.log(`[dry-run] 写 ${presetFile}`);
		console.log(
			after ? `[dry-run] 将会生效：${JSON.stringify(after)}` : "[dry-run] 回读不到生效值（预设形状变了？先跑 preset install）",
		);
		return;
	}
	if (before === generated.text) {
		ok(`预设已经是这个值，无需修改（${presetFile}）`);
		return;
	}
	fs.writeFileSync(presetFile, generated.text, "utf8");
	ok(`已写入 ${presetFile}`);
	if (after) console.log(`  生效值：${JSON.stringify(after)}`);
	console.log("  重启 dsh 后生效（这些阀值是加载期固定的），或切一次预设。");
}

/** 补丁结果码 → 中文短标签 */
const PATCH_LABEL = {
	patched: "已打补丁",
	already: "已经是展开态",
	missing: "找不到组件（上游改名？）",
	unexpected: "组件变了，没认出展开态（跳过）",
	unpatched: "未打补丁",
	restored: "已还原",
	"would-restore": "待还原（dry-run）",
	modified: "已被改过，跳过",
	"backup-missing": "备份丢了，跳过（重跑 patch 会重留）",
	gone: "文件已不存在",
	broken: "还原后语法检查失败",
};

/**
 * `dsh-team patch` —— 思考链与工具行默认展开。
 *
 * 改的是 dsh 客户端 bundle 里的 `useState(false)`：官方没有配置入口，
 * 组件也没导出，只能就地改。因此一律留原始备份，restore 只回滚
 * 「当前内容仍是我们写进去的那版」的文件，用户手改过的绝不覆盖。
 */
function cmdPatch() {
	if (has("status")) {
		const rows = patchStatus({ dshHome, installRoots: dshInstallRoots() });
		if (rows.length === 0) return fail("找不到 dsh 客户端 bundle；dsh 装在哪？");
		for (const row of rows) {
			console.log(`${row.file}${row.profiles.length ? `  [${row.profiles.join(", ")}]` : ""}`);
			for (const target of row.targets) {
				console.log(`  ${target.status === "patched" ? "✓" : "·"} ${target.label}：${PATCH_LABEL[target.status] ?? target.status}`);
			}
		}
		return;
	}

	if (has("restore")) {
		const rows = restorePatch({ dshHome, dryRun });
		if (rows.length === 0) return ok("没有可还原的记录（manifest 是空的）");
		for (const row of rows) {
			console.log(`${PATCH_LABEL[row.status] ?? row.status}  ${row.file}${row.error ? `\n    ${row.error}` : ""}`);
		}
		ok(dryRun ? "dry-run：以上是将会还原的文件" : "已还原；重启 dsh 后恢复折叠态");
		return;
	}

	const rows = applyPatch({ dshHome, installRoots: dshInstallRoots(), dryRun });
	for (const row of rows) {
		if (row.status === "no-bundles") return fail(row.label);
		console.log(`${row.file}${row.profiles.length ? `  [${row.profiles.join(", ")}]` : ""}`);
		for (const target of row.headers) {
			console.log(`  ${target.status === "patched" || target.status === "already" ? "✓" : "·"} ${target.label}：${PATCH_LABEL[target.status] ?? target.status}`);
		}
		if (row.error) console.log(`  ！语法检查失败，已回滚：${row.error}`);
	}
	ok(dryRun ? "dry-run：以上是将会改动的文件" : "已写入；dsh 开着会在 0.5 秒内热重载，否则重启生效");
	console.log("  还原：dsh-team patch --restore");
}

function cmdHelp() {
	console.log(`dsh-team ${pkg.version}

用法：
  dsh-team install   [--profile tauri] [--dry-run]
  dsh-team uninstall [--profile tauri]
  dsh-team status    [--profile tauri]
  dsh-team skills
  dsh-team preset install [--profile tauri] [--default] [--dry-run]
                                    生成「团队模式」预设（rc.x 下是个 bundle）；
                                    --default 顺带设成新会话的默认预设
  dsh-team thrift apply   [--profile tauri] [--dry-run]  写入团队预设（需先 preset install）
  dsh-team lens install                把 pi-lens 连依赖一起拷进 vendor/，让本包自包含
  dsh-team lens check [文件] [--lsp]   真跑一次 analyze-cli，验 vendor 可不可用
  dsh-team mc show                     看 magic-context 与 dsh 两边的压缩阈值是否拉开了
  dsh-team mc apply [--dry-run]        把 mc 执行阈值写进 ~/.config/cortexkit/magic-context.jsonc
  dsh-team patch [--status|--restore] [--dry-run]
                                      让思考链/工具行默认展开（改 dsh 安装树，可还原）
  dsh-team scheduler [status|enable|disable]
                                      定时任务调度器开关（默认关，改完重启 dsh）

环境变量：DSH_HOME（默认 ~/.dsh）`);
}

/** 把已装的 pi-lens 拷进 vendor/，这样换机器不用重新找 */
/** pi-lens 运行必需的运行时依赖（含传递依赖）；@ast-grep/cli 只要 napi，不要 50MB 的 .exe */
const LENS_RUNTIME_DEPS = [
	// typebox 是**必需**的：pi-lens 故意不打包它（dist/clients/deps/typebox.js
	// 只 `export { Type } from "typebox"`），靠宿主提供。pi 宿主自带，dsh 没有，
	// 缺了就连 dist/index.js 都 import 不进来 —— 整个工具集静默失效。
	"typebox",
	"js-yaml",
	"minimatch",
	"brace-expansion",
	"balanced-match",
	"pidusage",
	"vscode-jsonrpc",
	"web-tree-sitter",
];

/** 在 node_modules 里找一个包的真实位置（能处理 pnpm 的软链） */
function findDep(name) {
	const roots = [
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules"),
		path.join(os.homedir(), ".pi", "npm", "node_modules"),
	];
	for (const root of roots) {
		const dir = path.join(root, name);
		if (fs.existsSync(dir)) return dir;
	}
	return null;
}

function cmdLensInstall() {
	const source = process.env.PI_LENS_DIR ?? findLensSource();
	if (!source) fail("没找到 pi-lens 源；先 npm i -g pi-lens 或设 PI_LENS_DIR");
	const dest = path.join(PKG_ROOT, "vendor", "pi-lens");
	const nodeModules = path.join(dest, "node_modules");

	// pi-lens 把 @ast-grep/* 声明成 optional peer：它从【自己的】node_modules 往上找。
	// 所以不能只拷 pi-lens —— 得把它真实的依赖树一起搬进 vendor/pi-lens/node_modules。
	const steps = [
		[source, dest, "pi-lens 本体"],
		...LENS_RUNTIME_DEPS.map((name) => [findDep(name), path.join(nodeModules, name), name]),
		[
			findDep("@ast-grep/napi"), path.join(nodeModules, "@ast-grep", "napi"), "@ast-grep/napi",
		],
		[
			findDep("@ast-grep/napi-win32-x64-msvc"),
			path.join(nodeModules, "@ast-grep", "napi-win32-x64-msvc"),
			"@ast-grep/napi-win32-x64-msvc",
		],
	];

	const missing = steps.filter(([from]) => !from || !fs.existsSync(from));
	if (missing.length > 0) {
		fail(`缺这些包，装不了 pi-lens 运行时：${missing.map((s) => s[2]).join(", ")}`);
	}

	if (dryRun) {
		for (const [from, to, label] of steps) console.log(`[dry-run] ${label}: ${from} → ${to}`);
		console.log(`[dry-run] pi-tui 桩 → ${path.join(nodeModules, "@earendil-works", "pi-tui")}`);
		return;
	}

	// 老 vendor 先清掉，否则改依赖时旧文件会留着掺和
	fs.rmSync(dest, { recursive: true, force: true });
	for (const [from, to, label] of steps) {
		fs.mkdirSync(path.dirname(to), { recursive: true });
		// dereference：pnpm 的包是软链，拷内容而不是拷链
		fs.cpSync(from, to, { recursive: true, dereference: true });
		console.log(`  拷 ${label}`);
	}

	// pi-tui 只被 pi-lens 自己的渲染模块用到，放它自己的 node_modules 下，
	// 这样 Node 从 dist/**/*.js 往上找时命中它，而不是去够 pi 的安装树。
	const shimDir = path.join(nodeModules, "@earendil-works", "pi-tui");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.writeFileSync(
		path.join(shimDir, "package.json"),
		`${JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0-dsh-shim", type: "module", main: "index.js", exports: { ".": "./index.js" } }, null, 2)}\n`,
	);
	fs.copyFileSync(path.join(PKG_ROOT, "tools", "pi-tui-shim.js"), path.join(shimDir, "index.js"));
	console.log("  写 pi-tui 桩");

	const cli = path.join(dest, "dist", "mcp", "analyze-cli.js");
	if (!fs.existsSync(cli)) fail(`拷完了但 ${cli} 不在；检查 pi-lens 安装是否完整`);
	ok(`pi-lens 已就位：${dest}`);
	console.log("  验证：dsh-team lens check <文件>");
}

/** 真跑一次 analyze-cli，确认 vendor 可用 */
function cmdLensCheck() {
	const found = findLens();
	if (!found) fail("没找到 pi-lens；先跑 dsh-team lens install");
	const target = positional[2] ?? path.join(PKG_ROOT, "lib", "util.js");
	const cli = path.join(found, "dist", "mcp", "analyze-cli.js");
	const result = run(process.execPath, [cli, `--file=${target}`, `--cwd=${PKG_ROOT}`, ...(flags.lsp ? ["--lsp"] : [])]);
	if (result.status !== 0) fail(`analyze-cli 退出码 ${result.status}`);
}

/**
 * `dsh-team mc install` —— 把上游 magic-context bundle 拉进 vendor/。
 *
 * 不重新实现，也不改一行上游代码：
 *   npm pack @cortexkit/pi-magic-context@<版本> → 解包 → vendor/pi-magic-context/
 * 然后把 pi-tui 桩放进它自己的 node_modules，这样 Node 从 dist 往上找时
 * 命中桩，而不是去够 pi 的安装树。
 *
 * vendor/pi-magic-context 是 gitignored 的 —— 8.5M，谁要谁重建。
 */
function cmdMcInstall() {
	const version = typeof flags.version === "string" ? flags.version : MC_VERSION;
	const dest = path.join(PKG_ROOT, "vendor", "pi-magic-context");

	if (dryRun) {
		console.log(`[dry-run] npm install @cortexkit/pi-magic-context@${version} → 临时目录`);
		console.log(`[dry-run] 拷 → ${dest}`);
		console.log(`[dry-run] pi-tui 桩 → ${path.join(dest, "node_modules", "@earendil-works", "pi-tui")}`);
		return;
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pack-"));
	try {
		// 用 --prefix 装进临时目录，再拷出来。
		// 不用 npm pack + tar：Windows 的 tar 会把 "C:\…" 当成远程主机名
		// （把 hdd:path 当主机名），在 GNU tar 上必挂。
		const stage = path.join(tmp, "stage");
		fs.mkdirSync(stage, { recursive: true });
		fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ name: "mc-stage", private: true }, null, 2)}\n`);
		const installed = run(
			"npm",
			["install", `@cortexkit/pi-magic-context@${version}`, "--prefix", stage, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts"],
		);
		if (installed.status !== 0) fail(`npm install 失败：${installed.stderr?.trim() ?? installed.status}`);

		const source = path.join(stage, "node_modules", "@cortexkit", "pi-magic-context");
		if (!fs.existsSync(path.join(source, "dist", "index.js"))) {
			fail(`装完没有 dist/index.js；检查 ${source}`);
		}

		fs.rmSync(dest, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.cpSync(source, dest, { recursive: true, dereference: true });
		console.log(`  拷 magic-context ${version} → ${dest}`);

		// bundle 静态 import { Box, Text, matchesKey, visibleWidth, truncateToWidth }
		// from "@earendil-works/pi-tui" —— 桩放在它自己的 node_modules 下。
		const shimDir = path.join(dest, "node_modules", "@earendil-works", "pi-tui");
		fs.mkdirSync(shimDir, { recursive: true });
		fs.writeFileSync(
			path.join(shimDir, "package.json"),
			`${JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0-dsh-shim", type: "module", main: "index.js", exports: { ".": "./index.js" } }, null, 2)}\n`,
		);
		fs.copyFileSync(path.join(PKG_ROOT, "tools", "pi-tui-shim.js"), path.join(shimDir, "index.js"));
		console.log("  写 pi-tui 桩");

		// 伪 CLI 得落在**无空格**目录：bundle 用 `cmd.exe /d /s /c <path>` 调它，
		// 没加引号的路径会在空格处断开。插件启动时也会重装一遍（stagePiShim），
		// 这里做是为了让 `mc check` 之后立即可用，不用等下次启动。
		const piShimSrc = path.join(PKG_ROOT, "tools", "pi-shim");
		const piShimDest = path.join(os.homedir(), ".dsh", "team-workflow", "pi-shim");
		if (fs.existsSync(piShimSrc)) {
			// 文件被占用（historian 正在跑）时不能把整个 mc install 拖崩
			// —— vendor 已经装好了，shim 下次启动会重试。
			try {
				fs.mkdirSync(piShimDest, { recursive: true });
				for (const name of fs.readdirSync(piShimSrc)) {
					fs.copyFileSync(path.join(piShimSrc, name), path.join(piShimDest, name));
				}
				console.log(`  伪 CLI → ${piShimDest}（historian 靠它在 PATH 上找到 pi）`);
			} catch (error) {
				console.warn(`  警告：伪 CLI 未更新（${error.message}）；插件启动时会重试`);
			}
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	ok(`magic-context 已就位：${dest}`);
	console.log("  验证：dsh-team mc check");
}

/**
 * `dsh-team mc check` —— 用一个桩 pi 把 bundle 完整跑一遍，报注册面。
 *
 * 这是唯一诚实的验证：不启动真 dsh（要 GUI），但 bundle 的真实注册行为
 * 全在这里暴露 —— 工具数、命令数、事件处理器数、context 是否真在改写消息。
 */
function cmdMcCheck() {
	const bundleDir = process.env.MC_BUNDLE_DIR ?? path.join(PKG_ROOT, "vendor", "pi-magic-context");
	const entry = path.join(bundleDir, "dist", "index.js");
	if (!fs.existsSync(entry)) fail(`没找到 magic-context bundle；先跑 dsh-team mc install（找的是 ${entry}）`);

	const probe = path.join(PKG_ROOT, "tools", "mc-probe.mjs");
	if (!fs.existsSync(probe)) fail(`缺探针 ${probe}`);
	const result = run(process.execPath, [probe], { MC_BUNDLE_DIR: bundleDir });
	process.exit(result.status ?? 1);
}

/**
 * `dsh-team mc show` —— 把 mc 与 dsh 两边的压缩阈值摆在一起，并判不变式。
 *
 * 为什么要专门看：两边都「能」压上下文，但只有一个该先动手。mc 的执行阈值
 * 必须低于 dsh 的压缩阈值 —— 否则 dsh 先把地板压回低位，mc 的主动线永远
 * 够不到，它排队的操作（drop）就永远不执行（REQ-003 修的 bug）。
 */
function cmdMcShow() {
	const file = mcConfigPath();
	const exists = fs.existsSync(file);
	let mcPct = null;
	let historyPct = null;
	if (exists) {
		try {
			const text = fs.readFileSync(file, "utf8");
			mcPct = readThreshold(text);
			historyPct = readThreshold(text, "history_budget_percentage");
		} catch (error) {
			fail(`读 mc 配置失败（${file}）：${error.message}`);
		}
	}
	const dshPct = dshCompactionPct();
	const template = readTemplateSettings(PKG_ROOT);
	const templatePct = template[MC_MANAGED_KEYS[0]];
	const templateHistory = template["history_budget_percentage"];

	console.log(`mc 配置文件：${file}${exists ? "" : "（不存在 → 未设置过）"}`);
	if (mcPct === null) {
		console.log("mc 执行阈值：未设置（mc 默认 65%，主动线 63%）");
	} else {
		console.log(`mc 执行阈值：${mcPct}%（主动线 ${Math.max(0, mcPct - MC_PROACTIVE_OFFSET)}%）`);
	}
	console.log(`dsh 压缩阈值：${dshPct === null ? "读不到（team/agent-settings.json？）" : `${dshPct}%`}`);

	// history block 预算：它不是阈值，是阈值一降就跟着缩水的**副作用**，
	// 所以要一起看绝对值，否则「阈值降了、mc 能注入的历史也少了」会被忽略。
	// 窗口从团队设置里读（不硬编码）：它与 dsh 阈值同源，免得改窗口时这里静默失准。
	const shownHistory = historyPct ?? templateHistory;
	const window = Number(readTeamSettings().compaction?.contextWindow) || 512000;
	if (shownHistory !== undefined && mcPct !== null) {
		const now = Math.round(window * (mcPct / 100) * shownHistory);
		const before = Math.round(window * 0.65 * 0.15);
		console.log(`history block 预算：${shownHistory}${historyPct === null ? "（未设置，按模板值算）" : ""} → 约 ${now} tokens（改前 65%×0.15 ≈ ${before}）`);
	}
	if (templatePct !== undefined) {
		console.log(`本包模板值：${templatePct}%${templateHistory === undefined ? "" : ` / history ${templateHistory}`}`);
	}

	if (mcPct === null) {
		console.log("\n现在 dsh 会先动手（mc 默认 65% 高于 dsh），mc 排队的操作不会执行。");
		console.log("修：dsh-team mc apply");
		return;
	}
	const verdict = checkThresholdInvariant(mcPct, dshPct);
	if (verdict.ok) {
		ok(`阈值已拉开（mc ${mcPct}% < dsh ${dshPct}%，余量 ${(dshPct - mcPct).toFixed(0)} 个百分点）`);
	} else {
		console.log(`\n✗ ${verdict.reason}`);
		console.log("修：dsh-team mc apply");
		process.exitCode = 1;
	}
}

function cmdMcApply() {
	const settings = readTemplateSettings(PKG_ROOT);
	const templatePct = settings[MC_MANAGED_KEYS[0]];
	if (!Number.isFinite(templatePct)) {
		fail(`模板里读不到 ${MC_MANAGED_KEYS[0]}（${path.join("team", "mc-config.template.jsonc")}）`);
	}

	const dshPct = dshCompactionPct();
	const verdict = checkThresholdInvariant(templatePct, dshPct);
	if (!verdict.ok) {
		// 写进去也不会生效（dsh 仍先动手），且会把矛盾带进用户环境 —— 直接死。
		fail(`拒绝写入：${verdict.reason}`);
	}
	if (Object.keys(settings).length === 0) fail("模板里一个可管理的键都没有");

	const file = mcConfigPath();
	const existed = fs.existsSync(file);
	let before;
	try {
		// 不存在就按模板建一份：模板带解释注释，成员能看懂为什么是 20 而不是 65。
		before = existed ? fs.readFileSync(file, "utf8") : fs.readFileSync(path.join(PKG_ROOT, "team", "mc-config.template.jsonc"), "utf8");
	} catch (error) {
		fail(`读 mc 配置失败（${file}）：${error.message}`);
	}

	// 哪些键真的会变 —— 用 lib 里的纯函数算，CLI 与自检共用同一份逻辑
	const plan = planMcApply({ existed, before, settings });
	const changes = plan.map(({ key, from, to }) => `${key}：${from ?? "未设置（默认）"} → ${to}`);

	if (dryRun) {
		console.log(`[dry-run] ${existed ? "改" : "建"} ${file}`);
		for (const line of changes.length > 0 ? changes : [`全部 ${Object.keys(settings).length} 个键已是目标值，无需修改`]) {
			console.log(`[dry-run] ${line}`);
		}
		console.log("[dry-run] 其余键与注释保持原样");
		return;
	}

	if (changes.length === 0) {
		ok(`已经是目标值，无需修改（${file}）`);
		return;
	}

	let after;
	try {
		after = upsertSettings(before, settings);
	} catch (error) {
		fail(`拒绝写入：${error.message}`);
	}

	// 首次真写前留一份原件：这个命令改的是用户自己的配置文件（还有注释），
	// 写坏了得有办法拿回来。只在 .bak 不存在时创建 —— 保留**最初**那一版。
	const backup = `${file}.bak`;
	if (existed && !fs.existsSync(backup)) {
		try {
			fs.copyFileSync(file, backup);
		} catch (error) {
			fail(`备份原配置失败（${backup}）：${error.message}`);
		}
	}

	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, after, "utf8");
	} catch (error) {
		// 磁盘满 / 无权限：明确报错，不静默半写。
		fail(`写入失败（${file}）：${error.message}${fs.existsSync(backup) ? `（原件在 ${backup}）` : ""}`);
	}
	ok(`${existed ? "已写入" : "已创建"} ${file}`);
	if (existed && fs.existsSync(backup)) console.log(`  原件已备份到 ${backup}`);
	for (const line of changes) console.log(`  ${line}`);
	console.log(`  mc 主动线：${Math.max(0, templatePct - MC_PROACTIVE_OFFSET)}%    dsh 压缩阈值：${dshPct}%`);
	console.log("  重启 dsh 后生效（这些键不在 mc 的实时重载名单里）。");
	console.log("  验证：dsh-team mc show");
}

/**
 * 定时任务调度器（REQ-007）的开关。
 *
 * 只改包内 `team/extensions/scheduler.json` 的 `enabled` —— 不改 profile、不重装。
 * 因为调度器是本包的一个模块，不是独立 bundle：默认关靠的是这份配置，
 * `installScheduler` 在 enabled !== true 时立刻返回，什么都不注册。
 */
function cmdScheduler(mode) {
	const file = path.join(PKG_ROOT, "team", "extensions", "scheduler.json");
	if (!fs.existsSync(file)) fail(`找不到 ${file}`);
	const raw = readJson(file, null);
	if (raw === null || typeof raw !== "object") fail(`${file} 不是合法 JSON 对象`);

	if (mode === "enable" || mode === "disable") {
		const want = mode === "enable";
		if (raw.enabled === want) {
			console.log(`调度器已经是${want ? "开" : "关"}的，没动。`);
		} else {
			raw.enabled = want;
			// 临时文件 + rename：直接覆写的话，写到一半被打断就留下半个 JSON。
			// `readJsonConfig` 遇到解析失败会静默退回内置默认值（= enabled: false），
			// 于是「文件坏了」表现为「调度器自己关了」，排查起来很费劲。
			const tmp = `${file}.tmp-${process.pid}`;
			fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
			fs.renameSync(tmp, file);
			ok(`已把 ${path.relative(PKG_ROOT, file)} 的 enabled 改成 ${want}`);
		}
	}

	const on = raw.enabled === true;
	const store = path.join(dshHome, "team-workflow", "scheduler");
	console.log();
	console.log(`定时任务调度器  ${on ? "已开启" : "已关闭（默认）"}`);
	console.log(`  配置文件    ${file}`);
	console.log(`  存储目录    ${store}${fs.existsSync(store) ? "" : "（还没建，跑过才有）"}`);
	console.log(`  调度间隔    ${raw.tickMs ?? 1000}ms`);
	console.log(`  并发上限    ${raw.maxConcurrent ?? 4}`);
	console.log(`  单次上限    ${raw.runTimeoutMinutes ?? 30} 分钟`);
	console.log(`  历史条数    ${raw.historyLimit ?? 200}`);
	console.log(`  任务数上限  ${raw.maxTasks ?? 200}`);
	console.log(`  默认 preset ${raw.agentPreset ?? "standard"}`);
	console.log(`  默认权限档  ${raw.permission ?? "read-only"}   ← 每个新任务的默认沙箱档位`);
	console.log(`  权限天花板  ${raw.maxPermission ?? "workspace-write"}   ← 任何任务都不许超过它`);
	console.log();
	if (!on) {
		console.log("  开启：dsh-team scheduler enable   （改完要重启 dsh）");
		console.log("  它做什么：到点在**全新会话**里无人值守跑一段 prompt，8 种计划，");
		console.log("            4 个 scheduler_* 工具 + Web GUI 面板。");
		console.log("  注意：无人值守 = 审批策略强制 never，permission 是唯一安全边界。");
	} else {
		console.log("  关闭：dsh-team scheduler disable  （改完要重启 dsh）");
		console.log(`  路由前缀    /api/team/scheduler`);
	}
}

const [command, sub] = positional;
switch (command) {
	case "install":
		cmdInstall();
		break;
	case "uninstall":
		cmdUninstall();
		break;
	case "status":
		cmdStatus();
		break;
	case "skills":
		cmdSkills();
		break;
	case "lens":
		if (sub === "install") cmdLensInstall();
		else if (sub === "check") cmdLensCheck();
		else fail("用法：dsh-team lens install | lens check [文件] [--lsp]");
		break;
	case "mc":
		if (sub === "install") cmdMcInstall();
		else if (sub === "check") cmdMcCheck();
		else if (sub === "show") cmdMcShow();
		else if (sub === "apply") cmdMcApply();
		else fail("用法：dsh-team mc install [--version 0.43.0] | mc check | mc show | mc apply [--dry-run]");
		break;
	case "patch":
		// patch 没有子词；`patch status`（漏敲 `--`）不能静默落到真改安装树
		if (sub !== void 0) fail("用法：dsh-team patch [--status|--restore] [--dry-run]");
		cmdPatch();
		break;
	case "preset":
		if (sub !== "install") fail("用法：dsh-team preset install");
		cmdPresetInstall();
		break;
	case "thrift":
		if (sub !== "apply") fail("用法：dsh-team thrift apply");
		cmdThriftApply();
		break;
	case "scheduler":
		if (sub === void 0 || sub === "status") cmdScheduler("status");
		else if (sub === "enable" || sub === "disable") cmdScheduler(sub);
		else fail("用法：dsh-team scheduler [status|enable|disable]");
		break;
	case undefined:
	case "help":
	case "--help":
	case "-h":
		cmdHelp();
		break;
	default:
		fail(`未知命令 "${command}"；跑 dsh-team --help`);
}
