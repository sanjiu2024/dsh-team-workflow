#!/usr/bin/env node
/**
 * 自检：确定性折叠（REQ-018 的 ①，纯函数部分）。
 *
 * 四段：
 *   1. 逐条规则：用户原话逐字、工具首尾、助手挑重要行 + 首尾
 *   2. **确定性**：同输入必同输出（这是「不信任模型」的全部前提）
 *   3. 产物形状：markdown 结构 + 丢失说明 —— 而且要能被 ② 的 `parseCheckpoint` 认出条目
 *   4. 尺寸：产物必须**小于**输入（basic 有一道「摘要不比被压内容小就 throw」的闸）
 *
 *   node scripts/selftest-fold-core.mjs
 */
import * as assert from "node:assert/strict";
import { parseCheckpoint } from "../lib/context-filter.js";
import { FOLD_MARKER, contentText, foldMessages, headTail, looksImportant } from "../lib/fold-core.js";

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures += 1;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

const msg = (role, text) => ({ role, content: [{ type: "text", text }] });
const long = (n, ch = "x") => ch.repeat(n);

// ── 1. 逐条规则 ─────────────────────────────────────────────────────────────

check("用户原话：常规长度逐字全留；超长粘贴才裁首尾（需求本身最不该丢）", () => {
	const normal = long(3000, "需");
	const out1 = foldMessages([msg("user", normal), msg("tool", long(20000, "t"))]);
	assert.ok(out1.text.includes(normal), "常规长度的用户原话必须逐字在产物里");
	// 注意：标记是**整段**的 —— 同一条输入里工具被裁也会打标记，所以这里只看用户那一段
	assert.ok(out1.text.split("## 工具结果")[0].includes(normal), "用户段里必须逐字完整");

	const huge = long(20000, "需");
	const out2 = foldMessages([msg("user", huge), msg("tool", long(20000, "t"))]);
	assert.ok(!out2.text.includes(huge), "2 万字符的粘贴该被裁");
	assert.ok(out2.text.includes(long(50, "需")), "裁了也要留原文片段");
	assert.ok(out2.text.includes(FOLD_MARKER), "裁了要留标记");
});

check("更早的 checkpoint 不逐字留 —— 否则「折叠加折叠」，实测留存率 83%", () => {
	// 这条规则是拿真实会话跑出来的：checkpoint 本身也是一条 user/message，
	// 逐字留它等于把上一轮的摘要整段抄进这一轮。
	const body = `前言\n\n<compacted-summary>\n${long(6000, "旧")}\n</compacted-summary>`;
	const out = foldMessages([msg("user", body)]);
	assert.ok(!out.text.includes(long(600, "旧")), "旧 checkpoint 不许逐字留（只留首尾，不是整段）");
	assert.match(out.text, /更早的 checkpoint/, "要单列一段说明它是旧 checkpoint");
	assert.match(out.text, /其中 1 条是更早的 checkpoint/, "丢失说明里要点出条数");
	assert.equal(out.stats.priorCheckpoints, 1);
});

