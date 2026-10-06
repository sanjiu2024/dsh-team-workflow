#!/usr/bin/env node
/**
 * 自检：装工作流时的可选第三方插件（REQ-008）。
 *
 *   node scripts/selftest-profile-plugins.mjs
 *
 * 分三段：
 *   1. **决定**（纯函数）：谁该装、谁该跳过、谁该问 —— 含两条负向验证
 *   2. **改写**：bundles 幂等、不改入参、不认识的名字要报出来
 *   3. **真跑 CLI**：拿一个假 DSH_HOME 跑 `dsh-team plugins`，验实际接线
 *      （dry-run 那条不需要机器上有 dsh；装不上那条没有 dsh 就跳过并说明）
 *
 * 这一段为什么必须有：这个功能的判据全是「什么时候**不该**动」——已装的不许升、
 * 非交互不许猜用户意图、非 web profile 不许装。写错一条不会报错，只会静静地
 * 把用户的安装树改了，或者用户以为装了其实没装。纯函数才钉得住。
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const {
	installedVersions,
	OPTIONAL_PLUGINS,
	pluginAddArgs,
	pluginDecisions,
	repoMatches,
	retryCommand,
	summarizePlugins,
	unknownPluginFlags,
	WEB_APP_BUNDLE,
	withPluginBundles,
} = await import(new URL("lib/profile-plugins.js", ROOT).href);

let failures = 0;
let skipped = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const skip = (name, why) => {
	skipped++;
	console.log(`· 跳过：${name}（${why}）`);
};

/** 一个「像真的」profile：带 web 界面，依赖可注入 */
const profilePkg = (deps = {}, bundles = [WEB_APP_BUNDLE]) => ({
	name: "fake-profile",
	private: true,
	dependencies: deps,
	dsh: { profile: { bundles } },
});

const decisionOf = (rows, key) => rows.find((row) => row.key === key);
const actions = (rows) => rows.map((row) => `${row.key}:${row.action}`).join(",");

// —— 1. 决定 ——

check("表：三个 key 与 npm 名一一对应，key 就是 flag 后缀", () => {
	assert.deepEqual(OPTIONAL_PLUGINS.map((p) => p.key), ["sidebar", "wallpaper", "pet"]);
	assert.deepEqual(OPTIONAL_PLUGINS.map((p) => p.name), ["dsh-better-sidebar", "dsh-plugin-wallpaper-engine", "dsh-pet"]);
	for (const item of OPTIONAL_PLUGINS) {
		assert.ok(item.repo.startsWith("https://github.com/"), `${item.key} 缺仓库地址`);
		assert.ok(item.what && item.need && item.note, `${item.key} 缺说明字段`);
	}
});

check("表：npm 名不许从仓库名推出来（三个都不一样，写错了查不出来）", () => {
	// 这条不是废话：`dsh-plugin-wallpaper-engine` 的仓库叫 `dsh-wallpaper-engine`，
	// `dsh-pet` 的仓库根目录根本没有 package.json。名字写死在表里才是对的。
	const wallpaper = OPTIONAL_PLUGINS.find((item) => item.key === "wallpaper");
	assert.notEqual(wallpaper.name, "dsh-wallpaper-engine");
	assert.match(wallpaper.repo, /elysia395\/dsh-wallpaper-engine$/);
});

check("非 web profile：三个全跳过，原因要说清是缺 web 界面", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg({}, ["@deepseek-ai/dsh-base"]), interactive: true });
	assert.equal(actions(rows), "sidebar:skip,wallpaper:skip,pet:skip");
	for (const row of rows) assert.match(row.reason, /web 界面/);
});

check("没有表态 + 非交互：全跳过，原因要给出点名的 flag", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg(), interactive: false });
	assert.equal(actions(rows), "sidebar:skip,wallpaper:skip,pet:skip");
	assert.match(decisionOf(rows, "pet").reason, /--with-pet/);
});

check("没有表态 + 交互：三个都要问", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg(), interactive: true });
	assert.equal(actions(rows), "sidebar:ask,wallpaper:ask,pet:ask");
});

check("点过名（--with-x）就整体不问：其余按默认不装，不回头打扰用户", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg(), flags: { "with-sidebar": true }, interactive: true });
	assert.equal(actions(rows), "sidebar:install,wallpaper:skip,pet:skip");
	for (const key of ["wallpaper", "pet"]) assert.match(decisionOf(rows, key).reason, /只按点名的来/);
});

