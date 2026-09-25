#!/usr/bin/env node
/**
 * 自检：context7 文档查询移植。
 *
 * 盯的是：外部 HTTP 响应是信任边界（畸形 payload 不能炸、超长字段不能灌进上下文）、
 * 缓存键必须和实际请求参数一致（否则白打网络）、配置模板里写的键必须真的能读进来。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { installContext7, rankCandidates, sameLibraryName, CONTEXT7_FIELDS, CONTEXT7_DEFAULTS } from "../lib/context7.js";
import { readJsonConfig } from "../lib/util.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DSH = process.env.DSH_MODULES
	?? "C:/Users/Administrator/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/";

/**
 * 拿真的 Context / createScope / agentEvents，用来让 dsh 自己生成事件 payload。
 * 三者缺一不可：少了 agentEvents 就回到「手喂 payload」那个不可信的老路。
 */
async function loadRealEventStack() {
	const base = DSH.replace(/\/+$/, "") + "/";
	try {
		const [cordis, scope, agent] = await Promise.all([
			import(`file:///${base}cordis/lib/index.js`),
			import(`file:///${base}dsh-scope/lib/index.js`),
			import(`file:///${base}dsh-agent/lib/index.js`),
		]);
		if (
			typeof cordis.Context !== "function" ||
			typeof scope.createScope !== "function" ||
			typeof agent.agentEvents !== "function"
		) {
			return null;
		}
		return { Context: cordis.Context, createScope: scope.createScope, agentEvents: agent.agentEvents };
	} catch {
		return null;
	}
}

// ── 2. context7 纯逻辑 ───────────────────────────────────────────────────────

{
	// 同名匹配：大小写/分隔符归一化，避免多跑一轮
	assert.equal(sameLibraryName("fastapi", { title: "FastAPI" }), true, "FastAPI 应匹配 fastapi");
	assert.equal(sameLibraryName("node-fetch", { title: "Node Fetch" }), true, "node-fetch 应匹配 Node Fetch");
	assert.equal(sameLibraryName("react", { title: "React" }), true);
	assert.equal(sameLibraryName("react", { title: "React Native" }), false, "React 不该匹配 React Native");
	assert.equal(sameLibraryName("", { title: "React" }), false, "空名不能瞎匹配");
	console.log("✓ 库名同名匹配");
}

{
	// 候选裁剪：只留决策要用的字段，且尊重 maxCandidates
	const payload = {
		results: Array.from({ length: 30 }, (_, i) => ({
			id: `/x/${i}`, title: `Lib${i}`, description: "d".repeat(500),
			totalTokens: 100, totalSnippets: 5, trustScore: 9, benchmarkScore: 8,
			// 这些字段应当被丢掉（原样 30 条约 14,156 字符）
			versions: ["1", "2"], vip: false, state: "ok", lastUpdateDate: "2026-01-01", stars: 42,
		})),
	};
	const out = rankCandidates(payload, 3);
	assert.equal(out.length, 3, "maxCandidates=3 应只留 3 条");
	assert.equal(out[0].id, "/x/0");
	assert.equal(out[0].description.length, 200, "description 应裁到 200 字符");
	assert.deepEqual(Object.keys(out[0]).sort(), [
		"benchmarkScore", "description", "id", "title", "totalSnippets", "totalTokens", "trustScore",
	], "只应保留决策需要的字段");
	assert.equal(out[0].versions, undefined, "versions 这类无用字段应被丢弃");
	console.log("✓ 候选裁剪只留决策字段");
}

{
	// 空/畸形 payload 不能炸。外部 HTTP 响应是信任边界 —— 混进一个 null
	// 不该让整次搜索失败（以前会抛 Cannot read properties of null）。
	assert.deepEqual(rankCandidates(undefined, 3), [], "undefined 应得空数组");
	assert.deepEqual(rankCandidates({}, 3), [], "缺 results 应得空数组");
	assert.deepEqual(rankCandidates({ results: null }, 3), [], "results 为 null 应得空数组");
	assert.deepEqual(rankCandidates({ results: [null, undefined, "x", 42] }, 3), [], "非法条目应被过滤而不是抛错");
	assert.deepEqual(rankCandidates({ results: [null, { id: "/ok", title: "OK" }] }, 3).map((c) => c.id), ["/ok"],
		"一条非法 + 一条合法时，合法的那条要留下");
	// 没有 id 的候选取不了文档：留着会让 URL 变成 `.../api/v1undefined`。
	assert.deepEqual(rankCandidates({ results: [{ title: "无 id" }, { id: 42 }, { id: "" }] }, 3), [],
		"没有可用 id 的候选要丢掉，不能让 URL 拼出 undefined");
	// 过滤要在截断之前，否则坏条目会白占一个候选位
	const filler = [{ title: "bad" }, ...Array.from({ length: 5 }, (_, i) => ({ id: `/g${i}` }))];
	assert.deepEqual(rankCandidates({ results: filler }, 3).map((c) => c.id), ["/g0", "/g1", "/g2"],
		"应先过滤再截断，坏条目不该占掉候选名额");

	// 外部服务给的字符串没理由无限长：单条 9000 字符的 title 能撑到 18K 字符。
	const huge = rankCandidates({ results: [{ id: "i".repeat(9000), title: "t".repeat(9000), description: "d".repeat(9000) }] }, 1);
	assert.equal(huge[0].id.length, 200, "id 应有长度上限");
	assert.equal(huge[0].title.length, 200, "title 应有长度上限");
	assert.ok(JSON.stringify(huge[0]).length < 1000, `单条候选不该膨胀（实际 ${JSON.stringify(huge[0]).length} 字符）`);
	console.log("✓ 畸形 payload 安全降级 + 超长字段被裁剪");
}

