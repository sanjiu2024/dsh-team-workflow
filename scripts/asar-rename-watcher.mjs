#!/usr/bin/env node
/**
 * 等 dsh 退出 → 把 app.asar 改名让位 → 重新启动 dsh。
 *
 * 为什么需要它：0.2.2 的官方安装包又把宿主封回 `resources/app.asar` 里，而补丁写在
 * 解开的 `resources/app` 下。Electron 优先读 asar，所以补丁一条都不生效 —— 必须让 asar
 * 让位。但 asar 在 dsh 运行时被映射着，改名必然 `EBUSY`。
 *
 * `lib/purge/desktop.js` 里本来有 `scheduleAsarRenameWhenIdle`，它 spawn 一个 PowerShell
 * 脚本做这件事 —— 2026-11-11 实测那个脚本**起来就退**（`Get-Process | Where-Object { $_.Path }`
 * 对某些受保护进程会整条 cmdlet 抛错，`$holding` 变成 null 之后脚本崩掉，asar 原封不动）。
 * 所以这里用 node 重写一份：进程判定用 `tasklist` 的输出而不是 `$_.Path`，并且把每一步
 * 都写进日志文件，事后能查。
 *
 * 用法（detached，从 dsh 里启动）：
 *   node scripts/asar-rename-watcher.mjs --exe "<DeepSeek Harness.exe>" --asar "<...>/app.asar"
 *
 * 日志：`<asar 同目录>/asar-rename-watcher.log`
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] ?? "" : "";
};
const exe = argOf("--exe");
const asar = argOf("--asar");
if (exe === "" || asar === "") {
	console.error("用法：node asar-rename-watcher.mjs --exe <exe> --asar <asar>");
	process.exit(2);
}

const logFile = path.join(path.dirname(asar), "asar-rename-watcher.log");
const log = (line) => {
	try {
		fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* 日志写不了就算了，不能因此中断 */
	}
};

/** dsh 还在跑吗？用 tasklist 按 exe 名判 —— 不碰 `$_.Path`，也就不会整条命令崩。 */
function hostRunning() {
	try {
		const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/NH"], {
			encoding: "utf8",
			timeout: 10_000,
			windowsHide: true,
		});
		return /DeepSeek Harness\.exe/i.test(out);
	} catch (error) {
		// tasklist 自己失败时按「还在跑」处理 —— 宁可多等一轮，也不要在 dsh 活着时动 asar
		log(`tasklist 失败（按还在跑处理）：${String(error?.message ?? error)}`);
		return true;
	}
}

const deadline = Date.now() + 30 * 60 * 1000;
log(`开始等待（exe=${exe}）`);

while (Date.now() < deadline) {
	if (hostRunning()) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		continue;
	}
	log("dsh 已退出，开始改名");
	if (!fs.existsSync(asar)) {
		log("asar 已经不在了，无事可做");
		process.exit(0);
	}
	const backup = `${asar}.bak`;
	try {
		if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
		fs.renameSync(asar, backup);
		log(`已改名：${asar} → ${backup}`);
	} catch (error) {
		log(`改名失败（继续等）：${String(error?.message ?? error)}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
		continue;
	}
	try {
		fs.rmSync(`${asar}.rename-pending`, { force: true });
	} catch {
		/* ignore */
	}
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false, env });
	child.on("error", (error) => log(`启动 dsh 失败：${String(error?.message ?? error)}`));
	child.unref();
	log(`已重新启动 dsh（pid=${child.pid}）`);
	process.exit(0);
}
log("30 分钟到，dsh 一直没退出，放弃（下次启动 dsh 后再跑一次）");