check("--no-plugins：一个都不问也不装", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg(), flags: { "no-plugins": true }, interactive: true });
	assert.equal(actions(rows), "sidebar:skip,wallpaper:skip,pet:skip");
	for (const row of rows) assert.match(row.reason, /--no-plugins/);
});

check("--with-pet：只点名那个装，其余照旧（非交互下跳过）", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg(), flags: { "with-pet": true }, interactive: false });
	assert.equal(actions(rows), "sidebar:skip,wallpaper:skip,pet:install");
});

check("--without-pet：点名不要那个，其余照旧", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg(), flags: { "without-pet": true }, interactive: true });
	assert.equal(actions(rows), "sidebar:ask,wallpaper:ask,pet:skip");
	assert.match(decisionOf(rows, "pet").reason, /--without-pet/);
});

// 负向验证（判据顺序）：先看 flag、再看已装。反过来的话这两条必红。
check("已装 + 没表态 + 交互：跳过并报出已装版本，**不许**再问一遍", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg({ "dsh-better-sidebar": "0.24.1" }), interactive: true });
	assert.equal(decisionOf(rows, "sidebar").action, "skip");
	assert.match(decisionOf(rows, "sidebar").reason, /已装 0\.24\.1/);
	assert.equal(decisionOf(rows, "pet").action, "ask", "别的插件不该被连累");
});

check("已装 + 显式点名：仍然要装（点名 = 要升级），不许被「已装」挡掉", () => {
	const rows = pluginDecisions({ profilePkg: profilePkg({ "dsh-better-sidebar": "0.24.1" }), flags: { "with-sidebar": true }, interactive: true });
	assert.equal(decisionOf(rows, "sidebar").action, "install");
	assert.match(decisionOf(rows, "sidebar").reason, /升到最新/);
});

check("--without 优先于 --with（同时写时按「不要」算，别装）", () => {
	const rows = pluginDecisions({
		profilePkg: profilePkg(),
		flags: { "with-pet": true, "without-pet": true },
		interactive: false,
	});
	assert.equal(decisionOf(rows, "pet").action, "skip");
});

check("installedVersions：只认 dependencies，不认 bundles，也不改入参", () => {
	const input = profilePkg({ "dsh-pet": "0.3.5" });
	const snapshot = JSON.stringify(input);
	const versions = installedVersions(input);
	assert.deepEqual(versions, { "dsh-pet": "0.3.5" });
	assert.equal(JSON.stringify(input), snapshot, "读一眼就把入参改了");
	assert.deepEqual(installedVersions(undefined), {});
});

// —— 2. 改写 ——

check("补 bundles：补到末尾、别的字段一个不动、不改入参", () => {
	const input = profilePkg({ "dsh-pet": "0.3.5" });
	const snapshot = JSON.stringify(input);
	const out = withPluginBundles(input, ["dsh-pet", "dsh-better-sidebar"]);
	assert.deepEqual(out.dsh.profile.bundles, [WEB_APP_BUNDLE, "dsh-pet", "dsh-better-sidebar"]);
	assert.deepEqual(Object.keys(out).sort(), ["dependencies", "dsh", "name", "private"]);
	assert.equal(out.dependencies["dsh-pet"], "0.3.5");
	assert.equal(JSON.stringify(input), snapshot, "入参被就地改了");
});

check("补 bundles 幂等：都在里面就原样返回（同一个对象），不重复加", () => {
	const input = profilePkg({}, [WEB_APP_BUNDLE, "dsh-pet"]);
	const out = withPluginBundles(input, ["dsh-pet"]);
	assert.equal(out, input, "没变化就该原样返回，免得白写一次文件");
	assert.deepEqual(out.dsh.profile.bundles, [WEB_APP_BUNDLE, "dsh-pet"]);
});

check("补 bundles：bundles 缺失/不是数组时不炸，新建一个", () => {
	const out = withPluginBundles({ name: "x" }, ["dsh-pet"]);
	assert.deepEqual(out.dsh.profile.bundles, ["dsh-pet"]);
	const weird = withPluginBundles({ dsh: { profile: { bundles: "nope" } } }, ["dsh-pet"]);
	assert.deepEqual(weird.dsh.profile.bundles, ["dsh-pet"]);
});

