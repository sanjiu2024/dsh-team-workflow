#!/usr/bin/env node
/**
 * 自检：pi-lens 全套工具移植（lens_tools）。
 *
 * 重点盯三件事：
 *   1. 默认**只注册一个** lens_tools —— 这是省 token 的全部依据。谁改成预注册
 *      12 个工具，地板就悄悄涨 75%（真实成本 +8.7%），必须红。
 *   2. 参数 schema 的越界关键字确实被剥掉了 —— dsh 的 assertSupportedJsonSchema
 *      会直接 throw，不是警告。
 *   3. 工具只在**点亮它的那个 agent** 的回合结束时撤销，且多人共用时在场面是
 *      所有人需求的并集 —— 撤销写错方向会让正在干活的 agent 突然没工具。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sanitizeSchema, installLensTools } from "../lib/lens-tools.js";
import { LENS_TOOLS_FIELDS, LENS_TOOLS_DEFAULTS } from "../lib/lens-tools.js";
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

/**
 * 拿 dsh 自己的 schema 校验器。用真货而不是我复刻的一份规则 ——
 * 复刻那套只能证明「我读对了文档」，证明不了「dsh 真的会接受」。
 * 跟 selftest-fold / selftest-surface / e2e-fold 用同一个环境变量覆盖点。
 */
async function loadDshValidator() {
	for (const candidate of [DSH, `${DSH.replace(/\/$/, "")}/`]) {
		try {
			const mod = await import(`file:///${candidate}dsh-tools/lib/index.js`.replace(/\/+/g, "/"));
			if (typeof mod.assertSupportedJsonSchema === "function") return mod.assertSupportedJsonSchema;
		} catch {
			// 装没装 dsh 不确定，下面统一降级
		}
	}
	return null;
}

// ── 1. schema 清洗 ───────────────────────────────────────────────────────────

// dsh 只认这几个关键字（dsh-tools/lib/index.js 的 CONSTRAINT/ANNOTATION_KEYWORDS）
const DSH_KEYWORDS = new Set([
	"type", "oneOf", "properties", "required", "additionalProperties",
	"items", "enum", "const", "description", "title", "default", "examples",
]);

/** 递归收集所有出现过的 schema 关键字（跳过 properties 的属性名） */
function collectKeywords(node, out = new Set()) {
	if (!node || typeof node !== "object" || Array.isArray(node)) return out;
	for (const [key, value] of Object.entries(node)) {
		if (key === "properties") {
			for (const sub of Object.values(value ?? {})) collectKeywords(sub, out);
			continue;
		}
		out.add(key);
		if (key === "items" || key === "oneOf") collectKeywords(value, out);
	}
	return out;
}

{
	// anyOf → oneOf，minItems/maxItems 丢弃，其余原样
	const input = {
		type: "object",
		required: ["paths"],
		properties: {
			paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, description: "d" },
			refreshRunners: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["a", "b"] }] },
		},
		additionalProperties: false,
	};
	const out = sanitizeSchema(input);

	assert.equal(out.properties.paths.minItems, undefined, "minItems 应被剥掉");
	assert.equal(out.properties.paths.maxItems, undefined, "maxItems 应被剥掉");
	assert.deepEqual(out.properties.refreshRunners.oneOf, [
		{ type: "boolean" },
		{ type: "string", enum: ["a", "b"] },
	], "anyOf 应转成等价的 oneOf");
	assert.equal(out.properties.refreshRunners.anyOf, undefined, "anyOf 本身不能留");

	// 属性名不能被当成关键字丢掉 —— properties 的 key 是数据，不是关键字
	assert.ok(out.properties.paths, "properties 里的属性名必须保留");
	assert.ok(out.properties.refreshRunners, "properties 里的属性名必须保留");

	// 清洗结果对 dsh 必须完全合法
	const leftovers = [...collectKeywords(out)].filter((k) => !DSH_KEYWORDS.has(k));
	assert.deepEqual(leftovers, [], `清洗后仍有 dsh 不认的关键字：${leftovers.join(", ")}`);
	console.log("✓ anyOf→oneOf 转换、min/maxItems 剥离、属性名保留");
}

{
	// 深层的 items/oneOf 也要洗到（不能只洗第一层）
	const deep = { type: "array", items: { type: "object", properties: { x: { anyOf: [{ type: "number" }], maxItems: 1 } } } };
	const out = sanitizeSchema(deep);
	const leftovers = [...collectKeywords(out)].filter((k) => !DSH_KEYWORDS.has(k));
	assert.deepEqual(leftovers, [], `嵌套层未洗干净：${leftovers.join(", ")}`);
	console.log("✓ 嵌套层同样洗净");
}

