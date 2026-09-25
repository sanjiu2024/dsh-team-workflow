#!/usr/bin/env node
/**
 * 自检：思考链/工具行默认展开的补丁逻辑。
 *
 * 在一个临时 dsh 安装树上跑完整的 apply → status → restore 流程
 * （树里的 client.js 从上游真文件拷小片段，不是真安装树，测试不碰真实环境）。
 * 断言失败直接抛，退出码非 0。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch, patchBundle, patchStatus, restorePatch, TARGETS } from "../lib/chat-expand.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-patch-"));
process.on("exit", () => fs.rmSync(tempHome, { recursive: true, force: true }));

/** 读一个测试自己要用的 JSON 文件；坏了就当场报错，不要留个 undefined 在后面装蒜 */
function readTestJson(file) {
	const text = fs.readFileSync(file, "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`测试夹具坏了：${file} 不是合法 JSON（${error.message}）`);
	}
}

// —— fixture ——

/** 一份最小可用的 client.js：组件名与 `useState(false)` 的行都照抄上游形状 */
function bundleFor(components) {
	return [
		"window.__ModuleLoader__.load({",
		'\tid: "fixture",',
		"\tfactory: (require) => {",
		"\t\tvar react = require(\"react\");",
		...components.flatMap(([name, stateVar]) => [
			`\t\tfunction ${name}({ t }) {`,
			`\t\t\tconst [${stateVar}, set${stateVar[0].toUpperCase()}${stateVar.slice(1)}] = (0, react.useState)(false);`,
			"\t\t\treturn null;",
			"\t\t}",
		]),
		"\t\tfunction notATarget() {",
		"\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);",
		"\t\t\treturn null;",
		"\t\t}",
		"\t\treturn { apply: () => {} };",
		"\t}",
		"});",
		"",
	].join("\n");
}

/** 造一个假安装树：profilesRoot/<profile>/node_modules/<pkg>/… */
function makeProfile(profilesRoot, profile, pkg, text) {
	const dir = path.join(profilesRoot, profile, "node_modules", ...pkg.split("/"));
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: pkg, version: "0.0.0" })}\n`);
	const file = path.join(dir, "lib", "client.js");
	fs.writeFileSync(file, text);
	// profile 自己要有 package.json，discoverBundles 才认它
	fs.writeFileSync(path.join(profilesRoot, profile, "package.json"), `${JSON.stringify({ name: `fixture-${profile}` })}\n`);
	return file;
}

const CHAT = "@deepseek-ai/dsh-client-ui-chat";
const TOOL = "@deepseek-ai/dsh-client-ui-tool";
const profilesRoot = path.join(tempHome, "profiles");
const chatFile = makeProfile(profilesRoot, "tauri", CHAT, bundleFor([["ReasoningRow", "expanded"]]));
const toolFile = makeProfile(profilesRoot, "tauri", TOOL, bundleFor([["ToolRow", "expanded"], ["BashRow", "expanded"]]));

// —— 1. 纯函数：只改命中那一行 ——

{
	const text = bundleFor([["ReasoningRow", "expanded"], ["CompactionItem", "expanded"]]);
	const result = patchBundle(text, TARGETS[0]);
	assert.equal(result.status, "patched");

	const before = text.split("\n");
	const after = result.text.split("\n");
	const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
	assert.equal(changed.length, 1, "只应有 1 行变化");
	assert.equal(before[changed[0] - 1], "\t\tfunction ReasoningRow({ t }) {", "改的应该是 ReasoningRow 的函数体");
	assert.equal(after[changed[0]].includes(")(true)"), true, "改的那行应变成 true");
	// 只改这一个组件的态：全文只应出现一处 true，其余仍为 false
	assert.equal(result.text.match(/\)\(true\)/g).length, 1);
	assert.equal(result.text.match(/\)\(false\)/g).length, 2);

	// 幂等：再打一次不改动
	const again = patchBundle(result.text, TARGETS[0]);
	assert.equal(again.status, "already");
	assert.equal(again.text, result.text);
}

// —— 2. 上游改名 / 结构变化要认得出来，不能静默失效 ——

assert.equal(patchBundle("function Other() {}", TARGETS[0]).status, "missing", "组件都没了就报 missing");
// 组件在、但里面没有那个 useState（上游改了初始化方式）——“unexpected” 必须能被认出来，
// 否则上游一变我们就静默失效
assert.equal(
	patchBundle("\n\t\tfunction ReasoningRow() {\n\t\t\tconst x = 1;\n\t\t}", TARGETS[0]).status,
	"unexpected",
);
assert.equal(
	patchBundle("\n\t\tfunction ReasoningRow() {\n\t\t\tconst [open, setOpen] = useState(false);\n\t\t}", TARGETS[0]).status,
	"unexpected",
);

// —— 3. 端到端：apply → status → restore，且不认识的行不动 ——

const original = fs.readFileSync(chatFile, "utf8");
{
	const rows = applyPatch({ dshHome: tempHome, profilesRoot });
	assert.equal(rows.length, 2, "应发现 chat 与 tool 两个 bundle");
	assert.ok(!rows.some((row) => row.error), `补丁后语法检查应通过：${JSON.stringify(rows)}`);

	assert.match(fs.readFileSync(chatFile, "utf8"), /useState\)\(true\)/);
	assert.match(fs.readFileSync(toolFile, "utf8"), /useState\)\(true\)/);
	// 非目标组件保持折叠
	assert.match(fs.readFileSync(toolFile, "utf8"), /function notATarget\(\) \{\n\t\t\tconst \[expanded, setExpanded\] = \(0, react\.useState\)\(false\);/);

	// 幂等：重复 apply 不重复写、不报错
	const afterFirst = fs.readFileSync(chatFile, "utf8");
	const second = applyPatch({ dshHome: tempHome, profilesRoot });
	assert.ok(second.every((row) => row.headers.every((h) => h.status === "already")), "重复 apply 应全是 already");
	assert.equal(fs.readFileSync(chatFile, "utf8"), afterFirst, "重复 apply 不该再动文件");

	// dry-run 只算不写
	const beforeDry = fs.readFileSync(chatFile, "utf8");
	assert.ok(applyPatch({ dshHome: tempHome, profilesRoot, dryRun: true }).every((row) => row.headers.every((h) => h.status === "already")));
	assert.equal(fs.readFileSync(chatFile, "utf8"), beforeDry, "dry-run 不该写盘");

	// 状态查询
	const status = patchStatus({ dshHome: tempHome, profilesRoot });
	const chatRow = status.find((row) => row.file === chatFile);
	assert.deepEqual(chatRow.targets.map((t) => t.status), ["patched"]);

	// restore 回到逐字节一致
	const restored = restorePatch({ dshHome: tempHome });
	assert.ok(restored.every((row) => row.status === "restored"), JSON.stringify(restored));
	assert.equal(fs.readFileSync(chatFile, "utf8"), original);
	assert.deepEqual(patchStatus({ dshHome: tempHome, profilesRoot }).find((r) => r.file === chatFile).targets, [
		{ label: "思考链", status: "unpatched" },
	]);
	assert.equal(restorePatch({ dshHome: tempHome }).length, 0, "还原两次应无事可做");
}

// —— 4. restore 不覆盖用户手改过的文件 ——

{
	applyPatch({ dshHome: tempHome, profilesRoot });
	fs.writeFileSync(chatFile, `${fs.readFileSync(chatFile, "utf8")}\n// 用户自己又改过\n`);
	const rows = restorePatch({ dshHome: tempHome });
	const chatRow = rows.find((row) => row.file === chatFile);
	assert.equal(chatRow.status, "modified", "内容被动过就该跳过");
	assert.ok(fs.readFileSync(chatFile, "utf8").includes("用户自己又改过"));
}

