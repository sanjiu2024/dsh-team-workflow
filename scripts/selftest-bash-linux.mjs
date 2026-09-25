#!/usr/bin/env node
/**
 * 自检：linux/bash 命令工具（bash / bash_open / bash_send / bash_close）。
 *
 * 分两段：
 *   1. 纯函数（clipTail / renderRun / resolveTimeout / shellArgv / shellQuote）——
 *      零依赖、零平台假设，任何机器都跑。
 *   2. **真跑命令**：起真 bash，验证 cd/变量/函数跨调用保留、退出码、超时、
 *      多行与引号、语法错误不杀会话。这段在没装 bash 的机器上跳过并明说。
 *
 *   node scripts/selftest-bash-linux.mjs
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = new URL("../", import.meta.url);
const { BASH_DEFAULTS, BashSession, clipTail, installBashLinux, renderRun, resolveTimeout, resolveWorkdir, runOnce, shellArgv, shellQuote } = await import(
	new URL("lib/bash-linux.js", ROOT).href
);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

// clipTail：保留**尾部**（报错和结果通常在最后）
check("clipTail 保留尾部而不是头部", () => {
	// 用**互不重叠**的标记：不能拿 "HEAD" 当「头部内容」的判据 ——
	// "HEAD" 这四个字母本身也可能落在保留的尾部里（"TAIL_MARKER" 不含它，
	// 但裁点若落在半行，上下文仍可能带上）。用只在头部出现的独特串才可靠。
	const long = `${'X'.repeat(300)}\nHEAD_ONLY_MARKER\n${'Y'.repeat(300)}\nTAIL_ONLY_MARKER`;
	const got = clipTail(long, 100);
	assert.equal(got.truncated, true);
	assert.ok(got.text.includes("TAIL_ONLY_MARKER"), "尾部内容必须留下");
	assert.ok(!got.text.includes("HEAD_ONLY_MARKER"), `头部内容该被丢掉：${JSON.stringify(got.text.slice(0, 80))}`);
});
check("clipTail 不超限时原样返回", () => {
	const r = clipTail("短输出", 1000);
	assert.equal(r.truncated, false);
	assert.equal(r.text, "短输出");
	assert.equal(r.totalBytes, Buffer.byteLength("短输出", "utf8"));
});
check("clipTail 按字节算、不劈开多字节字符", () => {
	// 全中文：每字 3 字节。上限 30 字节 → 不能出现半个字（乱码）
	const got = clipTail("中文".repeat(50), 30);
	assert.equal(got.truncated, true);
	assert.ok(!got.text.includes("\ufffd"), `不能出现替换字符（半个多字节字符）：${JSON.stringify(got.text.slice(0, 60))}`);
});
check("clipTail 边界：0 / 负数 / 非数字都不截", () => {
	for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
		assert.equal(clipTail("abc", limit).truncated, false, `limit=${limit} 不该截断`);
	}
});
check("clipTail 空输入", () => {
	assert.deepEqual(clipTail("", 10), { text: "", truncated: false, totalBytes: 0 });
	assert.deepEqual(clipTail(undefined, 10), { text: "", truncated: false, totalBytes: 0 });
});

// renderRun：非零退出是结果不是错误
check("renderRun 非零退出报 exit code 而不是抛错", () => {
	const text = renderRun({ stdout: "", stderr: "oops", exitCode: 1 });
	assert.ok(text.includes("[exit code: 1]"), `应报退出码：${text}`);
	assert.ok(text.includes("[stderr]"), "stderr 应有标记");
	assert.ok(text.includes("oops"));
});
check("renderRun 退出码 0 不报", () => {
	assert.equal(renderRun({ stdout: "ok", exitCode: 0 }), "ok");
});
check("renderRun 无输出写成 (无输出)", () => {
	assert.ok(renderRun({ stdout: "", stderr: "", exitCode: 0 }).includes("(无输出)"));
});
check("renderRun 超时/中止时不报伪退出码", () => {
	// 真事故：超时后 taskkill 的退出码 1 被当成命令的退出码报出来，会误导模型
	const timeout = renderRun({ stdout: "", exitCode: 1, timedOut: true, timeoutMs: 1200 });
	assert.ok(timeout.includes("超时"), `应报超时：${timeout}`);
	assert.ok(!timeout.includes("[exit code: 1]"), `不该报 taskkill 的退出码：${timeout}`);
	const aborted = renderRun({ stdout: "", exitCode: 1, aborted: true });
	assert.ok(aborted.includes("取消"));
	assert.ok(!aborted.includes("[exit code: 1]"), `不该报伪退出码：${aborted}`);
});
check("renderRun 截断标记", () => {
	assert.ok(renderRun({ stdout: "x", exitCode: 0, truncated: true }).includes("截断"));
});

// resolveTimeout：模型给的不能超过配置上限
check("resolveTimeout 尊重上限", () => {
	const cfg = { timeoutMs: 1000, maxTimeoutMs: 5000 };
	assert.equal(resolveTimeout(999999, cfg), 5000, "超过上限要掐到上限");
	assert.equal(resolveTimeout(2000, cfg), 2000, "上限内的请求照给");
	assert.equal(resolveTimeout(undefined, cfg), 1000, "没给用默认");
	assert.equal(resolveTimeout(-5, cfg), 1000, "非法值回落到默认");
});
check("resolveTimeout 配置缺失时用内置默认", () => {
	assert.equal(resolveTimeout(undefined, {}), BASH_DEFAULTS.timeoutMs);
	assert.ok(Number.isFinite(resolveTimeout(undefined, {})), "不能返回 NaN/Infinity");
});

// shellArgv / shellQuote
check("shellArgv auto 用 bash -c、wsl 用 wsl.exe", () => {
	assert.deepEqual(shellArgv("auto", "echo hi"), { file: "bash", args: ["-c", "echo hi"] });
	assert.deepEqual(shellArgv("wsl", "echo hi"), { file: "wsl.exe", args: ["-e", "bash", "-c", "echo hi"] });
});
check("shellQuote 正确转义单引号（真往返）", () => {
	// 不比对字面串 —— 那是转义层数抄错就会假红/假绿的东西。
	// 直接用真 shell 验往返：这才是这个函数唯一的意义。
	const values = ["it's", "plain", "a'b'c", "'", "双引号\"混'单引号", "$HOME `id` \\backslash"];
	for (const value of values) {
		const r = spawnSync("bash", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
		assert.equal(r.stdout, value, `${JSON.stringify(value)} 往返后变成 ${JSON.stringify(r.stdout)}`);
	}
});

// resolveWorkdir
check("resolveWorkdir 相对路径按 fallback 解析、空值回落", async () => {
	const path = await import("node:path");
	assert.equal(resolveWorkdir("", "/base", path), "/base");
	assert.equal(resolveWorkdir(undefined, "/base", path), "/base");
	assert.equal(resolveWorkdir("sub", "/base", path), path.resolve("/base", "sub"));
	assert.equal(resolveWorkdir("/abs", "/base", path), "/abs");
});

// ── 2. 真跑命令 ─────────────────────────────────────────────────────────────
// 没有 bash 的机器上跳过（并明说跳过了什么），不假装通过。

const hasBash = (() => {
	const r = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8", timeout: 15000 });
	return r.status === 0 && (r.stdout ?? "").includes("ok");
})();

if (!hasBash) {
	console.log("⚠ 跳过「真跑命令」段：PATH 里没有可用的 bash（Windows 装 Git for Windows 即有）。");
	console.log(`\n${failures === 0 ? "✓ 自检通过（纯函数部分）" : `✗ ${failures} 项失败`}`);
	process.exit(failures === 0 ? 0 : 1);
}

const cwd = process.cwd();

// 一次性
{
	const r = await runOnce({ command: "printf 'hello'", cwd, mode: "auto", timeoutMs: 15000, maxOutputBytes: 65536 });
	check("runOnce 跑通并拿到输出", () => {
		assert.equal(r.exitCode, 0);
		assert.equal(r.stdout, "hello");
	});
	const gnu = await runOnce({ command: "grep --version | head -1", cwd, mode: "auto", timeoutMs: 15000, maxOutputBytes: 65536 });
	check("runOnce 真的在跑 GNU 工具链（这是「linux 命令」的实质）", () => {
		assert.match(gnu.stdout, /grep/i, `应看到 GNU grep 版本号：${gnu.stdout}`);
	});
	const exited = await runOnce({ command: "exit 3", cwd, mode: "auto", timeoutMs: 15000, maxOutputBytes: 65536 });
	check("runOnce 保留退出码", () => assert.equal(exited.exitCode, 3));
	const stderr = await runOnce({ command: "echo bad >&2; exit 1", cwd, mode: "auto", timeoutMs: 15000, maxOutputBytes: 65536 });
	check("runOnce 分流 stderr", () => {
		assert.equal(stderr.exitCode, 1);
		assert.ok(stderr.stderr.includes("bad"));
		assert.equal(stderr.stdout, "");
	});
	const multi = await runOnce({ command: "printf 'a\\nb\\nc\\n' | grep -c .", cwd, mode: "auto", timeoutMs: 15000, maxOutputBytes: 65536 });
	check("runOnce 多行命令不被拆开（真事故：单引号拼接会把换行当命令分隔）", () => {
		assert.equal(multi.stdout.trim(), "3", `应为 3，实际 ${JSON.stringify(multi.stdout)}`);
	});
	const quoted = await runOnce({ command: `printf '%s' "it's ok"`, cwd, mode: "auto", timeoutMs: 15000, maxOutputBytes: 65536 });
	check("runOnce 命令里的引号不被吃掉", () => assert.equal(quoted.stdout, "it's ok"));
	const timedOut = await runOnce({ command: "sleep 30", cwd, mode: "auto", timeoutMs: 1200, maxOutputBytes: 4096 });
	check("runOnce 超时能杀掉", () => {
		assert.equal(timedOut.timedOut, true);
		assert.ok(!renderRun(timedOut).includes("[exit code:"), "超时不该报伪退出码");
	});
	// 真 bug 回归：收集预算必须「推后判」。旧的「判后推」下，
	// 单块大输出会整块穿越 —— 实测 stderr 到 65536 字节（Node pipe 的 chunk 上限），
	// 而修好后滚动裁剪到 ~14KB。注意：真正限住「模型看到多少」的是工具层的
	// clipTail（下面单独测）；这一层管的是内存不被长命令吃爆。
	const bigErr = await runOnce({ command: "head -c 2000000 /dev/urandom | base64 >&2", cwd, mode: "auto", timeoutMs: 60000, maxOutputBytes: 4096 });
	check("runOnce 单块超大 stderr 不会整块穿越（真 bug 回归）", () => {
		// 阈值卡在两个版本中间：坏版 65536，好版 ~14780
		assert.ok(bigErr.stderr.length < 32768, `stderr 应被裁剪，实际 ${bigErr.stderr.length}（坏版本是 65536）`);
	});
	const manyChunks = await runOnce({ command: "for i in $(seq 1 50000); do echo 'padding padding padding'; done >&2", cwd, mode: "auto", timeoutMs: 60000, maxOutputBytes: 4096 });
	check("runOnce 多块输出滚动裁剪", () => {
		assert.ok(manyChunks.stderr.length > 0, "不能把输出裁没");
		assert.ok(manyChunks.stderr.length < 16384, `应滚动裁剪，实际 ${manyChunks.stderr.length}`);
	});
}

// 持久会话
{
	const session = new BashSession({ mode: "auto", cwd });
	await session.send("cd /", 15000);
	const pwd = await session.send("pwd", 15000);
	check("持久会话：cd 跨调用保留（这是它唯一的存在理由）", () => {
		assert.equal(pwd.text.trim(), "/", `cd 后 pwd 应为 /，实际 ${JSON.stringify(pwd.text.trim())}`);
		assert.equal(pwd.exitCode, 0);
	});
	await session.send("export SELFTEST_VAR=kept", 15000);
	const v = await session.send("printf %s \"$SELFTEST_VAR\"", 15000);
	check("持久会话：变量跨调用保留", () => assert.equal(v.text.trim(), "kept"));
	await session.send("selftest_fn() { printf 'fn-ok'; }", 15000);
	const fn = await session.send("selftest_fn", 15000);
	check("持久会话：shell 函数跨调用保留", () => assert.equal(fn.text.trim(), "fn-ok", `实际 ${JSON.stringify(fn.text)}`));
	const ml = await session.send("printf 'x\\ny\\nz\\n' | grep -c .", 15000);
	check("持久会话：多行命令正确（真事故：base64 方案的由来）", () => assert.equal(ml.text.trim(), "3"));
	const rc = await session.send("(exit 5)", 15000);
	check("持久会话：保留退出码", () => assert.equal(rc.exitCode, 5));
	const bad = await session.send("if then fi ((", 15000);
	check("持久会话：语法错误不杀死 shell（走 eval 的原因）", () => {
		assert.notEqual(bad.exitCode, 0, "语法错误应有非零退出码");
		assert.equal(session.alive, true, "shell 必须活下来");
	});
	const after = await session.send("printf still-alive", 15000);
	check("持久会话：语法错误后还能继续跑", () => assert.equal(after.text.trim(), "still-alive"));
	// 命令打印看起来像哨兵的东西，不能误判
	const fake = await session.send("printf '__DSH_1_1_abcdef__'", 15000);
	check("持久会话：命令伪造哨兵串不误判", () => {
		assert.equal(fake.text.trim(), "__DSH_1_1_abcdef__");
		assert.equal(fake.exitCode, 0);
	});
	// 真 bug 回归：命令自己读 stdin 时会吃掉后面的协议脚本（含哨兵），
	// 导致输出错位到下一次调用。实测修前 `read line` 让下一条命令拿到
	// `got:__dsh_rc=$?` 且退出码变 null。靠 `eval ... < /dev/null` 隔离。
	const reads = await session.send("read line; printf 'got:[%s]' \"$line\"", 15000);
	check("持久会话：命令读 stdin 不会吞掉协议（真 bug 回归）", () => {
		assert.equal(reads.text.trim(), "got:[]", `read 应立即 EOF 得到空串，实际 ${JSON.stringify(reads.text)}`);
		assert.equal(reads.exitCode, 0, "退出码应是 0，不是 null（null 说明协议被吃了）");
	});
	// 而且下一条命令不受影响
	const nextAfterRead = await session.send("printf clean-state", 15000);
	check("持久会话：读 stdin 后下一条命令仍正确", () => {
		assert.equal(nextAfterRead.text.trim(), "clean-state", `实际 ${JSON.stringify(nextAfterRead.text)}`);
		assert.equal(nextAfterRead.exitCode, 0);
	});
	// 真 bug 回归：超时杀树后本进程侧不能残留引住事件循环的子进程。
	// 原来 taskkill 是 fire-and-forget 且没关管道 —— 实测超时路径留下 4 个 Socket，
	// Node 事件循环被挂住（脚本跑完不退，退出码 124）。放在超时测试之后才有意义。
	session.kill();
	check("kill 之后不再 alive", () => assert.equal(session.alive, false));
}

// 持久会话：超时判死后能恢复到上次的 cwd（审查建议的改良）
{
	const s = new BashSession({ mode: "auto", cwd });
	// 用一个普通目录（不要用 `/`：Git Bash 的 MSYS 层会把根目录映射成 `/c`，
	// 重建时看到的路径与记下的不同，那是 MSYS 的怪癖不是本模块的问题）
	await s.send("cd /c/Users", 15000);
		await s.send("cd /c/Users", 15000);
		// 必须是**原生路径**（`C:/Users`）而不是 MSYS 路径（`/c/Users`）：
		// Node 在 Windows 上 `spawn({cwd})` 拿 MSYS 路径会 ENOENT。
		// 这就是为什么拿 `pwd -W` 而不是 `$PWD`。
		check("会话记住的原生路径 cwd（重建时用它当起始目录）", () => {
			assert.equal(s.cwd, "C:/Users", `应是原生路径，实际 ${JSON.stringify(s.cwd)}`);
			assert.ok(!s.cwd.startsWith("/c/"), "不能是 MSYS 路径 —— 拿它起新 shell 会 ENOENT");
		});
		// 超时会把会话判死（命令可能还挂着，状态不可信）
		const killed = await s.send("sleep 30", 900);
		check("超时判死", () => assert.equal(killed.timedOut, true));
		// 真 bug 回归：超时杀树后本进程必须能自己退出。
		// 原来 taskkill 是 fire-and-forget 且没关管道 —— 超时路径会留下 stdio Socket
		// 引住事件循环，脚本跑完不退（实测退出码 124）。
		//
		// 为什么另起子进程测：`process._getActiveHandles()` 里泄漏的是 **Socket**
		// （stdio 管道），不是 ChildProcess —— 查错对象就查不出这个 bug（实测过）。
		// 「能不能退」只能真跑一个子进程看它会不会自己结束。
		check("超时 kill 后本进程能自己退出（真 bug 回归）", () => {
			const probe = `
import { BashSession } from ${JSON.stringify(new URL("lib/bash-linux.js", ROOT).href)};
const s = new BashSession({ mode: "auto", cwd: ${JSON.stringify(cwd)} });
await s.send("printf ok", 15000);
await s.send("sleep 30", 800);
console.log("done");
`;
			const file = path.join(os.tmpdir(), `bash-selftest-exit-${Date.now()}.mjs`);
			fs.writeFileSync(file, probe, "utf8");
			try {
				// 给足时间起 bash + 超时（800ms）+ 收尾；如果 handle 泄漏，它会挂到超时
				const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 30000 });
				assert.notEqual(r.signal, "SIGTERM", "子进程被超时杀掉 = 它自己退不出去（handle 泄漏）");
				assert.equal(r.status, 0, `子进程应正常退出，实际 status=${r.status} signal=${r.signal}\n${r.stderr ?? ""}`);
				assert.ok((r.stdout ?? "").includes("done"), "子进程应该跑完了");
			} finally {
				fs.rmSync(file, { force: true });
			}
		});
	// 重建时用记下的 cwd：变量/函数丢了，但目录还在（最痛的那半补上了）
	const revived = new BashSession({ mode: "auto", cwd: s.cwd });
	const back = await revived.send("pwd", 15000);
	check("重建后回到上次的目录", () => assert.equal(back.text.trim(), "/c/Users", `实际 ${JSON.stringify(back.text.trim())}`));
	revived.kill();
}

// 安装函数：真注册工具、真能调用
{
	const registered = new Map();
	const disposers = [];
	const ctx = {
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		effect: (fn) => {
			// 组合生命周期：这里立刻拿到 disposer 存着，测完手动调
			disposers.push(fn());
			return () => {};
		},
		tools: {
			register: (definition) => {
				if (registered.has(definition.name)) throw new Error(`重复注册 ${definition.name}`);
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
		},
		sessions: { current: () => undefined },
	};
	// 用一份小上限的配置：上面的默认值是 65536，拿它断言就等于没断言
	const config = { ...BASH_DEFAULTS, maxOutputBytes: 8192 };
	const handle = installBashLinux(ctx, { config });
	check("installBashLinux 注册了四个工具", () => {
		assert.equal(handle.enabled, true);
		for (const name of ["bash", "bash_open", "bash_send", "bash_close"]) assert.ok(registered.has(name), `缺工具 ${name}`);
	});
	check("describe 能报出状态（/team-baseline 要显示）", () => {
		assert.match(handle.describe(), /bash/);
	});
	// 真调 bash 工具
	const bash = registered.get("bash");
	const out = await bash.execute({ command: "printf 'tool-works'", description: "测试" }, {});
	check("bash 工具真能跑出结果", () => {
		assert.ok(out.text.includes("tool-works"), `实际 ${JSON.stringify(out.text)}`);
	});

	// 真 bug 回归：stderr 必须也被截断。
	// 原来只对 stdout 调 clipTail，而且 collect 是「先判后推」——
	// 实测 `head -c 2MB /dev/urandom | base64 >&2` 一次送来 65536 字节，
	// 配置上限 4096，超了 16 倍且完全没截，静默把上下文顶爆。
	const bigErr = await bash.execute({ command: "head -c 2000000 /dev/urandom | base64 >&2; printf done", description: "大 stderr" }, {});
	check("bash 工具的 stderr 也受上限约束（真 bug 回归）", () => {
		const limit = config.maxOutputBytes;
		assert.ok(bigErr.text.length < limit * 2, `输出应在 ${limit * 2} 字节内，实际 ${bigErr.text.length}`);
		assert.ok(/截断|输出过长/.test(bigErr.text), `应有截断标记：${JSON.stringify(bigErr.text.slice(0, 120))}`);
		assert.ok(bigErr.text.includes("done"), "stdout 的内容不能被 stderr 挤掉");
	});
	// 小 stderr 不该被贴上截断标记（别为了安全把正常输出也标了）
	const smallErr = await bash.execute({ command: "printf oops >&2; printf ok", description: "小 stderr" }, {});
	check("小 stderr 不加截断标记", () => {
		assert.ok(smallErr.text.includes("oops"), `要看到 stderr：${smallErr.text}`);
		assert.ok(!/截断|输出过长/.test(smallErr.text), `不该标截断：${smallErr.text}`);
	});
	const empty = await bash.execute({ command: "   " }, {});
	check("bash 工具拦空命令", () => assert.ok(empty.text.includes("command")));
	// 假 agent 归属
	const agent = { session: { header: { cwd } } };
	await registered.get("bash_open").execute({}, { agent });
	const s1 = await registered.get("bash_send").execute({ command: "cd / && printf ok" }, { agent });
	check("bash_send 在持久会话里跑", () => assert.equal(s1.text.trim(), "ok"));
	const s2 = await registered.get("bash_send").execute({ command: "pwd" }, { agent });
	check("bash_send 的 cd 真的留在了 agent 的会话里", () => assert.equal(s2.text.trim(), "/"));
	check("同一 agent 不会开出第二个会话", () => assert.equal(handle.sessions(), 1));
	// 另一个 agent 是独立的
	const agent2 = { session: { header: { cwd } } };
	await registered.get("bash_open").execute({}, { agent: agent2 });
	check("不同 agent 的持久会话互相独立", () => assert.equal(handle.sessions(), 2));
	// P2 回归：shell 自己退出（命令里写了 exit）时该把它从 Map 里摘掉，
	// 否则 Map 会强引用已死的 agent 与子进程句柄，进程长活 + agent 多了就缓慢累积。
	await registered.get("bash_send").execute({ command: "exit 0" }, { agent: agent2 });
	await new Promise((resolve) => setTimeout(resolve, 400));
	check("shell 自己退出后自动从 Map 摘掉（不泄漏）", () => {
		assert.equal(handle.sessions(), 1, `应只剩 agent 那个会话，实际 ${handle.sessions()}`);
	});
	const c = await registered.get("bash_close").execute({}, { agent });
	check("bash_close 收掉自己的会话", () => {
		assert.equal(handle.sessions(), 0, `应全部收掉，实际 ${handle.sessions()}`);
		assert.match(c.text, /关闭/);
	});
	// 关掉开关
	const off = installBashLinux({ ...ctx, tools: { register: () => () => {} } }, { config: { ...BASH_DEFAULTS, enabled: false } });
	check("配置关掉时不注册任何工具", () => {
		assert.equal(off.enabled, false);
		assert.match(off.describe(), /关/);
	});
	handle.dispose();
	check("dispose 撤销注册并收掉长活 shell", () => {
		assert.equal(registered.size, 0, "工具应被撤销");
		assert.equal(handle.sessions(), 0, "长活 shell 应被收掉");
	});
}

console.log(failures === 0 ? "\n✓ 自检通过：纯函数 / 真跑 bash / 持久会话状态保留 / 工具注册与降级" : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