check("认不出的 --with-xx 要报出来（敲错 flag 静默无效等于什么都没发生）", () => {
	assert.deepEqual(unknownPluginFlags({ "with-pets": true, profile: "web", "dry-run": true }), ["with-pets"]);
	assert.deepEqual(unknownPluginFlags({ "without-sidebars": true }), ["without-sidebars"]);
	assert.deepEqual(unknownPluginFlags({ "with-pet": true, "without-sidebar": true, "no-plugins": true, profile: "web" }), []);
});

check("装的命令形态：走 dsh 转发的 pnpm add，且钉 @latest", () => {
	assert.deepEqual(pluginAddArgs("web", "dsh-pet"), ["plugin", "--profile", "web", "add", "dsh-pet@latest"]);
	assert.equal(retryCommand("web", "pet"), "dsh-team plugins --profile web --with-pet");
});

check("汇总：dry-run 说「会装」，不许说「已装」", () => {
	const rows = [{ key: "pet", name: "dsh-pet", status: "installed" }];
	const dry = summarizePlugins(rows, "web", { dryRun: true }).join("\n");
	assert.match(dry, /dry-run.*会装 dsh-pet@latest/);
	assert.ok(!/已装进 profile/.test(dry), "dry-run 里说了「已装」= 报告一件没发生的事");
	const real = summarizePlugins([{ key: "pet", name: "dsh-pet", status: "installed", version: "0.3.5" }], "web").join("\n");
	assert.match(real, /dsh-pet@0\.3\.5 已装进 profile/);
});

check("汇总：装成功时给出卸载命令（只装不卸是耍流氓）", () => {
	const lines = summarizePlugins([{ key: "pet", name: "dsh-pet", status: "installed", version: "0.3.5" }], "web").join("\n");
	assert.match(lines, /要卸掉：dsh plugin --profile web remove dsh-pet/);
	const dry = summarizePlugins([{ key: "pet", name: "dsh-pet", status: "installed" }], "web", { dryRun: true }).join("\n");
	assert.ok(!/要卸掉/.test(dry), "dry-run 里没有装过的东西可卸，不该给卸载命令");
});

check("来源核对：装到的包自称的仓库对不上就报出来（防同名抢注包）", () => {
	const repo = "https://github.com/PC2005-cloud/dsh-pet";
	assert.equal(repoMatches({ repository: { url: "git+https://github.com/PC2005-cloud/dsh-pet.git" } }, repo), true);
	assert.equal(repoMatches({ repository: "https://github.com/PC2005-cloud/dsh-pet.git" }, repo), true);
	assert.equal(repoMatches({ homepage: "https://github.com/PC2005-cloud/dsh-pet#readme" }, repo), true);
	assert.equal(repoMatches({ repository: "github:PC2005-cloud/dsh-pet" }, repo), true);
	assert.equal(repoMatches({ repository: { url: "https://github.com/someone-else/dsh-pet" } }, repo), false);
	// 裸简写只认不含点的两段：域名与文件路径都不能被当成 github 路径，否则「判断不了
	// 就不报」的兜底会失效，反过来冤枉用户装到了假包
	for (const value of ["mysite.io/docs", "docs/README.md", "bitbucket.org/team", "www.github.com.evil.io/x"]) {
		assert.equal(repoMatches({ repository: value }, repo), true, `不该报：${value}`);
		assert.equal(repoMatches({ homepage: value }, repo), true, `不该报：${value}`);
	}
	// 数组写法（npm 允许）：拍平了照样看得到 URL —— 不拍平就会「判成没写来源」，核对静默失效
	assert.equal(repoMatches({ repository: [{ url: "https://github.com/PC2005-cloud/dsh-pet" }] }, repo), true);
	assert.equal(repoMatches({ repository: [{ url: "https://github.com/someone-else/dsh-pet" }] }, repo), false);
	assert.equal(repoMatches({ repository: [{ type: "git", url: "https://github.com/someone-else/x" }, { url: "https://github.com/PC2005-cloud/dsh-pet.git" }] }, repo), true);
	// 包里压根没写来源、或写的不是 github：**判断不了就不能报**，否则用户会以为装到了假包
	assert.equal(repoMatches({}, repo), true);
	assert.equal(repoMatches({ repository: "https://evil.example/x" }, repo), true);
	assert.equal(repoMatches({ homepage: "https://gitlab.com/a/b" }, repo), true, "非 github 的 homepage 不该被当成「对不上」");
	assert.equal(repoMatches({ repository: "https://evil.example/x" }, "https://not-github.example/x"), true);
});

