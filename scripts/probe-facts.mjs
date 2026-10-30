#!/usr/bin/env node
/**
 * 一条命令拿全「代码事实」，省掉「先读一遍 → 写 → 写完再读一遍核对」。
 *
 * 为什么要有它：改一处配置/状态词之前，我每次都要 grep 五六处确认「真源在哪、几处漂移了」，
 * 改完又 grep 一遍核对 —— 同样的信息被读两次、付两次 cacheRead。这里一次性算完。
 *
 * 与 `doctor` 的分工（别重叠）：
 *   - probe-facts = **代码事实**：版本三处、状态词、阈值、inject 清单、rtk/lens 会不会生效
 *   - doctor      = **环境体检**：安装树、预设产物新鲜度、profile 接线、预设能否被真宿主接受
 *
 * 用法：
 *   node scripts/probe-facts.mjs            # 全部
 *   node scripts/probe-facts.mjs version    # 只跑某一节（可多个）
 *   node scripts/probe-facts.mjs --json     # 给 CI / 工具用
 * 退出码：有任何「漂移」（✗）→ 1，否则 0。只读，不改任何东西。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const read = (p) => fs.readFileSync(p, "utf8");
const j = (p) => JSON.parse(read(p));

const findings = [];
const say = (level, where, text) => {
	findings.push({ level, where, text });
	const mark = level === "bad" ? "✗" : level === "warn" ? "⚠" : "✓";
	console.log(`  ${mark} ${where.padEnd(22)} ${text}`);
};

/** 第一条匹配的捕获组 */
function grab(text, re) {
	const m = text.match(re);
	return m ? m[1] : undefined;
}
/** 所有匹配的捕获组，去重保序（re 必须带 g） */
function grabAll(text, re) {
	const out = [];
	for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
	return out;
}
/** 行号（给「谁在硬编码」那类报告用） */
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

// —— 1. 版本三处：package.json / CHANGELOG 首个标题 / git tag ——
function sectionVersion() {
	console.log("\n[version] 版本三处是否一致");
	const pkg = j(path.join(ROOT, "package.json")).version;
	const first = grab(read(path.join(ROOT, "CHANGELOG.md")), /^## \[([0-9][^\]]*)\]/m);
	say(pkg === first ? "ok" : "bad", "package.json", pkg);
	say(pkg === first ? "ok" : "bad", "CHANGELOG 首个", first ?? "（没有 `## [x.y.z]` 标题）");
	try {
		const tags = execFileSync("git", ["tag", "--list", `v${pkg}`], { cwd: ROOT, encoding: "utf8" }).trim();
		say(tags === `v${pkg}` ? "ok" : "warn", "git tag", tags || `（还没有 v${pkg}，发版时补 git tag -a v${pkg}）`);
	} catch {
		say("warn", "git tag", "读不到 git（不在仓库里就跑不了这条）");
	}
}

// —— 2. 小队：状态词与上限的真源，以及「谁还在按状态词判收工」——
function sectionSquad() {
	console.log("\n[squad] 状态词 / 上限 / 硬编码漂移");
	const src = read(path.join(ROOT, "lib/squad.js"));
	const memberRaw = grab(src, /export const MEMBER_STATUS = \[([^\]]+)\]/);
	const terminalRaw = grab(src, /export const TERMINAL_STATUS = \[([^\]]+)\]/);
	const words = (s) =>
		(s ?? "")
			.split(",")
			.map((x) => x.trim().replace(/^"|"$/g, ""))
			.filter(Boolean);
	say("ok", "MEMBER_STATUS", words(memberRaw).join(" / ") || "（没找到）");
	say("ok", "TERMINAL_STATUS", words(terminalRaw).join(" / ") || "（没找到）");
	const missing = words(terminalRaw).filter((w) => !words(memberRaw).includes(w));
	say(missing.length === 0 ? "ok" : "bad", "终态 ⊆ 状态词", missing.length ? `缺：${missing.join(" / ")}` : "是");

	const loop = read(path.join(ROOT, "lib/squad-loop.js"));
	const srcSteps = Number(grab(loop, /maxSteps:\s*(\d+)/));
	const fileSteps = j(path.join(ROOT, "team/extensions/squad.json")).limits?.maxSteps;
	say("ok", "maxSteps 真源", String(srcSteps));
	say(fileSteps === srcSteps ? "ok" : "bad", "出厂文件 maxSteps", `${fileSteps}（真源 ${srcSteps}）`);

	// 谁还在用 `status === "完成"` 判收工 —— 加状态词时这些地方会漏
	const offenders = [];
	for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
		if (!f.endsWith(".js")) continue;
		const t = read(path.join(ROOT, "lib", f));
		for (const m of t.matchAll(/status\s*(?:===|!==)\s*"(?:完成|卡住)"/g)) offenders.push(`${f}:${lineAt(t, m.index)}`);
	}
	say(offenders.length === 0 ? "ok" : "warn", "按状态词判收工", offenders.join("  ") || "没有（都用 isSettled）");
}

