/**
 * 操控电脑的纯函数与守护进程协议编码（REQ-024 从 lib/computer.js 抽出）。
 *
 * 全部平台无关、可单测。注意 buildCommand 与 daemon.ps1 的 Invoke-Body 是一对
 * 镜像：改一边必须改另一边（自检断言两侧 kind 集合一致）。
 */

import { MAGIC } from "./config.js";

// ── 纯函数（可单测） ─────────────────────────────────────────────────────────

/** 键名 → VK 码。修饰键 + 主键，未知键返回 null。 */
export const KEY_MAP = {
	ctrl: 17, control: 17, alt: 18, shift: 16, win: 91,
	enter: 13, esc: 27, escape: 27, tab: 9, space: 32, backspace: 8, delete: 46,
	up: 38, down: 40, left: 37, right: 39, home: 36, end: 35, pageup: 33, pagedown: 34,
	insert: 45, capslock: 20, pause: 19, printscreen: 44,
	f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
};
for (let c = 0; c < 26; c++) KEY_MAP[String.fromCharCode(97 + c)] = 65 + c;
for (let d = 0; d < 10; d++) KEY_MAP[String(d)] = 48 + d;

/**
 * 解析组合键，如 `ctrl+s` → [17, 83]。顺序 = 修饰键按下顺序 + 主键，
 * daemon 按此顺序按下、逆序抬起。未知键返回 null。
 * @param {string} key
 * @returns {number[] | null}
 */
export function parseKeyCombo(key) {
	if (typeof key !== "string") return null;
	const parts = key.toLowerCase().split("+").map((s) => s.trim()).filter((s) => s.length > 0);
	if (parts.length === 0) return null;
	const vks = [];
	for (const part of parts) {
		const vk = KEY_MAP[part];
		if (vk === undefined) return null;
		vks.push(vk);
	}
	const last = vks.at(-1);
	const MODIFIERS = new Set([17, 18, 16, 91]);
	// 只有修饰键没有主键（如单独 "ctrl"）不合法；主键必须在最后。
	if (MODIFIERS.has(last) && vks.length === 1) return null;
	if (vks.slice(0, -1).some((vk) => !MODIFIERS.has(vk))) return null;
	return vks;
}

/**
 * 钩子事件分类 —— 与 daemon.ps1 里 C# 的条件逐字对应（镜像，供单测钉住语义）。
 * armed 且事件没带注入标记 = 人的真实输入 → 拦截；其余放行。
 * @param {{dwExtraInfo?: number|bigint, armed: boolean, magic?: number}} ev
 * @returns {"allow" | "block"}
 */
export function classifyHookEvent({ dwExtraInfo, armed, magic = MAGIC }) {
	if (!armed) return "allow";
	return BigInt(dwExtraInfo ?? 0) === BigInt(magic) ? "allow" : "block";
}

/** 审批结果是否放行。 */
export function allowsOutcome(outcome) {
	return outcome === "allowed-once";
}

/** 守护进程命令编码（文件 spool 里的单行文本）。 */
export function buildCommand(kind, args = {}) {
	switch (kind) {
		case "arm": return "arm";
		case "disarm": return "disarm";
		case "status": return "status";
		case "quit": return "quit";
		case "pos": return "pos";
		case "move": return `move ${args.x} ${args.y}`;
		case "click": {
			const coords = args.x === undefined ? "" : ` ${args.x} ${args.y}`;
			return `click ${args.button ?? "left"} ${args.count ?? 1}${coords}`;
		}
		case "scroll": return `scroll ${args.lines}`;
		case "type": return `type ${Buffer.from(args.text, "utf8").toString("base64")}`;
		case "keys": return `keys ${args.vks.join(" ")}`;
		case "shot": return `shot ${args.file}`;
		default: throw new Error(`未知命令：${kind}`);
	}
}

/** 解析 daemon 应答：`ok ...` 视为成功（返回余下内容），其余抛错。 */
export function parseReply(text) {
	const s = String(text ?? "").trim();
	if (s.startsWith("ok")) return s.slice(2).trim();
	throw new Error(s.replace(/^err\s*/, "") || "守护进程返回空应答");
}

/** 从 `ok pos 10 20` 取坐标。 */
export function parsePos(reply) {
	const m = /^pos\s+(-?\d+)\s+(-?\d+)$/.exec(reply);
	if (m === null) return null;
	return { x: Number(m[1]), y: Number(m[2]) };
}
