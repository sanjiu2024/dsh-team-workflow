#!/usr/bin/env node
/**
 * 独立包自检。
 *
 * 真实登录链没有自动化测试（要人授权 + 网络），手工验过前半段（真拿到设备码）。
 * 这里钉的是「不激活时不出事」「错误说得清」「守卫真的会撤掉没凭据的 provider」。
 */
import assert from "node:assert/strict";

import { CODEX_LOGIN_DEFAULTS, installCodexLogin, installProviderGuard } from "../lib/codex-login.js";
import { Config, apply, name, normalizeConfig } from "../index.js";

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`✓ ${label}`);
};

// ① 包名与默认值
assert.equal(name, "dsh-codex-login", "包名要对得上 cordis.patch.yml 里的 name");
assert.equal(CODEX_LOGIN_DEFAULTS.enabled, false, "默认必须关");

// ② 配置归一化：坏值退回默认，未知键丢掉
{
	const filled = normalizeConfig(undefined);
	assert.equal(filled.enabled, false, "空配置 = 默认");
	assert.equal(filled.providerKey, "llm-pi-ai/openai-codex", "默认 key 要和 dsh-llm-pi-ai 的 RECORD_SCOPE 拼得上");
	assert.equal(filled.guard, true, "守卫默认开");
	assert.equal(filled.settingsNamespace, "llm-pi-ai", "默认命名空间是 cordis entry id");

	const bad = normalizeConfig({ enabled: "yes", providerKey: "no-slash", method: "" });
	assert.equal(bad.enabled, false, "字符串 yes 不是布尔，退回默认");
	assert.equal(bad.providerKey, "llm-pi-ai/openai-codex", "没有 / 的 key 退回默认");
	assert.equal(bad.method, "oauth", "空 method 退回默认");

	const extra = normalizeConfig({ enabled: true, futureKey: 1 });
	assert.equal(extra.enabled, true, "合法值要过");
	assert.equal(Object.hasOwn(extra, "futureKey"), false, "未知键丢掉，不报错");

	assert.ok(Config.enabled && Config.providerKey && Config.method && Config.guard, "Config 四个键都在");
}

// ③ 关着的时候不注册任何路由
{
	const registered = [];
	const ctx = {
		inject() {},
		effect() {},
		on: () => () => {},
		logger: { info() {} },
		webServer: { register: (entry) => registered.push(entry.path) },
	};
	apply(ctx, { enabled: false });
	assert.deepEqual(registered, [], "关着的时候不该注册路由");
}

// ④ 开着但宿主没有 authorization：不炸，start 说清缺什么
{
	const ctx = { inject() {}, effect() {}, on: () => () => {}, logger: { info() {} }, webServer: { register() {} } };
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const result = inst.start();
	assert.equal(result.ok, false, "缺 authorization 必须判失败");
	assert.match(String(result.error), /authorization/, "错误里要点名缺哪个服务");
}

// ⑤ 有 authorization 但没注册 flow：错误指向 dsh-llm-pi-ai
{
	const ctx = {
		inject: (_s, cb) => cb({ authorization: { describe: () => undefined, begin() {}, cancel() {} } }),
		effect() {},
		on: () => () => {},
		logger: { info() {} },
		webServer: { register() {} },
	};
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const result = inst.start();
	assert.equal(result.ok, false, "没有 flow 必须判失败");
	assert.match(String(result.error), /dsh-llm-pi-ai/, "要指向真正的原因");
}

// ⑥ 有 flow：start 立刻返回 pending，设备码落到 state
{
	let notify = null;
	let finish = null;
	const ctx = {
		inject: (_s, cb) =>
			cb({
				authorization: {
					describe: () => ({ key: "llm-pi-ai/openai-codex", label: "ChatGPT (Codex)", methods: [{ id: "oauth" }] }),
					begin: (request) => {
						notify = request.interaction.notify;
						return new Promise((resolve) => {
							finish = resolve;
						});
					},
					cancel() {},
				},
			}),
		effect() {},
		on: () => () => {},
		logger: { info() {} },
		webServer: { register() {} },
	};
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const started = inst.start();
	assert.equal(started.ok, true, "有 flow 时 start 要成功");
	assert.equal(started.phase, "pending", "立刻返回 pending，不等授权");

	notify({ type: "device_code", userCode: "ABCD-12345", verificationUri: "https://auth.openai.com/codex/device" });
	assert.equal(inst.state.code, "ABCD-12345", "设备码要落到 state");
	assert.equal(inst.state.url, "https://auth.openai.com/codex/device", "链接也要落");
	assert.match(String(inst.start().note ?? ""), /已经在等/, "重复 start 要给提示，不重复起");

	finish({ status: "authorized" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(inst.state.phase, "authorized", "authorized 后 phase 要跟上");
}

// ⑦ 守卫：没凭据的 provider 写完之后必须被撤掉
//
// 这是「加渠道时必须先登录」的落点。dsh-settings 只发写入**之后**的事件
// （没有 before-write 钩子），所以是写完之后立刻 unset —— 列表里留不下，效果一样。
{
	const mutations = [];
	const logs = [];
	let stored = false;
	const settingsDoc = { providers: { "openai-codex": {}, tmy: {} } };
	let hook = null;

	const services = {
		settings: {
			get: () => settingsDoc,
			mutate: async (ns, ops) => {
				mutations.push({ ns, ops });
			},
		},
		credentials: {
			describe: () => (stored ? { kind: "grant" } : undefined),
			get: async () => (stored ? { kind: "grant" } : undefined),
		},
	};
	const ctx = {
		inject: (_services, cb) => cb(services),
		on: (event, fn) => {
			if (event === "settings/updated") hook = fn;
			return () => {};
		},
	};
	const dispose = installProviderGuard(ctx, {
		providerKey: "llm-pi-ai/openai-codex",
		settingsNamespace: "llm-pi-ai",
		log: (message) => logs.push(message),
	});
	assert.equal(typeof dispose, "function", "守卫要返回卸载函数");
	assert.equal(typeof hook, "function", "要挂上 settings/updated");

	// 没凭据 → 撤掉
	await hook("llm-pi-ai");
	assert.equal(mutations.length, 1, "没凭据时必须撤掉这个 provider");
	assert.deepEqual(mutations[0].ops, [{ op: "unset", path: ["providers", "openai-codex"] }], "撤掉的路径要对");
	assert.match(logs.join(" "), /OAuth-only/, "日志要说明为什么拒绝");

	// 有凭据 → 放过
	mutations.length = 0;
	stored = true;
	await hook("llm-pi-ai");
	assert.equal(mutations.length, 0, "有凭据时不该撤");

	// 别的命名空间 → 不碰
	stored = false;
	mutations.length = 0;
	await hook("other-ns");
	assert.equal(mutations.length, 0, "别的命名空间不该动");
}

ok("默认关、配置归一化、缺服务不炸、错误指向真因、start 不阻塞、守卫会撤掉没凭据的 provider");

console.log(`\ndsh-codex-login：${passed} 项全过`);
