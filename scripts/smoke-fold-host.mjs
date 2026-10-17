#!/usr/bin/env node
/**
 * 集成冒烟：用**真的** `BasicCompactionEngine` + **真的** cordis 上下文，验证折叠后端的装配与
 * 「不调模型」。
 *
 * 为什么需要它：`selftest-compaction-fold.mjs` 用的是**假基类** —— 它证明不了
 * 「`ctx.loader.import` 真能在 profile 里解析到 `@deepseek-ai/dsh-compaction-basic`」
 * 「服务名 `compaction` 真注册得上」「basic 的 config schema 真接受预设里那几个键」。
 * 这三条以前只有静态依据。这个脚本把它们跑成事实。
 *
 * 为什么还不是端到端：真正的端到端要切 `compactionBackend: "fold"` + `preset install` + **重启 dsh**
 * 再压一次 —— 而 dsh 就是跑这个脚本的宿主，重启等于把会话杀掉。所以这里止步于
 * 「后端装得上、覆写生效、不调模型」，端到端仍要人工冒烟（REQ-018 §8 写了步骤）。
 *
 * 不进 `npm test`：它依赖本机 dsh 安装树（`~/.dsh/profiles/*`），是环境相关的一次性验证。
 *
 *   node scripts/smoke-fold-host.mjs
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * 找两个解析根 —— 它们**不是同一个**：
 * - **宿主的包**（`@deepseek-ai/*`）在 npx checkout 里（`~/.npm/_npx/<hash>/node_modules`）；
 * - **本包**在 profile 的 `node_modules` 里（`~/.dsh/profiles/<name>/node_modules`，symlink）。
 * 所以脚本分别按各自的方式解析：宿主的包从 checkout 绝对路径进，本包按裸标识符从 profile 解析
 * （这才验得到 `exports` 子路径）。
 */
function findRoots() {
	const profiles = join(homedir(), ".dsh", "profiles");
	let profile;
	if (existsSync(profiles)) {
		for (const name of readdirSync(profiles)) {
			const modules = join(profiles, name, "node_modules");
			if (existsSync(join(modules, "dsh-team-workflow"))) profile = { name, modules };
		}
	}
	const npx = join(homedir(), ".npm", "_npx");
	let checkout;
	if (existsSync(npx)) {
		for (const hash of readdirSync(npx)) {
			const modules = join(npx, hash, "node_modules");
			if (existsSync(join(modules, "@deepseek-ai", "cordis"))) checkout = modules;
		}
	}
	return { profile, checkout };
}

