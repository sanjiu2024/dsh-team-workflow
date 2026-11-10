#!/usr/bin/env node
/**
 * 自检：本地语料检索 `kb_search`（REQ-043）。
 *
 * 盯四件事：
 *   1. 能真搜到，且**带 路径:行号**（省掉再读一遍文件的来回，这是它唯一的价值）
 *   2. 边界：二进制跳过、超大文件跳过、目录黑名单跳过（否则一次扫出海量文件）
 *   3. **没配置就不挂工具** —— 用不上的工具会一直占着模型的选择面
 *   4. 空查询不炸、没命中要说清下一步
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectFiles, formatHits, installKbSearch, readKbConfig, searchKb } from "../lib/kb-search.js";

let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

// 搭一个临时语料
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-test-"));
fs.mkdirSync(path.join(root, "notes"));
fs.mkdirSync(path.join(root, "node_modules"));
fs.writeFileSync(path.join(root, "a.md"), "第一行\n这里提到 codex 预算\n第三行\n");
fs.writeFileSync(path.join(root, "notes", "b.txt"), "另一份文档，也提到 codex 与 harness\n");
fs.writeFileSync(path.join(root, "node_modules", "skip.md"), "codex 不该被扫到\n");
fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0]));
fs.writeFileSync(path.join(root, "big.md"), `codex ${"x".repeat(600 * 1024)}`);

// 1. 真搜到 + 带行号
{
	const r = searchKb("CODEX", { roots: [root] });
	assert.equal(r.hits.length, 2, `应命中 2 条（大小写不敏感、跳过 node_modules/二进制/超大），实际 ${r.hits.length}`);
	assert.ok(r.hits.every((h) => h.file.endsWith(".md") || h.file.endsWith(".txt")), "命中的必须是文本文件");
	const withLine = r.hits.find((h) => h.file.endsWith("a.md"));
	assert.equal(withLine.line, 2, "行号要对（第 2 行有 codex）");
	const text = formatHits(r, "codex");
	assert.match(text, /a\.md:2:/, "渲染必须带 路径:行号");
	ok("命中带路径与行号（2 条，跳过黑名单/二进制/超大）");
}

// 2. 目录黑名单与扩展名过滤
{
	const files = collectFiles([root]);
	assert.ok(files.every((f) => !f.includes("node_modules")), "node_modules 没被跳过");
	assert.ok(files.every((f) => !f.endsWith(".dat")), "不在扩展名白名单的文件不该收");
	ok("目录黑名单与扩展名白名单生效");
}

// 3. 没配置就不挂
{
	const noCfg = installKbSearch({ tools: { register: () => assert.fail("没配置却注册了工具") } }, path.join(root, "nope"));
	assert.equal(noCfg.enabled, false);
	assert.match(noCfg.status, /未配置/);
	assert.equal(readKbConfig(path.join(root, "nope")), null, "没有配置文件要返回 null");
	ok("没配置就不挂工具");
}

// 4. 有配置就挂，且真跑一次
{
	const home = path.join(root, "home");
	fs.mkdirSync(home);
	fs.writeFileSync(path.join(home, "kb-roots.json"), JSON.stringify({ roots: [root] }));
	const cfg = readKbConfig(home);
	assert.ok(cfg && cfg.roots.length === 1, "配置读不出来");

	let registered = null;
	const ctx = { tools: { register: (def) => { registered = def; } } };
	const res = installKbSearch(ctx, home);
	assert.equal(res.enabled, true);
	assert.equal(registered.name, "kb_search");
	const out = await registered.execute({ query: "harness" });
	assert.match(out.text, /b\.txt:\d/, "工具跑出来的结果要带路径行号");
	ok("有配置就挂载，工具真跑一次能出结果");
}

// 5. 空查询 / 没命中
{
	assert.deepEqual(searchKb("", { roots: [root] }).hits, [], "空查询不该返回任何命中");
	assert.match(formatHits(searchKb("绝不存在", { roots: [root] }), "绝不存在"), /没有在语料里找到/, "没命中要说清");
	ok("空查询与没命中都不炸");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nselftest-kb-search：${passed} 项全过`);
