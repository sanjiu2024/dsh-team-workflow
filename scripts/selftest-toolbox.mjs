#!/usr/bin/env node
/**
 * REQ-032 自检：工具箱（把 CLI 高频命令做成按钮）。
 *
 * 钉住的是**信任边界**，不是按钮好不好看：
 *   ① 只认 op 白名单 —— 前端不能传任意命令/参数；
 *   ② 危险 op 必须带 `confirm: true`，否则 428（两层确认里的服务端那层）；
 *   ③ 非回环来源一律 403（这些按钮等价于在本机执行命令）；
 *   ④ 状态聚合读不到东西时降级成文本，不 500。
 *
 * 危险 op（purge.apply / preset.install）在自检里**只测拒绝分支**，绝不真跑 ——
 * 它们会改宿主安装目录。
 *
 * 跑法：`node scripts/selftest-toolbox.mjs`
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { installToolbox, classifyApplyReport, OPS, TOOLBOX_ROUTE } = await import("../lib/toolbox.js");

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`✓ ${label}`);
};

/** 装一次工具箱，拿到注册进去的 handler。 */
function mount(deps = { root: ROOT }) {
	const routes = [];
	const disposers = [];
	const ctx = {
		inject(_names, callback) {
			callback({
				webServer: {
					register(spec) {
						routes.push(spec);
						return () => {};
					},
				},
				effect(fn) {
					const d = fn();
					if (typeof d === "function") disposers.push(d);
					return () => {};
				},
			});
		},
	};
	installToolbox(ctx, deps);
	assert.equal(routes.length, 1, "应该只注册一条路由");
	assert.equal(routes[0].path, TOOLBOX_ROUTE, "路由路径不对");
	return { spec: routes[0], disposers };
}

/** 假 request / response。 */
function makeReq({ method = "GET", body, origin, host = "127.0.0.1:64571", remote = "127.0.0.1" } = {}) {
	const listeners = {};
	const request = {
		method,
		socket: { remoteAddress: remote },
		headers: { host, ...(origin === undefined ? {} : { origin }) },
		on(event, fn) {
			(listeners[event] ??= []).push(fn);
			return request;
		},
		destroy() {},
	};
	setImmediate(() => {
		if (body !== undefined) {
			const raw = typeof body === "string" ? body : JSON.stringify(body);
			for (const fn of listeners.data ?? []) fn(Buffer.from(raw));
		}
		for (const fn of listeners.end ?? []) fn();
	});
	return request;
}

function makeRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: "",
		setHeader(key, value) {
			this.headers[key] = value;
		},
		end(chunk) {
			this.body = String(chunk ?? "");
			this.done?.();
		},
	};
	const done = new Promise((resolve) => {
		res.done = resolve;
	});
	return { res, done };
}

async function call(spec, options) {
	const { res, done } = makeRes();
	await spec.handler(makeReq(options), res);
	await done;
	let json = null;
	try {
		json = JSON.parse(res.body);
	} catch {
		/* 非 JSON 就保持 null，让断言自己说 */
	}
	return { status: res.statusCode, json, raw: res.body };
}

// ── ① 白名单 ────────────────────────────────────────────────────────────────
{
	const { spec } = mount();
	assert.ok(Object.keys(OPS).length >= 10, `op 太少了：${Object.keys(OPS).length}`);
	for (const op of Object.values(OPS)) {
		assert.ok(typeof op.label === "string" && op.label, "每个 op 都要有可读的按钮名");
		assert.ok(Array.isArray(op.args) || op.args === null, "args 要么是数组要么是 null（null = 由 core 直接做）");
	}
	const unknown = await call(spec, { method: "POST", body: { op: "rm -rf /", confirm: true } });
	assert.equal(unknown.status, 400, "未知 op 必须 400");
	assert.match(unknown.json.error, /没有这个操作/, "要说清是哪个 op 不认识");
	ok("白名单：未知 op 一律 400，前端传不了任意命令");
}

