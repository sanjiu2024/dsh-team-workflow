/**
 * Windows 驱动（第一个里程碑唯一有实现的平台）。
 *
 * 驱动只负责「这个平台特有的事实」，不含任何编排逻辑：
 *   - daemonScript：常驻进程要跑的那段脚本原文（null 表示本平台没有实现）；
 *   - scriptPrefix：写脚本文件时要加的前缀（PowerShell 5.1 必须带 BOM，见下）；
 *   - host：怎么起这个常驻进程、怎么杀掉它；
 *   - emergencyKeyLabel：紧急解锁的按键显示名 —— 每个平台不一定一样，
 *     所以它属于驱动，不属于 core（REQ-024 §6 点名要求 describe() 参数化）。
 */
import * as fs from "node:fs";

import { WIN32_DAEMON_HOST } from "../core/daemon-client.js";

/**
 * 脚本原文在仓库里是独立文件（REQ-024 步骤 2 外置）。这里读进来交给 core ——
 * 读失败要炸得明确：静默返回空字符串会让守护进程以「找不到命令」的形式失败，
 * 排查时会一路怀疑到钩子代码上去。
 */
const DAEMON_PS = fs.readFileSync(new URL("./win32/daemon.ps1", import.meta.url), "utf8");

export const win32Driver = {
	id: "win32",
	daemonScript: DAEMON_PS,
	// 必须带 UTF-8 BOM：Windows PowerShell 5.1 用 -File 读无 BOM 文件按系统 ANSI（GBK）解码，
	// 中文注释字节会解出乱码造成假解析错误（实测：ParseInput 同内容零错、ParseFile 报错）。
	scriptPrefix: "\uFEFF",
	host: WIN32_DAEMON_HOST,
	emergencyKeyLabel: "Ctrl+Alt+L",
};
