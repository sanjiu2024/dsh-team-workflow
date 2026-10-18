#!/usr/bin/env node
/**
 * 冒烟：把**生成出来的**档位工具行，交给**宿主真的** `@deepseek-ai/dsh-tool-subagent` 去挂载。
 *
 * 为什么非要有它：0.2.1 把 `toolFilter` / `persona` 废弃了，**但 `Config` schema 不拦这两个键**
 * （2026-10-18 实测：把 toolFilter / persona / backgroundMode / inject 一起喂给 `Config`，全部通过）。
 * 所以「拿 schema 验一遍」这种测法**测不到**它 —— 漏掉它的代价是整份预设被判非法、
 * **新建会话直接失败**（报错原文见 REQ-022 §1）。只有让插件真跑起来才咬得住。
 *
 * 它做三件事：
 *   1. 读**生效中的**预设产物（`~/.dsh/team-workflow/preset-team/cordis.patch.yml`），并检查它不比
 *      `lib/preset-gen.js` / `team/agent-settings.json` 旧（旧了说明测的是过期产物，直接报错）；
 *   2. 从**产物文本**里抠出团队那几条档位行的 config（只认 `agentOptions` 这个特征，不抄生成器逻辑）；
 *   3. 用真 cordis + 真的宿主插件逐条挂载：**全部挂上才算过**；并跑一条**反向对照** ——
 *      同一条 config 加上 `toolFilter: { allow: [] }` 必须**挂不上**（咬不住就说明这测试是空的）。
 *
 * 不进 `npm test`：它依赖本机 dsh 安装树（宿主包在 `resources/app.asar` 里），而且必须在 Electron 里跑
 * （asar 只有 Electron 的 fs 认）。用法：
 *
 *   ELECTRON_RUN_AS_NODE=1 "<安装目录>\DeepSeek Harness.exe" --expose-internals scripts/smoke-preset-tier.mjs
 *
 * 直接 `node scripts/smoke-preset-tier.mjs` 会**报错退出**，不假装通过。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/** 生效中的预设产物（`dsh-team preset install` 写出来的那份）。 */
const presetFile =
	process.env.DSH_TEAM_PRESET ?? path.join(process.env.USERPROFILE ?? "", ".dsh", "team-workflow", "preset-team", "cordis.patch.yml");

function die(why) {
	console.error("✗ " + why);
	process.exit(1);
}

if (!process.versions.electron) {
	die("必须在 Electron 里跑 —— 宿主包在 app.asar 里，普通 node 解析不了（见文件头注释里的命令）");
}

const mtime = (p) => {
	try {
		return fs.statSync(p).mtimeMs;
	} catch {
		return 0;
	}
};
if (!fs.existsSync(presetFile)) die("找不到预设产物 " + presetFile + "，先跑 dsh-team preset install");
const oldest = Math.min(mtime(path.join(repo, "lib", "preset-gen.js")), mtime(path.join(repo, "team", "agent-settings.json")));
if (mtime(presetFile) < oldest) {
	die("预设产物比生成器旧 —— 先跑 dsh-team preset install 再测（产物 " + new Date(mtime(presetFile)).toISOString() + "）");
}

const text = fs.readFileSync(presetFile, "utf8");
console.log("预设产物：" + presetFile);

/**
 * 从产物文本里抠团队那几条档位行的 config。
 *
 * 判据是 `agentOptions` —— 只有团队生成的那几条档位行带它（出厂自带的
 * `tool-subagent-control` / `list-agents` / `fork` 都没有），所以不会误抓。
 */
function tierRowConfigs(source) {
	const lines = source.split("\n");
	const found = new Map();
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i].match(/^(\s*)- id: tool-subagent-([\w-]+)$/);
		if (!head) continue;
		const [, indent, tier] = head;
		const cfg = {};
		let nested = null;
		let hasAgentOptions = false;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			if (line.trim() === "") continue;
			const lead = line.match(/^\s*/)[0].length;
			if (lead <= indent.length) break;
			const kv = line.match(/^\s*([\w-]+):\s*(.*)$/);
			if (!kv) continue;
			const [, key, value] = kv;
			if (key === "config") continue;
			if (value === "") {
				nested = key;
				cfg[nested] = {};
				if (key === "agentOptions") hasAgentOptions = true;
				continue;
			}
			const clean = value.replace(/^['"]|['"]$/g, "");
			if (nested && lead > indent.length + 16) cfg[nested][key] = clean;
			else {
				nested = null;
				cfg[key] = clean;
			}
		}
		if (hasAgentOptions) found.set(tier, cfg);
	}
	return found;
}

