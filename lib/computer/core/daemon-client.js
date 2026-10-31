/**
 * 守护进程客户端（文件 spool）—— 平台无关骨架，平台差异收进 host 注入点。
 *
 * 为什么抽出来（REQ-024 步骤 2b）：这段逻辑（懒启动 / 单命令互斥 / 超时弃单 /
 * 退出兜底）一个字都不是 Windows 特有的，原样留在 lib/computer.js 里就意味着一件事 ——
 * 每加一个平台都要复制一遍 155 行，然后各自漂移。抽出来之后，平台只提供两件东西：
 * 怎么起这个常驻进程、怎么杀掉它。
 *
 * 协议本身仍是文件 spool（in/*.cmd → out/*.out）：不用线程、不用行协议，
 * 超时只需弃单，没有流错位问题。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseReply } from "./protocol.js";

/**
 * Windows 的默认 host：spawn 一个常驻 powershell 跑 daemon.ps1，杀进程走 taskkill。
 *
 * 步骤 5 会把它挪进 drivers/win32.js —— 那时 core 里一个 `powershell` 字样都不该剩。
 * 现在留在这里是因为 2b 是纯搬家：先建立注入点，再谈把默认值搬走。
 */
export const WIN32_DAEMON_HOST = {
	scriptName: "daemon.ps1",
	readyFile: "_ready",
	spawn(scriptPath, inDir, outDir) {
		return spawn(
			"powershell",
			["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath, inDir, outDir, String(process.pid)],
			{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
	},
	killTree(pid) {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		} catch {
			/* ignore */
		}
	},
};

// ── daemon 客户端（文件 spool） ──────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 建守护进程客户端。目录里写 daemon.ps1，spawn powershell 跑它，
 * 命令走 in/<seq>.cmd → out/<seq>.out 文件往返；同一时刻只有一条在途命令（mutex）。
 * @param {string} dir spool 目录（宿主创建）
 * @param {{startTimeoutMs: number, runTimeoutMs: number, shotTimeoutMs: number}} config
 */
export function createDaemonClient(dir, config, host = WIN32_DAEMON_HOST) {
	const inDir = path.join(dir, "in");
	const outDir = path.join(dir, "out");
	const scriptPath = path.join(dir, host.scriptName);
	let child = null;
	let ready = false;
	let disposed = false;
	let seq = 0;
	let chain = Promise.resolve();
	let armedAtGen = 0;
	let generation = 0;
	let stderrTail = "";

	const withMutex = (fn) => {
		const run = chain.then(fn);
		chain = run.then(() => undefined, () => undefined);
		return run;
	};

	function spawnDaemon() {
		ready = false;
		fs.rmSync(path.join(outDir, host.readyFile), { force: true });
		// 清掉上一任残留的命令：超时路径已向调用方报「未完成」，
		// 重启后补执行就是迟到/重复执行（同一命令真跑两遍，比如双击）。
		for (const stale of fs.readdirSync(inDir)) {
			if (stale.endsWith(".cmd")) fs.rmSync(path.join(inDir, stale), { force: true });
		}
		stderrTail = "";
		const proc = host.spawn(scriptPath, inDir, outDir);
		child = proc;
		// unref：不让守护进程的句柄挻住宿主事件循环 —— 否则 dsh/自检进程退出不了，
		// 而守护进程靠「父进程死自退」+ dispose 的 quit 兜底，不会变孤儿。
		proc.unref?.();
		proc.stdout?.unref?.();
		proc.stderr?.unref?.();
		proc.stderr?.on("data", (chunk) => {
			stderrTail = (stderrTail + String(chunk)).slice(-1500);
		});
		proc.on("error", (err) => {
			// spawn 失败（EMFILE 等）：只影响自己，不碰后来者的句柄。
			stderrTail = (stderrTail + `\nspawn error: ${err?.message ?? err}`).slice(-1500);
			if (child === proc) { child = null; ready = false; }
		});
		proc.on("exit", (code, sig) => {
			// 关键：kill 旧进程后它的 exit 会迟到 —— 只能清自己的句柄，
			// 否则会把刚 spawn 的新进程句柄误清（启动误报失败）。
			if (child === proc) {
				child = null;
				ready = false;
				if (code !== null && code !== 0) stderrTail = (stderrTail + `\nexit code ${code} signal ${sig ?? "-"}`).slice(-1500);
			}
		});
		generation++;
	}

	async function ensureReady() {
		if (disposed) throw new Error("插件已停用");
		if (child !== null && ready) return;
		if (child !== null && !ready) throw new Error("守护进程正在启动中");
		spawnDaemon();
		const deadline = Date.now() + config.startTimeoutMs;
		while (Date.now() < deadline) {
			if (fs.existsSync(path.join(outDir, host.readyFile))) {
				ready = true;
				return;
			}
			if (child === null) break;
			await sleep(50);
		}
		const detail = stderrTail.trim() === "" ? "（无 stderr 输出）" : `：${stderrTail.trim()}`;
		try { child?.kill(); } catch { /* ignore */ }
		child = null;
		throw new Error(`守护进程启动失败${detail}`);
	}

	/** 杀掉守护进程（下次 ensureReady 重启）；用于超时中毒与 dispose。 */
	function killDaemon() {
		const pid = child?.pid;
		child = null;
		ready = false;
		if (pid === undefined) return;
		try { host.killTree(pid); } catch { /* ignore */ }
	}

	async function send(cmd, timeoutMs) {
		return withMutex(async () => {
			await ensureReady();
			seq += 1;
			const name = `${String(seq).padStart(8, "0")}.cmd`;
			const outName = `${String(seq).padStart(8, "0")}.out`;
			fs.writeFileSync(path.join(inDir, name), cmd, "utf8");
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const outPath = path.join(outDir, outName);
				if (fs.existsSync(outPath)) {
					let text = "";
					try { text = fs.readFileSync(outPath, "utf8"); } catch { /* ignore */ }
					fs.rmSync(outPath, { force: true });
					return parseReply(text);
				}
				if (child === null) break;
				await sleep(20);
			}
			killDaemon();
			throw new Error("守护进程无响应，已重启（本条命令未完成）");
		});
	}

	return {
		scriptPath,
		inDir,
		outDir,
		dir,
		get generation() { return generation; },
		get armedAtGen() { return armedAtGen; },
		set armedAtGen(v) { armedAtGen = v; },
		start: () => withMutex(() => ensureReady()),
		send,
		isAlive: () => child !== null && ready,
		kill: killDaemon,
		dispose() {
			disposed = true;
			// 优雅退出：写 quit 命令，等它回；等不到就 taskkill 兜底。
			try {
				if (child !== null && ready) {
					seq += 1;
					fs.writeFileSync(path.join(inDir, `${String(seq).padStart(8, "0")}.cmd`), "quit", "utf8");
				}
			} catch { /* ignore */ }
			const pid = child?.pid;
			const killer = setTimeout(() => {
				if (pid !== undefined) {
					try { host.killTree(pid); } catch { /* ignore */ }
				}
			}, 1200);
			killer.unref?.();
			child = null;
			ready = false;
		},
	};
}