{
	// required 是数组，不能被当 schema 递归进去改坏
	const out = sanitizeSchema({ type: "object", required: ["a"], properties: { a: { type: "string" } } });
	assert.deepEqual(out.required, ["a"], "顶层 required 数组必须原样保留");
	console.log("✓ required 数组原样保留");
}

{
	// 配置里的键必须真的被读。readJsonConfig 只采纳 FIELDS 里声明过的键，
	// 没声明的会**静默丢弃** —— 用户在配置模板里改了 maxTokens，以为生效，其实没生效。
	// 这里直接拿仓库里那份真配置逐个键对，不靠人看。
	const tmp = path.join(os.tmpdir(), `team-cfg-${process.pid}.json`);
	try {
		for (const [name, fields, defaults] of [["lens-tools", LENS_TOOLS_FIELDS, LENS_TOOLS_DEFAULTS]]) {
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

// ── 3. 核心成本保证：默认只注册一个工具 ──────────────────────────────────────

const lensDir = path.join(ROOT, "vendor", "pi-lens");
if (!fs.existsSync(path.join(lensDir, "dist", "index.js"))) {
	console.log("… 跳过 lens_tools 行为检查：vendor/pi-lens 不存在（vendor/ 是 gitignore 的）");
	// 不能只印「全部通过」:第 3~8 节（含省 token 的成本保证、三条撤销路径、
	// agent 隔离）**一个都没跑**。不把这句话说清楚，新克隆上改坏了也看着是绿的。
	console.log("\n仅通过第 1~2 节（纯函数）✓");
	console.log("⚠️ 未验证：默认只注册 1 个工具、三条撤销路径、agent 隔离 —— 需要 vendor/pi-lens。");
	console.log("   跑 `dsh-team lens install` 生成 vendor/pi-lens 后可完整验证。");
	process.exit(0);
}

function makeCtx() {
	const handlers = new Map();
	const tools = [];
	return {
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		tools: {
			register(def) {
				if (tools.some((t) => t.name === def.name)) throw new Error(`duplicate tool ${def.name}`);
				tools.push(def);
				return () => {
					const at = tools.indexOf(def);
					if (at >= 0) tools.splice(at, 1);
				};
			},
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		_handlers: handlers,
		_tools: tools,
	};
}

const ctx = makeCtx();
const installed = installLensTools(ctx, `file:///${ROOT.replace(/\\/g, "/")}/`, {});
assert.equal(installed.enabled, true, "vendor/pi-lens 在，就应该接上");

// ⚠️ 这是本文件最重要的一条：默认地板里只能有 1 个工具。
// 谁把 12 个改成预注册，这条就红 —— 那等于每次调用多烧 7,435 tok。
assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "默认只能注册 lens_tools 一个工具");

const entry = ctx._tools[0];
const entrySize = (entry.description ?? "").length + JSON.stringify(entry.parameters ?? {}).length;
assert.ok(entrySize < 600, `入口工具声明应小于 600 字符（实际 ${entrySize}）—— 它每次调用都重发`);

// status 里声称的数量必须和 list 报的一致（之前写着 13，实际只有 12，
// 因为 pi_lens_activate_tools 被剔了）。数字对不上会把排查带沟里。
{
	const listed = (await entry.execute({ action: "list" }, {})).text.match(/可用 (\d+) 个/)?.[1];
	const claimed = installed.status.match(/(\d+) 个工具/)?.[1];
	assert.ok(listed, "list 应报告工具数量");
	assert.equal(claimed, listed, `status 声称 ${claimed} 个、list 实际 ${listed} 个，对不上`);
}

// 每个工具都必须有 output{render}，否则 dsh 的 register 直接 throw
assert.equal(typeof entry.output?.render, "function", "必须声明 output.render");
console.log(`✓ 默认只注册 1 个工具（声明 ${entrySize} 字符 ≈ ${Math.round(entrySize / 2.5)} tok）`);

// ── 4. 按需激活 / 撤销 ──────────────────────────────────────────────────────

{
	const listText = (await entry.execute({ action: "list" }, {})).text;
	assert.match(listText, /symbol_search/, "list 应列出可用工具");

	const activated = await entry.execute({ action: "activate" }, {});
	assert.match(activated.text, /已点亮 \d+ 个工具/, "activate 应报告点亮数量");

	const names = ctx._tools.map((t) => t.name);
	assert.ok(names.length > 10, `activate 后应有 10+ 个工具（实际 ${names.length}）`);
	assert.ok(names.includes("symbol_search"), "activate 后应能直接调 symbol_search");
	assert.ok(names.includes("lsp_navigation"), "LSP 跳转应在点亮列表里");
	assert.ok(!names.includes("pi_lens_activate_tools"), "pi 宿主的启动器应被剔除（在 dsh 里是空操作）");

	// 用 dsh **自己的**校验器过一遍全部 schema（含 12 个真工具的 parameters）。
	// register 只校验 output.schema，但 parameters 会下发给模型，也必须合法；
	// 而 assertSupportedJsonSchema 会直接 throw，不是警告。
	const validate = await loadDshValidator();
	if (validate === null) {
		console.log("… 跳过 dsh 官方 schema 校验：找不到 dsh-tools（设 DSH_MODULES 可指定）");
	} else {
		let checked = 0;
		for (const t of ctx._tools) {
			for (const [what, schema] of [["output.schema", t.output?.schema], ["parameters", t.parameters]]) {
				assert.ok(schema !== undefined, `${t.name}.${what} 不能缺失`);
				validate(schema); // 不合法就在这里 throw
				checked += 1;
			}
		}
		assert.ok(checked >= 26, `应校验到 26 个 schema（13 工具 × 2），实际 ${checked}`);
		console.log(`✓ ${checked} 个 schema 过了 dsh 官方 assertSupportedJsonSchema`);
	}

	// 真调一次，确认参数适配 + 返回值摊平都对
	const sym = ctx._tools.find((t) => t.name === "symbol_search");
	const out = await sym.execute(
		{ query: "installLensTools" },
		{ agent: { session: { header: { cwd: ROOT } } } },
	);
	assert.equal(typeof out.text, "string", "工具必须返回 {text}");
	assert.ok(out.text.length > 0, "symbol_search 应有输出");
	assert.doesNotMatch(out.text, /执行失败/, `不该失败：${out.text.slice(0, 200)}`);
	console.log("✓ activate 后工具可用，且参数/返回值适配正确");

	// 重复 activate 不能抛 duplicate
	await entry.execute({ action: "activate" }, {});
	console.log("✓ 重复 activate 幂等（不抛 duplicate）");

	// 撤销
	await entry.execute({ action: "deactivate" }, {});
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "deactivate 后地板必须回落");
	console.log("✓ deactivate 后注册表回落成只剩入口");
}

// ── 5. 回合结束自动撤销（否则点亮一次就永久常驻）──────────────────────────

{
	const stops = ctx._handlers.get("agent/turn-stopping") ?? [];
	assert.equal(stops.length, 1, "应挂一个 agent/turn-stopping 处理器");

	// `agent/turn-stopping` 走 dispatch.serial —— `cb(...args)` 直接调，**没有 next**。
	// 写成 (payload, next) 会在每个回合末抛 "next is not a function"。
	//
	// 注意：处理器是 async，抛错会变成 rejected promise，**同步的 doesNotThrow 看不见**。
	// 所以必须 await —— 否则这条断言永远绿，等于没写。
	let stopError;
	try {
		await stops[0]({ turn: 1 });
	} catch (error) {
		stopError = error;
	}
	assert.equal(stopError, undefined, `turn-stopping 处理器不能依赖 next 回调，但抛了：${stopError?.message}`);
	// 上面那次调用会真的撤销
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "回合结束应自动撤销已点亮的工具");
	console.log("✓ 回合结束自动撤销，且不依赖 next 回调");

	// 中断/报错路径：dsh 只在正常分支 dispatch turn-stopping，所以按 Esc 时
	// 它**根本不会触发**，靠 `agent/status`→idle 兜底。这条就是在钉住兜底存在。
	await entry.execute({ action: "activate" }, {});
	assert.ok(ctx._tools.length > 10, "前提：应已点亮");
	const statusHandlers = ctx._handlers.get("agent/status") ?? [];
	assert.ok(statusHandlers.length > 0, "必须挂 agent/status —— 中断时唯一的撤销路径");
	for (const h of statusHandlers) h({ status: "idle" });
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "idle 后必须撤销（中断/报错兜底）");
	// 非 idle 状态不能误撤（否则跑到一半工具就没了）
	await entry.execute({ action: "activate" }, {});
	for (const h of statusHandlers) h({ status: "running" });
	assert.ok(ctx._tools.length > 10, "running 状态不能撤销工具");
	await entry.execute({ action: "deactivate" }, {});
	console.log("✓ 中断/报错时靠 agent/status→idle 兜底撤销");
}

