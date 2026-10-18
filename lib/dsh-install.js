/**
 * 定位 dsh 安装树里的东西 —— 目前只有一样：自带 standard 预设的**原文**。
 *
 * 为什么单独一个文件：`bin/dsh-team.mjs` 与自检都要用它。放 `lib/` 是因为它是纯函数
 * （给路径、读字节），自检可以直接 import，不必起 CLI（`bin/dsh-team.mjs` 顶层就会
 * `parseArgs` + 分发命令，import 它等于跑一次 CLI）。
 *
 * ── 为什么要读 asar（2026-10-18，dsh 0.2.1-rc.2 实测）────────────────────
 * 原来这条链是从 PATH 上的 `dsh` 反推安装树、再在真实文件系统里找
 * `node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。现在两个前提都不成立：
 *   · PATH 上第一个 `dsh` 是启动器目录（`%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd`），
 *     它的祖先里没有那些包 —— 向上 8 层全空；
 *   · Electron 版的包在 `resources/app.asar` **里面**，普通 Node 进程的 `fs.existsSync`
 *     看不见它（`app.asar.unpacked` 只解了 `dsh/node_modules/@deepseek-ai`，不含
 *     `dsh-web-app/presets`）。
 * 于是 `dsh-team preset install` 报「找不到 standard 预设（新旧两种布局都没找到）」。
 * asar 本身是明文归档（16 字节 pickle 头 + JSON 目录树 + 数据区），自己解析即可，无需依赖。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** asar 内 standard 预设的位置（Electron 版 dsh 把它打包在里面） */
export const STANDARD_PRESET_INNER = "dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml";
const STANDARD_PRESET_REL = ["node_modules", "@deepseek-ai", "dsh-web-app", "presets", "standard.patch.yml"];

/**
 * 读 asar 里的条目。目录 → 子项名数组；文件 → utf8 文本；不存在 → undefined。
 *
 * 头部布局：偏移 4 是 headerSize、偏移 12 是目录 JSON 的长度，数据区从 `8 + headerSize`
 * 开始，目录树里每个文件带 `offset` / `size`。
 */
