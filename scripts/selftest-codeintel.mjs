#!/usr/bin/env node
/**
 * 自检：代码情报（repo_map / symbol_refs，REQ-033）。
 *
 * 盯的是三类事：
 *   1. 跳过表真的生效 —— 把 node_modules 扫进来会让「省 token」变成「灌上下文」；
 *   2. 词边界真的生效 —— `alpha` 命中 `alphabet` 会让定位结果整批失真；
 *   3. 输出上限真的生效 —— 上限失效等于把一个仓库塞进一条工具结果。
 * 另外验一次「配置文件里的键都能被校验器接受」，防模板与校验器漂移。
 *
 * 不引测试框架（零依赖）。断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	CODEINTEL_DEFAULTS,
	CODEINTEL_FIELDS,
	buildRepoMap,
	extractSymbols,
	findReferences,
	installCodeintel,
	isDefinitionLine,
	makeWordMatcher,
	scanFiles,
} from "../lib/codeintel.js";
import { readJsonConfig } from "../lib/util.js";

const ROOT = path.resolve(import.meta.dirname, "..");

// ── 造一个真仓库当 fixture ───────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codeintel-"));
const write = (rel, text) => {
	const abs = path.join(tmp, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text);
	return abs;
};

write("src/a.js", [
	"export function alpha(x) {",
	"\treturn alphabet(x) + alphaBeta;",
	"}",
	"export const gamma = 1;",
	"class Delta {}",
	"function innerAlpha() {}",
	"",
].join("\n"));
write("src/b.py", "def alpha():\n    return 1\n\nclass Epsilon:\n    pass\n");
write("lib/util.ts", "export function beta(): number {\n\treturn alpha(1);\n}\n");
write("src/sub/deep/c.ts", "export const deepOne = 1;\n");
// 下面这些**都不该**出现在结果里
write("node_modules/pkg/index.js", "export function alpha() { return 'not-me'; }\n");
write("dist/bundle.js", "export function alpha() { return 'bundled'; }\n");
write(".git/objects/x.js", "export function alpha() {}\n");
write("assets/logo.png", "PNG\u0000\u0000binary");
// 含 NUL 的 .js —— 二进制伪装成源码，必须被 isSourceFile 挡掉
write("src/fake.js", "const alpha = 1;\u0000\u0000\u0000\n");

const scanOpts = {
	maxFiles: CODEINTEL_DEFAULTS.maxFiles,
	maxFileBytes: CODEINTEL_DEFAULTS.maxFileBytes,
	depth: 12,
};
const files = scanFiles(tmp, scanOpts);

// ── 1. 扫描：跳过表 ──────────────────────────────────────────────────────────

{
	const rels = files.map((f) => f.rel).sort();
	assert.deepEqual(rels, ["lib/util.ts", "src/a.js", "src/b.py", "src/sub/deep/c.ts"], `意外文件集：${rels.join(",")}`);
	assert.ok(!rels.some((r) => r.includes("node_modules")), "node_modules 不应被扫进来");
	assert.ok(!rels.some((r) => r.startsWith("dist/")), "dist 不应被扫进来");
	assert.ok(!rels.some((r) => r.startsWith(".git/")), ".git 不应被扫进来");
	assert.ok(!rels.includes("src/fake.js"), "含 NUL 的文件应被判为二进制并跳过");
	assert.ok(!rels.includes("assets/logo.png"), "非源码扩展名不应被扫");
	console.log("✓ 跳过表：node_modules/dist/.git/二进制/非源码");
}

// ── 2. 符号提取 ──────────────────────────────────────────────────────────────

{
	const js = fs.readFileSync(path.join(tmp, "src/a.js"), "utf8");
	const syms = extractSymbols(js, 20);
	const names = syms.map((s) => s.name);
	assert.ok(names.includes("alpha"), "export function alpha 应被识别");
	assert.ok(names.includes("gamma"), "export const gamma 应被识别");
	assert.ok(names.includes("Delta"), "class Delta 应被识别");
	assert.ok(names.includes("innerAlpha"), "普通 function 也应识别（不是只有 export）");
	assert.equal(names.filter((n) => n === "alpha").length, 1, "同名只留第一次");
	assert.equal(syms.find((s) => s.name === "alpha").kind, "fn");
	assert.equal(syms.find((s) => s.name === "Delta").kind, "class");

	const py = extractSymbols(fs.readFileSync(path.join(tmp, "src/b.py"), "utf8"), 20);
	assert.deepEqual(py.map((s) => s.name), ["alpha", "Epsilon"], `python 符号：${py.map((s) => s.name).join(",")}`);
	assert.equal(py[0].kind, "fn");
	assert.equal(py[1].kind, "class", "python 的 class 与 js 的 class 同义，kind 不必再分 type");

	const capped = extractSymbols(js, 2);
	assert.equal(capped.length, 2, "maxSymbols 必须生效");

	// 关键词不能被当成方法名
	const noisy = extractSymbols("if (x) {\n\twhile (y) {\n", 20);
	assert.deepEqual(noisy, [], `控制流关键字不该被识别成符号：${JSON.stringify(noisy)}`);
	console.log("✓ 符号提取：js/py、kind、去重、上限、关键字排除");
}

// ── 3. 词边界与定义判定 ──────────────────────────────────────────────────────

{
	const m = makeWordMatcher("alpha");
	assert.equal(m.test("const y = alpha(1)"), true);
	assert.equal(m.test("f(alpha)"), true);
	assert.equal(m.test("x = alpha;"), true);
	assert.equal(m.test("alphabet()"), false, "alpha 不应命中 alphabet");
	assert.equal(m.test("alphaBeta"), false, "alpha 不应命中 alphaBeta");
	assert.equal(m.test("my_alpha"), false, "alpha 不应命中 my_alpha（标识符内）");
	assert.equal(makeWordMatcher("installCodeintel").test("installCodeintel(ctx)"), true);
	assert.equal(makeWordMatcher("$q").test("const $q = 1"), true, "带 $ 的名字不能被转义吃掉");

	assert.equal(isDefinitionLine("export function alpha(x) {", "alpha"), true);
	assert.equal(isDefinitionLine("  def alpha():", "alpha"), true);
	assert.equal(isDefinitionLine("const y = alpha(1)", "alpha"), false, "调用行不是定义行");
	assert.equal(isDefinitionLine("export function alphabet() {}", "alpha"), false, "前缀相同不算定义");
	console.log("✓ 词边界与定义判定");
}

// ── 4. repo_map 输出 ─────────────────────────────────────────────────────────

{
	const map = buildRepoMap(files, {
		maxSymbolsPerFile: 10,
		maxOutputChars: CODEINTEL_DEFAULTS.maxOutputChars,
		rootLabel: "@ fixture",
	});
	assert.ok(map.includes("src/a.js"), "地图要含文件路径");
	assert.ok(map.includes("alpha"), "地图要含导出符号");
	assert.ok(map.includes("lib/util.ts"), "地图要含子目录文件");
	assert.ok(!map.includes("node_modules"), "地图里不应出现 node_modules");
	assert.ok(!map.includes("dist/bundle.js"), "地图里不应出现 dist");

	const focused = buildRepoMap(files, {
		focus: "src/",
		maxSymbolsPerFile: 10,
		maxOutputChars: CODEINTEL_DEFAULTS.maxOutputChars,
	});
	assert.ok(focused.includes("src/a.js") && !focused.includes("lib/util.ts"), "focus 子串过滤应生效");

	const tiny = buildRepoMap(files, { maxSymbolsPerFile: 10, maxOutputChars: 80 });
	assert.ok(tiny.length <= 80 + 120, `截断后长度失控：${tiny.length}`);
	assert.ok(tiny.includes("已截断"), "截断必须有提示，否则模型以为这就是全部");
	console.log("✓ repo_map：路径/符号/focus/截断");
}

// ── 5. symbol_refs 输出 ─────────────────────────────────────────────────────

{
	const rep = findReferences(files, "alpha", { maxHits: 60, maxOutputChars: 24_000 });
	// fixture 在 js 与 py 里各定义一次 alpha —— 两处都该算定义，这是跨语言同名混合的预期行为
	assert.ok(rep.includes("定义 2 处"), `定义数应为 2（src/a.js:1 + src/b.py:1），实际：${rep.split("\n")[0]}`);
	assert.ok(rep.includes("== 定义 ==") && rep.includes("src/a.js:1"), "定义段要指到 src/a.js:1");
	assert.ok(rep.includes("src/b.py:1"), "定义段要指到 src/b.py:1");
	assert.ok(rep.includes("== 引用 =="), "引用段应在");
	assert.ok(rep.includes("lib/util.ts"), "util.ts 里调用了 alpha，应被算作引用");
	assert.ok(!rep.includes("alphabet(x)") || !rep.includes("src/a.js:2  \treturn alphabet"), "alphabet 行不应被当作 alpha 的命中");

	const none = findReferences(files, "doesNotExist", { maxHits: 10, maxOutputChars: 1000 });
	assert.ok(none.includes("没找到"), "零命中要给明确文案");

	const capped = findReferences(files, "alpha", { maxHits: 1, maxOutputChars: 24_000 });
	assert.equal(capped.split("\n").filter((l) => l.includes("src/") || l.includes("lib/")).length, 1, "maxHits 必须生效");
	console.log("✓ symbol_refs：定义/引用分组、词边界、零命中、上限");
}

// ── 6. 真挂两个工具（假 ctx 照 cordis 语义：没有任何多余属性）──────────────

{
	const registered = new Map();
	const ctx = {
		tools: {
			register(def) {
				registered.set(def.name, def);
				return () => registered.delete(def.name);
			},
		},
		logger: { info() {}, warn() {} },
		effect(fn) {
			return fn;
		},
	};
	const inst = installCodeintel(ctx, {});
	assert.equal(inst.enabled, true);
	assert.deepEqual([...registered.keys()].sort(), ["repo_map", "symbol_refs"], "应恰好注册两个工具");

	const exec = { agent: { session: { header: { cwd: tmp } } } };
	const mapTool = registered.get("repo_map");
	const out1 = await mapTool.execute({}, exec);
	assert.ok(out1.map.includes("src/a.js"), "repo_map 真跑应含 fixture 文件");
	assert.ok(out1.map.includes(tmp), "输出应带根目录标签，便于确认扫的是哪儿");

	const refTool = registered.get("symbol_refs");
	const out2 = await refTool.execute({ symbol: "alpha" }, exec);
	assert.ok(out2.report.includes("src/a.js:1"), "symbol_refs 真跑应指到定义行");

	// 默认 cwd 走 exec；path 显式给相对路径时要相对会话目录解析
	const out3 = await refTool.execute({ symbol: "beta", path: "src/sub" }, exec);
	assert.ok(out3.report.includes("没找到") || out3.report.includes("扫 1 个文件"), `相对 path 应只扫该子目录：${out3.report.split("\n")[0]}`);

	// 关掉时不注册任何工具
	const empty = new Map();
	const off = installCodeintel({ tools: { register: (d) => (empty.set(d.name, d), () => {}) }, logger: {} }, { enabled: false });
	assert.equal(off.enabled, false);
	assert.equal(empty.size, 0, "enabled=false 时不应注册工具");
	inst.dispose();
	console.log("✓ 真挂载：两个工具、相对路径、关闭开关");
}

// ── 7. 配置文件里的键必须都被校验器接受（防模板漂移）────────────────────────

{
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(path.join(ROOT, "team/extensions/codeintel.json"), "utf8"));
	} catch (err) {
		throw new Error(`team/extensions/codeintel.json 不是合法 JSON：${err?.message ?? err}`);
	}
	const accepted = readJsonConfig(path.join(ROOT, "team/extensions/codeintel.json"), {}, CODEINTEL_FIELDS);
	const keys = Object.keys(raw).filter((k) => !k.startsWith("_"));
	for (const k of keys) {
		assert.ok(Object.hasOwn(CODEINTEL_FIELDS, k), `配置里的 \`${k}\` 没有对应校验器 —— 会被静默丢掉`);
		assert.equal(accepted[k], raw[k], `配置里的 \`${k}\` 没读进默认值（值不合法？）`);
	}
	assert.equal(raw.enabled, true, "出厂应默认启用");
	console.log("✓ 出厂配置与校验器一致");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ codeintel 自检全部通过");
