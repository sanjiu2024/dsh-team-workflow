#!/usr/bin/env node
/**
 * AI 技术雷达 —— 采集 → 打分 → 落一份日报。
 *
 * 它**只读网络、只写 docs/radar/**，绝不改仓库代码：定时任务跑在没有任何记忆的新会话里，
 * 让它自动移植等于让它自动破坏（这个包是零运行时依赖、纯 ESM，GitHub 上九成热门项目物理上搬不进来）。
 * 所以三道闸只做前两道：采集、打分。第三道「移植」由人在正常会话里走 REQ 流程。
 *
 * 判据分两层：
 *   - 硬闸（penalty）：命中 GPU / 容器 / 训练类 topic → 可移植性直接判 0，理由写进日报。
 *   - 软分（100 分）：可移植性 40 + 相关性 30 + 活跃度 20 + 许可 10，权重在 team/radar.json。
 *
 * 用法：
 *   node scripts/radar.mjs                 # 打到 stdout，不落盘
 *   node scripts/radar.mjs --write         # 写 docs/radar/<日期>.md + 更新 seen.json
 *   node scripts/radar.mjs --json          # 机读输出（给别的脚本用）
 *   node scripts/radar.mjs --days 30       # 改时间窗
 *   GH_TOKEN=ghp_xxx node scripts/radar.mjs   # 5000 次/时（不给我也行，就是 10 次/分）
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "MIT-0", "Unlicense", "0BSD"]);
const COPYLEFT = new Set(["GPL-3.0", "GPL-2.0", "AGPL-3.0", "LGPL-3.0", "LGPL-2.1", "MPL-2.0"]);

/** 剥掉环境里那个拒连的 HTTP_PROXY，按需自己加 -x。curl 而不是 fetch：Node 的 fetch 不认 -x。 */
// 有些站直连通（arxiv / HN / openrouter），有些必须过代理（github）。写死在哪一边都脆，
// 所以两个方向都试一次：先按调用方给的方向走，失败了翻过来再走一遍。
let FALLBACK_PROXY = null;

function curl(url, { proxy = null, token = null } = {}) {
	const run = (px) => {
		const args = ["-sL", "--max-time", "20", "-A", "dsh-team-radar"];
		if (px) args.push("-x", px);
		// 只对 api.github.com 发 token，别把它漏给别的站
		if (token && url.includes("api.github.com")) args.push("-H", `Authorization: Bearer ${token}`);
		args.push(url);
		const env = { ...process.env };
		for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[k];
		return execFileSync("curl", args, { env, encoding: "utf8", maxBuffer: 64 << 20 });
	};
	try {
		return run(proxy);
	} catch (err) {
		const other = proxy ? null : FALLBACK_PROXY;
		if (!other) throw err;
		return run(other);
	}
}

const json = (url, opts) => {
	try {
		return JSON.parse(curl(url, opts));
	} catch {
		return null;
	}
};

const daysBetween = (iso, now) => Math.floor((now - new Date(iso).getTime()) / 864e5);

/**
 * 给一个 GitHub repo 打分。纯函数 —— 不碰网络，自检直接喂假 repo。
 * @returns {{score:number, verdict:"adopt"|"watch"|"ignore", parts:object, reasons:string[]}}
 */
