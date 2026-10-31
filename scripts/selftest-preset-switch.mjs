#!/usr/bin/env node
/**
 * REQ-030 自检：会话级「换模式」（换模式并继续）。
 *
 * 钉住四件事：
 *   ① 交接文本只搬**请求与结论**，不搬整份 transcript（搬全量等于 token 翻倍）；
 *   ② 已开始的会话不去碰 `agentPresets.select`（宿主会抛 agent-preset/locked）——
 *      走的是 `create({ agentPreset })` 这条唯一合法路；
 *   ③ 交接**预填**进新会话输入框，不自动发送；
 *   ④ 旧会话要归档，且归档失败不挡新会话使用。
 *
 * 跑法：`node scripts/selftest-preset-switch.mjs`
 */
import assert from "node:assert/strict";

const { buildHandoff, listPresets, switchSessionPreset, currentPresetOf } = await import("../lib/preset-switch.js");
const rewind = await import("../lib/purge/rewind.js");

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`✓ ${label}`);
};

// ── 假事件（形状照真实会话事件：type + data.content 块）─────────────────────
const userEvent = (text, seq, source = { kind: "user" }) => ({
	seq,
	type: "user/message",
	data: { content: [{ type: "text", text }], source },
});
const agentEvent = (text, seq) => ({
	seq,
	type: "assistant/message",
	data: { content: [{ type: "text", text }] },
});
const toolEvent = (seq) => ({ seq, type: "tool/call", data: { name: "bash" } });

const events = [
	userEvent("先把登录页的 XSS 验一下", 0),
	agentEvent("收到，先看反射点。", 1),
	toolEvent(2),
	userEvent("插件注入的润色稿", 3, { kind: "plugin" }),
	userEvent("再看一下越权", 4),
	agentEvent("越权接口 /api/users 未鉴权，已记录。", 5),
];

// ── ① 交接文本 ──────────────────────────────────────────────────────────────
{
	const text = buildHandoff({
		events,
		fromPreset: "team",
		toPreset: "shadow",
		sourceSessionId: "session-abc",
	});
	assert.ok(text.includes("先把登录页的 XSS 验一下"), "最近请求没进交接");
	assert.ok(text.includes("再看一下越权"), "第二条请求没进交接");
	assert.ok(text.includes("越权接口 /api/users 未鉴权"), "上一步结论没进交接");
	assert.ok(!text.includes("插件注入的润色稿"), "插件注入的稿子不该当成用户请求");
	assert.ok(text.includes("team → shadow"), "模式迁移没写进去");
	assert.ok(text.includes("session-abc"), "来源会话没写进去");
	assert.ok(!text.includes("tool/call"), "工具调用不该进交接（交接要的是请求与结论）");
	ok("交接：只搬请求与结论，插件稿与工具调用被排除");

	const long = buildHandoff({
		events: [userEvent("x".repeat(5000), 0)],
		fromPreset: "a",
		toPreset: "b",
		sourceSessionId: "s",
	});
	assert.ok(long.includes("已截断"), "超长请求没截断（会把新会话第一条消息撑爆）");
	ok("交接：超长请求截断并注明");

	const many = Array.from({ length: 20 }, (_, i) => userEvent(`请求${i}`, i * 2));
	const trimmed = buildHandoff({ events: many, fromPreset: "a", toPreset: "b", sourceSessionId: "s" });
	assert.ok(trimmed.includes("请求19"), "最近的请求应该在");
	assert.ok(!trimmed.includes("请求0\n"), "太老的请求不该进交接（默认只带最近 6 条）");
	ok("交接：只带最近几条，不带全量历史");
}

// ── 假 ctx ─────────────────────────────────────────────────────────────────
function fakeCtx({ presetId = "team", createSessionId = "session-new", archiveThrows = false } = {}) {
	const calls = { create: [], archive: [], select: 0 };
	const presets = {
		async list() {
			return [
				{ config: { id: "team", name: "团队模式", description: "团队基线 + 红队" } },
				{ config: { id: "redteam", name: "红队模式", description: "窄版红队" } },
			];
		},
		async resolve(id) {
			if (id !== "team" && id !== "redteam") throw new Error(`unknown preset: ${id}`);
			return { id };
		},
		async select() {
			calls.select += 1;
			throw new Error("agent-preset/locked: This session has already started");
		},
	};
	const controller = {
		async inspect() {
			return { workspaceId: "ws-1", cwd: "C:/work", agentPreset: presetId };
		},
		async create(request) {
			calls.create.push(request);
			return { sessionId: createSessionId, agentPreset: request.agentPreset };
		},
	};
	const registry = {
		async archiveSession(sessionId) {
			if (archiveThrows) throw new Error("archive failed");
			calls.archive.push(sessionId);
		},
		async get() {
			return null;
		},
	};
	const ctx = {
		get(name) {
			if (name === "agentPresets") return presets;
			if (name === "sessionController") return controller;
			if (name === "workspaceRegistry") return registry;
			if (name === "workspaces") return registry;
			if (name === "sessions") {
				return {
					get: (id) => (id === "session-old"
						? { snapshotEvents: () => events, header: { cwd: "C:/work" } }
						: undefined),
				};
			}
			return undefined;
		},
	};
	return { ctx, calls };
}

