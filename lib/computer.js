/**
 * 操控电脑（computer use，REQ-002）：截屏看屏幕 + 鼠标键盘注入 + 操控期锁鼠标。
 *
 * 参考 Anthropic computer use 的动作集与「模型只发指令、宿主执行」架构
 * （调研结论：Codex 没有操控电脑插件，见 docs/requirements/REQ-002 §5）。
 *
 * 架构（零 npm 依赖）：
 *   - 单个常驻 PowerShell 守护进程（daemon.ps1，启动时写到临时目录）：
 *     装 WH_MOUSE_LL/WH_KEYBOARD_LL 钩子（锁鼠标）+ SendInput 注入 + 截图。
 *     与宿主之间用**文件 spool**（in/*.cmd → out/*.out）通信 —— 不用线程、
 *     不用行协议，超时只需弃单，没有流错位问题。
 *   - 锁鼠标：armed 时，钩子放行 dwExtraInfo == MAGIC 的注入事件（AI），
 *     拦截其余真实事件（人）。Ctrl+Alt+L 紧急解锁 → 本插件生命周期内拒操作。
 *   - 审批：execute 内主动 ctx.get("approval").request()，会话级 confirmed
 *     集合实现「首次问、本会话放行」；无审批服务 / rejected / cancelled /
 *     unavailable 一律拒绝（fail-safe）。
 *   - 截图：daemon 产出 PNG → attachments.saveImage → render 返回
 *     [text, image] ContentBlock（模型直接看到屏幕；模型路由不支持 image 时拒绝）。
 *
 * fail-safe：钩子进程死 = 鼠标自动解锁（外部进程天然 fail-open）；
 * 启动失败只报错不硬扛；非 Windows 不注册任何工具。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";


import { COMPUTER_DEFAULTS, COMPUTER_FIELDS, MAGIC, EMERGENCY_REFUSAL } from "./computer/core/config.js";
import { KEY_MAP, parseKeyCombo, classifyHookEvent, allowsOutcome, buildCommand, parseReply, parsePos, parseStatus } from "./computer/core/protocol.js";
import { createDaemonClient } from "./computer/core/daemon-client.js";
import { textOut, shotOut, deny } from "./computer/core/output.js";
import { createApprover } from "./computer/core/approval.js";
import { createLock } from "./computer/core/lock.js";
import { registerDshTools } from "./computer/fronts/dsh.js";
import { isImplementable, selectDriver } from "./computer/drivers/index.js";

// 兼容层（REQ-024）：下列符号原先定义在本文件，抽出到 core/ 后在此 re-export，
// 导出面与签名保持不变 —— scripts/selftest-computer.mjs 直接 import 它们。
export { COMPUTER_DEFAULTS, COMPUTER_FIELDS, MAGIC, EMERGENCY_REFUSAL };
export { KEY_MAP, parseKeyCombo, classifyHookEvent, allowsOutcome, buildCommand, parseReply, parsePos, parseStatus };
export { createDaemonClient };

// ── 平台驱动：见 drivers/（REQ-024 步骤 5） ─────────────────────────────────
// 脚本原文、拉起方式、紧急解锁的按键名都由驱动给；core 与 fronts 不含平台字样。

// ── daemon 客户端：见 core/daemon-client.js（REQ-024 步骤 2b 抽出） ──

// ── 安装 ────────────────────────────────────────────────────────────────────

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{config: Record<string, any>}} options
 * @returns {{enabled: boolean, reason?: string, describe: () => string, dispose: () => void}}
 */
export function installComputer(ctx, { config }) {
	const disabled = (reason) => ({
		enabled: false,
		reason,
		describe: () => `操控电脑：关（${reason}）`,
		dispose: () => {},
	});

	if (config.enabled !== true) return disabled("配置里关掉了");
	// 判据是「驱动有没有实现」，不是 process.platform 字符串 —— 后者每加一个平台都要改这里一次。
	const driver = selectDriver();
	if (!isImplementable(driver)) return disabled(driver.unsupportedReason ?? "本平台未实现");

	const log = {
		warn: (...a) => { try { ctx.logger?.warn?.(...a); } catch { /* ignore */ } },
	};

	// —— spool 目录 + daemon 脚本（每次安装唯一，多实例/多插件不撞） ——
	const dir = path.join(os.tmpdir(), `dsh-team-computer-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
	fs.mkdirSync(path.join(dir, "in"), { recursive: true });
	fs.mkdirSync(path.join(dir, "out"), { recursive: true });
	const daemon = createDaemonClient(dir, config, driver.host);
	// 脚本名、就绪文件名、BOM 前缀全部由驱动决定（Windows 必须带 BOM，理由见 drivers/win32.js）。
	fs.writeFileSync(daemon.scriptPath, `${driver.scriptPrefix}${driver.daemonScript}`, "utf8");

	// —— 审批 + 会话级放行：见 core/approval.js ——
	const approve = createApprover({ getApprovalService: () => ctx.get?.("approval") });

	// —— 鼠标锁生命周期：见 core/lock.js ——
	const lock = createLock({ daemon, config, log });

	// 紧急解锁探测：靠 ensureArmed 的 status 查询（见上），不用 fs.watch（会拴事件循环）。
	// daemon 仍会写 out/event-emergency.txt 作为证据文件，便于排障。

	// —— 输出形状：见 core/output.js ——

	// —— 路由门禁（模型必须支持 image 输入，照 dsh-tool-fs assertImageCapableRoute）——
	async function assertImageRoute(exec, what) {
		const routed = exec?.agent?.session?.requestHeader?.()?.config;
		const provider = routed?.provider ?? exec?.agent?.options?.provider;
		const model = routed?.model ?? exec?.agent?.options?.model;
		const llm = ctx.get?.("llm");
		if (provider === undefined || model === undefined || llm === undefined || llm === null) {
			throw new Error(`无法确认当前模型是否支持看图：${what}被拒绝（路由不可解析）`);
		}
		const active = await llm.resolveModelInfo(provider, model, exec.signal);
		const modalities = active.inputModalities ?? active.context?.inputModalities;
		if (!Array.isArray(modalities) || !modalities.includes("image")) {
			throw new Error(`当前模型 "${model}" 不支持图像输入，无法${what}；换到支持 image 的模型`);
		}
	}

	// —— 7 个工具的定义在 fronts/dsh.js（REQ-024 步骤 4 抽出） ——
	const disposeTools = registerDshTools(ctx, { daemon, lock, approve, assertImageRoute, config });

	// 不预热：安装时 spawn 常驻进程是副作用（污染任何 apply 进程的事件循环，
	// 也让「默认启用」变成「默认多一个进程」）。首次实操时才冷启动（daemon.send 自带 ensureReady）。
	// 代价：首次操控多 ~1s 冷启动；收益：不碰电脑就完全零进程、零开销。

	return {
		enabled: true,
		describe: () => `操控电脑：开（锁鼠标空闲 ${Math.round(config.idleUnlockMs / 1000)}s 解锁；紧急解锁 ${driver.emergencyKeyLabel}）`,
		/** 内部句柄（自检与排障用）：守护进程 spool 客户端。 */
		daemon,
		dispose() {
			lock.dispose();
			disposeTools();
			daemon.dispose();
			setTimeout(() => {
				try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
			}, 1500).unref?.();
		},
	};
}