export function scoreRepo(repo, cfg, now = Date.now()) {
	const topics = (repo.topics || []).map((t) => String(t).toLowerCase());
	const lang = String(repo.language || "").toLowerCase();
	const text = `${repo.name || ""} ${repo.full_name || ""} ${repo.description || ""} ${topics.join(" ")}`.toLowerCase();

	const banned = cfg.penalty.topics.filter((t) => topics.includes(t) || text.includes(t));
	const kw = cfg.keywords;

	let portability;
	if (banned.length) portability = 0;
	else if (lang === "javascript" || lang === "typescript") portability = 40;
	else if (lang === "shell") portability = 30;
	else if (lang === "go" || lang === "rust") portability = 25;
	else if (!lang) portability = 20;
	else if (lang === "python") portability = 10;
	else portability = 15;

	const ecoHits = kw.ecosystem.filter((k) => text.includes(k));
	const topicHits = kw.topic.filter((k) => text.includes(k));
	const generalHits = kw.general.filter((k) => text.includes(k));
	const relevance = Math.min(30, ecoHits.length * 9 + topicHits.length * 4 + generalHits.length);

	const pushed = repo.pushed_at ? daysBetween(repo.pushed_at, now) : 999;
	const created = repo.created_at ? daysBetween(repo.created_at, now) : 999;
	const activity = Math.min(
		20,
		(pushed <= 7 ? 12 : pushed <= 30 ? 8 : pushed <= 90 ? 4 : 0) +
			(created <= 30 ? 4 : 0) +
			(repo.stargazers_count >= 100 || repo.forks_count > 0 || repo.open_issues_count > 0 ? 4 : 0),
	);

	const spdx = repo.license?.spdx_id || "";
	const license = PERMISSIVE.has(spdx) ? 10 : COPYLEFT.has(spdx) ? 3 : 0;

	const score = Math.max(0, Math.min(100, portability + relevance + activity + license));
	let verdict = score >= cfg.thresholds.adopt ? "adopt" : score >= cfg.thresholds.watch ? "watch" : "ignore";
	if (license === 0 && verdict === "adopt") verdict = "watch";

	const reasons = [];
	if (banned.length) reasons.push(`硬闸：命中 ${banned.slice(0, 3).join("/")}，搬不进零依赖包`);
	else if (portability <= 15 && lang) reasons.push(`${repo.language}，只能抄思路不能抄代码`);
	if (license === 0) reasons.push(`无许可（${spdx || "none"}），禁抄`);
	else if (license === 3) reasons.push(`Copyleft（${spdx}），与 MIT 包不兼容`);
	if (relevance === 0) reasons.push("与我们现有模块无关联");
	if (pushed > 90) reasons.push(`${pushed} 天没更新`);

	return { score, verdict, parts: { portability, relevance, activity, license }, reasons };
}

// GitHub 的搜索端点是 30 次/分，连着打会撞二级限流（实测：8 次连发必有一次 403）
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const iso = (d) => {
	const x = new Date(d);
	const p = (n) => String(n).padStart(2, "0");
	// 本地时区，不是 UTC —— 晚上 8 点后跑的话 UTC 会落到前一天，日报名字就错一天
	return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};
const clean = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const cut = (s, n) => (clean(s).length > n ? clean(s).slice(0, n - 1) + "…" : clean(s));

export function searchGithub(q, { days, perPage, proxy, token }) {
	const url = `https://api.github.com/search/repositories?q=${q}+created:>${days}&sort=stars&order=desc&per_page=${perPage}`;
	let d = json(url, { proxy, token });
	if (!d || d.message) d = json(url, { proxy, token });
	if (!d || d.message) return { items: [], error: d?.message || "取数失败" };
	return { items: d.items || [], total: d.total_count };
}

export function collectGithub(cfg, { days, proxy, token }) {
	const createdAfter = iso(Date.now() - days * 864e5);
	const out = new Map();
	const errors = [];
	for (const { name, q } of cfg.github.queries) {
		const r = searchGithub(q, { days: createdAfter, perPage: cfg.github.perQuery, proxy, token });
		if (r.error) errors.push(`${name}: ${r.error}`);
		nap(1200);
		for (const it of r.items) if (!out.has(it.full_name)) out.set(it.full_name, { ...it, bucket: name });
	}
	return { repos: [...out.values()], errors };
}

/** 生态专线：不按主题搜索，按名字搜 —— 这条线比泛 AI 更靠谱，所以单独一节、不看分数也展示。 */
export function collectEcosystem(cfg, { proxy, token }) {
	const out = new Map();
	const errors = [];
	for (const term of cfg.ecosystem.queries) {
		const r = searchGithub(term, { days: iso(Date.now() - 365 * 864e5), perPage: cfg.ecosystem.perQuery, proxy, token });
		if (r.error) errors.push(`${term}: ${r.error}`);
		nap(1200);
		for (const it of r.items) {
			if (it.stargazers_count < cfg.ecosystem.minStars) continue;
			out.set(it.full_name, it);
		}
	}
	// 按「新建时间」倒序，不是按星 —— 这节的价值是「我们还没听过的新同行」，
	// 按星排的话前排永远被 deepseek-harness 那种 27 万星的熟面孔占满
	return { repos: [...out.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)), errors };
}