// ── 6. 子代理不能拔掉父代理的工具 ────────────────────────────────────────
//
// 本插件注册在根作用域，而 dsh-scope 的规则是「带祖先标签的监听者会收到派发
// 到后代 key 的事件」—— 所以同进程的**每一个** agent（包括子代理）的事件都
// 会打到这里。dsh 的子代理确实是同进程的（dsh-subagent-in-process-driver
// 里就是 parent.ctx.agents.create(...)）。不按 owner 过滤的话：父代理点亮了
// 工具，它派出去的子代理一跑完，父代理下一步就找不到工具了。
{
	const parent = { id: "parent" };
	const child = { id: "child" };
	const statusHandlers = ctx._handlers.get("agent/status") ?? [];

	await entry.execute({ action: "activate" }, { agent: parent });
	assert.ok(ctx._tools.length > 10, "前提：父代理应已点亮");

	// 子代理跑完 —— 不能把父代理的工具撤掉
	for (const h of statusHandlers) h({ status: "idle", agent: child });
	assert.ok(ctx._tools.length > 10, "子代理 idle 不能撤销父代理的工具（共享根注册表）");
	console.log("✓ 子代理转 idle 不影响父代理已点亮的工具");

	// 父代理自己结束 —— 必须撤
	for (const h of statusHandlers) h({ status: "idle", agent: parent });
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "父代理 idle 必须撤销自己的工具");
	console.log("✓ 父代理自己转 idle 才撤销");
}

