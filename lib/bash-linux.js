/**
 * Linux/bash 工具：让 AI 在 Windows 上也能跑 linux 命令（Git Bash / WSL）。
 *
 * 为什么另起一个工具，而不是把 dsh 的 `tool-bash` 打开：
 * dsh 的 `ctx.shell` 是**单例缝**（`dsh-shell/lib/index.js` 的注释写明「a host
 * composes exactly one provider of `ctx.shell`」，两个一起挂会因服务重名抛错）。
 * Windows 上这个单例被 `pwsh-sandbox` 占着，执行器是 `PwshLocalExecutor`。
 * 所以只把 `tool-bash` 打开、不改执行器，会得到一个**名叫 bash、实际跑 PowerShell**
 * 的工具 —— 比没有更糟。而换执行器要改 dsh 安装树的预设，升级就被覆盖。
 *
 * 这里换成：自己 spawn bash，只往 dsh 的 `tools` 注册表加工具。代价是这个工具的
 * 命令**不经过 dsh 的 sandbox 管辖**（Windows ACL 后端本身也只有 `partial` 保证），
 * 所以默认按 workspace-write 的直觉做最小约束：cwd 默认 session 工作目录。
 *
 * 两种形态（用户都要）：
 *   bash_sh    一次性：每次新 shell，退出即弃。查文件、跑构建、git 之类。
 *   bash_open  持久：保留一个长活 bash，`cd`/变量/函数跨调用保留。
 *   bash_close 关掉持久会话（会话结束也会自动关）。
 *
 * 平台：win32 上 `bash` 需在 PATH（Git Bash 提供）；Linux/macOS 天然有。
 * `wsl: true` 时不走本地 bash，改成 `wsl.exe -e bash -c`（真 Linux 内核，
 * 而不是 MINGW 模拟层），需要机器装过 WSL 发行版；没装会在首次调用时报错。
 *
 * 零依赖：只用 node 内置模块。手写配置叠层，与包内其他模块一致。
 */
import { spawn } from "node:child_process";
import * as pathModule from "node:path";
import { StringDecoder } from "node:string_decoder";

import { toParameterSchema } from "./util.js";

/** 配置默认值。无 Config schema —— 手写叠层（与包内其他模块一致）。 */
export const BASH_DEFAULTS = {
	enabled: true,
	/** 用哪个 bash：`auto` 走 PATH 里的 `bash`；`wsl` 走 `wsl.exe -e bash` */
	mode: "auto",
	/** 单次命令默认超时（毫秒） */
	timeoutMs: 120000,
	/** 超时上限，模型给再大也不超过它 */
	maxTimeoutMs: 600000,
	/** 一次性命令的 stdout/stderr 合并上限（字节） */
	maxOutputBytes: 65536,
	/** 持久会话单次返回的输出上限（字符） */
	maxSessionOutputChars: 16384,
};
export const BASH_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	mode: (v) => (v === "auto" || v === "wsl" ? v : undefined),
	timeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	maxTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	maxOutputBytes: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	maxSessionOutputChars: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
};

// ── 纯函数部分（可单测，不依赖进程） ─────────────────────────────────────────

/**
 * 掐掉中间的尾部截断。为什么截**尾**而不是截头：命令的报错和结果通常在最后，
 * 截头会把最要命的一行丢掉。与 dsh 的 `truncateTail` 同语义。
 *
 * @param {string} text 完整输出
 * @param {number} maxBytes 上限（按 UTF-8 字节算，避免多字节字符被算少了）
 * @returns {{text: string, truncated: boolean, totalBytes: number}}
 */
export function clipTail(text, maxBytes) {
	const value = String(text ?? "");
	const totalBytes = Buffer.byteLength(value, "utf8");
	if (!Number.isFinite(maxBytes) || maxBytes <= 0 || totalBytes <= maxBytes) {
		return { text: value, truncated: false, totalBytes };
	}
	// 从**后往前**数满 maxBytes，算出要保留的起点 —— 保留尾部，不是头部。
	const target = totalBytes - maxBytes;
	let bytes = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (bytes >= target) {
			start = i;
			break;
		}
		bytes += Buffer.byteLength(value[i], "utf8");
	}
	// 往后找到第一个换行，避免开头是半行
	const nl = value.indexOf("\n", start);
	const body = nl === -1 ? value.slice(start) : value.slice(nl + 1);
	const keptBytes = Buffer.byteLength(body, "utf8");
	return {
		text: `[输出过长：完整 ${totalBytes} 字节，下面只留结尾 ${keptBytes} 字节]\n${body}`,
		truncated: true,
		totalBytes,
	};
}

