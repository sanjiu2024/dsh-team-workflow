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

console.log(`\nselftest-purge：${passed} 项全过`);