{
	// 缓存键必须和**实际请求参数**一致。请求用的是 trim 过的 topic，
	// 键若用原值，" routing " 和 "routing" 会被当成两个请求 —— 多打一次网络。
	// 用假 fetch 数请求次数，这是唯一能真看出「是否真命中缓存」的办法。
	const realFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = async (url) => {
		fetches += 1;
		const body = String(url).includes("/search")
			? JSON.stringify({ results: [{ id: "/tiangolo/fastapi", title: "FastAPI", description: "d" }] })
			: `DOC-${fetches}`;
		return { ok: true, status: 200, text: async () => body };
	};
	try {
		let tool;
		installContext7(
			{ logger: { info: () => {}, warn: () => {}, error: () => {} }, tools: { register(def) { tool = def; return () => {}; } }, on: () => () => {} },
			{},
		);
		await tool.execute({ library: "/tiangolo/fastapi", topic: "routing" }, {});
		const after1 = fetches;
		await tool.execute({ library: "/tiangolo/fastapi", topic: "  routing  " }, {});
		assert.equal(fetches, after1, "topic 只差空白不应重新打网络（缓存键要和请求参数一致）");
		await tool.execute({ library: "/tiangolo/fastapi", topic: "middleware" }, {});
		assert.equal(fetches, after1 + 1, "不同 topic 应该真的重新取文档");
		console.log("✓ 缓存键与实际请求参数一致（空白变体命中、不同 topic 不误命中）");
	} finally {
		globalThis.fetch = realFetch;
	}
}

{
	// 配置里的键必须真的被读。readJsonConfig 只采纳 FIELDS 里声明过的键，
	// 没声明的会**静默丢弃** —— 用户在配置模板里改了 maxTokens，以为生效，其实没生效。
	// 这里直接拿仓库里那份真配置逐个键对，不靠人看。
	const tmp = path.join(os.tmpdir(), `team-cfg-${process.pid}.json`);
	try {
		for (const [name, fields, defaults] of [["context7", CONTEXT7_FIELDS, CONTEXT7_DEFAULTS]]) {
			const shipped = path.join(ROOT, "team", "extensions", `${name}.json`);
			if (!fs.existsSync(shipped)) continue;
			const raw = JSON.parse(fs.readFileSync(shipped, "utf8"));
			const cfgKeys = Object.keys(raw).filter((k) => !k.startsWith("_"));
			const silent = cfgKeys.filter((k) => !(k in fields));
			assert.deepEqual(silent, [], `${name}.json 里这些键没有校验器，会被静默丢弃：${silent.join(", ")}`);

			// 还要确认「非默认值真的读得进来」：全填占位值比只查键名更硬。
			const probe = {};
			for (const k of cfgKeys) {
				const d = defaults[k];
				probe[k] = typeof d === "boolean" ? !d : typeof d === "number" ? d + 1 : "__probe__";
			}
			fs.writeFileSync(tmp, JSON.stringify(probe), "utf8");
			const read = readJsonConfig(tmp, defaults, fields, () => {});
			for (const k of cfgKeys) {
				assert.notDeepEqual(read[k], defaults[k], `${name}.json 的 ${k} 没有真正生效（读出来还是默认值）`);
			}
		}
		console.log("✓ 配置模板里的每个键都有校验器，且改值真能生效");
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

// ── 3. context7 得更到用户眼前 ────────────────────────────────────────
//
// 只把 enabled/status 塞进 deps 而不显示，等于用户根本不知道它们开没开、
// 出问题时也无法自查。这里用真 Context 跑一遍 apply，把命令输出抓回来盯。
{
	const real = await loadRealEventStack();
	if (real === null) {
		console.log("… 跳过 /team-baseline 显示检查：找不到 dsh 模块");
	} else {
		const cmds = new Map();
		const cmdCtx = new real.Context();
		cmdCtx.logger = { info: () => {}, warn: () => {}, error: () => {} };
		cmdCtx.tools = { register: () => () => {} };
		cmdCtx.commands = { register(d) { cmds.set(d.name, d); return () => {}; } };
		cmdCtx.systemPrompt = { section: () => () => {} };
		cmdCtx.sessions = { list: () => [] };
		const indexMod = await import(`file:///${ROOT.replace(/\\/g, "/")}/lib/index.js`);
		await indexMod.apply(cmdCtx, {});
		const shown = (await cmds.get("team-baseline").handler()).text;
		assert.match(shown, /context7：开/, "/team-baseline 要显示 context7 状态");
		console.log("✓ /team-baseline 会显示 context7 状态");
	}
}

console.log("\n全部通过 ✓");