export function asarEntry(asarPath, innerPath) {
	let fd;
	try {
		fd = fs.openSync(asarPath, "r");
		const head = Buffer.alloc(16);
		if (fs.readSync(fd, head, 0, 16, 0) < 16) return undefined;
		const headerSize = head.readUInt32LE(4);
		const jsonLen = head.readUInt32LE(12);
		// 头部长度必须像话：拿一个不是 asar 的文件进来（例如拿 package.json 当 asar）时，
		// 这两个字段可以是任意值 —— 实测能算出 1.6GB，最坏 4GB。Buffer.alloc 会先分配再失败，
		// 进程被拖死或 OOM，而那是**不可捕获**的。真 asar 的目录树约 3.4MB。
		if (headerSize > 64 * 1024 * 1024 || jsonLen > 64 * 1024 * 1024) return undefined;
		const jsonBuf = Buffer.alloc(jsonLen);
		fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
		const raw = jsonBuf.toString("utf8");
		// 先做一次廉价的字符串包含判断：扫安装位置时会挨个看 asar，全量 JSON.parse 一个
		// 116MB 包的目录树（约 3.4MB）太亏，只有真像 dsh 的才值得解析。
		if (!raw.includes('"dsh-web-app"')) return undefined;
		let node = JSON.parse(raw);
		for (const seg of innerPath.split("/")) {
			if (!seg) continue;
			node = node?.files?.[seg];
			if (!node) return undefined;
		}
		if (typeof node.size !== "number") return Object.keys(node.files ?? {});
		const buf = Buffer.alloc(node.size);
		fs.readSync(fd, buf, 0, node.size, 8 + headerSize + Number(node.offset));
		return buf.toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** 从一个安装根取 standard 预设原文（`root` 可以是安装目录，也可以直接是 app.asar） */
export function standardFromInstall(root) {
	const asar = root.endsWith(".asar") ? root : path.join(root, "resources", "app.asar");
	if (!fs.existsSync(asar)) return undefined;
	const text = asarEntry(asar, STANDARD_PRESET_INNER);
	if (typeof text !== "string") return undefined;
	// 顺手把这份安装的 dsh 版本带出来：底稿陈旧时（例如历史 junction 指着旧版）
	// 打印里能一眼看见，不用去猜
	let version = "";
	const runtime = asarEntry(asar, "dsh/desktop-runtime.json");
	if (typeof runtime === "string") {
		try {
			const v = JSON.parse(runtime).release?.version;
			if (v) version = `（dsh ${v}）`;
		} catch {
			/* 版本读不出来不影响取底稿 */
		}
	}
	return { text, label: `${asar} → ${STANDARD_PRESET_INNER}${version}` };
}

/**
 * 本机装了哪些 dsh（候选安装根目录）。两处用途：查找底稿，以及自检区分
 * 「本机没装 dsh」（跳过）与「装了却读不到它的预设」（那是查找链坏了，必须红）。
 */
export function dshInstallRoots() {
	const roots = [];
	// 判据是「exe 旁边有没有 resources/app.asar」，不是文件名 —— 改名版/便携版 Electron
	// 认不出来，而直接用 node 跑时旁边自然没有（于是这一条自动跳过）。
	const exeDir = path.dirname(process.execPath ?? "");
	if (fs.existsSync(path.join(exeDir, "resources", "app.asar"))) roots.push(exeDir);
	const parents = [];
	if (process.env.LOCALAPPDATA) parents.push(path.join(process.env.LOCALAPPDATA, "Programs"));
	for (const key of ["PROGRAMFILES", "PROGRAMFILES(X86)"]) if (process.env[key]) parents.push(process.env[key]);
	for (const parent of parents) {
		try {
			for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
				if (entry.isDirectory()) roots.push(path.join(parent, entry.name));
			}
		} catch {
			/* 目录不存在就跳过 */
		}
	}
	// 排序只为确定性：两个安装并存时按名字固定挑一个，不随 readdir 顺序飘
	return roots.sort();
}

/** PATH 上找 dsh —— 拿它反推安装树（profile 的 node_modules 里没有 @deepseek-ai/*） */
export function whichDsh() {
	const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir.trim() === "") continue;
		for (const name of names) {
			const file = path.join(dir, name);
			if (!fs.existsSync(file)) continue;
			try {
				return fs.realpathSync(file);
			} catch {
				return file;
			}
		}
	}
	return null;
}

/**
 * 找到 dsh 自带的 standard 预设**原文**，返回 `{ text, label }`（读不到返回 null）。
 *
 * 为什么不是「返回一个文件路径」：命中点可能在 asar **里面**，那种路径 `fs.readFileSync`
 * 读不了 —— 与其让调用方各自处理两种来源，不如这里就把原文取出来。
 *
 * 候选顺序（命中即返回）：① 运行中的 Electron 安装（`process.execPath`）；
 * ② 常见安装位置扫一遍；③ PATH 反推的真实目录（Tauri 那种解包布局）；④ profile 的 node_modules。
 * **① ② 必须排在 ③ 前面**：本机 `.dshbin` 那个历史 junction 指向 **0.2.0-rc.2** 的旧底稿，
 * 若先命中它，会**静默**生成缺 `time-context` / `tool-schedule` / `tool-plugin-market`
 * 三条新行的预设，且没有任何报错。
 *
 * @param options - `{ profileDir }`：③④ 两条候选要用（自检可以传 undefined，只走 ①②）
 */
export function findRc2StandardPatch({ profileDir } = {}) {
	// ① ② 运行中的 Electron 安装 + 常见安装位置（都走 asar；见文件头的说明）
	for (const root of dshInstallRoots()) {
		const hit = standardFromInstall(root);
		if (hit) return hit;
	}
	// ③ PATH 反推的真实目录（解包布局：目录里就有 node_modules/@deepseek-ai/...）
	const seeds = [];
	const dshBin = whichDsh();
	if (dshBin) seeds.push(path.dirname(dshBin));
	if (profileDir) seeds.push(path.join(profileDir, "node_modules", ".bin"));
	for (const seed of seeds) {
		let dir = path.resolve(seed);
		for (let i = 0; i < 8; i++) {
			const file = path.join(dir, ...STANDARD_PRESET_REL);
			if (fs.existsSync(file)) return { text: fs.readFileSync(file, "utf8"), label: file };
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}
