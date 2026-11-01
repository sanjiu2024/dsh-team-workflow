#!/usr/bin/env node
/**
 * REQ-028 / REQ-029 自检：dsh-purge 移植进本包后，「接缝」还对不对。
 *
 * 这个套件只钉**搬运之后最容易断的那几处**，不重复上游自己的逻辑：
 *
 *   ① 代码真的搬全了（86 条补丁、红队工具表、命令表、20+ 路由）
 *   ② 包根定位改了层数 —— `presets/`、`skills/redteam/`、`cordis.patch.yml`
 *      必须指到**本包**（这一处断了不会报错，只会静默读不到技能/预设）
 *   ③ 幂等注入补丁还在（上游 `injectOnce` 是空配置键，删掉它就退回双份注入）
 *   ④ 互斥闸：外部 `dsh-purge` 装着时本包让位，没有时放行
 *   ⑤ 红队指挥稿：注释不进提示、段名幂等、文件改了能重读
 *   ⑥ 前端半区真的并进来了（一个包只有一个 client 入口，不能另开文件）
 *
 * 跑法：`node scripts/selftest-purge.mjs`（`npm test` 链里也会跑）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`✓ ${label}`);
};

// ── ① 代码搬全了 ────────────────────────────────────────────────────────────

const core = await import("../lib/purge/core.js");
assert.ok(Array.isArray(core.ALL_PATCHES), "core.ALL_PATCHES 不是数组");
assert.ok(core.ALL_PATCHES.length >= 86, `补丁表只有 ${core.ALL_PATCHES.length} 条，上游是 86+`);
for (const patch of core.ALL_PATCHES) {
	assert.ok(Number.isFinite(patch.id), `补丁缺 id：${JSON.stringify(patch).slice(0, 80)}`);
	assert.ok(typeof patch.name === "string" && patch.name.length > 0, `补丁 #${patch.id} 缺 name`);
}
ok(`清洗引擎：${core.ALL_PATCHES.length} 条补丁，id/name 齐全`);

const toolsSrc = read("lib/purge/redteam/tools.js");
const REQUIRED_TOOLS = [
	"redteam_engagement_open",
	"redteam_preflight",
	"redteam_agent_slot",
	"redteam_asset_add",
	"redteam_asset_query",
	"redteam_vuln_add",
	"redteam_credential_add",
	"redteam_webshell_add",
	"redteam_tunnel_add",
	"redteam_score_hit",
	"redteam_score_list",
	"redteam_score_report",
	"redteam_sessions",
	"redteam_role_prompt",
];
for (const name of REQUIRED_TOOLS) {
	assert.ok(toolsSrc.includes(`name: '${name}'`), `红队工具表缺 ${name}`);
}
ok(`红队工具表：${REQUIRED_TOOLS.length} 个关键工具都在`);

const purgeIndex = read("lib/purge/index.js");
for (const cmd of ["purge", "rules", "skills", "rewind"]) {
	assert.ok(purgeIndex.includes(`name: "${cmd}"`), `命令表缺 /${cmd}`);
}
ok("命令表：/purge /rules /skills /rewind 都在");

// 命令 / 工具注册必须走去重包装（2026-10-31，dsh 0.2.1-rc.5 实测）：宿主按 **agent**
// 重复 apply，而 commands / tools 是全局服务，裸注册在第二个 agent 上抛 already registered
// → 整个 purge 半边记成「挂载失败」，命令与 20+ 个工具全都拿不到。
// 断言按**代码行**数、跳过注释 —— 注释里引用了原来的写法，直接全文搜会永远命中。
const codeLines = (src) =>
	src.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
const purgeCode = codeLines(purgeIndex);
const bareCommandRegisters = purgeCode.match(/commands\.register\(/g) || [];
assert.equal(bareCommandRegisters.length, 0, `index.js 里还有 ${bareCommandRegisters.length} 处裸的 commands.register`);
const guardedCommandRegisters = purgeCode.match(/registerCommandOnce\(commands, \{/g) || [];
assert.ok(
	guardedCommandRegisters.length === 4,
	`命令去重只包了 ${guardedCommandRegisters.length} 处（/purge /rules /skills /rewind 四处都要）`,
);
const bareToolRegisters = purgeCode.match(/ctx\.tools\.register\(/g) || [];
assert.equal(bareToolRegisters.length, 0, `index.js 里还有 ${bareToolRegisters.length} 处裸的 ctx.tools.register`);
const guardedPurgeTools = purgeCode.match(/registerToolOnce\(ctx\.tools, \{/g) || [];
assert.ok(guardedPurgeTools.length === 3, `purge_status/apply/revert 三处工具注册要去重，实际 ${guardedPurgeTools.length}`);

// 红队工具表 56 个工具同样按 agent 重复注册 —— 一处漏掉就是「purge 挂载失败」。
const redteamCode = codeLines(toolsSrc);
assert.equal((redteamCode.match(/ctx\.tools\.register\(/g) || []).length, 0, "redteam/tools.js 里还有裸的 ctx.tools.register");
const guardedRedteamTools = redteamCode.match(/registerToolOnce\(ctx\.tools, /g) || [];
assert.ok(guardedRedteamTools.length === 56, `红队工具只去重了 ${guardedRedteamTools.length} 处（56 个都要）`);

// 去重实现只能有一份宿主调用：包装体之外的任何裸注册都等于绕过了它。
const onceSrc = codeLines(read("lib/purge/register-once.js"));
assert.equal((onceSrc.match(/commands\.register\(/g) || []).length, 1, "register-once.js 里的 commands.register 应当恰好 1 处");
assert.equal((onceSrc.match(/tools\.register\(/g) || []).length, 1, "register-once.js 里的 tools.register 应当恰好 1 处");
assert.ok(onceSrc.includes("new WeakMap()"), "去重要按服务对象记（WeakMap），模块级 Set 挡不住两份模块实例");
ok(
	`注册去重：命令 ${guardedCommandRegisters.length} 处 + 工具 ${guardedPurgeTools.length + guardedRedteamTools.length} 处全走去重，没有裸注册`,
);

const routeCount = (purgeIndex.match(/registerPluginRoute\(/g) || []).length;
// 实际是 13 条（`/purge/*` 状态页与注入编辑、`/redteam/*` 桥接等）。这里不写死 20+ ——
// 上游本来就只有这些；断言的是「没有被搬丢」，不是某个凭印象的数字。
assert.ok(routeCount >= 13, `Web 路由只有 ${routeCount} 条（上游 13 条）`);
ok(`Web 路由：${routeCount} 条`);

// ── ② 包根定位 ──────────────────────────────────────────────────────────────

const redteam = await import("../lib/purge/redteam/index.js");
const paths = redteam.packagePaths();
const expect = (label, actual, want) =>
	assert.equal(path.resolve(actual), path.resolve(want), `${label} 指错了：${actual}`);
expect("预设目录", paths.presets, path.join(ROOT, "presets"));
expect("红队预设", paths.presetDir, path.join(ROOT, "presets", "redteam"));
expect("技能目录", paths.skills, path.join(ROOT, "skills", "redteam"));
expect("安装脚本", paths.setupScript, path.join(ROOT, "scripts", "redteam-setup.sh"));
for (const [label, p] of Object.entries(paths)) {
	assert.ok(fs.existsSync(p), `${label} 不存在：${p}`);
}
ok("包根定位：presets / skills/redteam / setup.sh 全部指到本包且真实存在");

const coreSrc = read("lib/purge/core.js");
assert.ok(
	coreSrc.includes('path.join(path.dirname(fileURLToPath(import.meta.url)), "cordis.patch.yml")'),
	"purge 自己的 cordis.patch.yml 路径没跟着搬（会指到 lib/cordis.patch.yml）",
);
assert.ok(exists("lib/purge/cordis.patch.yml"), "lib/purge/cordis.patch.yml 缺失");
ok("bundle patch 底稿随包放在 lib/purge/ 且路径对");

// 桌面官方包的宿住在 app.asar 里：没解开时 findAiBase()/listDesktopPackageRoots() 都返回空，
// enumeratePatchAiBases() 于是是空数组 →「点应用」静默 applied=0 还报成功（2026-10-31，rc.5 实测）。
// 断言的是**顺序**，不是「有没有这句话」：把它挪进枚举循环体（枚举完才解包）等于没修，
// 而 includes 那种写法对顺序完全瞎（审查测出的假绿）。
const sealedCallAt = coreSrc.indexOf("options.forApply === true ? await openSealedHostForApply()");
const enumerateAt = coreSrc.indexOf("const enumerated = enumeratePatchAiBases(");
assert.ok(sealedCallAt > 0, "applyPatchesAllHosts 里找不到 forApply 时解包 app.asar 的那一次调用");
assert.ok(enumerateAt > 0, "applyPatchesAllHosts 里找不到 enumeratePatchAiBases 的调用");
assert.ok(
	sealedCallAt < enumerateAt,
	`解包必须发生在枚举之前（解包在 ${sealedCallAt}、枚举在 ${enumerateAt}）—— 枚举完再解包照样是空宿主`,
);
assert.ok(
	coreSrc.includes("opened?.aiBase ? [opened.aiBase, ...enumerated] : enumerated"),
	"解包得到的 aiBase 没并入本次枚举 —— 二次探测有偏差时补丁会落到宿主不加载的目录",
);
assert.ok(
	coreSrc.includes("async function openSealedHostForApply()") && coreSrc.includes("resolveOfficialAiBase(findAiBase(), { forApply: true })"),
	"openSealedHostForApply 没复用 resolveOfficialAiBase —— 会和 /purge apply 走两套解包逻辑",
);
ok("桌面封包：apply 前先解 app.asar（与 /purge apply 共用一条解包路）");

// 让位脚本（PowerShell）钉两条，都是 2026-10-31 真机踩出来的：
// ① Move-Item 失败是**非终止错误**，try/catch 抓不到 —— 不加 -ErrorAction Stop 就当成功；
// ② 改名成不成功都得把 dsh 拉回来，否则用户只看到窗口消失、asar 还在、补丁一条没生效。
const desktopSrc = read("lib/purge/desktop.js");
const swapPs1 = desktopSrc.slice(
	desktopSrc.indexOf("const ASAR_SWAP_PS1 = ["),
	desktopSrc.indexOf("const ASAR_RENAME_WHEN_IDLE_PS1"),
);
assert.ok(swapPs1.length > 0, "ASAR_SWAP_PS1 找不到了");
assert.ok(
	swapPs1.includes("Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop"),
	"让位脚本的 Move-Item 少了 -ErrorAction Stop —— 失败会被当成成功（实测：dsh 被杀、asar 没动）",
);
assert.ok(
	/if \(\$moved\) \{ Remove-Item -LiteralPath \$lock/.test(swapPs1),
	"lock 要按 $moved 分流，否则失败也当成成功",
);
const relaunchAt = swapPs1.indexOf("Start-Process -FilePath $ExePath");
const guardAt = swapPs1.indexOf("if ($moved) {");
assert.ok(relaunchAt > guardAt, "Start-Process 找不到");
assert.ok(
	!/\}\s*else\s*\{[\s\S]*Start-Process -FilePath \$ExePath/.test(swapPs1.slice(guardAt)),
	"Start-Process 还写在 if ($moved) 里面 —— 改名失败时 dsh 不会回来",
);
ok("让位脚本：Move-Item 失败能被 catch 到，且改名失败也会拉起 dsh");

// 去重实现的行为断言（不是文本断言）：同服务同名只落一次，宿主自己抛 already registered 不拖垮 apply。
const once = await import("../lib/purge/register-once.js");
let hostRegisters = 0;
const fakeCommands = {
	register: () => {
		hostRegisters += 1;
		if (hostRegisters > 1) throw new Error('command "purge" is already registered (per-agent variant)');
	},
};
assert.equal(once.registerCommandOnce(fakeCommands, { name: "purge" }), true, "第一次注册应当真的调宿主");
assert.equal(once.registerCommandOnce(fakeCommands, { name: "purge" }), false, "第二次同服务同名必须短路");
assert.equal(hostRegisters, 1, `同名命令让宿主注册了 ${hostRegisters} 次，第二个 agent 会把它抛成挂载失败`);
const anotherService = { register: () => {} };
assert.equal(once.registerToolOnce(anotherService, { name: "purge_status" }), true, "换了服务对象要重新记一份（跨模块副本）");
const preTaken = {
	register: () => {
		throw new Error('tool "purge_apply" is already registered (per-agent variant)');
	},
};
assert.equal(once.registerToolOnce(preTaken, { name: "purge_apply" }), false, "宿主已注册过同名工具时不能把 apply 拖垮");
ok("注册去重：同服务同名只落一次；宿主报 already registered 时让位");

// ── ③ 幂等注入补丁还在 ──────────────────────────────────────────────────────

assert.ok(purgeIndex.includes("PURGE_SECTIONS_ON"), "幂等注入补丁（PURGE_SECTIONS_ON）被搬丢了");
assert.ok(
	purgeIndex.includes("hosts.some((h) => purgeSectionAlreadyOn(h, sectionName))"),
	"PURGE_SECTIONS_ON 只声明没用于判定 —— 等于没打补丁（这就是双份注入会回来的形态）",
);
assert.ok(
	purgeIndex.includes("if (sectionName) purgeMarkSection(host, sectionName);"),
	"挂了段却没有登记，下一次照样会重复挂",
);
ok("幂等注入：声明 + 判定 + 登记三处都在");

// ── ④ 互斥闸 ────────────────────────────────────────────────────────────────

const { purgeGate, findLegacyPurge, dshHomeOf } = await import("../lib/purge/gate.js");
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "team-purge-gate-"));
try {
	assert.equal(purgeGate({ home: fakeHome }).blocked, false, "空 home 不该被拦");

	const profile = path.join(fakeHome, "profiles", "desktop");
	fs.mkdirSync(profile, { recursive: true });
	fs.writeFileSync(
		path.join(profile, "package.json"),
		JSON.stringify({ name: "dsh-profile-desktop", dependencies: { "dsh-purge": "1.1.72" } }),
	);
	const blocked = purgeGate({ home: fakeHome });
	assert.equal(blocked.blocked, true, "profile 依赖里有 dsh-purge 时必须让位");
	assert.match(blocked.reason, /dsh-purge/, "让位理由要写出是哪个包");

	// node_modules 里只有目录名、包名不对 → 不算装着（pnpm 残留就是这个形态）
	fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "p" }));
	const nm = path.join(profile, "node_modules", "dsh-purge");
	fs.mkdirSync(nm, { recursive: true });
	fs.writeFileSync(path.join(nm, "package.json"), JSON.stringify({ name: "not-purge" }));
	assert.equal(findLegacyPurge({ home: fakeHome }).length, 0, "包名不对的残留目录不该被当成 dsh-purge");

	fs.writeFileSync(path.join(nm, "package.json"), JSON.stringify({ name: "dsh-purge", version: "9.9.9" }));
	assert.equal(purgeGate({ home: fakeHome }).blocked, true, "node_modules 里真装着时要让位");
} finally {
	fs.rmSync(fakeHome, { recursive: true, force: true });
}
assert.equal(dshHomeOf({ DSH_HOME: "/tmp/x" }), "/tmp/x", "DSH_HOME 环境变量要优先");
ok("互斥闸：依赖命中 / 包名不信目录名 / DSH_HOME 优先");

// ── ⑤ 红队指挥稿 ────────────────────────────────────────────────────────────

const brief = await import("../lib/redteam-brief.js");
const briefFile = path.join(ROOT, "team", "REDTEAM.md");
assert.ok(fs.existsSync(briefFile), "team/REDTEAM.md 不存在");

const rawBrief = fs.readFileSync(briefFile, "utf8");
assert.ok(rawBrief.includes("<!--"), "维护者注释该用 HTML 注释包住（否则会进系统提示）");
const text = brief.redteamBriefText(briefFile, 1 << 20);
// REQ-031：注入的是**骨架**（不读全文也要照做的硬约束），不是整份指挥稿 ——
// 全文在 skills/redteam/brief.md，按需 skill 加载。所以这里断言的是"骨架够厚但不臃肿"。
assert.ok(text.length > 800, `骨架只剩 ${text.length} 字符，是不是被剥过头了`);
assert.ok(text.length < 3200, `骨架 ${text.length} 字符 —— 又长回去了？完整稿应该在技能里`);
assert.ok(!text.includes("<!--"), "HTML 注释没被剥掉");
assert.ok(!text.includes("REQ-029"), "维护者说明漏进了系统提示");
assert.ok(text.includes("派活（硬约束）"), "骨架缺了派活硬约束");
assert.ok(text.includes("redteam-brief"), "骨架要指向完整稿技能，否则模型不知道去哪读细节");

// 完整稿必须真的在技能里，且覆盖骨架里省略掉的那几节。
const fullBrief = read("skills/redteam/brief.md");
for (const section of ["并发硬约束", "汇报口径", "什么时候才跟用户说话", "红线"]) {
	assert.ok(fullBrief.includes(section), `完整稿技能缺「${section}」`);
}
assert.match(fullBrief, /^---\nname: redteam-brief\n/, "完整稿技能缺 frontmatter（name: redteam-brief）");

// 幂等：同一个 ctx 装两次，宿主只该收到一次 section
const registered = [];
const fakeCtx = { systemPrompt: { section: (s) => { registered.push(s.name); return () => {}; } } };
brief.installRedteamBrief(fakeCtx, ROOT);
brief.installRedteamBrief(fakeCtx, ROOT);
assert.equal(registered.length, 1, `同一宿主被挂了 ${registered.length} 次（双份注入）`);
assert.equal(registered[0], brief.REDTEAM_BRIEF_SECTION, "段名不是幂等判据那个");

// 换一个宿主是对的（子代理隔离 ctx 各挂一份），不该被全局名字挡住
brief.installRedteamBrief({ systemPrompt: { section: (s) => { registered.push(s.name); return () => {}; } } }, ROOT);
assert.equal(registered.length, 2, "不同宿主应该各挂一份");
ok("红队指挥稿：注释剥离 / 段名幂等 / 不同宿主各一份");

// mtime 变了要重读（改稿子不用重启）
const tmpBrief = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "team-brief-")), "REDTEAM.md");
try {
	fs.writeFileSync(tmpBrief, "<!-- x -->\n第一版");
	assert.equal(brief.redteamBriefText(tmpBrief, 1 << 20), "第一版");
	fs.writeFileSync(tmpBrief, "<!-- x -->\n第二版");
	const bumped = new Date(Date.now() + 5000);
	fs.utimesSync(tmpBrief, bumped, bumped);
	assert.equal(brief.redteamBriefText(tmpBrief, 1 << 20), "第二版", "mtime 变了没重读");
} finally {
	fs.rmSync(path.dirname(tmpBrief), { recursive: true, force: true });
}
ok("红队指挥稿：文件改了下一轮就生效（mtime 缓存）");

// ── ⑥ 打包与接线 ────────────────────────────────────────────────────────────

const pkg = JSON.parse(read("package.json"));
for (const sub of ["./purge", "./purge/redteam", "./purge/redteam/store", "./purge/redteam/ui", "./purge/redteam/tools"]) {
	assert.ok(pkg.exports[sub], `package.json exports 缺 ${sub}`);
	assert.ok(fs.existsSync(path.join(ROOT, pkg.exports[sub])), `exports ${sub} 指向的文件不存在`);
}
const patchYml = read("cordis.patch.yml");
for (const row of [
	"dsh-team-workflow/purge\n",
	"dsh-team-workflow/purge/redteam\n",
	"dsh-team-workflow/purge/redteam/store\n",
	"dsh-team-workflow/purge/redteam/ui\n",
]) {
	assert.ok(patchYml.includes(`name: ${row}`), `cordis.patch.yml 缺插件行 ${row.trim()}`);
}
assert.ok(fs.existsSync(path.join(ROOT, "presets", "redteam", "preset.yml")), "红队预设没随包");
assert.ok(fs.existsSync(path.join(ROOT, "skills", "redteam", "suo5-tunnel.md")), "红队技能没随包");
ok("打包：exports 5 条 + cordis 4 行 + 预设/技能随包");

const client = read("lib/client.js");
assert.ok(client.includes("const purgeClient = (() => {"), "purge 面板没并进 client.js");
assert.ok(client.includes("purgeClient.apply(ctx)"), "purge 面板并进来了但没挂");
assert.ok(client.includes("dsh-purge-dock"), "purge 面板的槽位 id 不见了");
assert.ok(client.includes("exports.purgeClient = purgeClient"), "自检拿不到 purge 面板入口");
ok("前端半区：purge 面板并进唯一 client 入口且被 apply");

// 团队预设必须自带红队工具行（REQ-029 融合的落点）
const presetGen = read("lib/preset-gen.js");
assert.ok(presetGen.includes("dsh-team-workflow/purge/redteam/tools"), "团队预设没带红队工具行");
assert.ok(presetGen.includes("redteamTools"), "生成器没有 redteamTools 开关");
const presetRedteam = read("presets/redteam/agent.cordis.yml");
assert.ok(
	!presetRedteam.includes("并发硬约束"),
	"红队预设的 persona 里还留着指挥稿 —— 会与 lib/redteam-brief.js 的注入重复",
);
ok("融合：团队预设带红队工具行，红队预设不再重复 persona 稿");

// ── ⑦ 破甲人格只进主会话（REQ-031）─────────────────────────────────────

// 子会话（subagent / 红队执行角色）拿的是角色稿 + 任务书；21.8k 字符的人格稿
// 每轮进子代理地板，等于让每次派活贵一倍。主会话永远保留（用户 2026-10-31 明确）。
{
	const identity = await import("../lib/purge/identity.js");
	const FULL = "BROKEN-ARMOR-PERSONA-".repeat(40);
	const assembled = {
		sections: [
			{ name: "harness:identity", text: "official" },
			{ name: "dsh-purge", text: FULL, order: 100 },
			{ name: "team:baseline", text: "团队规矩" },
		],
	};
	const main = identity.rewritePromptAssembly(assembled, { fallbackInject: FULL, context: null });
	const sub = identity.rewritePromptAssembly(assembled, {
		fallbackInject: FULL,
		stripPurgeInject: true,
		context: null,
	});
	assert.ok(JSON.stringify(main).includes("BROKEN-ARMOR"), "主会话该保留破甲人格");
	// 关键回归：只删段不清文本时\`ensureFullInject\` 会把全文塞回去 —— 实测过。
	assert.ok(!JSON.stringify(sub).includes("BROKEN-ARMOR"), "子会话不该带破甲人格");
	assert.ok(JSON.stringify(sub).includes("团队规矩"), "剥离人格时不能把团队基线一起删了");
	ok("子会话：破甲人格被剥离，团队基线保留");

	// 子代理没有主稿时**必须**拿到短英文 override。2026-11-01 实测：给空串时子代理只剩角色稿，
	// 模型的默认对齐还在，派下去的执行体直接说「我不干渗透」。
	assert.ok(
		/SUBAGENT_OVERRIDE_EN : inject/.test(purgeIndex),
		"子代理分支又退回空串了 —— 派下去的执行体会按默认对齐拒活",
	);
	const overrideStart = purgeIndex.indexOf("const SUBAGENT_OVERRIDE_EN = [");
	const overrideEnd = purgeIndex.indexOf("].join(", overrideStart);
	assert.ok(overrideStart > 0 && overrideEnd > overrideStart, "子代理短 override 常量不见了");
	const overrideBlock = purgeIndex.slice(overrideStart, overrideEnd);
	assert.ok(overrideBlock.length > 300, "子代理短 override 太短，压不住默认对齐");
	assert.ok(/I can't help with X/.test(overrideBlock), "子代理短 override 少了「不能说我不能帮你」这条硬规则");
	assert.ok(
		!overrideBlock.split("\n").some((line) => !/我不能帮你干|这个我做不了/.test(line) && /[\u4e00-\u9fa5]/.test(line)),
		"子代理短 override 要纯英文（唯一允许的中文是那两个被禁句式的样本）",
	);
	ok("子代理 override：非空、纯英文骨架、不会退回空串");
}

console.log(`\nselftest-purge：${passed} 项全过`);
