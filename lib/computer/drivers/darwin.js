/**
 * macOS 驱动 —— 只有接口，没有实现。
 *
 * 这是 REQ-024 §3 主动选的边界：本机只有 Windows 11，没跑过的平台一行实现都不写。
 * 写一个「看起来能跑、实际没验证过」的 osascript 驱动，比返回「未实现」更糟 ——
 * 它会把「没测过」伪装成「能用」，而这类失败是静默的（点偏了不报错，继续往下走）。
 *
 * 补齐时只需要填三个字段，core 与 fronts 一行都不用改：
 *   daemonScript：一段常驻进程脚本（osascript / shell 均可，协议见 core/daemon-client.js）；
 *   host：{ scriptName, readyFile, spawn(scriptPath, inDir, outDir), killTree(pid) }；
 *   emergencyKeyLabel：这个平台上紧急解锁显示成什么。
 */
export const darwinDriver = {
	id: "darwin",
	daemonScript: null,
	scriptPrefix: "",
	host: null,
	emergencyKeyLabel: null,
	unsupportedReason: "本平台未实现",
};
