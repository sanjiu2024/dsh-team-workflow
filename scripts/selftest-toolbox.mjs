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
const { installToolbox, OPS, TOOLBOX_ROUTE } = await import("../lib/toolbox.js");

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

console.log(`\nselftest-toolbox：${passed} 项全过`);
