#!/usr/bin/env node
/**
 * 自检：凭据保险库（REQ-037）能挂上，且默认是关的。
 *
 * 盯三件事：
 *   1. **默认关** —— 它会往 `$DSH_HOME` 写加密文件与主密钥，没明确同意不该建。
 *   2. **挂载时三样都挂上** —— `credential` 工具、系统提示段、HTTP 路由（8 条）。
 *      少挂一样，`use` 那条「只给环境变量名」的路就走不通，用户只能 reveal 明文。
 *   3. **缺服务时不炸** —— 上游是顶层 `inject`，缺 `webServer` 会让整个插件不激活；
 *      我们改成模块内 `ctx.inject`，缺服务只让保险库不激活、其余照常。
 *
 * 用假 ctx 就够：这一层验的是「有没有把上游 apply 接对」，不是加密本身
 * （那是上游 2724 行的事，它自己带 11 个测试文件）。
 */

import assert from "node:assert/strict";

import { installVault, VAULT_DEFAULTS, VAULT_FIELDS, TOOL_NAME } from "../lib/vault/index.js";

const tick = () => Promise.resolve();
let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

/** 造一个够用的假 scope：记录被调了什么。 */
function fakeScope() {
	const calls = { tool: [], section: [], route: [] };
	const scope = {
		systemPrompt: { section: (def) => (calls.section.push(def), () => {}) },
		tools: { register: (def) => (calls.tool.push(def), () => {}) },
		webServer: { register: (def) => (calls.route.push(def), () => {}) },
		effect: (fn) => fn(),
		on: () => {},
		get: () => undefined,
	};
	return { scope, calls };
}

/** 造一个假 ctx：`inject` 立刻回调（等价于「服务都在」）。 */
function fakeCtx({ servicesReady = true } = {}) {
	const { scope, calls } = fakeScope();
	return {
		calls,
		ctx: {
			inject: (_names, cb) => {
				if (servicesReady) cb(scope);
			},
			effect: (fn) => fn(),
			get: () => undefined,
			logger: { info: () => {} },
		},
	};
}

// —— 1. 默认关：不建 store、不碰磁盘 ——
assert.equal(VAULT_DEFAULTS.enabled, false, "保险库默认必须是关的（它会写加密文件与主密钥）");
{
	const { ctx, calls } = fakeCtx();
	const v = installVault(ctx, { config: {}, dshHome: () => "C:/tmp/fake" });
	assert.equal(v.state.activated, false, "关着的时候不该激活");
	assert.equal(calls.tool.length, 0, "关着的时候不该注册工具");
	assert.equal(calls.section.length, 0, "关着的时候不该注入提示段");
	ok("默认关：不激活、不注册、不注入");
}

// —— 2. 打开后三样都挂上 ——
{
	const { ctx, calls } = fakeCtx();
	const v = installVault(ctx, { config: { enabled: true }, dshHome: () => "C:/tmp/fake" });
	assert.equal(v.state.activated, true, "打开后要激活");
	assert.equal(calls.tool.length, 1, "要注册 1 个工具");
	assert.equal(calls.tool[0].name, TOOL_NAME, `工具名必须是 ${TOOL_NAME}`);
	assert.equal(calls.section.length, 1, "要注入 1 段系统提示");
	// 8 条 HTTP 路由：list / entry / audit / set / delete / rotate / export / import
	assert.equal(calls.route.length, 8, "要挂 8 条 HTTP 路由（管理面板要用）");
	assert.ok(
		calls.route.every((r) => r.kind === "exact"),
		"路由必须是 exact —— 上游注释里说 prefix 那种热重载后不可达",
	);
	ok("打开后：工具 + 提示段 + 8 条 exact 路由都挂上");
}

// —— 3. 缺服务时不炸（上游是顶层 inject，缺一个整个插件挂掉）——
{
	const { ctx, calls } = fakeCtx({ servicesReady: false });
	const v = installVault(ctx, { config: { enabled: true }, dshHome: () => "C:/tmp/fake" });
	assert.equal(v.state.activated, false, "服务没齐时不该标记激活");
	assert.equal(calls.tool.length, 0, "服务没齐时不该注册工具");
	// 关键是**没有抛** —— 抛了会连团队基线一起挂
	ok("缺服务时不抛，只让保险库不激活");
}

// —— 4. 配置模板里的键都有校验器 ——
{
	const fs = await import("node:fs");
	const path = await import("node:path");
	const tpl = JSON.parse(
		fs.readFileSync(path.join(import.meta.dirname, "..", "team", "extensions", "vault.json"), "utf8"),
	);
	const keys = Object.keys(tpl).filter((k) => !k.startsWith("_"));
	assert.ok(keys.length > 0, "配置模板不能是空的");
	for (const k of keys) {
		assert.ok(VAULT_FIELDS[k], `配置模板里的 "${k}" 没有校验器 —— 写成什么值都会被悄悄丢掉`);
		assert.ok(Object.hasOwn(VAULT_DEFAULTS, k), `配置模板里的 "${k}" 没有默认值`);
	}
	ok(`配置模板 ${keys.length} 个键都有校验器与默认值`);
}

// —— 5. 上游代码真的搬进来了（不是空壳）——
{
	const fs = await import("node:fs");
	const path = await import("node:path");
	const host = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "vault", "host.js"), "utf8");
	const files = fs.readdirSync(path.join(import.meta.dirname, "..", "lib", "vault", "lib"));
	assert.ok(host.includes("createVaultStore"), "host.js 没引到保险库存储");
	assert.ok(files.length >= 10, `lib/ 下只有 ${files.length} 个文件，上游是 13 个 —— 搬漏了`);
	assert.ok(
		!/^export const inject/m.test(host),
		"host.js 里不该再留**可执行**的顶层 inject（注释里提它是允许的）—— 那会让缺服务的 profile 整个插件不激活",
	);
	ok(`上游后端已搬入：host.js + lib/ 下 ${files.length} 个模块`);
}

void tick;
console.log(`\nselftest-vault：${passed} 项全过`);
