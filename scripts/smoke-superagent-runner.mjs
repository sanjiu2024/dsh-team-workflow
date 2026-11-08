#!/usr/bin/env node
/**
 * 冒烟：`agent-runner.js` 的三条真前置 + 错误路径。
 *
 * `agent-runner` 是全模块**唯一**碰宿主内部 API 的地方，而它的失败模式在单测里看不见：
 * 包名写错、导出名写错、`scope` 缺服务 —— 全都是**运行期**才炸，且炸法各不相同：
 *
 *   - `host.load("@deepseek-ai/dsh-sandbox-policy", ["setSandboxMode"])` 包名错了 → 我的代码抛
 *     `SUPERAGENT_RUNTIME_EXPORT_MISSING`；
 *   - `createAgentRunner` 拿到没有 `agents.create` 的 scope → 必须**当场**抛，不能等到跑会话时；
 *   - `makeHostLoader` 的 `__esModule` 折法错了 → 命名导出全丢（scheduler 在 1.18.1 踩过这个坑，
 *     当时的症状是执行器一启动就 `SCHEDULER_RUNTIME_EXPORT_MISSING`）。
 *
 * 这些只有**真 loader + 真宿主包**才验得到。所以这个脚本起一个真 cordis 上下文，
 * 用真的 `@deepseek-ai/*` 包去解析，然后：
 *
 *   1. 三个导出都是函数（`setSandboxMode` / `setApprovalPolicy` / `createUserMessage`）；
 *   2. `createAgentRunner` 的三种坏 scope 都在**构造时**抛，且错误信息说明了缺什么；
 *   3. 反向对照：故意把包名改一个字符，必须抛（证明这个测法不是空的）。
 *
 * **它不跑真实会话**：`agents.create` 要完整的宿主服务栈（llm / sessionPersistence /
 * workspaceRegistry / agentPresets ...）+ 一次真模型调用，那不是「冒烟」是「端到端」。
 * 会话那一段的验证路径写在 `docs/状态.md`。
 *
 * 不进 `npm test`（依赖本机 dsh 安装树，且必须在 Electron 里跑）：
 *
 *   ELECTRON_RUN_AS_NODE=1 "<安装目录>\DeepSeek Harness.exe" --expose-internals scripts/smoke-superagent-runner.mjs
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { dshInstallRoots } from "../lib/dsh-install.js";

/** 找宿主包的解析根：profile 的 node_modules（本包）与安装树里的 `@deepseek-ai`（宿主包）。 */
function findRoots() {
	const profiles = join(homedir(), ".dsh", "profiles");
	let profile;
	if (existsSync(profiles)) {
		for (const name of readdirSync(profiles)) {
			const modules = join(profiles, name, "node_modules");
			if (existsSync(join(modules, "dsh-team-workflow"))) profile = { name, modules };
		}
	}
	let checkout;
	for (const root of dshInstallRoots()) {
		// 两种布局都要试：打包版在 `resources/app.asar/dsh`，**解包版在 `resources/app/dsh`**
		// （本机就是解包版 —— 2026-11-08 第一次跑这个脚本时只认 asar，于是「找不到宿主包」）。
		for (const rel of ["resources/app/dsh/node_modules", "resources/app.asar/dsh/node_modules"]) {
			const modules = join(root, rel);
			if (existsSync(join(modules, "@deepseek-ai", "cordis"))) {
				checkout = modules;
				break;
			}
		}
		if (checkout !== undefined) break;
	}
	return { profile, checkout };
}

const { checkout } = findRoots();
if (checkout === undefined) {
	console.error("✗ 找不到宿主包（<安装目录>/resources/app.asar/dsh/node_modules 里要有 @deepseek-ai/cordis）");
	process.exit(1);
}
if (checkout.includes("app.asar") && process.versions.electron === undefined) {
	console.error(
		"✗ 宿主包在 app.asar 里，普通 node 的 fs 认不了 —— 用 Electron 跑：\n" +
			'  ELECTRON_RUN_AS_NODE=1 "<安装目录>\\DeepSeek Harness.exe" --expose-internals scripts/smoke-superagent-runner.mjs',
	);
	process.exit(1);
}

const from = (spec) => pathToFileURL(join(checkout, spec)).href;
const { Context, Service } = await import(from("@deepseek-ai/cordis/lib/index.js"));
const { makeHostLoader } = await import("../lib/dsh-exports.js");
const { createAgentRunner } = await import("../lib/superagent/agent-runner.js");

