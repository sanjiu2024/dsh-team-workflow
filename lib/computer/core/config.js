/**
 * 操控电脑的配置与常量（REQ-024 从 lib/computer.js 抽出，平台无关）。
 *
 * 这些值原本定义在 lib/computer.js 顶部；抽出后由该文件 re-export，
 * 导出面与签名保持不变 —— scripts/selftest-computer.mjs 直接 import 它们。
 */

export const COMPUTER_DEFAULTS = {
	/** 默认启用（1.7.0 起，用户要求；enabled:false 可关）。 */
	enabled: true,
	/**
	 * 操控空闲多久把鼠标还给人（毫秒）。
	 *
	 * 为什么是 2 分钟而不是 15 秒（2026-09-28 用户反馈「锁不住，顶多让鼠标慢一点」）：
	 * 锁只在工具调用的瞬间生效，而模型在两次操作之间会思考几秒到几十秒。
	 * 原来的 15 秒空闲窗口意味着「模型一想事，锁就松了」——用户去碰鼠标时
	 * 绝大多数时刻锁都是关的，自然感觉「根本没锁」。
	 * 2 分钟能盖住一整段连续操控（截图→想→点击→想→打字），
	 * 又不至于在 AI 跑神后长时间占着用户的鼠标。
	 * 立即取回鼠标的办法：Ctrl+Alt+L（紧急解锁，本次会话内不再上锁）。
	 */
	idleUnlockMs: 120000,
	/** 守护进程启动（含 C# 编译）超时。 */
	startTimeoutMs: 30000,
	/** 单条命令超时；超时视为守护进程中毒，杀掉重启。 */
	runTimeoutMs: 15000,
	/** 截图命令超时（大屏 PNG 编码更慢）。 */
	shotTimeoutMs: 30000,
};

export const COMPUTER_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	idleUnlockMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	startTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	runTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
	shotTimeoutMs: (v) => (Number.isFinite(v) && v > 0 ? v : undefined),
};

/** 注入标记：SendInput 的 dwExtraInfo 带它，钩子放行；与 daemon.ps1 里的 MAGIC 一致。 */
export const MAGIC = 1146314819; // 0x44534843 = "DSHC"

/** 紧急解锁后给模型的拒绝话术（工具结果原文）。 */
export const EMERGENCY_REFUSAL =
	"[已停用] 鼠标锁被紧急解除（Ctrl+Alt+L）：操控类工具已停用，截屏仍可用。重启 dsh 后恢复。";