/**
 * 把一次运行的原始结果渲染成模型看的那段文字。
 *
 * 退出码**不是错误**：非零退出是命令自己说的结果（`grep` 没匹配就是 1），
 * 渲染成 `[exit code: N]` 让模型自己判断；只有基础设施故障（起不来、被中止）
 * 才该报错。
 *
 * @param {{stdout?: string, stderr?: string, exitCode?: number|null, timedOut?: boolean, aborted?: boolean, timeoutMs?: number, truncated?: boolean}} run
 * @returns {string}
 */
export function renderRun(run) {
	const parts = [];
	const stdout = String(run?.stdout ?? "");
	const stderr = String(run?.stderr ?? "");
	if (stdout.trim() === "" && stderr.trim() === "") parts.push("(无输出)");
	else {
		if (stdout !== "") parts.push(stdout.replace(/\n+$/, ""));
		if (stderr !== "") parts.push(`[stderr]\n${stderr.replace(/\n+$/, "")}`);
	}
	if (run?.truncated === true) parts.push("[输出超出上限，已截断]");
	if (run?.timedOut === true) parts.push(`[命令超时（${run.timeoutMs ?? "?"}ms）已被终止]`);
	if (run?.aborted === true) parts.push("[命令被取消]");
	// 超时/中止时退出码是 taskkill 的，不是命令的 —— 报出来只会误导（实测显示 [exit code: 1]）
	if (run?.timedOut === true || run?.aborted === true) return parts.join("\n");
	if (run?.exitCode !== undefined && run?.exitCode !== null && run.exitCode !== 0) parts.push(`[exit code: ${run.exitCode}]`);
	return parts.join("\n");
}

/**
 * 解析一次命令的 shell 调用形态。
 *
 * `mode: "wsl"` 走真 Linux 内核（`wsl.exe -e bash -c`），`auto` 走 PATH 上的
 * `bash`（Windows 上是 Git Bash 的 MINGW 层 —— 它**不是**真 Linux，`uname -s`
 * 返回 `MINGW64_NT-...`，但 sed/awk/grep/find/ln 这类 GNU 工具齐全，日常够用）。
 *
 * @param {string} mode
 * @param {string} command
 * @returns {{file: string, args: string[]}}
 */
export function shellArgv(mode, command) {
	if (mode === "wsl") return { file: "wsl.exe", args: ["-e", "bash", "-c", command] };
	return { file: "bash", args: ["-c", command] };
}

/** 把模型给的工作目录变成绝对路径；没给就用 session 的 cwd。 */
export function resolveWorkdir(workdir, fallback, pathModule) {
	const value = typeof workdir === "string" ? workdir.trim() : "";
	if (value === "") return fallback;
	return pathModule.isAbsolute(value) ? value : pathModule.resolve(fallback, value);
}

/** 超时取 min(模型给的, 配置上限)，没给用默认。 */
export function resolveTimeout(requested, config) {
	const def = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : BASH_DEFAULTS.timeoutMs;
	const cap = Number.isFinite(config?.maxTimeoutMs) && config.maxTimeoutMs > 0 ? config.maxTimeoutMs : BASH_DEFAULTS.maxTimeoutMs;
	const want = Number.isFinite(requested) && requested > 0 ? requested : def;
	return Math.min(want, cap);
}

// ── 进程部分 ────────────────────────────────────────────────────────────────

/**
 * 跑一条命令，收集输出，返回结构化结果。不抛：所有失败都变成结果字段。
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string} options.cwd
 * @param {string} options.mode auto | wsl
 * @param {number} options.timeoutMs
 * @param {number} options.maxOutputBytes
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, aborted: boolean, spawnError?: string, timeoutMs: number}>}
 */
