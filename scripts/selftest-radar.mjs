#!/usr/bin/env node
/**
 * 自检：AI 技术雷达的打分与去重（REQ-039）。
 *
 * 盯四件事：
 *   1. **打分是纯函数、可喂假 repo** —— 它决定「什么值得移植」，判错了会让人去搬不该搬的东西。
 *   2. **硬闸真的判死** —— 命中 GPU/训练类 topic 时，语言再好也不能是候选。
 *   3. **阈值真的在驱动判定** —— 同一份数据，阈值一动结论就得跟着变（否则分数是个摆设）。
 *   4. **去重不会把新东西吞掉** —— ignored 的项目分数涨上来要重新出现。
 *
 * 全部离线：scoreRepo / applySeen / renderMarkdown 都不碰网络。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applySeen, renderMarkdown, scorePaper, scoreRepo, suggestLanding } from "./radar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (what) => {
	passed += 1;
	console.log(`✓ ${what}`);
};

const cfg = JSON.parse(readFileSync(join(HERE, "..", "team", "radar.json"), "utf8"));
const NOW = Date.parse("2026-11-11T00:00:00Z");
const ago = (d) => new Date(NOW - d * 864e5).toISOString();

/** 造一个 repo：默认是最理想的形态（JS 零依赖、MIT、刚更新）。 */
function repo(over = {}) {
	return {
		full_name: "someone/thing",
		name: "thing",
		description: "agent orchestration for llm workflows",
		html_url: "https://github.com/someone/thing",
		language: "JavaScript",
		topics: ["ai-agent"],
		stargazers_count: 500,
		forks_count: 20,
		open_issues_count: 5,
		created_at: ago(5),
		pushed_at: ago(1),
		license: { spdx_id: "MIT" },
		...over,
	};
}

// ── 1. 理想形态进候选 ────────────────────────────────────────────────
{
	const r = scoreRepo(repo(), cfg, NOW);
	assert.equal(r.verdict, "adopt", `理想项目应进候选，实际 ${r.score} 分 / ${r.verdict}`);
	assert.ok(r.parts.portability === 40, "JS 应给满可移植性");
	assert.ok(r.parts.license === 10, "MIT 应给满许可分");
	ok(`理想项目判为候选（${r.score} 分）`);
}

// ── 2. 硬闸：GPU / 训练类 topic 直接判死，语言再好也没用 ─────────────
{
	const r = scoreRepo(repo({ topics: ["ai", "cuda", "fine-tuning"], language: "TypeScript" }), cfg, NOW);
	assert.equal(r.parts.portability, 0, "命中硬闸时可移植性必须为 0");
	assert.equal(r.verdict, "ignore", `硬闸应判死，实际 ${r.score} 分 / ${r.verdict}`);
	assert.ok(r.reasons.some((x) => x.includes("硬闸")), "忽略理由里要写清是硬闸");
	ok("GPU/训练类 topic 被硬闸判死");
}

// ── 3. 语言分档：Python 只能抄思路 ───────────────────────────────────
{
	const r = scoreRepo(repo({ language: "Python" }), cfg, NOW);
	assert.equal(r.parts.portability, 10, "Python 应给 10");
	assert.ok(r.reasons.some((x) => x.includes("只能抄思路")), "Python 要给出「只能抄思路」的提示");
	ok("Python 项目被标为只能抄思路");
}

// ── 4. 许可：Copyleft 降分，无许可禁抄 ──────────────────────────────
{
	const gpl = scoreRepo(repo({ license: { spdx_id: "GPL-3.0" } }), cfg, NOW);
	assert.equal(gpl.parts.license, 3, "GPL 应给 3 分");
	assert.ok(gpl.reasons.some((x) => x.includes("Copyleft")), "GPL 要提示不兼容");

	const none = scoreRepo(repo({ license: null }), cfg, NOW);
	assert.equal(none.parts.license, 0, "无许可应为 0");
	assert.ok(none.reasons.some((x) => x.includes("禁抄")), "无许可要提示禁抄");
	ok("GPL 降分、无许可禁抄");
}