// ── 7. agent/disposed 是最后一道保险 ──────────────────────────────────────
//
// idle 与 dispose 之间隔着异步（announcing / detachRequested 会推迟派发），
// 会话被直接关掉时可能只走 dispose。少了这条，工具就跟着一个已经消失的
// agent 永久留在注册表里。
{
	const disposedHandlers = ctx._handlers.get("agent/disposed") ?? [];
	assert.ok(disposedHandlers.length > 0, "必须挂 agent/disposed —— 会话被关掉时的保险");

	const parent = { id: "parent" };
	const child = { id: "child" };
	await entry.execute({ action: "activate" }, { agent: parent });
	assert.ok(ctx._tools.length > 10, "前提：应已点亮");

	// 别人的 agent 被销毁，不能连坐
	for (const h of disposedHandlers) h({ agent: child });
	assert.ok(ctx._tools.length > 10, "子代理被销毁不能撤销父代理的工具");

	// 自己的 agent 没了 —— 工具必须跟着走
	for (const h of disposedHandlers) h({ agent: parent });
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "owner 被销毁后不能留下工具");
	console.log("✓ agent 被销毁时兜底撤销（且不误伤其它 agent）");
}

// ── 7b. 多人共用：在场面必须是「所有人需求的并集」──────────────────────
//
// dsh 的工具注册表是全局的（一个名字一个槽位），而父子代理同进程。所以「谁最后
// 调 activate 谁说了算」是错的：A 只要 2 个，B 要全部，若 A 后调就会把 B 的 12 个
// 挤掉，B 下一步找不到工具。
{
	const ctx = makeCtx();
	installLensTools(ctx, `file:///${ROOT.replace(/\\/g, "/")}/`, {});
	const entry = ctx._tools.find((t) => t.name === "lens_tools");
	const statusHandlers = ctx._handlers.get("agent/status") ?? [];
	const A = { id: "A" };
	const B = { id: "B" };

	await entry.execute({ action: "activate", tools: ["symbol_search", "read_symbol"] }, { agent: A });
	const aOnly = ctx._tools.length;
	await entry.execute({ action: "activate" }, { agent: B });
	const both = ctx._tools.length;
	// A 再点一次子集：不能把 B 的点亮结果压回去
	await entry.execute({ action: "activate", tools: ["symbol_search", "read_symbol"] }, { agent: A });
	assert.equal(ctx._tools.length, both, "A 后点一个子集不能挤掉 B 已经点亮的工具（并集语义）");

	// A 走了 → B 的还在
	for (const h of statusHandlers) h({ status: "idle", agent: A });
	assert.equal(ctx._tools.length, both, "A 结束不能撤掉 B 的工具");
	// B 也走 → 全部回落
	for (const h of statusHandlers) h({ status: "idle", agent: B });
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "最后一个人走了要全撤");
	assert.ok(aOnly < both, "前提：A 单独点亮应少于 B 全量点亮");

	// 关键是**后点的人要得更少**这个顺序：如果实现退化成「最后一个 owner 说了算」，
	// A 的 2 个就会把 B 的 12 个挤掉。反过来（先子集后全量）恰好掩盖 bug，
	// 因为 Map 的迭代顺序总是先插入的先来，全量那方永远在后面。
	const C = { id: "C" };
	const D = { id: "D" };
	await entry.execute({ action: "activate" }, { agent: C });
	assert.equal(ctx._tools.length, both, "前提：C 全量点亮");
	await entry.execute({ action: "activate", tools: ["symbol_search"] }, { agent: D });
	assert.equal(ctx._tools.length, both, "后点的子集（D）不能挤掉先点的全量（C）—— 在场面是并集，不是最后一个 owner");

	// 反向：先点的子集走了，后点的全量还在
	for (const h of statusHandlers) h({ status: "idle", agent: D });
	assert.equal(ctx._tools.length, both, "D（子集）走了不能动摇 C（全量）的工具");
	for (const h of statusHandlers) h({ status: "idle", agent: C });
	assert.deepEqual(ctx._tools.map((t) => t.name), ["lens_tools"], "C 也走了就应该只剩入口");

	console.log(`✓ 多 agent 共用：在场面是并集（A 单点 ${aOnly} → A+B ${both}），谁走都不动别人的`);
}