export function runOnce({ command, cwd, mode, timeoutMs, maxOutputBytes, signal }) {
	const { file, args } = shellArgv(mode, command);
	return new Promise((resolve) => {
		const stdoutChunks = [];
		const stderrChunks = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timedOut = false;
		let aborted = false;
		const budget = Math.max(1024, Math.floor((Number.isFinite(maxOutputBytes) ? maxOutputBytes : BASH_DEFAULTS.maxOutputBytes) / 2));
		// StringDecoder：一次 chunk 可能在多字节字符中间断开，直接 toString 会出乱码
		const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };

		let child;
		try {
			child = spawn(file, args, {
				cwd,
				// windowsHide 免得每个命令弹一个黑框
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...(process.platform === "win32" && mode !== "wsl" ? { MSYS_NO_PATHCONV: "1" } : {}) },
			});
		} catch (error) {
			resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, aborted: false, spawnError: error?.message ?? String(error), timeoutMs });
			return;
		}

		const timer =
			Number.isFinite(timeoutMs) && timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						killTree(child);
					}, timeoutMs)
				: undefined;

		const onAbort = () => {
			aborted = true;
			killTree(child);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const collect = (which, chunk) => {
			const text = decoders[which].write(chunk);
			// 必须「推后判」而不是「判后推」：单次 chunk 可能远大于预算
			//（实测 head -c 2MB | base64 >&2 一次就送来 65536 字节，
			// 旧的「先判后推」会把它整块留下 —— 配置上限 4096，实际入 65536，
			// 静默把上下文顶爆）。超过预算时只留尾部。
			if (which === "out") {
				stdoutChunks.push(text);
				stdoutBytes += Buffer.byteLength(text, "utf8");
				while (stdoutChunks.length > 1 && stdoutBytes > budget) {
					const dropped = stdoutChunks.shift();
					stdoutBytes -= Buffer.byteLength(dropped, "utf8");
				}
			} else {
				stderrChunks.push(text);
				stderrBytes += Buffer.byteLength(text, "utf8");
				while (stderrChunks.length > 1 && stderrBytes > budget) {
					const dropped = stderrChunks.shift();
					stderrBytes -= Buffer.byteLength(dropped, "utf8");
				}
			}
		};
		child.stdout?.on("data", (chunk) => collect("out", chunk));
		child.stderr?.on("data", (chunk) => collect("err", chunk));

		const finish = (exitCode) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			stdoutChunks.push(decoders.out.end());
			stderrChunks.push(decoders.err.end());
			resolve({
				stdout: stdoutChunks.join(""),
				stderr: stderrChunks.join(""),
				exitCode,
				timedOut,
				aborted,
				timeoutMs,
			});
		};

		child.on("error", (error) => {
			// ENOENT（找不到 bash）走这里。要变成可读的提示，不能只报 code。
			const hint =
				error?.code === "ENOENT"
					? mode === "wsl"
						? "找不到 wsl.exe；这台机器可能没装 WSL 发行版（跑 `wsl --install`）。"
						: "PATH 里找不到 bash；Windows 上装 Git for Windows 即有（或用 mode: \"wsl\"）。"
					: (error?.message ?? String(error));
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ stdout: "", stderr: "", exitCode: null, timedOut, aborted, spawnError: hint, timeoutMs });
		});
		child.on("close", (code, signalName) => {
			// 被信号杀掉时 code 是 null，按惯例映射成 128+signal
			if (code === null && typeof signalName === "string") {
				const num = signalNumber(signalName);
				finish(num === undefined ? null : 128 + num);
			} else finish(code);
		});
	});
}

/** 杀掉整棵进程树。Windows 上 child.kill 只杀直接子进程，bash 起的孙子会留下。 */
/**
 * 杀掉整棵进程树，并把本进程这侧的管道符关干净。
 *
 * Windows 上 `child.kill` 只杀直接子进程，bash 起的孙子会留下，所以走 `taskkill /T /F`。
 * 两件事必须都做，否则 Node 退不出去（实测超时路径留下 4 个 Socket，进程挂死）：
 *   · taskkill 自己也是个子进程，必须 `unref()`（不引住事件循环）并 `destroy()` 它的 stdio；
 *   · 被杀的 bash 的 stdout/stderr 管道要 `destroy()`，否则本进程的 read 端仍开着。
 */
function killTree(child) {
	// 本进程这侧的管道先关：无论后面走哪条路，这些 read 端都不再需要了
	const closePipes = () => {
		for (const stream of [child.stdout, child.stderr, child.stdin]) {
			try {
				stream?.destroy?.();
			} catch {
				/* 已经关了 */
			}
		}
	};
	if (process.platform === "win32" && child.pid !== undefined) {
		try {
			// /T 连子孙、/F 强制。不传 shell:true（会多一层 cmd 并触发 DEP0190）。
			// stdio:"ignore" + unref：不让这个短命进程拖住事件循环。
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			killer.on("error", () => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* 已经没了 */
				}
			});
			killer.unref?.();
			closePipes();
			return;
		} catch {
			/* 落到下面的 kill */
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* 已经没了 */
	}
	closePipes();
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGABRT: 6, SIGSEGV: 11, SIGPIPE: 13 };
function signalNumber(name) {
	return SIGNALS[name];
}

// ── 持久会话 ────────────────────────────────────────────────────────────────

