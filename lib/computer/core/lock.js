/**
 * 鼠标锁生命周期 —— REQ-024 步骤 3 抽出。
 *
 * 语义：操控动作前 armed（钩子开始拦截真人鼠标、放行带 MAGIC 的 AI 注入），
 * 空闲 idleUnlockMs 后自动 disarm；用户按 Ctrl+Alt+L 紧急解锁后，本插件生命周期内拒操作。
 *
 * 两个坑，都是实测踩出来的，别改回去：
 * 1. 紧急解锁靠每次 ensureArmed 查一次 status 探测，**不用 fs.watch** ——
 *    Windows 上 fs.watch 的句柄 unref 无效，会把宿主拴在事件循环里退不出去
 *    （实测能把整条 npm test 卡到超时）。代价是每次操控多一次 spool 往返（~20ms）。
 * 2. status 必须用 parseStatus 解析，不能 `includes("emergency 1")` ——
 *    后者在字段顺序变化或多出字段时会静默失真，而失真后果是「用户按了紧急解锁，
 *    AI 继续动鼠标」。
 */
import { buildCommand, parseStatus } from "./protocol.js";

export function createLock({ daemon, config, log }) {
		let armed = false;
	let emergency = false;
	let idleTimer = null;

	function touchIdle() {
		if (idleTimer !== null) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			armed = false;
			daemon.send(buildCommand("disarm"), config.runTimeoutMs).catch(() => { /* 进程死了本来就解锁 */ });
		}, config.idleUnlockMs);
		idleTimer.unref?.();
	}

	/** 操控动作前调用：确保钩子 armed，并刷新空闲计时。失败抛错（操作不执行）。 */
	async function ensureArmed() {
		if (emergency) throw new Error("鼠标锁已被紧急解除（Ctrl+Alt+L），操控已停用");
		// 每次实操前查一次 status（权威）：紧急解锁的探测靠这里，不靠 fs.watch ——
		// Windows 上 fs.watch 的句柄 **unref 无效**，会把宿主/任何 apply 过的进程
		// 死在事件循环里退不出去（实测 npm test 链被它卡到超时）。
		// 代价：每次操控多一次 spool 往返（~20ms），对比人工审批弹窗可忽略。
		const st = await daemon.send(buildCommand("status"), config.runTimeoutMs).catch(() => "");
		if (parseStatus(st).emergency === 1) {
			emergency = true;
			if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
			log.warn("computer: 鼠标锁被紧急解除（Ctrl+Alt+L），操控类工具已停用，重启 dsh 恢复");
			throw new Error("鼠标锁已被紧急解除（Ctrl+Alt+L），操控已停用");
		}
		if (armed && daemon.isAlive() && daemon.armedAtGen === daemon.generation) {
			touchIdle();
			return;
		}
		await daemon.send(buildCommand("arm"), config.runTimeoutMs);
		armed = true;
		daemon.armedAtGen = daemon.generation;
		touchIdle();
	}

	return {
		ensureArmed,
		touchIdle,
		/** 紧急解锁已触发（Ctrl+Alt+L 按下过）—— 本插件生命周期内拒绝一切操控。 */
		isEmergency: () => emergency,
		/** 只清定时器，不解锁：解锁靠 daemon.dispose 或父进程死亡。 */
		dispose() {
			if (idleTimer !== null) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		},
	};
}
