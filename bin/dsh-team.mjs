#!/usr/bin/env node
/**
 * dsh-team CLI。
 *
 *   dsh-team install   [--profile tauri]   把本包装进某个 profile 并重启后生效
 *   dsh-team uninstall [--profile tauri]   移除
 *   dsh-team status    [--profile tauri]   看当前状态
 *   dsh-team preset install [--profile tauri]  生成 team 预设（compaction/subagent 配置）
 *   dsh-team thrift apply   [--profile tauri]  把 ~/.dsh/team-workflow/thrift.json 写进 profile patch
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

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAME = "dsh-team-workflow";
const ROW_ID = "dsh-team-workflow";
const SKILLS_ROW_ID = "dsh-team-workflow-skills";
const PRESET_ID = "team";
/** 上游 magic-context 版本。升级前先跑 mc check 确认注册面没变。 */
const MC_VERSION = "0.43.0";

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
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
const dryRun = flags["dry-run"] === true;

function fail(message, code = 1) {
	console.error(`✗ ${message}`);
	process.exit(code);
}

function ok(message) {
	console.log(`✓ ${message}`);
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
	return JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
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

/** 极简 YAML 输出：只够写 loader patch 那种结构（数组 / 对象 / 标量）；undefined 直接丢 */
function toYaml(value, indent = 0) {
	const pad = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return value
			.map((item) => {
				const rendered = toYaml(item, indent + 2);
				return rendered.includes("\n") ? `${pad}-\n${rendered}` : `${pad}- ${rendered.trimStart()}`;
			})
			.join("\n");
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined);
		if (entries.length === 0) return "{}";
		return entries
			.map(([key, item]) => {
				const rendered = toYaml(item, indent + 2);
				const isBlock = rendered.includes("\n") || rendered.startsWith("{") || rendered.startsWith("[");
				return isBlock ? `${pad}${key}:\n${rendered}` : `${pad}${key}: ${rendered}`;
			})
			.join("\n");
	}
	if (typeof value === "string") return JSON.stringify(value);
	return String(value);
}

// —— 子命令 ——

