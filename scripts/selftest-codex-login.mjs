#!/usr/bin/env node
/**
 * codex-login 自检：默认关、配置键有校验器、缺服务不炸、错误说得清。
 *
 * 这个子系统**没有真实登录可测**（要人授权 + 网络），所以这里只钉「不激活时不出事」
 * 和「激活但缺前置时给的是能看懂的话」。真实登录链在 `scripts/codex-login.mjs` 里手工验过
 * 前半段（真拿到设备码），见 CHANGELOG 2.53.0 的验证记录。
 */
import assert from "node:assert/strict";

let passed = 0;
const ok = (name) => {
	passed += 1;
	console.log(`✓ ${name}`);
};

const { CODEX_LOGIN_DEFAULTS, CODEX_LOGIN_FIELDS, installCodexLogin, activeCodexLogin, CODEX_LOGIN_ROUTE } =
	await import("../lib/codex-login/index.js");

// ① 默认关 —— 和 vault / superagent 一致：装上不等于打开
assert.equal(CODEX_LOGIN_DEFAULTS.enabled, false, "默认必须关");
assert.equal(CODEX_LOGIN_DEFAULTS.providerKey, "llm-pi-ai/openai-codex", "默认 key 要和 dsh-llm-pi-ai 的 RECORD_SCOPE 拼得上");
assert.equal(CODEX_LOGIN_DEFAULTS.method, "oauth", "dsh-llm-pi-ai 只注册 oauth 一个方法");

// ② 每个键都有校验器，坏值一律拒
for (const key of Object.keys(CODEX_LOGIN_DEFAULTS)) {
	assert.equal(typeof CODEX_LOGIN_FIELDS[key], "function", `配置键 ${key} 没有校验器`);
}
assert.equal(CODEX_LOGIN_FIELDS.enabled("true"), undefined, "字符串 true 不是布尔");
assert.equal(CODEX_LOGIN_FIELDS.providerKey("no-slash"), undefined, "key 必须带 / （record 名是 scope/id）");
assert.equal(CODEX_LOGIN_FIELDS.providerKey("llm-pi-ai/openai-codex"), "llm-pi-ai/openai-codex", "合法 key 要过");
assert.equal(CODEX_LOGIN_FIELDS.method(""), undefined, "空 method 要拒");

// ③ 关着的时候：不注册路由、不登记单例、describe 说明白为什么关
{
	const registered = [];
	const ctx = {
		inject() {},
		effect() {},
		webServer: { register: (entry) => registered.push(entry.path) },
	};
	const inst = installCodexLogin(ctx, { config: { enabled: false } });
	assert.deepEqual(registered, [], "关着的时候不该注册任何路由");
	assert.match(inst.describe(), /关闭/, "describe 要说清是关闭状态");
	assert.equal(inst.state.phase, "idle", "没跑过就是 idle");
}

// ④ 开着但宿主没有 authorization 服务：不炸，start 给明确错误
{
	activeCodexLogin(); // 清一下（上一个用例没登记）
	const ctx = { inject() {}, effect() {}, webServer: { register() {} } };
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const result = inst.start();
	assert.equal(result.ok, false, "缺 authorization 时必须判失败");
	assert.match(String(result.error), /authorization/, "错误里要点名缺哪个服务 —— 否则人不知道去查什么");
	inst.dispose();
}

// ⑤ 开着、有 authorization 但没注册对应 flow：说清是「dsh-llm-pi-ai 没挂」
{
	const ctx = {
		inject: (_services, cb) => cb({ authorization: { describe: () => undefined, begin: () => {}, cancel: () => {} } }),
		effect: () => {},
		webServer: { register() {} },
	};
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const result = inst.start();
	assert.equal(result.ok, false, "没有 flow 时必须判失败");
	assert.match(String(result.error), /dsh-llm-pi-ai/, "错误要指向真正的原因（provider 没注册 flow）");
	inst.dispose();
}

// ⑥ 有 flow 时：start 立刻返回（不等授权），并把设备码留在 state 上
{
	let notify = null;
	let beginResolve = null;
	const fakeAuthorization = {
		describe: () => ({ key: "llm-pi-ai/openai-codex", label: "ChatGPT (Codex)", methods: [{ id: "oauth" }] }),
		begin: (request) => {
			notify = request.interaction.notify;
			return new Promise((resolve) => { beginResolve = resolve; });
		},
		cancel: () => {},
	};
	const ctx = {
		inject: (_services, cb) => cb({ authorization: fakeAuthorization }),
		effect: () => {},
		webServer: { register() {} },
	};
	const inst = installCodexLogin(ctx, { config: { enabled: true } });
	const started = inst.start();
	assert.equal(started.ok, true, "有 flow 时 start 要成功");
	assert.equal(started.phase, "pending", "立刻返回 pending，不等授权");
	assert.equal(typeof notify, "function", "要真的把 interaction.notify 交给 flow");

	// 模拟 pi-ai 发设备码
	notify({ type: "device_code", userCode: "ABCD-12345", verificationUri: "https://auth.openai.com/codex/device", expiresInSeconds: 900 });
	assert.equal(inst.state.code, "ABCD-12345", "设备码要留在 state 上给前端读");
	assert.equal(inst.state.url, "https://auth.openai.com/codex/device", "链接也要留");

	// 重复 start 不该再起一次
	const again = inst.start();
	assert.match(String(again.note ?? ""), /已经在等/, "重复点要提示，不是默默起第二个");

	// 授权完成
	beginResolve({ status: "authorized" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(inst.state.phase, "authorized", "流程返回 authorized 后 phase 要跟上");
	inst.dispose();
}

// ⑦ 路由常量是三条 exact
assert.equal(CODEX_LOGIN_ROUTE, "/codex-login", "路由前缀固定");
ok("codex-login：默认关、校验器齐、缺服务不炸、错误指向真因、start 不阻塞");

console.log(`\nselftest-codex-login：${passed} 项全过`);
