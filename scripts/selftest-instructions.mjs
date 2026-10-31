#!/usr/bin/env node
/**
 * 自检：`lib/instructions.js`（仓库外的个人指令注入）。
 *
 * 每条断言配一个能咬住它的变异（见 `docs/状态.md` 的规矩）：
 *   ① 缺文件 → 空串（变异：改成抛错/返回提示串 → 红）
 *   ② 按 mtime 缓存（变异：去掉 mtime 判断 → 改文件后不刷新 → 红）
 *   ③ 截断到 maxBytes 且带提示（变异：去掉截断 → 长度断言红）
 *   ④ **幂等**：连挂两次只注册一个段 —— 这是 dsh-purge 那个「同一段注两遍」
 *      直接对应的判据（变异：去掉 REGISTERED 判断 → 注册 2 次 → 红）
 *   ⑤ dispose 后能重挂（变异：dispose 里不删名字 → 只能挂一次 → 红）
 *   ⑥ enabled:false 不挂（变异：忽略 enabled → 红）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const m = await import("../lib/instructions.js");

let failed = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`✓ ${name}`);
	} catch (error) {
		failed++;
		console.log(`✗ ${name}`);
		console.log(`    ${error?.message ?? error}`);
	}
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selftest-instructions-"));
const file = path.join(dir, "instructions.md");
const fakeCtx = () => {
	const registered = [];
	return {
		registered,
		ctx: {
			systemPrompt: {
				section: (spec) => {
					registered.push(spec);
					return () => {};
				},
			},
		},
	};
};

check("① 文件不存在 → 空串，不抛也不写提示", () => {
	assert.equal(m.instructionsText(path.join(dir, "nope.md")), "");
});

check("② 按 mtime 缓存：改文件后立刻反映（同一进程不重启）", () => {
	fs.writeFileSync(file, "第一版");
	assert.equal(m.instructionsText(file), "第一版");
	fs.writeFileSync(file, "第二版");
	// mtime 分辨率可能是毫秒级；显式往前推一下制造确定的新 mtime
	const t = new Date(Date.now() + 2000);
	fs.utimesSync(file, t, t);
	assert.equal(m.instructionsText(file), "第二版", "改了文件却还返回旧内容 —— mtime 缓存判据失效");
});

check("③ 超过 maxBytes 截断，并说明截断", () => {
	fs.writeFileSync(file, "x".repeat(20000));
	const t = m.instructionsText(file, 1024);
	assert.ok(t.startsWith("x".repeat(1024)), "截断后开头不对");
	assert.ok(t.includes("已按 maxBytes"), "截断后没告诉模型它被截断了");
});

check("④ 幂等：连挂两次只注册一个段（dsh-purge 的重复注入就是缺这一步）", () => {
	const { ctx, registered } = fakeCtx();
	m.installInstructions(ctx, { file });
	m.installInstructions(ctx, { file });
	assert.equal(registered.length, 1, `连挂两次注册了 ${registered.length} 个段 —— 系统提示里会出现同样内容的多份`);
	assert.equal(registered[0].name, m.INSTRUCTIONS_SECTION);
	assert.equal(registered[0].order, m.INSTRUCTIONS_ORDER);
});

check("⑤ dispose 后能重新挂（HMR / 重启插件场景）", () => {
	const { ctx, registered } = fakeCtx();
	const dispose = m.installInstructions(ctx, { file });
	dispose();
	m.installInstructions(ctx, { file });
	assert.equal(registered.length, 2, "dispose 之后挂不上 —— 幂等标记没跟着回收");
});

check("⑥ enabled:false 一个都不挂", () => {
	const { ctx, registered } = fakeCtx();
	m.installInstructions(ctx, { enabled: false, file });
	assert.equal(registered.length, 0);
});

check("⑦ 段文本是函数：每次组装现读，不是注册那一刻的快照", () => {
	const { ctx, registered } = fakeCtx();
	fs.writeFileSync(file, "快照检查");
	m.installInstructions(ctx, { file });
	const spec = registered[0];
	assert.equal(typeof spec.text, "function", "text 写成字符串了 —— 改文件必须重启才生效");
	assert.equal(spec.text(), "快照检查");
	fs.writeFileSync(file, "改过了");
	const t = new Date(Date.now() + 4000);
	fs.utimesSync(file, t, t);
	assert.equal(spec.text(), "改过了", "text 不是现读的");
});

check("⑧ 默认路径落在 <DSH_HOME>/team-workflow/instructions.md", () => {
	const p = m.defaultInstructionsPath({ DSH_HOME: "C:/tmp/dsh" }).replace(/\\/g, "/");
	assert.ok(p.endsWith("team-workflow/instructions.md"), p);
	assert.ok(p.startsWith("C:/tmp/dsh"), p);
});

fs.rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
	console.log(`\n✗ ${failed} 项失败`);
	process.exit(1);
}
console.log("\n✓ 自检通过：instructions（缺文件 / mtime 缓存 / 截断 / 幂等 / 回收 / 现读 / 默认路径）");
