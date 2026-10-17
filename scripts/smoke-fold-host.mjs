#!/usr/bin/env node
/**
 * 集成冒烟：**真宿主代码 + 真会话数据**，把折叠后端的压缩事务整个跑一遍。
 *
 * 用真的：`BasicCompactionEngine`（真基类）、真 cordis 上下文、真 `TokenMeter`（真 `measure`）、
 * 真 `SessionStore`（真 Session，事件从**本机真实会话日志**回放）、真 `SessionProjectionRegistry`。
 * 所以它证明的是：
 *
 *   - `ctx.loader.import` 真能在 profile 里解析到 `@deepseek-ai/dsh-compaction-basic`
 *   - 服务名 `compaction` 真注册得上、config 真过 basic 的 schema、确实是它的子类
 *   - `compactNow` 真能压：真区间选择、真尺寸闸、真 checkpoint 落进 surface —— **不抛**
 *   - **一次模型都没调**（`llm.stream()` 计数为 0）
 *
 * 为什么还不是端到端：真正的端到端要切 `compactionBackend: "fold"` + `preset install` + **重启 dsh**
 * 再让真实会话自然触发压缩 —— 而 dsh 就是跑这个脚本的宿主，重启等于把会话杀掉。这里止步于
 * 「dsh 启动时把这一行换成折叠后端」之前的一切；那一行由 `selftest-preset-gen.mjs` 钉着。
 *
 * 不进 `npm test`：它依赖本机 dsh 安装树（`~/.dsh/profiles/*`）和本机会话日志，是环境相关验证。
 *
 *   node scripts/smoke-fold-host.mjs [会话id]
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readSessionLog } from "../lib/session-log.js";

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

/** 挑一份真实会话日志：≥200KB 里最小的那份（够压、又跑得动）；给了会话 id 就直接用它。 */
function pickSessionLog(wanted) {
	const root = join(homedir(), ".dsh", "sessions");
	if (!existsSync(root)) return null;
	let best = null;
	for (const slug of readdirSync(root)) {
		for (const id of readdirSync(join(root, slug))) {
			const file = join(root, slug, id, "session.v4.jsonl.zstd");
			if (!existsSync(file)) continue;
			if (wanted && !file.includes(wanted) && id !== wanted) continue;
			const { events } = readSessionLog(file);
			const size = JSON.stringify(events).length;
			if (wanted) return { file, events, id, size };
			if (size < 200_000) continue;
			if (!best || size < best.size) best = { file, events, id, size };
		}
	}
	return best;
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
	const { SessionProjectionRegistry } = await import(from("@deepseek-ai/dsh-session-projection/lib/index.js"));
	const { TokenMeter } = await import(from("@deepseek-ai/dsh-token-meter/lib/index.js"));
	const { SessionStore } = await import(from("@deepseek-ai/dsh-session/lib/index.js"));

	// —— 真服务栈：tokenMeter 要 sessionProjections；sessions 是内存 store（文档明说持久化不在这里）——
	const ctx = new Context();
	new SessionProjectionRegistry(ctx);
	new TokenMeter(ctx);
	const store = new SessionStore(ctx);
	let llmCalls = 0;
	class Loader extends Service {
		constructor(c) {
			super(c, "loader");
			// 宿主对 `@deepseek-ai/*` 就是这么解析的（从 checkout 找）—— 照做，于是「基类真加载得到」也被验了。
			this.import = async (name) => import(from(`${name}/lib/index.js`));
		}
	}
	class Llm extends Service {
		constructor(c) {
			super(c, "llm");
			// 折叠后端**不该**碰它 —— 只记账，真被调就是 bug。
			this.stream = async () => {
				llmCalls += 1;
				throw new Error("折叠后端不该调 llm.stream()");
			};
			// 真 TokenMeter 会问它图片计价（没配 = undefined → 走固定启发式）。
			this.imageRequestPricing = () => undefined;
		}
	}
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

		// —— 真会话：把本机真实日志回放成真 Session ——
		// `readSessionLog().events[0]` 是 **header**（`type: "session"`），而 store 自己会建 header，
		// 所以 seed 用 `slice(1)`：不切会被 `assertSessionEventEnvelope` 拒（信封只认
		// type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable）。
		const picked = pickSessionLog(process.argv[2]);
		if (!picked) {
			console.error("✗ 找不到可用的真实会话日志（~/.dsh/sessions/**/session.v4.jsonl.zstd）");
			process.exitCode = 1;
		} else {
			console.log(
				`\n真会话：${picked.id} · ${picked.events.length} 条事件 · ${(picked.size / 1024).toFixed(0)} KB（${picked.file.replace(homedir(), "~")}）`,
			);
			const session = store.create("smoke-fold-host", {
				seed: picked.events.slice(1),
				meta: { cwd: process.cwd() },
			});
			const before = ctx.tokenMeter.measure(session);
			console.log(`回放后 surface：${session.surface.nodes.length} 个节点 · ${before.surfaceTokens} tokens`);

			// —— 真事务：真区间选择 + 真尺寸闸 + 真 checkpoint ——
			const signal = new AbortController().signal;
			const agent = { session, runMaintenance: async (fn) => fn(signal) };
			let result = null;
			let threw = null;
			try {
				result = await engine.compactNow(agent, signal);
			} catch (error) {
				threw = error;
			}
			const after = ctx.tokenMeter.measure(session);
			console.log(`\ncompactNow：${threw ? `✗ 抛了 ${threw.constructor?.name}: ${threw.message}` : "没抛 ✓"}`);
			if (result) {
				console.log(
					`  压掉 seq ${result.startSeq}..${result.endSeq}（${result.shadowedSeqs.length} 个节点 / ${result.shadowedTokenCount} tokens）`,
				);
			}
			console.log(`  surface：${session.surface.nodes.length} 个节点 · ${after.surfaceTokens} tokens`);
			console.log(`llm.stream() 被调次数：${llmCalls}（必须是 0）`);

			// checkpoint 真在 surface 上吗？（`surface.nodes` 是 **SessionSeq[]** —— 一串序号，不是对象数组）
			const blocks = Array.isArray(result?.summary) ? result.summary : [];
			const text = blocks.map((b) => b.text ?? "").join("");
			const nodes = [...session.surface.nodes];
			const checkpointSeq = nodes.find((seq) => {
				const event = session.eventAt(seq);
				if (event?.type !== "user/message") return false;
				const content = event.data?.content;
				const body = Array.isArray(content) ? content.map((b) => b.text ?? "").join("") : String(content ?? "");
				return body.includes("<compacted-summary>");
			});
			console.log(`产物是块数组：${blocks.length > 0 && blocks.every((b) => b.type === "text") ? "是 ✓" : "否 ✗"}`);
			console.log(
				`surface 上有带标签的 checkpoint：${checkpointSeq === undefined ? "没有 ✗" : `seq=${checkpointSeq} ✓`}`,
			);
			console.log(`产物体积：${text.length} 字符 / 被压 ${result?.shadowedTokenCount ?? 0} tokens`);
			console.log("\n--- 产物开头 300 字符 ---");
			console.log(text.slice(0, 300));

			const ok =
				engine instanceof BasicCompactionEngine &&
				engine.summarize !== BasicCompactionEngine.prototype.summarize &&
				threw === null &&
				result !== null &&
				result.shadowedTokenCount > 0 &&
				llmCalls === 0 &&
				checkpointSeq !== undefined &&
				after.surfaceTokens < before.surfaceTokens;
			console.log(
				ok
					? "\n✓ 真事务冒烟通过（真基类 + 真 cordis + 真会话回放 + 真压缩；dsh 启动时换后端那一步由 preset 自检钉着）"
					: "\n✗ 真事务冒烟未通过（见上面几行）",
			);
			if (!ok) process.exitCode = 1;
		}
	}
}