// —— 3. 客户端契约：inject 清单与注册的槽位 ——
function sectionClient() {
	console.log("\n[client] inject 清单与槽位");
	const src = read(path.join(ROOT, "lib/client.js"));
	say("ok", "inject", grab(src, /const inject = \[([^\]]+)\]/) ?? "（没找到）");
	const slots = grabAll(src, /ctx\.slots\.inject\("([^"]+)"/g);
	const regs = grabAll(src, /ctx\.slots\.register\(\s*\{[^}]*?name:\s*"([^"]+)"/g);
	say("ok", "injects 槽位", slots.join(" / ") || "（没有）");
	say("ok", "registers 槽位", regs.join(" / ") || "（没有）");
	const orphan = slots.filter((s) => !regs.includes(s));
	say(orphan.length === 0 ? "ok" : "warn", "inject 无 register", orphan.join(" / ") || "无");
}

// —— 4. 压缩阈值：dsh 与 mc 的不变式（mc 必须更早触发，否则永不出手）——
function sectionCompact() {
	console.log("\n[compact] 阈值与 mc 不变式");
	const json = read(path.join(ROOT, "team/agent-settings.json"));
	const ratio = grab(json, /"compactThresholdRatio":\s*([0-9.]+)/);
	const window = grab(json, /"contextWindow":\s*(\d+)/);
	say("ok", "dsh 阈值", ratio ? `${ratio}（× ${window} = ${Math.round(Number(ratio) * Number(window))} 触发）` : "（没找到）");
	const mc = grab(read(path.join(ROOT, "team/mc-config.template.jsonc")), /"execute_threshold_percentage":\s*([0-9.]+)/);
	say("ok", "mc 阈值", mc ? `${mc}%` : "（没找到）");
	if (ratio && mc) {
		const margin = Number(ratio) * 100 - Number(mc);
		say(margin >= 2 ? "ok" : "bad", "mc < dsh 且 ≥2", `差 ${margin.toFixed(1)} 个百分点`);
	}
}

// —— 5. rtk / lens 会不会生效（这俩都是「装了但静默关掉」的常客）——
async function sectionRuntime() {
	console.log("\n[runtime] rtk / lens 会不会生效");
	const rtk = await import(new URL("../lib/rtk.js", import.meta.url).href);
	const exe = rtk.resolveRtk(undefined);
	say(exe ? "ok" : "bad", "rtk 可执行文件", exe ? rel(exe) : "没解析到（tools/ 与 PATH 都没有 → 输出压缩全关）");
	const lens = await import(new URL("../lib/lens.js", import.meta.url).href);
	const found = lens.resolveLens(new URL("../", import.meta.url));
	say(found ? "ok" : "warn", "pi-lens", found ? rel(found.cli) : "没找到（vendor/ 与 ~/.pi 都没有 → lens 全关）");
}

// —— 6. 工具面：成员被 deny 掉了哪些、注册了多少 ——
function sectionTools() {
	console.log("\n[tools] 工具面与成员护栏");
	const deny = grab(read(path.join(ROOT, "lib/squad-agent.js")), /MEMBER_DENY_TOOLS = \[([^\]]+)\]/);
	say("ok", "成员 deny", (deny ?? "（没找到）").replace(/\s+/g, " ").trim());
	const count = grabAll(read(path.join(ROOT, "lib/index.js")), /name:\s*"([a-z][a-z0-9_]+)"/g).length;
	say("ok", "工具声明数", String(count));
}

const SECTIONS = {
	version: sectionVersion,
	squad: sectionSquad,
	client: sectionClient,
	compact: sectionCompact,
	runtime: sectionRuntime,
	tools: sectionTools,
};

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const wanted = argv.filter((a) => !a.startsWith("--"));
const names = wanted.length > 0 ? wanted : Object.keys(SECTIONS);
const unknown = names.filter((n) => SECTIONS[n] === undefined);
if (unknown.length > 0) {
	console.error(`不认识的节：${unknown.join(" / ")}\n可用：${Object.keys(SECTIONS).join(" / ")}`);
	process.exit(2);
}

if (!asJson) console.log(`代码事实探针 · ${path.basename(ROOT)}`);
for (const name of names) await SECTIONS[name]();

const bad = findings.filter((f) => f.level === "bad");
const warn = findings.filter((f) => f.level === "warn");
if (asJson) {
	console.log(JSON.stringify({ root: ROOT, findings, bad: bad.length, warn: warn.length }, null, 2));
} else {
	console.log(`\n合计 ${findings.length} 项：✗ ${bad.length} · ⚠ ${warn.length} · ✓ ${findings.length - bad.length - warn.length}`);
	if (bad.length > 0) console.log("✗ 的项就是真漂移，别当噪声。");
}
process.exit(bad.length > 0 ? 1 : 0);