check("汇总：装上了但收尾没做完（bundles 没写）不许说「没装上」", () => {
	const lines = summarizePlugins(
		[{ key: "pet", name: "dsh-pet", status: "failed", installed: true, detail: "没写 bundles（/x/node_modules/dsh-pet 不在）" }],
		"web",
	).join("\n");
	assert.match(lines, /⚠ dsh-pet 装上了，但没写 bundles/);
	assert.ok(!/没装上/.test(lines), `包在 node_modules 里，说「没装上」是假话：${lines}`);
	assert.match(lines, /要卸掉：dsh plugin --profile web remove dsh-pet/, "装上了就得能卸掉");
});

check("汇总：失败那条要给重试命令，并说明主流程没受影响", () => {
	const lines = summarizePlugins([{ key: "pet", name: "dsh-pet", status: "failed", detail: "退出码 1" }], "web");
	assert.match(lines.join("\n"), /没装上：退出码 1/);
	assert.match(lines.join("\n"), /重试：dsh-team plugins --profile web --with-pet/);
	assert.match(lines.join("\n"), /工作流本身已装好/);
	assert.ok(!/失败/.test(summarizePlugins([{ key: "pet", name: "dsh-pet", status: "skipped", reason: "没选" }], "web").join("\n")));
});

// —— 3. 真跑 CLI（假 DSH_HOME，不碰真安装树）——

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-plugins-"));
const fakeDir = path.join(tmpHome, "profiles", "fake");
fs.mkdirSync(fakeDir, { recursive: true });
const fakePkgFile = path.join(fakeDir, "package.json");
fs.writeFileSync(fakePkgFile, JSON.stringify(profilePkg({ "dsh-better-sidebar": "0.24.1" }), null, 2));
// install 的收尾会验 `node_modules/dsh-team-workflow` 在不在（dry-run 也验，那是既有行为），
// 所以这里先摆一个空目录出来，好走到「可选插件」那一段
fs.mkdirSync(path.join(fakeDir, "node_modules", "dsh-team-workflow"), { recursive: true });

const runCli = (args) =>
	spawnSync(process.execPath, [new URL("bin/dsh-team.mjs", ROOT).pathname, ...args], {
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: tmpHome },
	});

check("CLI：--with-pet --dry-run 也把「会动 bundles」打出来（干跑要能看出会改什么）", () => {
	const result = runCli(["plugins", "--profile", "fake", "--with-pet", "--dry-run"]);
	assert.match(result.stdout, /\[dry-run\] 写 .*package\.json.*bundles \+= dsh-pet/);
});