check("全局预算：工具结果多的时候，产物仍要装进目标留存率", () => {
	// 逐条预算不够用：20 条工具结果 × 每条 1600 字符 = 3 万字符（真实会话实测 83% 留存）。
	// 长工具结果：靠逐条预算就够
	const longInput = [msg("user", "需求")];
	for (let i = 0; i < 20; i += 1) longInput.push(msg("tool", long(3000, "t")));
	const a = foldMessages(longInput);
	const aChars = longInput.reduce((n, m) => n + contentText(m).length, 0);
	assert.ok(a.text.length <= aChars * 0.35, `长消息：留存要 ≤35%，实际 ${(a.text.length / aChars * 100).toFixed(1)}%`);
	// 3000 字符的工具消息：第 0 轮（1600/3000=53%）超目标，第 1 轮减半后达标 → scale 必须正好是 1/2。
	// 这条钉住「每轮减半」这个机制（变异成「不缩」时最终 scale 会不一样）。
	assert.equal(a.stats.scale, 0.5, `该在第 1 轮达标，实际 scale=${a.stats.scale}`);

	// 全是短消息：逐条预算咬不住（每条都没超），必须靠硬截断兜住 —— 否则 basic 的尺寸闸会 throw
	const shortInput = [msg("user", "需求")];
	for (let i = 0; i < 60; i += 1) shortInput.push(msg("tool", long(200, "t")));
	const b = foldMessages(shortInput);
	const bChars = shortInput.reduce((n, m) => n + contentText(m).length, 0);
	// 全是短消息：压不到 35%（每条都没超预算），但不变量（比输入小）仍然成立。
	assert.ok(b.text.length < bChars * 0.9, `短消息：必须明显小于输入，实际 ${(b.text.length / bChars * 100).toFixed(1)}%`);

	// 硬截断那条路什么时候才真的会走：**消息极多**时，每条 40 字符的地板加起来会超过输入。
	// 这条用例是那个分支的守门员（不然它就是死代码）。
	const many = [];
	for (let i = 0; i < 3000; i += 1) many.push(msg("tool", long(50, "t")));
	const c = foldMessages(many);
	const cChars = many.reduce((n, m) => n + contentText(m).length, 0);
	assert.equal(c.stats.hardTruncated, true, "消息极多时地板之和超过输入 → 必须硬截断");
	// 断言**机制**而不是结果：这条输入必须真的触发收缩（否则「超目标就减半」那套逻辑删掉也看不出来）
	assert.ok(c.stats.scale < 1, `该触发收缩，实际 scale=${c.stats.scale}`);
	assert.equal(c.stats.targetRatio, 0.35, "默认目标留存率是 35%");
	assert.ok(c.text.length < cChars * 0.9, `硬截断后仍要满足不变量，实际 ${(c.text.length / cChars * 100).toFixed(1)}%`);
	assert.match(c.text, /折叠产物本身也被截断/, "硬截断要写明（静默截断最坏）");
});

check("全局预算是确定的：同一输入两次收缩结果一致", () => {
	const input = [msg("user", "需求")];
	for (let i = 0; i < 10; i += 1) input.push(msg("tool", long(4000, "t")));
	const a = foldMessages(input);
	const b = foldMessages(input);
	assert.equal(a.text, b.text);
	assert.equal(a.stats.scale, b.stats.scale);
});

check("标记必须非空 —— 否则「留了标记」是空断言（includes 空串恒为真）", () => {
	// 这条是「静默丢内容」的守门员：标记一旦退化成空串，下面那些断言全会假装通过。
	assert.ok(FOLD_MARKER.length > 0, "折叠标记不能是空串");
	assert.ok(FOLD_MARKER.includes("折叠"), "标记要说得清发生了什么");
});

check("工具结果：留首尾、中段折叠并标记", () => {
	const body = `${long(3000, "头")}${long(3000, "中")}${long(1000, "尾")}`;
	const { text } = foldMessages([msg("tool", body)]);
	assert.ok(text.includes(long(20, "头")), "头部要在");
	assert.ok(text.includes(long(20, "尾")), "尾部要在");
	assert.ok(text.includes(FOLD_MARKER), "中段要留标记");
	assert.ok(!text.includes(long(50, "中")), "中段必须真的没了");
});

check("助手消息：重要行被提到前面，且整段做首尾裁剪", () => {
	const body = `我打算先看看\n\n改了 lib/squad-round.js 的 startMember\n${long(2000, "啰")}\n最后结论：换档链路是根因`;
	const { text } = foldMessages([msg("assistant", body)]);
	assert.ok(text.includes("lib/squad-round.js"), "带路径的行要留下");
	assert.ok(text.includes(FOLD_MARKER), "长助手消息要做首尾裁剪");
});

check("非文本块与空消息不进产物", () => {
	const { text, stats } = foldMessages([
		{ role: "user", content: [{ type: "image", data: "…" }] },
		{ role: "user", content: [] },
		{ role: "system", content: [{ type: "text", text: "系统提示不该进折叠产物" }] },
	]);
	assert.doesNotMatch(text, /系统提示/, "system 不是这段对话的内容");
	assert.equal(stats.keptChars, 0);
});