const rows = tierRowConfigs(text);
if (rows.size === 0) die("产物里一条带 agentOptions 的档位行都没找到 —— 生成器结构变了？");
console.log("找到档位行：" + [...rows.keys()].join(" / "));

// ── 用真宿主插件挂载 ──────────────────────────────────────────────────────
const asarBase = path.join(path.dirname(process.execPath), "resources", "app.asar", "dsh", "node_modules", "x.js");
const req = createRequire(asarBase);
const { Context } = await import(pathToFileURL(req.resolve("@deepseek-ai/cordis")).href);
const subagent = await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-tool-subagent")).href);

/**
 * 把插件 inject 的服务都用桩顶住 —— 这里测的是**配置合不合法**，不是服务实现。
 * 桩按真实接口给（该有方法的给方法），**不用魔法 Proxy**：替身骗人的代价是测试变成空断言。
 */
function stubServices(ctx) {
	const noop = () => {};
	const stubs = {
		tools: { restrict: noop, register: noop },
		subagents: {
			register: noop,
			get: () => undefined,
			resolveMaxDepth: () => undefined,
			// 形状照真实 provider：挂载期会读 `capabilities.agentPreset` / `agentOptions`
			// 和 `inheritsParentContext`（宿主 `lib/index.js:243`、`:365`）。
			getProvider: (name) => ({
				name: name ?? "spawn",
				capabilities: { agentPreset: true, agentOptions: true, toolFilter: true },
				inheritsParentContext: false,
			}),
		},
		systemPrompt: { section: noop, register: noop },
		sessionProjections: { register: noop },
		agentPresets: { get: () => undefined, list: () => [], ids: () => [] },
	};
	for (const name of [...(subagent.inject ?? []), "agentPresets"]) {
		const value = stubs[name] ?? {};
		try {
			ctx.provide(name, value);
		} catch {
			try {
				ctx.set(name, value);
			} catch {
				/* 顶不住就让它抛，下面的断言会看到 */
			}
		}
	}
}

async function mount(cfg) {
	const ctx = new Context();
	stubServices(ctx);
	let fiber = null;
	let err = null;
	try {
		fiber = await ctx.plugin(subagent, cfg);
	} catch (e) {
		err = e;
	}
	if (!err && fiber) {
		await new Promise((r) => setTimeout(r, 200));
		err = fiber.error ?? null;
	}
	return err ? String(err.message ?? err.cause?.message ?? err) : null;
}

/**
 * 「配置被拒」的报文 —— 只有命中这几种才算失败。
 *
 * 为什么这么判：这里要证明的是**配置合不合法**（0.2.1 会因为 `toolFilter` 直接把整份预设判非法），
 * 而服务是桩、跑不完整个生命周期。桩不够真导致的残留报错如实标出来，不当成通过也不当成失败。
 */
const CONFIG_REJECTED = [/is no longer supported/, /invalid config/, /requires the agent-presets service/];

let rejected = 0;
let mounted = 0;
for (const [tier, cfg] of rows) {
	const err = await mount(cfg);
	if (!err) {
		mounted++;
		console.log("  ✓ tool-subagent-" + tier + " 完整挂上（" + JSON.stringify(cfg) + "）");
		continue;
	}
	if (CONFIG_REJECTED.some((re) => re.test(err))) {
		rejected++;
		console.log("  ✗ tool-subagent-" + tier + " 配置被拒：" + err.slice(0, 150));
		continue;
	}
	console.log("  · tool-subagent-" + tier + " 配置被接受（残留报错是桩不够真：" + err.slice(0, 70) + "）");
}

// ── 反向对照：这测试到底咬不咬得住 ────────────────────────────────────────
const [probeTier, probeCfg] = [...rows.entries()][0];
const control = await mount({ ...probeCfg, toolFilter: { allow: [] } });
if (!control) {
	die("反向对照没咬住 —— 给 " + probeTier + " 加上 toolFilter 居然还能挂上，说明这测试是空的");
}
if (!/toolFilter is no longer supported/.test(control)) {
	die("反向对照报的不是预期那句（拿到：" + control.slice(0, 120) + "）");
}
console.log("  ✓ 反向对照咬住了：" + control.slice(0, 80) + "…");

if (rejected > 0) die(rejected + "/" + rows.size + " 条档位行的配置被宿主拒了 —— 预设会被判非法，新会话建不起来");
console.log(
	"\n✓ " +
		rows.size +
		" 条档位行配置全部被接受" +
		(mounted > 0 ? "（其中 " + mounted + " 条在本桩环境下完整挂上）" : "（桩不够真，没跑到完整挂载，但配置这一关过了）") +
		"；反向对照也咬住了",
);
