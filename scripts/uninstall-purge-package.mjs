#!/usr/bin/env node
/**
 * 卸掉 profile 里**外部的** dsh-purge 包（REQ-028 收尾）。
 *
 * 为什么要单独一个脚本，而不是手改 package.json：
 *   1. 要一起处理三处（`dependencies`、`dsh.profile.bundles`、`node_modules` 目录），
 *      漏一处宿主就会去加载一个不存在的行 —— 表现是启动报错、而不是"少个功能"；
 *   2. 要**先备份再删**：本包接管 purge 之前如果出问题，用户得能一条命令回去；
 *   3. pnpm 硬链接：直接 `rm -rf node_modules/dsh-purge` 不会毁 store，但**改名保留**
 *      能让人在 30 秒内回滚（不用重下 GitHub release 的 tgz —— 上游已经停更）。
 *
 * 只动外部包。本包（dsh-team-workflow）自己的 purge 半边是包内代码，不在这里卸。
 *
 * 用法：
 *   node scripts/uninstall-purge-package.mjs --dry-run          # 只打印会做什么
 *   node scripts/uninstall-purge-package.mjs                    # 默认 profile=desktop
 *   node scripts/uninstall-purge-package.mjs --profile web
 *   node scripts/uninstall-purge-package.mjs --restore <备份目录>  # 回滚
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LEGACY = "dsh-purge";

const args = process.argv.slice(2);
const flag = (name) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const profileName = flag("profile") ?? "desktop";
const restoreDir = flag("restore");

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileDir = path.join(DSH_HOME, "profiles", profileName);
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

function fail(message) {
	console.error(`[uninstall] ${message}`);
	process.exit(1);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

// ── 回滚 ────────────────────────────────────────────────────────────────────
if (restoreDir) {
	const from = path.resolve(restoreDir);
	if (!fs.existsSync(from)) fail(`备份目录不存在：${from}`);
	const target = path.join(profileDir, "node_modules", LEGACY);
	if (fs.existsSync(target)) fail(`目标已存在：${target}（先手动挪走再回滚）`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.renameSync(from, target);
	const pkgFile = path.join(profileDir, "package.json");
	const pkg = readJson(pkgFile);
	if (pkg) {
		pkg.dependencies = { ...pkg.dependencies, [LEGACY]: `file:${from}` };
		const bundles = pkg?.dsh?.profile?.bundles;
		if (Array.isArray(bundles) && !bundles.includes(LEGACY)) bundles.push(LEGACY);
		fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
	}
	console.log(`✓ 已回滚：${target}`);
	console.log("  依赖已指回 file: 形式 —— 重启 dsh 生效。");
	process.exit(0);
}

// ── 卸载 ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(profileDir)) fail(`profile 不存在：${profileDir}（用 --profile 指定，例如 web / desktop）`);

const pkgFile = path.join(profileDir, "package.json");
const pkg = readJson(pkgFile);
if (!pkg) fail(`读不到 ${pkgFile}`);

const installedDir = path.join(profileDir, "node_modules", LEGACY);
const installedMeta = readJson(path.join(installedDir, "package.json"));
const depSpec = pkg.dependencies?.[LEGACY];
const inBundles = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(LEGACY);

const actions = [];
if (depSpec) actions.push(`从 dependencies 移除 ${LEGACY}: ${depSpec}`);
if (inBundles) actions.push(`从 dsh.profile.bundles 移除 ${LEGACY}`);
if (installedMeta?.name === LEGACY) actions.push(`把 node_modules/${LEGACY} 改名为备份（版本 ${installedMeta.version}）`);

if (actions.length === 0) {
	console.log(`✓ profile "${profileName}" 里已经没有 ${LEGACY} —— 不需要卸载。`);
	process.exit(0);
}

console.log(`profile: ${profileDir}`);
for (const action of actions) console.log(`  · ${action}`);
if (dryRun) {
	console.log("\n[dry-run] 什么都没改。");
	process.exit(0);
}

// 1. 备份 package.json
const pkgBackup = `${pkgFile}.bak-before-${LEGACY}-removal-${stamp}`;
fs.copyFileSync(pkgFile, pkgBackup);

// 2. 改 package.json（先写临时文件再 rename：半写坏会让 dsh 起不来）
if (depSpec) delete pkg.dependencies[LEGACY];
if (inBundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== LEGACY);
const tmp = `${pkgFile}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`);
fs.renameSync(tmp, pkgFile);

// 3. 备份包目录（改名，不删 —— 回滚是一条命令的事）
let backupDir;
if (installedMeta?.name === LEGACY) {
	backupDir = path.join(DSH_HOME, `${LEGACY}.pkg-backup-${stamp}`);
	fs.renameSync(installedDir, backupDir);
}

console.log("\n✓ 完成");
console.log(`  package.json 备份：${pkgBackup}`);
if (backupDir) console.log(`  包目录备份：      ${backupDir}`);
console.log(`\n下一步：**重启 dsh**（补丁与插件行都在启动时加载）。`);
console.log(`  重启后确认：purge_status 只剩一份注入；redteam_* 工具来自本包。`);
if (backupDir) {
	console.log(`  要回滚：node scripts/uninstall-purge-package.mjs --restore "${backupDir}"`);
}