check("headTail：短文本原样、0/0 表示不裁、边界正确", () => {
	assert.equal(headTail("短", 100, 100), "短");
	assert.equal(headTail(long(50), 0, 0), long(50), "0/0 = 不裁");
	const cut = headTail("a".repeat(10) + "b".repeat(10), 4, 4);
	assert.equal(cut, `aaaa${FOLD_MARKER}bbbb`);
});

check("looksImportant：认路径/命令/报错，不认散文", () => {
	assert.equal(looksImportant("改了 lib/squad.js"), true);
	assert.equal(looksImportant("`npm test` 全绿"), true);
	assert.equal(looksImportant("Error: 找不到模块"), true);
	assert.equal(looksImportant("我觉得这样比较好"), false);
});

// ── 2. 确定性 ───────────────────────────────────────────────────────────────

check("确定性：同一份输入跑两次，产物逐字节相同", () => {
	const input = [msg("user", "需求：修 X"), msg("tool", long(4000, "t")), msg("assistant", `结论 ${long(2000, "a")}`)];
	const a = foldMessages(input);
	const b = foldMessages(input);
	assert.equal(a.text, b.text, "同输入必须同输出（不信任模型的前提）");
	assert.deepEqual(a.stats, b.stats);
});

check("确定性：不依赖输入对象的顺序以外的东西（复制一份新对象也一样）", () => {
	const one = [msg("user", "甲"), msg("tool", "乙")];
	const two = [msg("user", "甲"), msg("tool", "乙")];
	assert.equal(foldMessages(one).text, foldMessages(two).text);
});

// ── 3. 产物形状 ─────────────────────────────────────────────────────────────

check("产物是 markdown 结构，且能被 ② 的 parseCheckpoint 认出条目", () => {
	const { text } = foldMessages([
		msg("user", "需求甲"),
		msg("tool", long(3000, "工具乙")),
		msg("assistant", `结论丙 ${long(3000, "推理")}`),
	]);
	assert.match(text, /^## 用户原话（逐字）/m);
	assert.match(text, /^## 工具结果（首尾）/m);
	assert.match(text, /^## 助手结论（首尾）/m);
	const wrapped = `前言\n\n<compacted-summary>\n${text}\n</compacted-summary>\n\n后语`;
	const parsed = parseCheckpoint(wrapped);
	assert.ok(parsed, "折叠产物放进 checkpoint 后要能被解析");
	const entries = parsed.blocks.filter((b) => b.kind === "entry");
	assert.ok(entries.length >= 3, `至少 3 个条目，实际 ${entries.length}`);
});

check("丢失说明写清了：条数、保留字符、丢弃字符、去哪取回", () => {
	const { text } = foldMessages([msg("user", "甲"), msg("tool", long(3000, "t"))]);
	assert.match(text, /确定性折叠：共 2 条消息/);
	assert.match(text, /逐字保留 \d+ 字符、丢弃 \d+ 字符/);
	assert.match(text, /session_recall/, "要告诉模型原文去哪取");
});

check("空输入不炸，且明确说明「没有可折叠的内容」", () => {
	const { text, stats } = foldMessages([]);
	assert.match(text, /共 0 条消息/);
	assert.equal(stats.messages, 0);
	assert.equal(foldMessages(undefined).stats.messages, 0);
});

// ── 4. 尺寸 ─────────────────────────────────────────────────────────────────

check("尺寸：真实形状的输入，产物必须明显小于输入（basic 的尺寸闸）", () => {
	const input = [
		msg("user", "请修 A、B、C 三处"),
		msg("tool", long(8000, "t")),
		msg("assistant", long(6000, "a")),
		msg("tool", long(8000, "u")),
	];
	const { text, stats } = foldMessages(input);
	const inputChars = input.reduce((n, m) => n + contentText(m).length, 0);
	assert.ok(text.length < inputChars, `产物 ${text.length} 必须小于输入 ${inputChars}`);
	assert.ok(stats.droppedChars > 0);
	assert.ok(text.length < inputChars * 0.5, `至少要砍掉一半，实际 ${text.length}/${inputChars}`);
});

if (failures > 0) {
	console.error(`✗ ${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("✓ 自检通过：确定性折叠（逐条规则 / 确定性 / 产物形状 / 尺寸）");
}