function cmdInstall() {
	requireProfile();
	const pkgFile = path.join(profileDir, "package.json");
	const before = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
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
	const before = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
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

/** team 预设 = standard 预设 + 团队 compaction / subagent 配置 */
function cmdPresetInstall() {
	const standard = findStandardPreset();
	if (!standard) fail("找不到 standard 预设目录");
	const teamSettings = readTeamSettings();
	const dest = path.join(dshHome, ".agent-presets", PRESET_ID);
	fs.mkdirSync(dest, { recursive: true });

	let cordis = fs.readFileSync(path.join(standard, "agent.cordis.yml"), "utf8");
	const pristine = cordis;
	const compaction = teamSettings.compaction;
	let patched;
	if (compaction) {
		patched = patchCompactionRow(cordis, compaction);
		cordis = patched.cordis;
	} else {
		console.log("  警告：team/agent-settings.json 里没有 compaction，预设压杯阈保持 standard 默认");
	}
	const persona = teamSettings.persona;
	if (persona) cordis = patchPersonaRow(cordis, persona);

	// 我们只能改 compaction 那一行。把补丁换回去必须逐字节等于 standard——
	// 这是能在没有图形界面时真正验证“预设没被改坏”的最直接的断言。
	// （dsh-agent-presets 只在 host 组合（tauri/web）里，headless 跑不到它，
	//   所以这里只能静态自证，端到端得重启 app 看。）
	if (patched && cordis.replace(patched.block, patched.plain) !== pristine) {
		fail("预设自检失败：除 compaction 那一行外还有其他改动，不要装");
	}
	console.log("  自检：除 compaction 那一行外与 standard 逐字一致 ✓");

	fs.writeFileSync(path.join(dest, "agent.cordis.yml"), cordis, "utf8");
	fs.writeFileSync(
		path.join(dest, "preset.yml"),
		[
			"name: 团队模式",
			"description: 标准能力 + 团队基线插件、审计日志、上下文节流与团队压缩阈值。",
			"order: 0",
			"",
		].join("\n"),
		"utf8",
	);
	ok(`team 预设已写到 ${dest}`);
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
	const file = path.join(PKG_ROOT, "team", "agent-settings.json");
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

/** 把 team 的 reserveTokens/keepRecentTokens 换成 ratio 形式的 compaction-basic 配置 */
function patchCompactionRow(cordis, compaction) {
	const contextWindow = compaction.contextWindow ?? 128000;
	const thresholdRatio = Number((1 - (compaction.reserveTokens ?? 32768) / contextWindow).toFixed(4));
	const retainRatio = Number(((compaction.keepRecentTokens ?? 20000) / contextWindow).toFixed(4));
	if (!(retainRatio < thresholdRatio)) fail("团队压缩配置不合法：keepRecentTokens 必须小于窗口减去 reserveTokens");

	const block = [
		"    - id: compaction-basic",
		"      name: '@deepseek-ai/dsh-compaction-basic'",
		"      config:",
		`        thresholdRatio: ${thresholdRatio}`,
		`        retainRatio: ${retainRatio}`,
		`        auto: ${compaction.enabled === false ? "false" : "true"}`,
	].join("\n");

	const plain = "    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'";
	if (!cordis.includes(plain)) fail("standard 预设里没找到 compaction-basic 行，预设结构变了？");
	return { cordis: cordis.replace(plain, block), block, plain };
}

function patchPersonaRow(cordis, persona) {
	const marker = "      You are a coding agent powered by the {{model}} model.";
	if (!cordis.includes(marker)) return cordis;
	return cordis.replace(
		marker,
		`      ${persona.replace(/\n/g, "\n      ")}`.trimEnd(),
	);
}

/** 把 thrift overlay 写进 profile patch，覆盖插件行的 config */
function cmdThriftApply() {
	requireProfile();
	const overlayFile = path.join(dshHome, "team-workflow", "thrift.json");
	let overlay = {};
	try {
		overlay = JSON.parse(fs.readFileSync(overlayFile, "utf8"));
	} catch {
		ok(`${overlayFile} 不存在或不是 JSON，按默认值写`);
	}
	const patchFile = path.join(profileDir, "cordis.patch.yml");
	const existing = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "[]\n";

	const thrift = Object.fromEntries(
		["compactThresholdRatio", "pruneThresholdChars", "pruneHeadChars", "pruneTailChars"]
			.filter((key) => overlay[key] !== undefined)
			.map((key) => [key, overlay[key]]),
	);
	if (Object.keys(thrift).length === 0) {
		ok(`${overlayFile} 里没有可覆盖的键，保持默认，不动 profile patch`);
		return;
	}

	// profile patch 只覆盖我们那一行的 config 键；其余原样保留
	const patch = [{ id: ROW_ID, config: { thrift } }];

	const body = `${existing.trimEnd()}\n\n# dsh-team thrift apply 生成：覆盖 ${ROW_ID} 的节流阈值\n${toYaml(patch)}\n`;
	if (dryRun) {
		console.log(body);
		return;
	}
	// 反复 apply 会重复追加；先把上一次生成的块切掉
	const cleaned = existing.split(/# dsh-team thrift apply 生成/)[0].trimEnd();
	fs.writeFileSync(patchFile, `${cleaned === "[]" ? "" : `${cleaned}\n\n`}${toYaml(patch)}\n`, "utf8");
	ok(`已写入 ${patchFile}`);
	console.log("  重启 dsh 后生效（压缩阈值是加载期固定的）。");
}

function cmdHelp() {
	console.log(`dsh-team ${pkg.version}

用法：
  dsh-team install   [--profile tauri] [--dry-run]
  dsh-team uninstall [--profile tauri]
  dsh-team status    [--profile tauri]
  dsh-team skills
  dsh-team preset install [--profile tauri]
  dsh-team thrift apply   [--profile tauri] [--dry-run]
  dsh-team lens install                把 pi-lens 连依赖一起拷进 vendor/，让本包自包含
  dsh-team lens check [文件] [--lsp]   真跑一次 analyze-cli，验 vendor 可不可用

环境变量：DSH_HOME（默认 ~/.dsh）`);
}

/** 把已装的 pi-lens 拷进 vendor/，这样换机器不用重新找 */
/** pi-lens 运行必需的运行时依赖（含传递依赖）；@ast-grep/cli 只要 napi，不要 50MB 的 .exe */
const LENS_RUNTIME_DEPS = [
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
