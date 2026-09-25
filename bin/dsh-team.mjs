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
import { generateTeamPreset, readEffectiveThrift } from "../lib/preset-gen.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAME = "dsh-team-workflow";
const ROW_ID = "dsh-team-workflow";
const SKILLS_ROW_ID = "dsh-team-workflow-skills";
const PRESET_ID = "team";
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
	const presetDir = path.join(dshHome, ".agent-presets", PRESET_ID);
	console.log(`  team 预设   ${fs.existsSync(path.join(presetDir, "preset.yml")) ? presetDir : "未生成"}`);
	console.log();
	console.log(`  bundle 补丁插入的行：${SKILLS_ROW_ID}（skills） + ${ROW_ID}（插件本体）`);
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

/** team 预设 = standard 预设 + 团队 compaction 阀值 + 团队 persona */
function cmdPresetInstall() {
	const standard = findStandardPreset();
	if (!standard) fail("找不到 standard 预设目录");
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
		[
			"name: 团队模式",
			"description: 标准能力 + 团队基线插件、审计日志、magic-context 折叠；dsh 自带压缩抬到 0.9 只做兜底。",
			"order: 0",
			"",
		].join("\n"),
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
	const standard = findStandardPreset();
	if (!standard) fail("找不到 standard 预设目录");
	const presetFile = path.join(dshHome, ".agent-presets", PRESET_ID, "agent.cordis.yml");
	if (!fs.existsSync(presetFile)) {
		fail(`team 预设还没生成（${presetFile}）：先跑 dsh-team preset install`);
	}

	const overlay = readThriftOverlay();
	const overlayFile = path.join(dshHome, "team-workflow", "thrift.json");
	if (Object.keys(overlay).length === 0) {
		ok(`${overlayFile} 不存在、不是 JSON 或没有可覆盖的键，保持默认，不改预设`);
		return;
	}

	const pristine = fs.readFileSync(path.join(standard, "agent.cordis.yml"), "utf8");
	let generated;
	try {
		generated = generateTeamPreset(pristine, { settings: readTeamSettings(), overlay });
	} catch (error) {
		// 不合法就在这里死：写进去 dsh 加载期会直接抛错，比现在报错严重得多
		fail(`拒绝写入：${error.message}`);
	}

	const before = fs.readFileSync(presetFile, "utf8");
	const after = readEffectiveThrift(generated.text);
	if (dryRun) {
		console.log(`[dry-run] 写 ${presetFile}`);
		// 回读不到就别印 undefined —— 那和显示假生效值是同一个毛病
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
		const rows = patchStatus({ dshHome });
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

	const rows = applyPatch({ dshHome, dryRun });
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
  dsh-team preset install [--profile tauri]
  dsh-team thrift apply   [--profile tauri] [--dry-run]  写入 team 预设（需先 preset install）
  dsh-team lens install                把 pi-lens 连依赖一起拷进 vendor/，让本包自包含
  dsh-team lens check [文件] [--lsp]   真跑一次 analyze-cli，验 vendor 可不可用
  dsh-team patch [--status|--restore] [--dry-run]
                                      让思考链/工具行默认展开（改 dsh 安装树，可还原）

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
		else fail("用法：dsh-team mc install [--version 0.43.0] | mc check");
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
	case undefined:
	case "help":
	case "--help":
	case "-h":
		cmdHelp();
		break;
	default:
		fail(`未知命令 "${command}"；跑 dsh-team --help`);
}