// ── 5. 生态专线：dsh 生态关键词的相关性必须显著高于泛 AI ──────────────
{
	const eco = scoreRepo(repo({ description: "dsh plugin for agent presets", topics: [] }), cfg, NOW);
	const generic = scoreRepo(repo({ description: "a blog about llm", topics: [] }), cfg, NOW);
	assert.ok(eco.parts.relevance > generic.parts.relevance, "生态关键词应比泛 AI 词得分高");
	assert.ok(eco.parts.relevance >= 9, `生态命中至少 9 分，实际 ${eco.parts.relevance}`);
	ok(`生态关键词优先（${eco.parts.relevance} > ${generic.parts.relevance}）`);
}

// ── 6. 阈值真的驱动判定：同一份数据换个阈值，结论必须变 ─────────────
{
	const r = scoreRepo(repo(), cfg, NOW);
	const strict = { ...cfg, thresholds: { adopt: 101, watch: 100 } };
	const r2 = scoreRepo(repo(), strict, NOW);
	assert.equal(r.verdict, "adopt", "默认阈值下应是候选");
	assert.equal(r2.verdict, "ignore", "阈值拉到 101 后必须不再是候选");
	ok("阈值变动会改变判定（分数不是摆设）");
}

// ── 7. 去重：已移植永久跳过，已忽略的分数涨 10 分要重新出现 ──────────
{
	const items = [
		{ repo: { full_name: "a/adopted" }, score: 90, verdict: "adopt" },
		{ repo: { full_name: "b/ignored-same" }, score: 40, verdict: "ignore" },
		{ repo: { full_name: "c/ignored-risen" }, score: 75, verdict: "adopt" },
		{ repo: { full_name: "d/new" }, score: 60, verdict: "watch" },
	];
	const seen = {
		"a/adopted": { status: "adopted", score: 90 },
		"b/ignored-same": { status: "ignored", score: 40 },
		"c/ignored-risen": { status: "ignored", score: 40 },
	};
	const { fresh, skipped } = applySeen(items, seen);
	const names = fresh.map((x) => x.repo.full_name).sort();
	assert.deepEqual(names, ["c/ignored-risen", "d/new"], `该出现的没出现：${names.join(",")}`);
	assert.equal(skipped.length, 2, "已移植 + 已忽略未涨分，应各跳过一条");
	ok("去重：已移植跳过、涨分复活、新项目照常进");
}

// ── 8. 日报渲染：五个小节都在，且不吞掉错误信息 ──────────────────────
{
	const md = renderMarkdown({
		date: "2026-11-11",
		adopt: { threshold: 70, items: [{ repo: repo(), score: 88, reasons: [] }] },
		watch: { threshold: 50, items: [] },
		eco: [repo({ full_name: "someone/eco", stargazers_count: 12 })],
		hn: [{ points: 100, num_comments: 10, title: "t", objectID: "1" }],
		arxiv: [{ date: "2026-11-10", cat: "cs.AI", title: "paper", id: "http://x" }],
		models: { total: 400, biggest: [], cheapest: [] },
		errors: ["agent 编排: API rate limit exceeded"],
		cfg,
	});
	for (const h of ["移植候选", "观察", "生态专线", "情报", "怎么用这份日报"]) {
		assert.ok(md.includes(h), `日报缺少「${h}」小节`);
	}
	assert.ok(md.includes("88"), "候选分数要出现在表里");
	assert.ok(md.includes("API rate limit"), "取数失败必须留在日报里，不能静默");
	ok("日报五节齐全，取数失败不静默");
}

// ── 9. 无许可封顶：分数再高也不能进候选（抄进去就是许可证污染）─────────
{
	const r = scoreRepo(repo({ license: null, stargazers_count: 5000 }), cfg, NOW);
	assert.ok(r.score >= cfg.thresholds.adopt, `这条得先够候选分才有意义，实际 ${r.score}`);
	assert.equal(r.verdict, "watch", "无许可的项目最高只能到观察区");
	ok(`无许可封顶在观察区（原始 ${r.score} 分也不放行）`);
}

