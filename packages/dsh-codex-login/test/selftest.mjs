#!/usr/bin/env node
/**
 * 独立包自检：默认关、配置校验、缺服务不炸、start 不阻塞。
 *
 * 真实登录链没有自动化测试（要人授权 + 网络），手工验过前半段（真拿到设备码）。
 */
import assert from "node:assert/strict";
import { CODEX_LOGIN_DEFAULTS, installCodexLogin } from "../lib/codex-login.js";
import { Config, apply, normalizeConfig, name } from "../index.js";

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`✓ ${label}`);
};

assert.equal(name, "dsh-codex-login", "包名要对得上 cordis.patch.yml 里的 name");
assert.equal(CODEX_LOGIN_DEFAULTS.enabled, false, "默认必须关");

// ① 配置归一化：坏值退回默认，未知键丢掉
{
	const filled = normalizeConfig(undefined);
	assert.equal(filled.enabled, false, "空配置 = 默认");
	assert.equal(filled.providerKey, "llm-pi-ai/openai-codex", "默认 key 要和 dsh-llm-pi-ai 的 RECORD_SCOPE 拼得上");
	const bad = normalizeConfig({ enabled: "yes", providerKey: "no-slash", method: "" });
	assert.equal(bad.enabled, false, "字符串 yes 不是布尔，退回默认");
	assert.equal(bad.providerKey, "llm-pi-ai/openai-codex", "没有 / 的 key 退回默认");
	assert.equal(bad.method, "oauth", "空 method 退回默认");
	const extra = normalizeConfig({ enabled: true, futureKey: 1 });
	assert.equal(extra.enabled, true, "合法值要过");
	assert.equal(Object.hasOwn(extra, "futureKey"), false, "未知键丢掉，不报错");
	assert.ok(Config.enabled && Config.providerKey && Config.method, "Config 三个键都在");
}

// ② 关着的时候不注册任何路由
{
	const registered = [];
	const ctx = {
		inject() {},
		effect() {},
		logger: { info() {} },
		webServer: { register: (entry) => registered.push(entry.path) },
	};
	apply(ctx, { enabled: false });
	assert.deepEqual(registered, [], "关着的时候不该注册路由");
}

// ③ 开着但宿主没有 authorization：不炸，start 说清缺什么
{
	const ctx = { inject() {}, effect() {}, logger: { info() {} }, webServer: { register() {} } };
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const result = inst.start();
	assert.equal(result.ok, false, "缺 authorization 必须判失败");
	assert.match(String(result.error), /authorization/, "错误里要点名缺哪个服务");
}

// ④ 有 authorization 但没注册 flow：错误指向 dsh-llm-pi-ai
{
	const ctx = {
		inject: (_s, cb) => cb({ authorization: { describe: () => undefined, begin() {}, cancel() {} } }),
		effect() {},
		logger: { info() {} },
		webServer: { register() {} },
	};
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const result = inst.start();
	assert.equal(result.ok, false, "没有 flow 必须判失败");
	assert.match(String(result.error), /dsh-llm-pi-ai/, "要指向真正的原因");
}

// ⑤ 有 flow：start 立刻返回 pending，设备码落到 state
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

ok("默认关、配置归一化、缺服务不炸、错误指向真因、start 不阻塞");

console.log(`\ndsh-codex-login：${passed} 项全过`);