/**
 * 一个长活的 bash，`cd`/变量/函数跨调用保留。
 *
 * 定界办法：每条命令后面跟一个哨兵 `printf` 打印**唯一标记 + 退出码**，从输出流里
 * 找这个标记来切分「这条命令的输出」。比读 prompt 稳（PS1 可被用户改坏），比等静默
 * 可靠（`sleep 5` 期间没输出不等于跑完了）。
 *
 * 已知天花板（`ponytail:` 标注）：
 *   · 命令自己打印标记串时会误判 —— 标记用 `pid + 计数` 拼，命令不可能猜中。
 *   · 不支持交互式命令（vim、ssh 要密码）—— 它们会挂住直到超时，然后整个会话作废重建。
 *   · 命令在后台留了进程并持续往 stdout 写，会污染下一条命令的输出。
 *     要彻底解决得像 dsh 那样上 PTY + 独立 fd；这里按「够用」收手。
 */
export class BashSession {
	/**
	 * @param {object} options
	 * @param {string} options.mode auto | wsl
	 * @param {string} options.cwd 起始工作目录
	 * @param {(session: BashSession) => void} [options.onExit] shell 自己退出时回调
	 *   （用来把已死的会话从持有它的 Map 里拿走 —— 否则 Map 会强引用着死 agent
	 *   和已退出的子进程句柄，进程长活 + agent 多了就缓慢累积）
	 */
	constructor({ mode, cwd, onExit }) {
		this.mode = mode;
		this.cwd = cwd;
		this.onExit = onExit;
		this.child = undefined;
		this.buffer = "";
		this.seq = 0;
		this.marker = undefined;
		this.pending = undefined;
		this.decoder = new StringDecoder("utf8");
		this.exited = false;
		this.exitNote = undefined;
	}

	/** 起进程（幂等）。起不来时抛，由调用方兜住并降级。 */
	start() {
		if (this.child !== undefined) return;
		// 必须用 `-s`（从 stdin 读、**非交互**），不能用 `-i`：
		// 实测 `bash -i` 在管道下会「回显输入 + 吐提示符 + 带 ANSI 转义」，
		// 三者都会污染输出，而且回显的脚本文本里正好含哨兵串，会让定界逻辑
		// 提前匹配到错误位置（第一条命令就返回一段脚本原文）。
		// `bash -s` 不出提示符、不回显、不带 ANSI，且同样是**一个进程**
		// —— `cd`/变量/函数跨调用保留（那才是持久会话的全部意义）。
		const { file, args } = this.mode === "wsl" ? { file: "wsl.exe", args: ["-e", "bash", "-s"] } : { file: "bash", args: ["-s"] };
		const child = spawn(file, args, {
			cwd: this.cwd,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			// PS1 置空双保险（`-s` 本就不打提示符；`-i` 才有 PS1）
			env: { ...process.env, PS1: "", PS2: "", ...(process.platform === "win32" && this.mode !== "wsl" ? { MSYS_NO_PATHCONV: "1" } : {}) },
		});
		this.child = child;
		child.stdout.on("data", (chunk) => this.#onData(this.decoder.write(chunk)));
		child.stderr.on("data", (chunk) => this.#onData(this.decoder.write(chunk)));
		child.on("error", (error) => {
			this.exited = true;
			// ENOENT 有两种成因，必须分开报：
			//   · 真的没装 bash
			//   · cwd 不存在 —— `$PWD` 是 MSYS 路径（`/c/Users`），而 Node 在 Windows 上
			//     要求原生路径（`C:\Users`），传 `/c/...` 会直接 ENOENT。
			//     实测这个误报把「重建会话」整条路径堵死，而且错误文字指向 bash，难查。
			if (error?.code === "ENOENT") {
				this.exitNote =
					this.mode === "wsl"
						? "找不到 wsl.exe；这台机器可能没装 WSL 发行版（跑 `wsl --install`）。"
						: `启动失败（cwd: ${this.cwd}）：找不到 bash，或者该目录不存在。Windows 装 Git for Windows 即有；cwd 需是原生路径（C:\\...）而不是 MSYS 路径（/c/...）。`;
			} else {
				this.exitNote = error?.message ?? String(error);
			}
			try {
				this.onExit?.(this);
			} catch {
				/* 回调是别人的代码 */
			}
			this.#failPending();
		});
		child.on("close", (code) => {
			this.exited = true;
			// 告诉持有者把它拿走（不影响待处理命令的结算，下面还要用它）
			try {
				this.onExit?.(this);
			} catch {
				/* 回调是别人的代码，不能让它拖垮结算 */
			}
			// shell 自己退出了（比如命令里写了 `exit 7`）。这时待处理的命令**不是错误** ——
			// 它的退出码就是 shell 的退出码，报给模型看才有用（之前是 reject，会炸调用方）。
			const pending = this.pending;
			if (pending !== undefined) {
				this.pending = undefined;
				if (pending.timer !== undefined) clearTimeout(pending.timer);
				const partial = this.buffer;
				this.buffer = "";
				this.exitNote = `持久 shell 已退出（code ${code ?? "?"}）`;
				pending.resolve({ text: partial, exitCode: typeof code === "number" ? code : null });
				return;
			}
			this.exitNote = `持久 shell 已退出（code ${code ?? "?"}）`;
		});
		// `bash -s` 不打提示符，所以这里不用等任何开场输出 —— 第一条命令的哨兵就是第一个信号
	}

	/**
	 * 基础设施故障时结束待处理的命令：**resolve** 而不是 reject。
	 *
	 * 为什么不用 reject：`send` 的调用方（工具的 `execute`）会 catch，但 `close`/`error`
	 * 也可能在**没有任何人 await 的窗口**里触发（比如测试里调了 `exit`，或者进程被外部
	 * 杀掉），这时未处理的 rejection 会直接冒到进程级 —— 实测把整个自检脚本打挂了。
	 * 这些失败对模型来说都应该是一条可读的结果，不是异常。
	 */
	#failPending() {
		const pending = this.pending;
		if (pending === undefined) return;
		this.pending = undefined;
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		const partial = this.buffer;
		this.buffer = "";
		pending.resolve({ text: this.exitNote ?? partial, exitCode: null, failed: true });
	}

	#onData(text) {
		this.buffer += text;
		const pending = this.pending;
		if (pending === undefined) {
			// 没有待处理命令时的输出（提示符、后台进程噪声）直接丢掉，不累积
			if (this.buffer.length > 1_000_000) this.buffer = this.buffer.slice(-4096);
			return;
		}
		const at = this.buffer.indexOf(pending.marker);
		if (at === -1) {
			// 上限保护：命令疯狂输出时别把内存吃光
			if (this.buffer.length > pending.hardCap) {
				const tail = this.buffer.slice(-pending.hardCap);
				this.buffer = tail;
			}
			return;
		}
		const body = this.buffer.slice(0, at);
		const after = this.buffer.slice(at + pending.marker.length);
		// 标记之后是 `退出码\t当前目录`，然后一个换行
		const nl = after.indexOf("\n");
		const codeText = nl === -1 ? after : after.slice(0, nl);
		this.buffer = nl === -1 ? "" : after.slice(nl + 1);
		this.pending = undefined;
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		const [rcPart, pwdPart] = codeText.split("\t");
		// 把 shell 报的目录记下来：重建会话时用它当起始目录
		if (typeof pwdPart === "string" && pwdPart !== "") this.cwd = pwdPart;
		const code = Number.parseInt(String(rcPart).trim(), 10);
		pending.resolve({ text: body, exitCode: Number.isFinite(code) ? code : null });
	}