// ── 10. 落点建议：命中规则就要给出具体文件，别只说「待判」──────────────
{
	const hit = suggestLanding(repo({ description: "context compaction for agents" }), cfg);
	assert.ok(hit.includes("lib/mc.js"), `context 类应落到压缩后端，实际「${hit}」`);
	const miss = suggestLanding(repo({ name: "x", description: "zzz", topics: [] }), cfg);
	assert.ok(miss.includes("先读代码"), "没命中规则时要诚实说没命中，不要瞎指");
	ok("落点建议按配置命中，未命中不瞎指");
}

// ── 10b. 落点建议：一个泛关键词不足以定落点（2026-11-12 的错配回归）────────
{
	// 真实错配：Yandex 统计的 MCP 服务器，描述里只有 "mcp" 一个词命中，
	// 旧逻辑按顺序取第一个规则，把它指到了 lib/squad*.js —— 纯噪音。
	const yandex = suggestLanding(
		repo({
			name: "yandex-metrika-mcp",
			description: "Read-only MCP server for Yandex Metrika: visits, sources, goals",
			topics: [],
		}),
		cfg,
	);
	assert.ok(
		yandex.includes("先读代码"),
		`只命中一个描述里的泛词时不该下定论，实际「${yandex}」`,
	);

	// 但关键词出现在 name / topics 里就是「它自称是干什么的」，可以信
	const named = suggestLanding(
		repo({ name: "context-window-compaction", description: "a library", topics: ["compaction"] }),
		cfg,
	);
	assert.ok(named.includes("lib/mc.js"), `name/topics 命中应给落点，实际「${named}」`);

	ok("落点建议：单个泛关键词不瞎定，name/topics 命中才可信");
}

// ── 11. 论文打分：工程手段给高分，要训练的判低 ──────────────────────────
{
	const good = scorePaper(
		{
			title: "System Optimizations for Cost-Efficient Agent Harnesses",
			abs: "We analyze harness-side cost accumulation across agent traces, reduce token use and LLM calls; code at github.com/x/y.",
			date: new Date(NOW - 864e5).toISOString().slice(0, 10),
		},
		cfg,
		NOW,
	);
	assert.equal(good.verdict, "adopt", `harness 类工程论文应进候选，实际 ${good.score}`);
	assert.equal(good.parts.hasCode, 10, "提到 github 应给代码分");

	const train = scorePaper(
		{
			title: "Reinforcement Learning for Agent Harnesses",
			abs: "We fine-tune with RL and LoRA on GPU memory; context window compression is evaluated.",
			date: new Date(NOW - 864e5).toISOString().slice(0, 10),
		},
		cfg,
		NOW,
	);
	assert.equal(train.parts.feasibility, 8, "要训练的论文可落地性必须判低");
	assert.ok(
		train.reasons.some((x) => x.includes("需要训练")),
		"理由里要写清是我们没条件训练，不是论文不好",
	);
	ok(`论文判据分层（工程 ${good.score} > 训练 ${train.score}）`);
}

// ── 12. 新鲜度是真在用的维度，不是摆设 ──────────────────────────────────
{
	const base = { title: "agent context harness budget", abs: "tool output compression" };
	const fresh = scorePaper({ ...base, date: new Date(NOW).toISOString().slice(0, 10) }, cfg, NOW);
	const old = scorePaper({ ...base, date: new Date(NOW - 90 * 864e5).toISOString().slice(0, 10) }, cfg, NOW);
	assert.ok(fresh.score > old.score, `同内容下新论文必须分更高（${fresh.score} vs ${old.score}）`);
	assert.equal(old.parts.freshness, 0, "90 天前不该有新鲜度分");
	ok(`新鲜度参与打分（${fresh.score} > ${old.score}）`);
}

console.log(`\nselftest-radar：${passed} 项全过`);