let failed = 0;
const check = (cond, what, detail = "") => {
	if (cond) {
		console.log(`✓ ${what}`);
		return true;
	}
	failed += 1;
	console.log(`✗ ${what}${detail === "" ? "" : `\n    ${detail}`}`);
	return false;
};

/** 真 loader：宿主对 `@deepseek-ai/*` 就是从安装树解析的，照做。 */
class Loader extends Service {
	constructor(ctx) {
		super(ctx, "loader");
		this.import = async (name) => import(from(`${name}/lib/index.js`));
	}
}

const ctx = new Context();
new Loader(ctx);
const host = makeHostLoader(ctx);

console.log(`宿主包：${checkout.replace(homedir(), "~")}\n`);

// —— 1. 三个导出都是函数 ——
//
// 这是 `agent-runner` 的 `modules()` 干的事。写成一样的调用形状：包名 + 导出名列表。
for (const [spec, exportName] of [
	["@deepseek-ai/dsh-sandbox-policy", "setSandboxMode"],
	["@deepseek-ai/dsh-user-approval", "setApprovalPolicy"],
	["@deepseek-ai/dsh-llm", "createUserMessage"],
]) {
	try {
		const loaded = await host.load(spec, [exportName]);
		check(
			typeof loaded?.[exportName] === "function",
			`${spec} 的 ${exportName} 是函数`,
			`实际是 ${typeof loaded?.[exportName]}（拿到的键：${Object.keys(loaded ?? {}).join(",") || "空"}）`,
		);
	} catch (error) {
		check(false, `${spec} 能加载`, String(error?.message ?? error).slice(0, 240));
	}
}

// —— 2. 反向对照：包名错一个字符必须抛 ——
//
// 没有这一条，「三个导出都在」可能只是因为 host.load 永远返回真值 —— 那这测法就是空的。
try {
	await host.load("@deepseek-ai/dsh-sandbox-polic", ["setSandboxMode"]);
	check(false, "反向对照：包名写错必须抛", "居然解析成功了，说明这个测法是空的");
} catch (error) {
	check(
		/MODULE_NOT_FOUND|Cannot find|not found/i.test(String(error?.message ?? error)),
		"反向对照：包名写错必须抛",
		String(error?.message ?? error).slice(0, 200),
	);
}

// —— 3. createAgentRunner 的三种坏 scope 都在构造时抛 ——
const throwsAtConstruction = (label, run) => {
	try {
		run();
		check(false, label, "没抛 —— 坏配置会一路带到跑会话时才炸");
	} catch (error) {
		check(true, label, "");
		return String(error?.message ?? error);
	}
	return "";
};

throwsAtConstruction("空 scope → 构造时抛", () => createAgentRunner({ scope: undefined, agentPreset: "team" }));
throwsAtConstruction("scope 没有 agents.create → 构造时抛", () => createAgentRunner({ scope: {}, agentPreset: "team" }));
const msg = throwsAtConstruction("agentPreset 为空 → 构造时抛", () =>
	createAgentRunner({ scope: { agents: { create: () => {} } }, agentPreset: "" }),
);
check(/preset/i.test(msg), "空预设的报错说明白了「要预设」", msg);

// —— 4. 构造成功后，runAgent 在缺 cwd / 缺指令时必须**立刻**回 ok:false，不碰宿主 ——
//
// 用假 scope 就够了：这一步验的是「它有没有先检查参数」，不是「它会不会跑会话」。
{
	const runner = createAgentRunner({
		scope: { agents: { create: () => { throw new Error("不该走到这里"); } }, agentPresets: {} },
		agentPreset: "team",
	});
	const noCwd = await runner({ commentId: "c1", instruction: "说话", cwd: "" });
	check(noCwd.ok === false && /cwd|目录/.test(noCwd.error ?? ""), "没有 cwd → 立刻拒绝，且说明原因", noCwd.error ?? "");
	const noInstruction = await runner({ commentId: "c2", instruction: "", cwd: "C:/tmp" });
	check(
		noInstruction.ok === false && /指令|描述/.test(noInstruction.error ?? ""),
		"没有指令 → 立刻拒绝",
		noInstruction.error ?? "",
	);
}

console.log(`\n${failed === 0 ? "全部通过 ✓" : `${failed} 项失败 ✗`}`);
process.exitCode = failed === 0 ? 0 : 1;