// —— 5. dsh 升级换掉同路径文件后：重新 apply 要刷新备份，restore 不能把客户端降级 ——

{
	// 清掉上一节留下的脏状态，从干净的原始树重来
	fs.writeFileSync(chatFile, original);
	fs.rmSync(path.join(tempHome, "team-workflow"), { recursive: true, force: true });

	applyPatch({ dshHome: tempHome, profilesRoot });
	// 模拟 dsh 升级：同路径换成新版上游原文（组件仍在，仍是折叠态）
	const upgraded = bundleFor([["ReasoningRow", "expanded"]]).replace('id: "fixture"', 'id: "fixture-v2"');
	fs.writeFileSync(chatFile, upgraded);

	applyPatch({ dshHome: tempHome, profilesRoot });
	assert.match(fs.readFileSync(chatFile, "utf8"), /useState\)\(true\)/, "新版也该被展开");

	const rows = restorePatch({ dshHome: tempHome });
	assert.equal(rows.find((r) => r.file === chatFile).status, "restored");
	assert.equal(fs.readFileSync(chatFile, "utf8"), upgraded, "restore 必须回到新版原文，而不是旧版");
}

// —— 6. 备份丢了：跳过并报告，不能半途崩 ——

{
	fs.writeFileSync(chatFile, original);
	fs.rmSync(path.join(tempHome, "team-workflow"), { recursive: true, force: true });
	applyPatch({ dshHome: tempHome, profilesRoot });

	const manifest = readTestJson(path.join(tempHome, "team-workflow", "patch-cache", "manifest.json"));
	const entry = Object.values(manifest).find((e) => e.file === chatFile);
	assert.ok(entry, "manifest 里应有这个文件的记录");
	fs.rmSync(entry.backup);

	const rows = restorePatch({ dshHome: tempHome });
	assert.equal(rows.find((r) => r.file === chatFile).status, "backup-missing");
	assert.match(fs.readFileSync(chatFile, "utf8"), /useState\)\(true\)/, "没备份就别乱动文件");
}

console.log("✓ 思考链/工具行展开补丁自检通过");