// ── ①b 「应用补丁」的结果判定：na / skipped 不是失败 ───────────────────────
{
	const core = await import("../lib/purge/core.js");
	const report = [
		{ patch_id: 1, status: "applied" },
		{ patch_id: 2, status: "already" },
		{ patch_id: 28, status: "na" },
		{ patch_id: 88, status: "skipped" },
	];
	const verdict = classifyApplyReport(report, core);
	assert.equal(verdict.ok, true, "na / skipped 被当成失败 → 面板整行标红（2026-10-31 实测 9 条假失败）");
	assert.equal(verdict.applied, 1);
	assert.equal(verdict.already, 1);
	assert.deepEqual(verdict.soft.map((r) => r.patch_id), [28, 88], "na / skipped 要单列成「不适用/跳过」");
	assert.deepEqual(verdict.failed, [], "这批里没有真失败");

	const real = classifyApplyReport([...report, { patch_id: 99, status: "pattern_not_found" }], core);
	assert.equal(real.ok, false, "pattern_not_found 是真失败，不能被吞");

	// 兜底分支（不传 core）必须与 core 的口径一致，否则换个实现就悄悄改判。
	const fallback = classifyApplyReport(report);
	assert.deepEqual(fallback.soft.map((r) => r.patch_id), verdict.soft.map((r) => r.patch_id));
	assert.equal(fallback.ok, verdict.ok);
	ok("补丁结果判定：na / skipped 不算失败、pattern_not_found 才算；兜底口径与 core 一致");
}

// ── ② 危险 op 的第二次确认 ─────────────────────────────────────────────────
{
	const { spec } = mount();
	for (const name of ["purge.apply", "purge.revert", "preset.install"]) {
		assert.ok(OPS[name], `白名单里少了危险 op ${name}`);
		assert.equal(OPS[name].danger, true, `${name} 必须标 danger（面板才做两段式确认）`);
		const refused = await call(spec, { method: "POST", body: { op: name } });
		assert.equal(refused.status, 428, `${name} 没带 confirm 必须 428`);
		assert.match(refused.json.error, /confirm/, "拒绝理由要指出缺 confirm");
	}
	ok("危险 op：不带 confirm 一律 428（服务端那层兜底）");
}

// ── ③ 来源校验 ──────────────────────────────────────────────────────────────
{
	const { spec } = mount();
	const remote = await call(spec, {
		method: "POST",
		body: { op: "status" },
		remote: "10.0.0.9",
	});
	assert.equal(remote.status, 403, "非回环来源必须 403");

	const crossOrigin = await call(spec, {
		method: "POST",
		body: { op: "status" },
		origin: "https://evil.example.com",
	});
	assert.equal(crossOrigin.status, 403, "跨源必须 403");

	const sameOrigin = await call(spec, {
		method: "POST",
		body: { op: "status" },
		origin: "http://127.0.0.1:64571",
	});
	// status 走 CLI（dsh-team status），能跑起来就算通过 —— 内容不作断言（环境相关）
	assert.notEqual(sameOrigin.status, 403, "同源请求不该被拒");
	ok("来源：非回环 403 / 跨源 403 / 同源放行");
}

// ── ④ 状态聚合 ──────────────────────────────────────────────────────────────
{
	const { spec } = mount({ root: ROOT, subsystems: { 审计: "开", 小队: "开" } });
	const got = await call(spec, { method: "GET" });
	assert.equal(got.status, 200, got.raw.slice(0, 200));
	assert.ok(Array.isArray(got.json.rows) && got.json.rows.length >= 4, `状态行太少：${got.raw.slice(0, 200)}`);
	const keys = got.json.rows.map((row) => row.key);
	for (const expect of ["版本", "补丁", "团队预设", "审计", "小队"]) {
		assert.ok(keys.includes(expect), `状态里缺「${expect}」：${keys.join(",")}`);
	}
	assert.equal(got.json.rows.find((r) => r.key === "版本").value, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, "版本要读真实 package.json");
	assert.ok(got.json.ops["purge.apply"], "ops 清单要一起给前端（按钮从它渲染）");
	ok("状态：版本/补丁/预设/各子系统都在，且带上 ops 清单");
}

// ── ⑤ 方法限制 ──────────────────────────────────────────────────────────────
{
	const { spec } = mount();
	const put = await call(spec, { method: "PUT", body: {} });
	assert.equal(put.status, 405, "只接受 GET/POST");
	ok("方法：GET/POST 之外 405");
}

