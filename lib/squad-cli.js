/**
 * `dsh-team squad ls` 的数据层（REQ-016 · B6）。
 *
 * 小队状态是**进程内**的：命令行看不到另一个进程里活着的那些队。但**落盘的那份**能看
 * （`<DSH_HOME>/team-workflow/squads/<工作目录>.json`，REQ-015 起按工作目录一份）。
 * 所以这个子命令的语义是「看盘上的状态」，**不是**「看现在在跑的」—— 实时的那份在 Web 面板。
 *
 * 两条约束写在这里：
 * 1. **只读**：走 `createSquadStore({ quarantine: false })` —— 默认的 store 会把版本不认识的
 *    文件改名隔离（那是插件加载时的正确行为），但「看一眼」不该改用户的盘。
 * 2. 渲染复用 `snapshotAll` / `renderSnapshot`（与 `squad_status` 工具同一套），
 *    免得命令行和工具两处格式各自漂移。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createSquadStore, reviveSquad } from "./squad-store.js";
import { MEMBER_STATUS, renderSnapshot, snapshotAll } from "./squad.js";
import { dshHome } from "./util.js";

/** 落盘目录。 */
export function squadStoreDir(home = dshHome()) {
	return path.join(home, "team-workflow", "squads");
}

/** 只读的 store 句柄（不落盘、不隔离）。 */
function readOnlyStore(home) {
	return createSquadStore({ dir: squadStoreDir(home), log: () => {}, quarantine: false });
}

/**
 * 读某个工作目录的小队（落盘那份）。
 *
 * @returns {{dir: string, file: string, records: object[]}}
 */
export function readSquadsForCwd(cwd, { home = dshHome() } = {}) {
	const store = readOnlyStore(home);
	return { dir: squadStoreDir(home), file: store.fileFor(cwd), records: store.load(cwd) };
}

/**
 * 读**所有**工作目录的小队（`--all`）。一个工作目录一份文件，所以这里直接列目录。
 *
 * @returns {Array<{file: string, cwd: string, records: object[]}>}
 */
export function readAllSquads({ home = dshHome() } = {}) {
	const dir = squadStoreDir(home);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
		const file = path.join(dir, name);
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			out.push({ file, cwd: typeof parsed?.cwd === "string" ? parsed.cwd : "", records: Array.isArray(parsed?.squads) ? parsed.squads : [] });
		} catch {
			// 坏文件跳过（只读命令不该因为一份坏文件整个失败）
		}
	}
	return out;
}

/**
 * 记录 → 给人看的文字（空数组返回空串，由调用方说「没有」）。
 *
 * @param {object[]} records 落盘记录（`{name, objective, ...}`）
 */
export function renderSquadRecords(records) {
	if (!Array.isArray(records) || records.length === 0) return "";
	const squads = new Map();
	for (const record of records) {
		const squad = reviveSquad(record, { statuses: MEMBER_STATUS });
		squads.set(squad.name, squad);
	}
	// owner 只是渲染用的一层壳（命令行没有会话身份）；快照的形状与工具一致
	return renderSnapshot(snapshotAll(new Map([["(命令行)", squads]])));
}