check("CLI：敲错的 flag 在**动手之前**就报错（不许先装工作流再退出 1）", () => {
	const before = fs.readFileSync(fakePkgFile, "utf8");
	const result = runCli(["install", "--profile", "fake", "--with-pets"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /认不出的 flag/);
	assert.equal(fs.readFileSync(fakePkgFile, "utf8"), before, "报错之前就把 profile 改了");
});

check("CLI：--no-plugins 和 --with-pet 并存要报矛盾（不许把点名的那个静默吃掉）", () => {
	const result = runCli(["plugins", "--profile", "fake", "--no-plugins", "--with-pet", "--dry-run"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /矛盾的/);
	assert.match(result.stderr, /--with-pet/);
});

check("CLI：残缺 flag --with- 也报错（不许静默无操作）", () => {
	const result = runCli(["plugins", "--profile", "fake", "--with-", "--dry-run"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /认不出的 flag：--with-/);
});

check("CLI：非交互 --dry-run 一个 pnpm add 都不跑，已装的不动，没表态的不猜", () => {
	const before = fs.readFileSync(fakePkgFile, "utf8");
	const result = runCli(["plugins", "--profile", "fake", "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(!/add /.test(result.stdout), `dry-run 里出现了 add：\n${result.stdout}`);
	assert.match(result.stdout, /跳过（已装 0\.24\.1）/);
	assert.match(result.stdout, /非交互环境/);
	assert.equal(fs.readFileSync(fakePkgFile, "utf8"), before, "dry-run 改了 profile");
});

check("CLI：--with-pet --dry-run 只打印那一条 add，且明说「会装」", () => {
	const result = runCli(["plugins", "--profile", "fake", "--with-pet", "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /plugin --profile fake add dsh-pet@latest/);
	assert.match(result.stdout, /dry-run.*会装 dsh-pet@latest/);
	assert.ok(!/restart|重启 dsh 后生效/.test(result.stdout), "dry-run 里说了「重启后生效」");
});

check("CLI：敲错的 flag 直接报错退出（不许静默照跑）", () => {
	const result = runCli(["plugins", "--profile", "fake", "--with-pets", "--dry-run"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /认不出的 flag：--with-pets/);
	assert.match(result.stderr, /--with-sidebar/);
});

check("CLI：install --dry-run 里也带着这一段（接在收尾之前）", () => {
	const result = runCli(["install", "--profile", "fake", "--dry-run"]);
	assert.match(result.stdout, /可选插件：/);
	assert.match(result.stdout, /dsh-better-sidebar\s+跳过（已装 0\.24\.1）/);
});

check("CLI：status 把三个插件逐个报出来", () => {
	const result = runCli(["status", "--profile", "fake"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /dsh-better-sidebar\s+已装 0\.24\.1/);
	assert.match(result.stdout, /dsh-plugin-wallpaper-engine\s+未装/);
	assert.match(result.stdout, /dsh-pet\s+未装/);
});

// 装不上那条要真跑 dsh（会联网碰 registry），没有 dsh 就跳过而不是假装过了
const hasDsh = spawnSync("dsh", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasDsh) {
	skip("CLI：装不上时报错但退出码 0、汇总带重试命令", "机器上没有 dsh");
} else {
	// 目录只读 → pnpm 必然写不进去，这是**故意**造出来的失败
	fs.chmodSync(fakeDir, 0o555);
	const result = runCli(["plugins", "--profile", "fake", "--with-pet"]);
	fs.chmodSync(fakeDir, 0o755);
	check("CLI：装不上时报错但退出码 0、汇总带重试命令", () => {
		assert.equal(result.status, 0, "插件装不上不该把退出码改了");
		assert.match(result.stdout, /✗ dsh-pet 没装上：dsh plugin add 退出码 1/);
		assert.match(result.stdout, /重试：dsh-team plugins --profile fake --with-pet/);
		assert.match(result.stdout, /工作流本身已装好/);
	});
	check("CLI：装不上时也没把 bundles 写脏", () => {
		const after = JSON.parse(fs.readFileSync(fakePkgFile, "utf8"));
		assert.deepEqual(after.dsh.profile.bundles, [WEB_APP_BUNDLE]);
	});
}

fs.rmSync(tmpHome, { recursive: true, force: true });

// 先验后写：这条路径（dsh add 退出码 0 但 node_modules 里没有）很难真造出来，
// 但它留下的脏 profile 会让 dsh 启动去加载一个不存在的包 —— 所以直接盯源码顺序
check("源码顺序：确认装上（existsSync）必须在写 bundles（writeFileSync）之前", () => {
	const source = fs.readFileSync(new URL("bin/dsh-team.mjs", ROOT), "utf8");
	const verified = source.indexOf("const linked = path.join(profileDir, \"node_modules\", item.name);");
	const written = source.indexOf("fs.writeFileSync(pkgFile");
	assert.ok(verified > 0 && written > 0, "找不到这两处，得改这条断言");
	assert.ok(verified < written, "先写了 bundles 才验包：失败会留下指向不存在包的 bundle 项");
});

// 发出去的包里必须有这个文件（files 里只列了 lib / bin 这些目录）
check("发得出去：lib/profile-plugins.js 在 files 覆盖的目录里", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("package.json", ROOT), "utf8"));
	assert.ok(pkg.files.includes("lib"), "files 里没有 lib，新文件发不出去");
	assert.ok(fs.existsSync(new URL("lib/profile-plugins.js", ROOT)));
});

console.log(
	failures === 0
		? `\n✓ 自检通过：可选插件的决定（已装不许升 / 非交互不许猜 / 非 web 不许装）/ bundles 幂等改写 / flag 校验 / 汇总措辞 / 真跑 CLI（dry-run · status · 装不上）${skipped ? `（跳过 ${skipped} 项）` : ""}`
		: `\n✗ ${failures} 项失败`,
);
process.exit(failures === 0 ? 0 : 1);