	/**
	 * 发一条命令，等它跑完。
	 * @param {string} command
	 * @param {number} timeoutMs
	 * @returns {Promise<{text: string, exitCode: number|null}>}
	 */
	send(command, timeoutMs) {
		if (this.exited) return Promise.reject(new Error(this.exitNote ?? "持久 shell 已退出"));
		// 重入守卫：并发 send 会覆盖 this.pending，前一条永不 resolve（只能等它自己的
		// timer 把会话判死）。当前 dsh 同一 agent 内工具调用是串行的、不同 agent 键不同，
		// 所以走不到；但守着只花一行，而漏了就是难查的挂死。
		if (this.pending !== undefined) return Promise.reject(new Error("上一条命令还在跑，请等它结束再发"));
		this.start();
		this.seq += 1;
		// 标记不可能被命令猜中：进程 pid + 递增计数 + 随机串
		const marker = `__DSH_${this.child.pid ?? "x"}_${this.seq}_${Math.random().toString(36).slice(2, 8)}__`;
		this.buffer = "";
		const hardCap = 4 * 1024 * 1024;
		return new Promise((resolve, reject) => {
			const timer =
				Number.isFinite(timeoutMs) && timeoutMs > 0
					? setTimeout(() => {
							const pending = this.pending;
							this.pending = undefined;
							// 超时后 shell 里可能还挂着那条命令，会话状态不可信 —— 直接判死
							const partial = this.buffer;
							this.kill();
							pending?.resolve({ text: partial, exitCode: null, timedOut: true });
						}, timeoutMs)
					: undefined;
			this.pending = { marker, resolve, reject, timer, hardCap };
			// 只**在末尾**打标记 + 退出码。开头不能打：标记是切分用的，先出现就先被匹配到。
			//
			// 命令走 **base64 解码后 eval**，不再单引号拼接。实测单引号方案在三种
			// 输入上全错：
			//   1. 多行命令：`printf 'a\nb\nc\n' | grep -c .` 因为字面换行被拆成三条命令
			//   2. 函数定义：`myfn() { ... }` 没法跨调用保留（定义在子 shell 里）
			//   3. 命令自身带单引号时的转义链易错
			// base64 只含 `A-Za-z0-9+/=`，过 shell 字符串零风险，命令内容原封不动到达 eval。
			// 且必须走 eval：`bash -s` 非交互读 stdin 时，一个语法错误会被当成**脚本级**
			// 错误而结束整个 shell；eval 下它只是一个非零退出（实测 exit 2），shell 活下来。
			//
			// `< /dev/null` 不能省：命令若自己读 stdin（`read`、`cat`、要密码的 ssh），
			// 会吃掉**后面几行协议脚本**（包括标记），导致输出错位到下一次调用。
			// 实测 `read line; echo got:$line` 会把 `__dsh_rc=$?` 当成输入吃掉，
			// 下一条命令的输出里出现 `got:__dsh_rc=$?` 且退出码变成 null。
			// 重定向后 read 立即 EOF，协议行与命令的 stdin 彻底隔离。
			const encoded = Buffer.from(command, "utf8").toString("base64");
			// 标记行顺带回传目录：超时会把整个 shell 判死重建，那时能按上一版恢复 cwd
			//（变量/函数仍丢，但「反复 cd 进一个目录」是最痛的那半）。
			//
			// 必须用 `pwd -W` 而不是 `$PWD`：`$PWD` 在 Git Bash 里是 MSYS 路径
			//（`/c/Users`），而 Node 在 Windows 上 `spawn({cwd})` 要求原生路径
			//（`C:/Users`）—— 拿 `/c/...` 去起新 shell 会 ENOENT（实测把重建整条路堵死，
			// 而报错文字指向 bash，极难查）。`pwd -W` 给原生路径，且在同一个 shell 里。
			// 非 MSYS 环境（Linux/macOS/WSL）`pwd -W` 不可用，回落到 `$PWD`。
			const script = `__dsh_cmd=$(printf %s ${encoded} | base64 -d)\neval "$__dsh_cmd" < /dev/null\n__dsh_rc=$?\n__dsh_dir=$(pwd -W 2>/dev/null || printf %s "$PWD")\nprintf '%s%s\\t%s\\n' ${shellQuote(marker)} "$__dsh_rc" "$__dsh_dir"\n`;
			try {
				this.child.stdin.write(script);
			} catch (error) {
				this.pending = undefined;
				if (timer !== undefined) clearTimeout(timer);
				reject(error);
			}
		});
	}