// ── ⑥ 前端接线 ──────────────────────────────────────────────────────────────
{
	const clientSrc = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
	assert.ok(clientSrc.includes('const TOOLBOX_API = "/api/team/toolbox"'), "客户端没有指向工具箱路由");
	assert.ok(clientSrc.includes("function ToolboxPage()"), "客户端缺工具箱面板组件");
	assert.ok(clientSrc.includes("function ToolboxButton()"), "客户端缺会话头入口按钮");
	assert.ok(clientSrc.includes("exports.ToolboxPage = ToolboxPage"), "工具箱面板要能被自检直接渲染");
	assert.ok(
		clientSrc.includes('id: TOOLBOX_PANEL_ID, order: 14'),
		"会话头入口没注册（或 order 与小队的 13 冲突）",
	);
	assert.ok(
		clientSrc.includes("armed === key"),
		"面板缺两段式确认（危险操作第一次点只该变成「确认？」）",
	);
	ok("前端：入口按钮 + 面板 + 两段式确认 + 可被自检渲染");
}

// —— REQ-034：两个编排模式按钮 ——
//
// 盯三件事：① 两个 op 在白名单里且 `args: null`（走进程内 switchSessionPreset，
// 不是 CLI —— CLI 那边没有切模式的命令）；② 服务端真的把 body 里的 sessionId
// 传进 runOp（拿不到就是「点了没反应」，那是最难查的失败形态）；
// ③ 前端 POST 里确实带了 sessionId。
{
	const { OPS } = await import("../lib/toolbox.js");
	for (const [opName, presetId] of [
		["mode.ralph", "ralph"],
		["mode.workflow", "workflow"],
	]) {
		const op = OPS[opName];
		assert.ok(op, `工具箱缺 ${opName}`);
		assert.equal(op.args, null, `${opName} 必须走进程内（args: null），CLI 没有切模式的子命令`);
		assert.ok(op.label && op.desc, `${opName} 要有 label 与 desc，否则面板上是空白按钮`);
		assert.ok(!op.danger, `${opName} 不该标 danger：它不改宿主文件，只是开个新会话`);
		assert.ok(presetId, "预设 id 映射不能空");
	}

	const src = fs.readFileSync(new URL("../lib/toolbox.js", import.meta.url), "utf8");
	assert.ok(
		src.includes("sessionId: String(body?.sessionId ?? \"\")"),
		"handler 没把 body.sessionId 传进 runOp —— 按钮会永远报「拿不到当前会话 id」",
	);
	assert.ok(
		src.includes("switchSessionPreset(deps.ctx, { sessionId, presetId })"),
		"mode.* 分支没调 switchSessionPreset（应复用 REQ-030 的换模式路径）",
	);

	const client = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	assert.ok(
		client.includes("JSON.stringify({ op, confirm: true, sessionId })"),
		"前端 POST 没带 sessionId",
	);
	// REQ-035：superagent 状态 op。它必须**不是** danger（只读），且在册。
	assert.ok(OPS["superagent.status"], "superagent.status 不在白名单里 —— 面板上就没有这个按钮");
	assert.ok(OPS["superagent.status"].danger !== true, "superagent.status 是只读的，不该标 danger（标了就要点两下）");
	ok("编排模式按钮：两个 op 在册、走进程内、sessionId 两端都传");
}

console.log(`\nselftest-toolbox：${passed} 项全过`);

// —— stage 分组接进面板：先「需要你处理」，再「在跑」——
//
// 只列 status 不够 —— 人看到 `done` / `failed` 还得自己想「那我要做什么」。
// 这条钉的是：面板输出里必须有 stage 的中文标签，且**需要人的排前面**。
{
	const src = fs.readFileSync(new URL("../lib/toolbox.js", import.meta.url), "utf8");
	// 它是动态 import（toolbox 里所有子系统都是按需加载，重东西不在模块顶层拉）
	assert.ok(src.includes('import("./superagent/stage.js")'), "toolbox 没引入 stage.js —— 分组代码会 ReferenceError");
	assert.ok(src.includes("groupByStage("), "toolbox 没调 groupByStage");
	// 顺序：person 先输出，working 后输出（人先看到该自己动手的）
	const personAt = src.indexOf("**需要你处理");
	const workingAt = src.indexOf("在跑 / 其它");
	assert.ok(personAt > 0 && workingAt > personAt, "面板要先列「需要你处理」再列「在跑」");
	assert.ok(!src.includes("`  · ${ticket.commentId}  ${ticket.status"), "旧的「只列 status」循环还留着");
	ok("面板：stage 分组接上了，需要人的排前面");
}