// ── ② 换模式主流程 ─────────────────────────────────────────────────────────
{
	const { ctx, calls } = fakeCtx();
	const result = await switchSessionPreset(ctx, { sessionId: "session-old", presetId: "redteam" });
	assert.equal(result.ok, true, result.error);
	assert.equal(result.preset, "redteam", "新会话没拿到目标模式");
	assert.equal(result.sessionId, "session-new");
	assert.equal(calls.select, 0, "已开始的会话不该去调 select（宿主会抛 locked）");
	assert.equal(calls.create.length, 1, "应该只建一个新会话");
	assert.equal(calls.create[0].agentPreset, "redteam", "create 没带 agentPreset（那就白建了）");
	assert.equal(calls.create[0].workspaceId, "ws-1", "新会话该落在同一个工作区");
	assert.deepEqual(calls.archive, ["session-old"], "旧会话该被归档");
	assert.equal(result.archived, true);
	ok("换模式：新建带 preset 的会话 + 归档旧会话，且不碰 select");

	// 预填：草稿挂在新会话上，文本就是交接
	const draft = rewind.getDraft("session-new");
	assert.ok(draft, "交接没有预填到新会话（用户切过去会看到空输入框）");
	assert.ok(draft.text.includes("再看一下越权"), "预填的不是交接文本");
	ok("换模式：交接预填进新会话输入框（不自动发送）");
}

// ── ③ 边界 ─────────────────────────────────────────────────────────────────
{
	const { ctx } = fakeCtx();
	const same = await switchSessionPreset(ctx, { sessionId: "session-old", presetId: "team" });
	assert.equal(same.ok, false);
	assert.match(same.error, /已经是/, "同模式应该直说不用换");

	const unknown = await switchSessionPreset(ctx, { sessionId: "session-old", presetId: "nope" });
	assert.equal(unknown.ok, false);
	assert.match(unknown.error, /不存在/, "未知模式要说清");

	const noSession = await switchSessionPreset(ctx, { presetId: "redteam" });
	assert.equal(noSession.ok, false);
	assert.match(noSession.error, /没有当前会话/);

	const noPreset = await switchSessionPreset(ctx, { sessionId: "session-old" });
	assert.equal(noPreset.ok, false);
	assert.match(noPreset.error, /没有指定模式/);
	ok("边界：同模式 / 未知模式 / 缺会话 / 缺模式 id 各有明确理由");
}

// ── ④ 归档失败不挡新会话 ────────────────────────────────────────────────────
{
	const { ctx } = fakeCtx({ archiveThrows: true });
	const result = await switchSessionPreset(ctx, { sessionId: "session-old", presetId: "redteam" });
	assert.equal(result.ok, true, "归档失败不该让换模式失败");
	assert.equal(result.archived, false);
	ok("归档失败：新会话照样可用（旧会话留在列表里）");
}

// ── ⑤ 服务缺失 / 列表 / 当前模式 ────────────────────────────────────────────
{
	const empty = { get: () => undefined };
	assert.equal((await listPresets(empty)).length, 0, "没有预设服务时该返回空数组而不是抛");
	assert.equal((await switchSessionPreset(empty, { sessionId: "s", presetId: "x" })).ok, false);
	assert.equal(await currentPresetOf(empty, "s"), "", "读不到当前模式该返回空串");

	const { ctx } = fakeCtx();
	const rows = await listPresets(ctx);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].id, "team");
	assert.equal(await currentPresetOf(ctx, "session-old"), "team");
	ok("服务缺失安全降级；列表与「当前模式」读得出来");
}

console.log(`\nselftest-preset-switch：${passed} 项全过`);
