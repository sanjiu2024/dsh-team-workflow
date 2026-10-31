/**
 * 平台驱动选择（REQ-024 步骤 5）。
 *
 * 判据只有一个：这个平台有没有 daemonScript。有 = 完整实现，可以去建守护进程；
 * 没有（null）= 本平台未实现，installComputer 必须如实返回「关」并说明原因，
 * 而不是注册一堆一调就报错的工具。**「假装注册成功」是最坏的形态** ——
 * 模型会以为它能操控电脑，然后在每一步收到莫名其妙的失败。
 *
 * 未知平台不走 default 猜测：返回一个显式的 unsupported 驱动，
 * 这样将来有人在 FreeBSD 上装包，看到的是「FreeBSD 本平台未实现」，而不是别的平台的怪错。
 */
import { darwinDriver } from "./darwin.js";
import { linuxDriver } from "./linux.js";
import { win32Driver } from "./win32.js";

const BY_PLATFORM = {
	win32: win32Driver,
	darwin: darwinDriver,
	linux: linuxDriver,
};

/**
 * @param {string} [platform] 默认取 process.platform；显式传参是为了能被自检覆盖
 * @returns {{id: string, daemonScript: string|null, scriptPrefix: string, host: object|null, emergencyKeyLabel: string|null, unsupportedReason?: string}}
 */
export function selectDriver(platform = process.platform) {
	const known = BY_PLATFORM[platform];
	if (known !== undefined) return known;
	return {
		id: String(platform),
		daemonScript: null,
		scriptPrefix: "",
		host: null,
		emergencyKeyLabel: null,
		unsupportedReason: `${platform} 本平台未实现`,
	};
}

/** 这个驱动是否真的能干活（判据是 daemonScript，不是 id 字符串）。 */
export function isImplementable(driver) {
	return typeof driver?.daemonScript === "string" && driver.daemonScript.length > 0;
}