const { profile, checkout } = findRoots();
if (!profile || !checkout) {
	console.error(
		`缺东西：profile=${profile ? "有" : "没找到（先 dsh-team install）"} · checkout=${checkout ? "有" : "没找到（~/.npm/_npx/*/node_modules/@deepseek-ai/cordis）"}`,
	);
	process.exitCode = 1;
} else {
	console.log(`宿主 profile：${profile.name} · 宿主包：${checkout.replace(homedir(), "~")}`);
	const from = (spec) => pathToFileURL(join(checkout, spec)).href;
	const { Context, Service } = await import(from("@deepseek-ai/cordis/lib/index.js"));
	const { BasicCompactionEngine } = await import(from("@deepseek-ai/dsh-compaction-basic/lib/index.js"));
	// 宿主的计量函数在 `./estimate` **exports 子路径**上（package.json 里写着）—— 子路径不是文件路径，
	// 得按裸标识符从 checkout 解析（`from()` 是拼文件路径的，对子路径不适用）。
	const checkoutRequire = createRequire(join(checkout, "noop.js"));
	const meterMod = await import(pathToFileURL(checkoutRequire.resolve("@deepseek-ai/dsh-token-meter/estimate")).href).catch(
		() => null,
	);
	const estimateMessage = meterMod?.estimateMessage ?? meterMod?.default ?? undefined;

	console.log(`BasicCompactionEngine：${typeof BasicCompactionEngine === "function" ? "拿到 ✓" : "没拿到 ✗"}`);
	console.log(`tokenMeter.estimateMessage：${typeof estimateMessage === "function" ? "拿到 ✓（用宿主同一把尺）" : "没导出（退回字符估）"}`);

	// —— 搭一个真 cordis 上下文，把引擎 inject 的三个服务都放进去 ——
	const ctx = new Context();
	let llmCalls = 0;
	class Meter extends Service {
		constructor(c) {
			super(c, "tokenMeter");
			this.estimateMessage = (message) => {
				if (typeof estimateMessage === "function") return estimateMessage(message);
				const content = message?.content;
				const text = typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("");
				return Math.ceil(text.length / 4);
			};
		}
	}
	class Sessions extends Service {
		constructor(c) {
			super(c, "sessions");
		}
	}
	class Loader extends Service {
		constructor(c) {
			super(c, "loader");
			// 宿主对 `@deepseek-ai/*` 就是这么解析的（从 checkout 找）—— 这里照做，
			// 于是这个冒烟同时验了「基类能不能真加载到」。
			this.import = async (name) => import(from(`${name}/lib/index.js`));
		}
	}
	class Llm extends Service {
		constructor(c) {
			super(c, "llm");
			// 折叠后端**不该**碰它 —— 所以这里只记账，真被调就是 bug。
			this.stream = async () => {
				llmCalls += 1;
				throw new Error("折叠后端不该调 llm.stream()");
			};
		}
	}
	new Meter(ctx);
	new Sessions(ctx);
	new Loader(ctx);
	new Llm(ctx);

	// —— 按预设里的形状注册折叠后端（config 用团队预设会写的那几个键）——
	// **按宿主的方式解析**：从 profile 出发解析裸标识符（宿主加载器就是这么干的，
	// `cordis-plugin-loader:223` 是裸 `import()`）。这样才真的验到 `exports` 子路径。
	const require = createRequire(join(profile.modules, "noop.js"));
	let fold = null;
	try {
		fold = await import(pathToFileURL(require.resolve("dsh-team-workflow/compaction-fold")).href);
	} catch (error) {
		console.error(`✗ 解析 dsh-team-workflow/compaction-fold 失败：${error?.message ?? error}`);
	}
	if (!fold) {
		console.error("✗ 加载不到 dsh-team-workflow/compaction-fold —— exports 子路径或安装有问题");
		process.exitCode = 1;
	} else {
		const config = { thresholdRatio: 0.25, retainRatio: 0.1, auto: true };
		await ctx.plugin({ name: fold.name, inject: fold.inject, apply: fold.apply }, config);
		const engine = ctx.get("compaction");
		console.log(`服务 compaction：${engine ? "注册上了 ✓" : "没有 ✗"}`);
		console.log(`是不是 basic 的子类：${engine instanceof BasicCompactionEngine ? "是 ✓" : "不是 ✗"}`);
		console.log(
			`summarize 被覆写：${engine && engine.summarize !== BasicCompactionEngine.prototype.summarize ? "是 ✓" : "否 ✗"}`,
		);
		console.log(`config 被 schema 接受：${engine ? `是 ✓（auto=${engine.config?.auto}）` : "否 ✗"}`);

		const long = (n, ch) => ch.repeat(n);
		const messages = [
			{ role: "user", content: [{ type: "text", text: "请修 A、B、C 三处" }] },
			{ role: "tool", content: [{ type: "text", text: long(8000, "t") }] },
			{ role: "assistant", content: [{ type: "text", text: `结论 ${long(4000, "a")}` }] },
			{ role: "tool", content: [{ type: "text", text: long(8000, "u") }] },
		];
		const result = await engine.summarize({ messages }, { id: "smoke" }, undefined);
		const text = result?.summary?.[0]?.text ?? "";
		const inputChars = messages.reduce((n, m) => n + m.content[0].text.length, 0);
		console.log(`\nsummarize 产物：${text.length} 字符 / 输入 ${inputChars} 字符（${((text.length / inputChars) * 100).toFixed(1)}%）`);
		console.log(`provider/model：${JSON.stringify(result?.provider)}/${JSON.stringify(result?.model)}`);
		console.log(`llmStreamCall：${result?.llmStreamCall === undefined ? "没打（未标记支 ✓）" : "打了 ✗"}`);
		console.log(`llm.stream() 被调次数：${llmCalls}（必须是 0）`);
		console.log("\n--- 产物开头 400 字符 ---");
		console.log(text.slice(0, 400));

		const ok =
			engine instanceof BasicCompactionEngine &&
			engine.summarize !== BasicCompactionEngine.prototype.summarize &&
			llmCalls === 0 &&
			text.length > 0 &&
			text.length < inputChars &&
			result?.llmStreamCall === undefined;
		console.log(ok ? "\n✓ 集成冒烟通过（真基类 + 真 cordis；端到端仍需重启后人工压一次）" : "\n✗ 集成冒烟未通过（见上面几行）");
		if (!ok) process.exitCode = 1;
	}
}
