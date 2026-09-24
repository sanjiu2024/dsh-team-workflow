/**
 * `pi` 伪 CLI —— 让 magic-context 的 historian 在 dsh 上跑起来。
 *
 * 背景：magic-context 的 `PiSubagentRunner` 会 spawn 一个 `pi` 进程来跑
 * 后台摘要任务（historian / dreamer / recomp），协议在 bundle 里是固定的：
 *
 *   argv:  --print --mode json --no-session --no-skills
 *          --no-prompt-templates --no-context-files
 *          --no-tools --system-prompt <临时文件> --model <provider/model>
 *          [--thinking <level>]
 *          （Windows 上 userMessage 走 stdin，不在 argv）
 *
 *   stdin:  user message 全文
 *   stdout: NDJSON，每行一个 pi 事件。只需要一行 agent_end：
 *          {"type":"agent_end","messages":[{role:"assistant",
 *            content:[{type:"text","text":"..."}],stopReason:"stop"}]}
 *   exit:  0
 *
 * 我们不实现 pi，只回这一行。bundle 侧 `extractFinalAssistant` 从
 * messages 里倒着找第一条 role=assistant 的消息取 text；stopReason 不是
 * stop/length/error/aborted 之一会被当成失败。
 *
 * 凭据：父进程（dsh）的 env 里没有 key —— dsh 用 `ctx.credentials` 解析
 * `apiKeyEnv`，那是进程内的事。这里直接读 ~/.dsh/.credentials.yaml 的
 * refs 段（同一个引用名，同一份凭据），不额外引入密钥文件。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

/** 从 argv 取 --flag value 形式的值。 */
function flagValue(argv, name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** 读 dsh 的凭据引用表。文件不存在或格式不对时返回 {}。 */
function readCredentialRefs() {
	try {
		const file = path.join(homedir(), ".dsh", ".credentials.yaml");
		const text = fs.readFileSync(file, "utf8");
		const refs = {};
		let inRefs = false;
		for (const raw of text.split(/\r?\n/)) {
			if (/^refs:\s*$/.test(raw)) {
				inRefs = true;
				continue;
			}
			// 顶层键（顶格且以 : 结尾）离开 refs 段
			if (inRefs && /^\S/.test(raw)) break;
			if (!inRefs) continue;
			const m = raw.match(/^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/);
			if (m) refs[m[1]] = m[2];
		}
		return refs;
	} catch {
		return {};
	}
}

/** 读 stdin 全文。 */
function readStdin() {
	return new Promise((resolve) => {
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (buf += c));
		process.stdin.on("end", () => resolve(buf));
		process.stdin.on("error", () => resolve(buf));
	});
}

/**
 * 发一行 pi 事件到 stdout。bundle 用 readline 逐行解析，一行一个 JSON。
 */
function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * 按 agent_end 的形态报错退出。bundle 侧看到 assistant 文本为空 / stopReason
 * 是 error，就会把它映射成 no_assistant / model_failed，并带上 errorMessage。
 */
function fail(message) {
	emit({
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: message,
			},
		],
	});
	process.exitCode = 1;
}

/** dsh 的 settings.yaml 里注册的 provider —— 拿 baseURL 和 api。 */
function readProvider(providerName) {
	try {
		const text = fs.readFileSync(path.join(homedir(), ".dsh", "settings.yaml"), "utf8");
		const lines = text.split(/\r?\n/);
		const block = [];
		let inside = false;
		let indent = 0;
		for (const raw of lines) {
			const m = raw.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
			if (m && m[2] === providerName) {
				inside = true;
				indent = m[1].length;
				continue;
			}
			if (!inside) continue;
			if (raw.trim() !== "" && raw.match(/^(\s*)/)[1].length <= indent) break;
			block.push(raw);
		}
		const body = block.join("\n");
		const pick = (key) => body.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"))?.[1];
		return {
			baseURL: pick("baseURL"),
			api: pick("api"),
			apiKeyEnv: pick("apiKeyEnv"),
		};
	} catch {
		return {};
	}
}

/** 把 --system-prompt 指向的临时文件读出来（bundle 写在那，不在 argv 里）。 */
function readSystemPrompt(argv) {
	const file = flagValue(argv, "--system-prompt");
	if (!file) return "";
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const userMessage = (await readStdin()).trim();
	const systemPrompt = readSystemPrompt(argv);
	const modelRef = flagValue(argv, "--model") ?? "";

	if (userMessage.length === 0) {
		fail("pi-shim: empty user message on stdin");
		return;
	}

	// model ref 形态是 "provider/model-id"。带斜杠取第一段当 provider。
	const slash = modelRef.indexOf("/");
	if (slash <= 0) {
		fail(`pi-shim: model ref "${modelRef}" lacks provider prefix (provider/model-id)`);
		return;
	}
	const providerName = modelRef.slice(0, slash);
	const modelId = modelRef.slice(slash + 1);

	const provider = readProvider(providerName);
	const refs = readCredentialRefs();
	const apiKey =
		(provider.apiKeyEnv ? refs[provider.apiKeyEnv] : undefined) ??
		refs.NEW_API_API_KEY ??
		process.env.NEW_API_API_KEY;

	if (!provider.baseURL) {
		fail(`pi-shim: provider "${providerName}" not found in ~/.dsh/settings.yaml`);
		return;
	}
	if (!apiKey) {
		fail(`pi-shim: no credential for provider "${providerName}" (looked in ~/.dsh/.credentials.yaml refs)`);
		return;
	}

	const url = `${provider.baseURL.replace(/\/+$/, "")}/chat/completions`;
	const messages = [];
	if (systemPrompt.length > 0) messages.push({ role: "system", content: systemPrompt });
	messages.push({ role: "user", content: userMessage });

	const controller = new AbortController();
	// bundle 侧自己管超时与 kill；这里给一个比它宽松的上限兜底，避免泄漏进程。
	const hardTimeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
	hardTimeout.unref?.();

	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ model: modelId, messages, stream: false }),
		});
	} catch (error) {
		fail(`pi-shim: request failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	} finally {
		clearTimeout(hardTimeout);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		fail(`pi-shim: HTTP ${response.status} from ${url}${body ? ` | ${body.slice(0, 500)}` : ""}`);
		return;
	}

	let payload;
	try {
		payload = await response.json();
	} catch (error) {
		fail(`pi-shim: invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const text = payload?.choices?.[0]?.message?.content;
	const finish = payload?.choices?.[0]?.finish_reason;
	if (typeof text !== "string" || text.length === 0) {
		fail(`pi-shim: empty assistant text (finish_reason=${finish ?? "?"})`);
		return;
	}

	// finish_reason 映射；"length" 会被 bundle 当成 truncated。
	const stopReason = finish === "length" ? "length" : "stop";
	emit({
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
			},
		],
	});
}

main().catch((error) => {
	fail(`pi-shim: unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