	kill() {
		if (this.child === undefined) return;
		killTree(this.child);
		this.exited = true;
		this.pending = undefined;
	}

	get alive() {
		return this.child !== undefined && !this.exited;
	}
}

/** 单引号包裹一个字符串，供 shell 使用（内部的单引号转义成 '\''）。 */
export function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ── 装进 dsh ────────────────────────────────────────────────────────────────

/**
 * 注册 bash_sh / bash_open / bash_send / bash_close 四个工具。
 *
 * 为什么是四个工具而不是一个带 `session_id` 参数的：
 * 模型更容易「看到 bash_open 就知道要先开」，比记住某个 magic id 可靠；
 * 工具名分开也让「这条命令会不会影响后续」这件事在调用点上就可见。
 *
 * @param {object} ctx cordis 上下文（需要 `tools` 与 `sessions` 已 inject）
 * @param {object} options
 * @param {object} options.config 已叠好的配置
 * @returns {{enabled: boolean, reason?: string, describe: () => string, dispose: () => void, sessions: () => number}}
 */
export function installBashLinux(ctx, { config }) {
	const log = (m) => ctx.logger.info(m);

	if (config.enabled !== true) {
		return { enabled: false, reason: "配置里关掉了", describe: () => "bash（linux 命令）：关  （配置里关掉了）", dispose: () => {}, sessions: () => 0 };
	}

	// 按 agent 存持久会话（一个会话一个 shell；不同会话互不影响）
	const sessions = new Map();
	// shell 死后重建时用的起始目录。会话被忘掉后还得记得它 cd 到过哪里
	//（用户最痛的是「sleep 久了丢 cd」），所以这份记录与 sessions 分开存。
	const lastCwd = new Map();
	/** 取当前调用所属 agent 的键；没有 agent（不该发生）时退回全局单槽。 */
	const keyOf = (exec) => (exec?.agent !== undefined && exec.agent !== null ? exec.agent : "@global");

	const disposeAll = () => {
		for (const session of sessions.values()) {
			try {
				session.kill();
			} catch {
				/* 已经没了 */
			}
		}
		sessions.clear();
	};
	/** 把一个已死的会话从 Map 里摘掉（只摘它还挂着的那个，不误伤后来者）。 */
	const forget = (key, dead) => {
		if (dead?.cwd !== undefined && dead.cwd !== "") lastCwd.set(key, dead.cwd);
		if (sessions.get(key) === dead) sessions.delete(key);
	};
	/**
	 * 重建时该用的起始目录。
	 *
	 * 优先级：手上还挂着的那个（哪怕是刚死、close 事件还没到的）> 以前记下的 > 会话目录。
	 * 第一档不能省：超时判死后 `killTree` 是异步的，`close`（进而 `onExit`/`forget`）
	 * 可能还没触发，而下一条 `bash_send` 已经来了 —— 实测这时 `lastCwd` 还是空的，
	 * 于是 cwd 静默回落到会话目录，刚 cd 过的位置白记了。
	 */
	const startCwd = (key, exec) => sessions.get(key)?.cwd ?? lastCwd.get(key) ?? baseCwd(exec);
	// 组合拆除时收掉所有长活 shell，不然会留下孤儿进程
	ctx.effect(() => disposeAll, "team:bash-linux.dispose");

	const disposers = [];
	/** 会话起始目录：dsh 在 session.header.cwd 上记了会话工作目录。 */
	const baseCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

	// —— bash_sh：一次性 ——
	disposers.push(
		ctx.tools.register({
			name: "bash",
			description:
				"跑一条 linux/bash 命令（Git Bash / GNU 工具链），返回 stdout/stderr 与退出码。每次调用是**全新 shell**，cd/变量不保留；要保留请用 `bash_open`。" +
				"适合：ls/grep/find/sed/awk/wc/git/npm 等。" +
				"注意：这是 MSYS/MINGW 环境，路径用 `/c/Users/...` 而不是 `C:\Users\...`；Windows 程序要小心路径被转换（已设 MSYS_NO_PATHCONV=1）。",
			parameters: toParameterSchema({
				command: { type: "string", required: true, description: "要执行的 bash 命令。" },
				description: { type: "string", description: "这条命令做什么，5-10 个词的简短说明（显示给用户看）。" },
				workdir: { type: "string", description: "工作目录，默认当前会话目录；相对路径按会话目录解析。" },
				timeoutMs: { type: "number", description: `超时（毫秒），默认 ${BASH_DEFAULTS.timeoutMs}，上限 ${BASH_DEFAULTS.maxTimeoutMs}。` },
			}),
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args, exec) {
				const command = String(args?.command ?? "");
				if (command.trim() === "") return { text: "请给出 command。" };
				const cwd = resolveWorkdir(args?.workdir, baseCwd(exec), pathModule);
				const timeoutMs = resolveTimeout(args?.timeoutMs, config);
				const run = await runOnce({
					command,
					cwd,
					mode: config.mode,
					timeoutMs,
					maxOutputBytes: config.maxOutputBytes,
					signal: exec?.signal,
				});
				if (run.spawnError !== undefined) return { text: `[启动失败] ${run.spawnError}` };
				// stdout 与 stderr 都要过 clipTail：两者合起来才是模型看到的正文。
				// 预算各给一半，免得一边把另一边挤没。
				const half = Math.max(1024, Math.floor(config.maxOutputBytes / 2));
				const out = clipTail(run.stdout, half);
				const err = clipTail(run.stderr, half);
				return { text: renderRun({ ...run, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated }) };
			},
		}),
	);

	// —— bash_open：开/复用持久会话 ——
	disposers.push(
		ctx.tools.register({
			name: "bash_open",
			description:
				"开一个**持久 bash 会话**：之后用 `bash_send` 跑命令，`cd`、环境变量、shell 函数都跨调用保留。适合需要反复进出同一目录、或要累积环境的工作。" +
				"同一会话重复调用只会复用，不会开第二个。用完（或切任务）请 `bash_close`。注意：持久会话里 `exit` 会真的关掉会话。",
			parameters: toParameterSchema({
				workdir: { type: "string", description: "会话起始工作目录，默认当前会话目录。" },
			}),
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args, exec) {
				const key = keyOf(exec);
				const existing = sessions.get(key);
				if (existing?.alive === true) return { text: `持久 bash 会话已在运行（cwd: ${existing.cwd}）。用 bash_send 跑命令。` };
				const cwd = resolveWorkdir(args?.workdir, baseCwd(exec), pathModule);
				// onExit：shell 自己退出（命令里写了 `exit`、或被外部杀掉）时把它从 Map 里
				// 拿走，不然 Map 会强引用已死的 agent 与子进程句柄。
				const session = new BashSession({ mode: config.mode, cwd, onExit: (dead) => forget(key, dead) });
				try {
					// 起进程 + 探一条命令，确认真能用（不能只回「已开」）。
					// 两个条件都得满足：退出码 0 **且** 文本是 ok。
					// （写 `!== 0 && !== "ok"` 会让「exit 非零但输出恰为 ok」通过。）
					const probe = await session.send("printf ok", timeoutProbe(config));
					if (probe.exitCode !== 0 || probe.text.trim() !== "ok") {
						session.kill();
						return { text: `[持久会话启动失败] ${probe.text.trim() || `exit ${probe.exitCode}`}` };
					}
				} catch (error) {
					session.kill();
					return { text: `[持久会话启动失败] ${error?.message ?? error}` };
				}
				sessions.set(key, session);
				return { text: `持久 bash 会话已就绪（cwd: ${cwd}）。cd/变量/函数会跨 bash_send 保留；结束后用 bash_close 收掉。` };
			},
		}),
	);

	// —— bash_send：往持久会话发命令 ——
	disposers.push(
		ctx.tools.register({
			name: "bash_send",
			description: "往 `bash_open` 开的持久会话里发一条 linux/bash 命令，`cd`/变量/函数保留。没开会话会先自动开一个。",
			parameters: toParameterSchema({
				command: { type: "string", required: true, description: "要执行的 bash 命令。" },
				description: { type: "string", description: "这条命令做什么，5-10 个词的简短说明。" },
				timeoutMs: { type: "number", description: `超时（毫秒），默认 ${BASH_DEFAULTS.timeoutMs}。` },
			}),
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args, exec) {
				const command = String(args?.command ?? "");
				if (command.trim() === "") return { text: "请给出 command。" };
				const key = keyOf(exec);
				let session = sessions.get(key);
				if (session === undefined || session.alive !== true) {
					session = new BashSession({ mode: config.mode, cwd: startCwd(key, exec), onExit: (dead) => forget(key, dead) });
					sessions.set(key, session);
				}
				const timeoutMs = resolveTimeout(args?.timeoutMs, config);
				let result;
				try {
					result = await session.send(command, timeoutMs);
				} catch (error) {
					sessions.delete(key);
					return { text: `[持久会话不可用] ${error?.message ?? error}\n下次调用会自动重开。` };
				}
				// 输出按「字符」截断（持久会话给的是字符口径的配置项）
				const limit = Number.isFinite(config.maxSessionOutputChars) ? config.maxSessionOutputChars : BASH_DEFAULTS.maxSessionOutputChars;
				const text = result.text.length > limit ? `[输出过长，只留结尾 ${limit} / ${result.text.length} 字符]\n${result.text.slice(-limit)}` : result.text;
				const head = session.alive ? "" : `[会话已结束] ${session.exitNote ?? ""}\n`;
				return { text: head + renderRun({ stdout: text, exitCode: result.exitCode, timedOut: result.timedOut === true, timeoutMs }) };
			},
		}),
	);

	// —— bash_close ——
	disposers.push(
		ctx.tools.register({
			name: "bash_close",
			description: "关掉当前会话的持久 bash 会话（不关也不会泄漏，组合拆除时会自动收）。",
			parameters: toParameterSchema({}),
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(_args, exec) {
				const key = keyOf(exec);
				const session = sessions.get(key);
				if (session === undefined) return { text: "当前没有持久 bash 会话。" };
				session.kill();
				sessions.delete(key);
				return { text: "持久 bash 会话已关闭。" };
			},
		}),
	);

	log(`[team:bash] linux 命令工具已注册：bash（一次性）/ bash_open / bash_send / bash_close；mode=${config.mode}`);

	return {
		enabled: true,
		describe: () => `bash（linux 命令）：开  mode=${config.mode}  一次性+持久  活跃会话 ${sessions.size}`,
		dispose: () => {
			for (const d of disposers) d?.();
			disposeAll();
		},
		sessions: () => sessions.size,
	};
}

/** 探测持久会话时用的短超时：起不来要快点失败，别让开会话本身卡住。 */
function timeoutProbe(config) {
	const cap = Number.isFinite(config?.timeoutMs) ? config.timeoutMs : BASH_DEFAULTS.timeoutMs;
	return Math.min(cap, 15000);
}
