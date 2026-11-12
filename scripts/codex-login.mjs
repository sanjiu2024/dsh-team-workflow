#!/usr/bin/env node
/**
 * 用 ChatGPT 账号登录，把 OAuth 凭据写进 dsh 的 credentials。
 *
 * ## 为什么需要这个脚本
 *
 * dsh 0.2.2-rc.1 **原生支持** `openai-codex`：pi-ai 的 catalog 里有这个 provider
 * （`env: []`，`baseURL: https://chatgpt.com/backend-api`），OAuth 实现也完整
 * （`loginOpenAICodex` 浏览器回调 1455 / `loginOpenAICodexDeviceCode` 设备码），
 * `dsh-llm-pi-ai` 还**无条件**给每个 provider 注册了 `ctx.authorization.registerFlow`
 * （注释原话："Registration is unconditional on configuration"）。
 *
 * **但没有任何 UI 消费它** —— `authorization.list()` 全树零调用方；模型设置页里
 * `authorization` 出现 0 次，只能填 API key 与 baseURL；账号页是 DeepSeek 账号的
 * 引导步骤（`step: done`）。所以人有能力、没入口。
 *
 * 这个脚本补的就是那个入口：跑一次设备码登录，把凭据落到
 * `~/.dsh/.credentials.yaml` 的 `llm-pi-ai/openai-codex` 记录里。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/codex-login.mjs          # 设备码登录（推荐：不用占 1455 端口）
 * node scripts/codex-login.mjs --browser  # 浏览器回调（需要 1455 端口空闲）
 * ```
 *
 * 脚本会打印一个 8 位码 + 一个链接。浏览器打开链接、输码、授权，脚本自己轮询到 token。
 *
 * ## 它不会做的事
 *
 * - 不碰 `refs:`（那是 API key 的环境变量映射，和 OAuth 记录是两条线）
 * - 不覆盖别的 record（只写 `llm-pi-ai/openai-codex` 这一个键）
 * - 写之前先备份 `.credentials.yaml`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PI_AI = path.join(
	"C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js",
);
const CREDENTIALS = path.join(os.homedir(), ".dsh", ".credentials.yaml");
const RECORD_KEY = "llm-pi-ai/openai-codex";
const useBrowser = process.argv.includes("--browser");

const { openaiCodexOAuth } = await import("file://" + PI_AI.replace(/\\/g, "/"));

/** 极简 interaction：只做「打印设备码」和「选登录方式」两件事。 */
const controller = new AbortController();
// Ctrl+C 时让 pi-ai 的轮询自己退出，而不是留一个孤儿请求
process.on("SIGINT", () => {
	console.log("\n已取消。");
	controller.abort();
	process.exit(130);
});
const interaction = {
	// 必须是真 AbortSignal —— `device-code.js:39` 直接读 `options.signal.aborted`，
	// 给 undefined 会在轮询第一轮就 `Cannot read properties of undefined`（实测）。
	signal: controller.signal,
	/** pi-ai 用它问「浏览器还是设备码」。默认设备码 —— 不占 1455 端口，也不会和 Codex CLI 抢。 */
	async prompt(request) {
		if (request?.type === "select") {
			const wanted = useBrowser ? "browser" : "device_code";
			console.log(`登录方式：${wanted}`);
			return wanted;
		}
		// 其它 prompt（极少）：直接回车
		console.log(request?.message ?? "");
		return "";
	},
	/** pi-ai 用它通知「去这个链接输这个码」。 */
	notify(event) {
		if (event?.type === "device_code") {
			console.log("");
			console.log("─".repeat(60));
			console.log(`  打开：${event.verificationUri}`);
			console.log(`  输入码：${event.userCode}`);
			console.log(`  （${event.expiresInSeconds ?? "?"} 秒内有效）`);
			console.log("─".repeat(60));
			console.log("");
		} else if (event?.type === "auth_url") {
			console.log("");
			console.log("在浏览器里完成登录：");
			console.log("  " + event.url);
			console.log("");
		} else if (event?.message !== undefined) {
			console.log(event.message);
		}
	},
};

console.log("正在向 ChatGPT 申请设备码……");
const credential = await openaiCodexOAuth.login(interaction, { agentName: "DeepSeek Harness" });

if (credential === undefined || credential === null || typeof credential.access !== "string") {
	console.error("登录没有返回凭据。原始返回：", credential);
	process.exit(1);
}

console.log("");
console.log("✓ 拿到凭据");
console.log("  accountId:", credential.accountId ?? "(未取到)");
console.log("  过期时间:", credential.expires === undefined ? "(未知)" : new Date(credential.expires).toISOString());

// ── 写进 dsh 的 credentials ──────────────────────────────────────────
//
// 格式是从现有文件反推的（version: 1 / records.<key>.{kind,payload} / refs）。
// 手写而不是用 yaml 库：这个包的约定是零运行时依赖，而这里的结构只有三层。
if (!fs.existsSync(CREDENTIALS)) {
	console.error(`找不到 ${CREDENTIALS} —— dsh 还没写过任何凭据，先启动一次 dsh。`);
	process.exit(1);
}
const raw = fs.readFileSync(CREDENTIALS, "utf8");
const backup = `${CREDENTIALS}.bak-before-codex-${Date.now()}`;
fs.writeFileSync(backup, raw, "utf8");
console.log(`已备份：${backup}`);

// payload 用 JSON 内联（YAML 支持 flow mapping），避免手写多行缩进出错
const payload = JSON.stringify({
	type: "oauth",
	access: credential.access,
	refresh: credential.refresh,
	expires: credential.expires,
	accountId: credential.accountId,
});
const block = `  ${RECORD_KEY}:\n    kind: grant\n    payload: ${payload}\n`;

let next;
if (raw.includes(`  ${RECORD_KEY}:`)) {
	// 已经有这条：整段替换（从它的行首找到下一个 record 或文末）
	const lines = raw.split("\n");
	const start = lines.findIndex((line) => line === `  ${RECORD_KEY}:`);
	let end = start + 1;
	while (end < lines.length && (lines[end].startsWith("    ") || lines[end].trim() === "")) end += 1;
	next = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n");
	console.log("（已存在同 key 记录，已替换）");
} else {
	// 插到 records: 下面第一条记录之前（保持 records 块完整）
	const at = raw.indexOf("records:\n");
	if (at < 0) {
		console.error("credentials 文件里没有 records: 块，格式不对，已中止（原文件未改）。");
		process.exit(1);
	}
	const insertAt = at + "records:\n".length;
	next = raw.slice(0, insertAt) + block + raw.slice(insertAt);
}

fs.writeFileSync(CREDENTIALS, next, "utf8");
console.log("");
console.log("✓ 已写入 " + RECORD_KEY);
console.log("");
console.log("下一步：");
console.log("  1. 重启 dsh（凭据在启动时读进内存）");
console.log("  2. 设置 → 模型 → openai-codex，模型目录里应能看到可用模型");
console.log("  3. 没看到就点「获取可用模型」；仍为空则手动加，模型 id 用 gpt-5.5 / gpt-6.1-sol 这类");