function collectHn(cfg, proxy) {
	const hits = new Map();
	const since = Math.floor(Date.now() / 1000) - cfg.hn.days * 86400;
	for (const q of cfg.hn.queries) {
		const d = json(
			`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=${cfg.hn.perQuery}`,
			{ proxy },
		);
		for (const h of d?.hits || []) if (!hits.has(h.objectID)) hits.set(h.objectID, h);
	}
	return [...hits.values()]
		.filter((h) => (h.points || 0) >= cfg.hn.minPoints)
		.sort((a, b) => (b.points || 0) - (a.points || 0))
		.slice(0, 5);
}

/** 拉最近 N 天的新投稿（**不做关键词预筛**）—— 预筛会漏掉用词不同的好论文，交给打分排序。 */
export function collectArxiv(cfg, { days = cfg.papers.days, proxy = null } = {}) {
	const since = iso(Date.now() - days * 864e5);
	const seen = new Map();
	for (const cat of cfg.papers.cats) {
		const xml = curl(
			`https://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&max_results=${cfg.papers.perCat}`,
			{ proxy },
		);
		for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
			const e = m[1];
			const g = (t) => clean((e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
			const date = g("published").slice(0, 10);
			if (!date || date < since) continue;
			const id = g("id");
			if (seen.has(id)) continue;
			seen.set(id, { title: g("title"), abs: g("summary"), id, cat, date });
		}
	}
	return [...seen.values()];
}

/**
 * 给一篇论文打分。纯函数。
 *
 * 和仓库那套判据**故意不一样**：仓库看「能不能搬代码」，论文看「方法能不能用几十行零依赖 JS
 * 实现」。要训练/微调/蒸馏的（RL、LoRA、SFT）不是不好，是我们没有那个条件 —— 判低不是贬低。
 *
 * @returns {{score:number, verdict:"adopt"|"watch"|"ignore", parts:object, reasons:string[]}}
 */
export function scorePaper(paper, cfg, now = Date.now()) {
	const p = cfg.papers;
	const text = `${paper.title || ""} ${paper.abs || ""}`.toLowerCase();

	const train = p.trainingSignals.filter((k) => text.includes(k));
	const dataset = p.datasetSignals.filter((k) => text.includes(k));
	const landable = p.landingSignals.filter((k) => text.includes(k));
	const titleDataset = /(dataset|benchmark|benchmarking|corpus)/i.test(paper.title || "");

	// 可落地性按「方法能不能用几十行零依赖 JS 重写」判：要训练 8；数据集/评测集 12；
	// 工程手段按命中条数分档（1 条很可能是顺口提的，3 条才算真的在讲这件事）。
	let feasibility;
	if (train.length > 0) feasibility = 8;
	// 数据集/评测集看**标题**，不看 abstract：真做方法的工作也会在自己的实验里提 benchmark，
	// 用摘要判会把它们一起误杀；而标题写 Dataset/Benchmarking 的基本就是造数据/造榜。
	else if (titleDataset) feasibility = 12;
	else feasibility = landable.length >= 3 ? 40 : landable.length === 2 ? 32 : landable.length === 1 ? 20 : 12;

	// 相关性分强弱：`compaction`/`harness`/`tool output` 这种出现在 abstract 里就是真在讲；
	// `context`/`agent` 这种满屏都是，只值 2 分。否则一篇 Context-Grounded QA Dataset 能刷到顶。
	const strong = (p.strongKeywords || []).filter((k) => text.includes(k));
	const weak = p.keywords.filter((k) => text.includes(k));
	const relevance = Math.min(30, strong.length * 5 + weak.length * 2);

	const age = paper.date ? daysBetween(paper.date, now) : 999;
	const freshness = age <= 3 ? 20 : age <= 7 ? 15 : age <= 30 ? 8 : 0;

	const hasCode = /github\.com|code is (public|available)|we (release|open)|open[- ]source|available at http/i.test(text) ? 10 : 0;

	const score = Math.max(0, Math.min(100, feasibility + relevance + freshness + hasCode));
	const verdict = score >= p.thresholds.adopt ? "adopt" : score >= p.thresholds.watch ? "watch" : "ignore";

	const reasons = [];
	if (train.length > 0) reasons.push(`需要训练（${train.slice(0, 2).join("/")}），我们没条件`);
	else if (titleDataset && feasibility <= 12) reasons.push("数据集/评测集，给的是可测的东西不是可抄的方法");
	else if (feasibility <= 12) reasons.push("方法不是工程手段，抄不了");
	if (hasCode) reasons.push("有开源实现可对照");
	if (relevance === 0) reasons.push("与我们无关");
	if (freshness === 0) reasons.push(`${age} 天前，不是最新`);

	return { score, verdict, parts: { feasibility, relevance, freshness, hasCode }, reasons };
}

function collectModels(proxy) {
	const d = json("https://openrouter.ai/api/v1/models", { proxy });
	const list = d?.data;
	if (!Array.isArray(list)) return null;
	const withCtx = list.filter((m) => m.context_length);
	const biggest = [...withCtx].sort((a, b) => b.context_length - a.context_length).slice(0, 3);
	const cheapest = withCtx
		.filter((m) => Number(m.pricing?.prompt) > 0 && m.context_length >= 131072)
		.sort((a, b) => Number(a.pricing.prompt) - Number(b.pricing.prompt))
		.slice(0, 3);
	return { total: list.length, biggest, cheapest };
}

function loadSeen(file) {
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

/**
 * 这个项目该往我们哪个文件上落？规则在 team/radar.json 的 landing —— 让它可配置，
 * 是因为「落点」是随仓库演进的（模块改名、拆文件），写死在代码里第二天就过期。
 *
 * 2026-11-12 修：原来是「按顺序取第一个命中」，而 tool / agent / mcp 都是高频词，
 * 于是 yandex-metrika-mcp（Yandex 统计服务器）落到 lib/squad*.js、lasik（BLA 去混淆器）
 * 落到 team/agent-settings.json —— 全是错配，反而稀释了这份日报的可信度。
 *
 * 现在的判据：**一个落点结论至少要有一个「具体词」撑着**。
 * 「泛词」（tool/agent/mcp/...，见 team/radar.json 的 landingGeneric）自己不算证据，
 * 因为它们在任何项目描述里都出现；`compaction`、`squad`、`subagent` 这种才是真信号。
 * 命中多个关键词、或命中 name/topics，权重更高。
 */
export function suggestLanding(repo, cfg) {
	const name = (repo.name || "").toLowerCase();
	const topics = (repo.topics || []).join(" ").toLowerCase();
	const text = `${name} ${repo.description || ""} ${topics}`.toLowerCase();
	const generic = new Set(cfg.landingGeneric || []);

	let best = null;
	for (const rule of cfg.landing || []) {
		const hits = rule.match.filter((m) => text.includes(m));
		if (!hits.length) continue;
		// 全是泛词 → 这条规则对这个项目没有指向性，跳过
		if (hits.every((m) => generic.has(m))) continue;
		// name / topics 里出现的关键词是「这个项目自称是干什么的」，比描述里顺手一提可信
		const strong = rule.match.filter((m) => name.includes(m) || topics.includes(m)).length;
		const weight = hits.length + strong * 2;
		if (!best || weight > best.weight) best = { rule, weight };
	}

	if (!best) return "先读代码再判（无匹配规则）";
	return best.rule.target;
}

/** 去重：已 adopted 的永久跳过；已 ignored 且分数没涨 10 分以上的也不再提。 */
export function applySeen(items, seen) {
	const fresh = [];
	const skipped = [];
	for (const it of items) {
		const prev = seen[it.repo.full_name];
		if (prev?.status === "adopted") {
			skipped.push({ ...it, why: "已移植" });
			continue;
		}
		if (prev?.status === "ignored" && it.score < (prev.score || 0) + 10) {
			skipped.push({ ...it, why: "已判忽略且分数未变" });
			continue;
		}
		fresh.push({ ...it, isNew: !prev });
	}
	return { fresh, skipped };
}

export function renderMarkdown({ date, adopt, papers, watch, eco, hn, arxiv, models, errors, cfg }) {
	const L = [];
	L.push(`# AI 雷达 · ${date}`, "");
	L.push("> 自动生成，别手改。判据看 `team/radar.json`，移植决定记在 `docs/radar/INDEX.md`。", "");

	L.push(`## 一、移植候选（≥${adopt.threshold} 分）`, "");
	if (!adopt.items.length) L.push("今天没有过闸门的项目。", "");
	else {
		L.push("| 分 | 项目 | 语言 | ★ | 许可 | 一句话 | 建议落点 |", "| --- | --- | --- | --- | --- | --- | --- |");
		for (const { repo: r, score, reasons } of adopt.items) {
			L.push(
				`| **${score}** | [${r.full_name}](${r.html_url}) | ${r.language || "—"} | ${r.stargazers_count} | ${r.license?.spdx_id || "无"} | ${cut(r.description, 60) || "—"} | ${suggestLanding(r, cfg)}${reasons.length ? `（${reasons.join("；")}）` : ""} |`,
			);
		}
		L.push("");
	}

	L.push(`## 二、论文候选（≥${cfg.papers.thresholds.adopt} 分）`, "");
	L.push("> 论文能移植的只有**方法**，不是代码。看这一节时问自己：这三十行零依赖 JS 能不能写出来。", "");
	if (!papers?.length) L.push("今天没有值得移植的论文。", "");
	else {
		for (const { paper: p, score, reasons } of papers) {
			const url = String(p.id).replace("http://", "https://");
			L.push(`- **${score}** · [${cut(p.title, 88)}](${url}) · ${p.date} · ${p.cat}`);
			L.push(`  - 落点：${suggestLanding({ name: "", description: `${p.title} ${p.abs}`, topics: [] }, cfg)}${reasons.length ? `　_(${reasons.join("；")})_` : ""}`);
		}
		L.push("");
	}

	L.push(`## 三、观察（分数不够，或被许可/语言封顶的）`, "");
	if (!watch.items.length) L.push("无。", "");
	else {
		for (const { repo: r, score, reasons } of watch.items.slice(0, 10)) {
			L.push(`- **${score}** · [${r.full_name}](${r.html_url}) · ${r.language || "—"} · ★${r.stargazers_count} · ${cut(r.description, 70) || "—"}${reasons.length ? `　_(${reasons.join("；")})_` : ""}`);
		}
		L.push("");
	}

	L.push("## 四、dsh / pi 生态专线", "", "> 不看分数：这条线上任何新项目都值得扫一眼，它们是我们的同行。", "");
	if (!eco.length) L.push("近一年没抓到新的生态项目。", "");
	else {
		for (const r of eco.slice(0, 10)) {
			L.push(`- ★${String(r.stargazers_count).padStart(4)} · [${r.full_name}](${r.html_url}) · ${iso(r.created_at)} · ${cut(r.description, 70) || "—"}`);
		}
		L.push("");
	}

	L.push("## 五、情报（不进代码，只更新认知）", "");
	if (models) {
		L.push(`- **模型目录**：OpenRouter 上 ${models.total} 个模型`);
		L.push(`- **最大上下文**：${models.biggest.map((m) => `${m.id} (${m.context_length})`).join("；")}`);
		L.push(`- **128K+ 里最便宜**：${models.cheapest.map((m) => `${m.id} $${(Number(m.pricing.prompt) * 1e6).toFixed(3)}/M`).join("；")}`);
	}
	if (hn.length) {
		L.push("- **HN 在讨论**：");
		for (const h of hn) L.push(`  - ${h.points}分/${h.num_comments}评 · ${cut(h.title, 70)} · https://news.ycombinator.com/item?id=${h.objectID}`);
	}
	if (arxiv.length) {
		L.push("- **arXiv 方向**：");
		for (const a of arxiv) L.push(`  - ${a.date} [${a.cat}] ${cut(a.title, 80)} · ${a.id}`);
	}
	if (!models && !hn.length && !arxiv.length) L.push("- 今天情报源全部取数失败，看下面的错误。");
	L.push("");

	if (errors.length) {
		L.push("## 取数失败", "");
		for (const e of errors) L.push(`- ${e}`);
		L.push("");
	}

	L.push("## 六、怎么用这份日报", "");
	L.push("1. 只对「移植候选」里的项目做判断，观察区不用管。");
	L.push("2. 真要移植的，写进 `docs/radar/INDEX.md` 并开一条 REQ —— 别直接改代码。");
	L.push("3. 判死不感兴趣的，把 `seen.json` 里那条的 `status` 改成 `ignored`，以后不再出现。");
	L.push("");
	return L.join("\n");
}

function main(argv) {
	const flag = (name) => argv.includes(name);
	const opt = (name, fallback) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
	};
	if (flag("--help")) {
		console.log(
			[
				"AI 技术雷达",
				"",
				"  node scripts/radar.mjs            打到 stdout",
				"  node scripts/radar.mjs --write    写 docs/radar/<日期>.md 并更新 seen.json",
				"  node scripts/radar.mjs --json     机读输出",
				"  --days N      时间窗（默认取 team/radar.json 的 days）",
				"  --no-proxy    不走代理",
				"  --config P    换配置文件",
				"",
				"环境变量：GH_TOKEN（GitHub 5000 次/时）· RADAR_PROXY（覆盖代理）",
			].join("\n"),
		);
		return;
	}

	const cfgPath = opt("--config", join(ROOT, "team", "radar.json"));
	let cfg;
	try {
		cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
	} catch (err) {
		throw new Error(`${cfgPath} 读不出来：${err.message}`);
	}
	const days = Number(opt("--days", cfg.days));
	const proxy = flag("--no-proxy") ? null : process.env.RADAR_PROXY || cfg.proxy || null;
	FALLBACK_PROXY = proxy;
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
	const now = Date.now();
	const errors = [];

	const { repos, errors: ghErr } = collectGithub(cfg, { days, proxy, token });
	errors.push(...ghErr);

	const scored = repos.map((repo) => ({ repo, ...scoreRepo(repo, cfg, now) })).sort((a, b) => b.score - a.score);
	const seen = loadSeen(resolve(ROOT, cfg.seenFile));
	const { fresh, skipped } = applySeen(scored, seen);

	const adopt = { threshold: cfg.thresholds.adopt, items: fresh.filter((x) => x.verdict === "adopt") };
	const watch = { threshold: cfg.thresholds.watch, items: fresh.filter((x) => x.verdict === "watch") };
	const eco = collectEcosystem(cfg, { proxy, token }).repos;
	const hn = cfg.sources.hn ? collectHn(cfg, null) : [];
	const arxiv = cfg.sources.arxiv ? collectArxiv(cfg, { days: cfg.papers.days, proxy: null }) : [];
	const papers = arxiv
		.map((paper) => ({ paper, ...scorePaper(paper, cfg, now) }))
		.sort((a, b) => b.score - a.score)
		.filter((x) => x.verdict !== "ignore")
		.slice(0, cfg.papers.top);
	const models = cfg.sources.openrouter ? collectModels(null) : null;

	if (flag("--json")) {
		console.log(JSON.stringify({ date: iso(now), adopt: adopt.items, papers, watch: watch.items, eco, hn, arxiv, models, skipped, errors }, null, 1));
		return;
	}

	const md = renderMarkdown({ date: iso(now), adopt, papers, watch, eco, hn, arxiv, models, errors, cfg });
	if (!flag("--write")) {
		console.log(md);
		return;
	}

	const dir = resolve(ROOT, cfg.outputDir);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${iso(now)}.md`);
	writeFileSync(file, md, "utf8");

	for (const it of scored) {
		const key = it.repo.full_name;
		const prev = seen[key] || { first: iso(now), status: "watch" };
		seen[key] = {
			first: prev.first,
			last: iso(now),
			score: it.score,
			status: prev.status === "adopted" || prev.status === "ignored" ? prev.status : it.verdict === "ignore" ? "ignored" : "watch",
			stars: it.repo.stargazers_count,
		};
	}
	writeFileSync(resolve(ROOT, cfg.seenFile), `${JSON.stringify(seen, null, "\t")}\n`, "utf8");

	console.log(`已写入 ${cfg.outputDir}/${iso(now)}.md`);
	console.log(`候选 ${adopt.items.length} · 观察 ${watch.items.length} · 生态 ${eco.length} · 跳过(已见) ${skipped.length}`);
	if (errors.length) console.log(`取数失败 ${errors.length} 条：${errors.slice(0, 3).join(" | ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		// 定时任务里跑，栈没人看：给一行能照做的错误，非零退出让调度器知道这次没成
		console.error(`radar 失败：${err.message}`);
		console.error("常见原因：team/radar.json 不在、--config 路径写错、或本机网络全断（加 --no-proxy 试试）");
		process.exit(1);
	}
}
