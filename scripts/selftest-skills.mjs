#!/usr/bin/env node
/**
 * 自检：技能目录完整性（REQ-045）。
 *
 * 仓库里有两套约定，都要认：
 *   - `skills/<名字>/SKILL.md` —— 一个目录一个技能（`kb-*` 知识库、ai-search 等）
 *   - `skills/<分组>/*.md`     —— 一个文件一个技能（`redteam/` 那 24 个）
 *
 * 盯五件事：
 *   1. frontmatter 有 name + description
 *   2. 目录式技能的 name 必须与目录名一致（dsh 按 name 识别）
 *   3. description ≤120 字符 —— 它进的是**常驻 catalog**，一条超长就长期占地板
 *   4. 没有重名
 *   5. **条目表里点名的文件必须真实存在** + kb-* 里不许留源插件的死链
 *      —— 复制知识库时漏文件不会报错，只会让模型 read 到 ENOENT
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const SKILLS = path.join(import.meta.dirname, "..", "skills");
let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

const dirs = fs.readdirSync(SKILLS).filter((d) => fs.statSync(path.join(SKILLS, d)).isDirectory());

/** 收集技能单元：目录式（SKILL.md）与文件式（分组下每个 .md）。 */
const units = [];
for (const dir of dirs) {
	const skillFile = path.join(SKILLS, dir, "SKILL.md");
	if (fs.existsSync(skillFile)) {
		units.push({ dir, file: skillFile, mustMatchDir: true });
	} else {
		for (const f of fs.readdirSync(path.join(SKILLS, dir)).filter((x) => x.endsWith(".md"))) {
			units.push({ dir, file: path.join(SKILLS, dir, f), mustMatchDir: false });
		}
	}
}
assert.ok(units.length > 0, "一个技能都没找到 —— 路径错了");

const problems = [];
const seen = new Map();
for (const u of units) {
	const rel = path.relative(SKILLS, u.file);
	const text = fs.readFileSync(u.file, "utf8");
	const name = (text.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
	const desc = (text.match(/^description:\s*(.+)$/m) || [])[1]?.trim();
	if (!name) problems.push(`${rel}: 缺 name`);
	if (!desc) problems.push(`${rel}: 缺 description`);
	else if (desc.length > 120) problems.push(`${rel}: description ${desc.length} 字符 >120（常驻占地板）`);
	if (u.mustMatchDir && name && name !== u.dir) problems.push(`${rel}: name「${name}」与目录名「${u.dir}」不一致`);
	if (name) {
		if (seen.has(name)) problems.push(`重名：${name}（${seen.get(name)} 与 ${rel}）`);
		seen.set(name, rel);
	}
}
assert.deepEqual(problems, [], `技能目录有问题：\n  ${problems.join("\n  ")}`);
ok(`${units.length} 个技能（${dirs.length} 个目录）的 name/description 都自洽`);

// 条目表引用 & 死链：只查 kb-* 知识库（结构最规整，也最容易漏文件）
{
	const missing = [];
	const dead = [];
	for (const dir of dirs.filter((d) => d.startsWith("kb-"))) {
		const root = path.join(SKILLS, dir);
		const text = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
		for (const m of text.matchAll(/^\|\s*`([^`]+\.md)`\s*\|/gm)) {
			if (!fs.existsSync(path.join(root, m[1]))) missing.push(`${dir}: 条目表提到 ${m[1]}，文件不存在`);
		}
		const walk = (p) => {
			for (const f of fs.readdirSync(p, { withFileTypes: true })) {
				const full = path.join(p, f.name);
				if (f.isDirectory()) walk(full);
				else if (f.isFile() && f.name.endsWith(".md")) {
					if (/dsh-prompt-custom|127\.0\.0\.1:54\d|campaign_upsert|pipeline_next|finding_upsert/.test(fs.readFileSync(full, "utf8"))) {
						dead.push(path.relative(SKILLS, full));
					}
				}
			}
		};
		walk(root);
	}
	assert.deepEqual(missing, [], `条目表指向了不存在的文件：\n  ${missing.join("\n  ")}`);
	ok("kb-* 的条目表指向的文件都在");

	assert.deepEqual(dead, [], `这些文件还留着源插件的死链（我们没有那些接口）：${dead.join(", ")}`);
	ok("kb-* 里没有源插件的死链");
}

console.log(`\nselftest-skills：${passed} 项全过`);