// ── 8. 用 dsh **真货**跑一遍，不用我手喂的 payload ─────────────────────────
//
// 上面 6/7 节都是我自己构造 `{agent: ...}` 传给处理器。如果 dsh 实际上**不往
// payload 里塞 agent**，那些测试会全部通过而现实里永久漏撤 —— 正是「不可能
// 失败的断言」。这里改用真的 Context / createScope / agentEvents，让 payload
// 由 dsh 自己生成（agentEvents 的 fused() 负责注入 agent），并确认：
//   1) 根作用域注册确实收得到 agent 事件（dsh-scope: 事件向上流，不向下）
//   2) payload 里确实有 agent 字段
//   3) 子代理 idle 不误伤父代理，父代理回合结束能真撤销
{
	const real = await loadRealEventStack();
	if (real === null) {
		console.log("… 跳过真实事件链路检查：找不到 dsh 模块（设 DSH_MODULES 可指定）");
	} else {
		const { Context, createScope, agentEvents } = real;
		const root = new Context();
		const registry = [];
		const realCtx = {
			logger: { info: () => {}, warn: () => {}, error: () => {} },
			tools: {
				register(def) {
					registry.push(def);
					return () => {
						const at = registry.indexOf(def);
						if (at >= 0) registry.splice(at, 1);
					};
				},
			},
			on(event, handler) {
				return root.on(event, handler);
			},
		};
		installLensTools(realCtx, `file:///${ROOT.replace(/\\/g, "/")}/`, {});
		const realEntry = registry[0];

		const parent = { name: "parent", session: { header: { cwd: ROOT } } };
		const child = { name: "child", session: { header: { cwd: ROOT } } };
		const parentScope = createScope(root, parent);
		const childScope = createScope(root, child);

		// 用真货发事件：agent 字段由 agentEvents 的 fused() 注入，不是我塞的
		const parentEvents = agentEvents(parentScope.ctx, parent);
		const childEvents = agentEvents(childScope.ctx, child);

		await realEntry.execute({ action: "activate" }, { agent: parent });
		assert.ok(registry.length > 10, "前提：父代理应已点亮");

		// 子代理真的转 idle —— 必须什么事都不发生
		childEvents.emit("agent/status", { status: "idle" });
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(
			registry.length > 10,
			"真实事件链路上，子代理 idle 不能拔掉父代理的工具（说明 payload.agent 确实被注入且比对生效）",
		);

		// 父代理回合真的结束 —— 必须真撤销
		parentEvents.emit("agent/turn-stopping", {});
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(registry.map((t) => t.name), ["lens_tools"], "真实事件链路上，父代理回合结束必须撤销");
		console.log("✓ 真实 dsh 事件链路（真 Context/createScope/agentEvents）下隔离与撤销都成立");
	}
}

// ── 9. lens 工具集得更到用户眼前 ────────────────────────────────────────
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
		assert.match(shown, /lens工具：开/, "/team-baseline 要显示 lens 工具集状态（只塞进 deps 不显示 = 用户无从得知）");
		console.log("✓ /team-baseline 会显示 lens 工具集状态");
	}
}

console.log("\n全部通过 ✓");
