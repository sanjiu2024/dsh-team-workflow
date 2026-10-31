/**
 * Linux 驱动 —— 只有接口，没有实现。理由与 darwin.js 相同（REQ-024 §3）。
 *
 * 补齐时的现实约束（先记在这里，免得下次从零试错）：
 *   - 无障碍树走 AT-SPI：需要 at-spi2-core 且必须跑在用户的图形会话总线里，
 *     Ubuntu 22.04 的 ATK 桥在 Action.GetActions 上会 abort（见 REQ-024 §5 调研）；
 *   - 合成输入走 XTest / uinput，悬空与缩放在 Wayland 下与 X11 行为不同；
 *   - 「紧急解锁」在这个平台上的等价物需要先定（不是 Ctrl+Alt+L 那么简单）。
 */
export const linuxDriver = {
	id: "linux",
	daemonScript: null,
	scriptPrefix: "",
	host: null,
	emergencyKeyLabel: null,
	unsupportedReason: "本平台未实现",
};
