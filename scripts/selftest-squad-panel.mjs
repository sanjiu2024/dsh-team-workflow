#!/usr/bin/env node
/**
 * 自检：小队面板（REQ-015 的展示三件 + 搜索框）。
 *
 * 两段：
 *   1. **纯函数**：`filterSquads`（队名/目标/成员名/角色/黑板命中、空查询、无匹配）
 *      与 `formatDuration`（0s / 秒 / 分 / 时 / 天五个档）
 *   2. **真渲染**：用 React 替身把 `SquadPage` 挂起来，喂一份**带新字段**的快照，
 *      断言耗时 / token / 重试 / 待投 / 合计 / 工作目录 / 接管徽章真出现在文字里，
 *      并且搜索框的 `onChange` 真能改变显示；再喂一份**老形状**的快照（REQ-015 之前
 *      的字段一个都没有），断言它不炸、也不显示假的 0。
 *
 * 为什么第 2 段不能省：纯函数全绿也可能压根没接到面板上（过滤写好了、没人调用它，
 * 自检照样通过）。反过来，老形状那段挡的是「字段没来就显示 undefined」这类只有
 * 真渲染才看得见的坏味道。
 *
 *   node scripts/selftest-squad-panel.mjs
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const ROOT = new URL("../", import.meta.url);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── 装载客户端半区 ─────────────────────────────────────────────────────────

const clientExport = JSON.parse(fs.readFileSync(new URL("package.json", ROOT), "utf8")).exports["./client"];
const clientSource = fs.readFileSync(new URL(clientExport, ROOT), "utf8");

/**
 * 一个够用的 React 替身：`useState` 真存状态并触发重渲染，`useEffect` 真跑
 * （否则面板的探活与轮询都不发生），`createElement` 返回可遍历的对象树。
 *
 * `deps` 必须真的比较 —— 这是 React 的语义，不是可选的优化：面板是
 * `useEffect(refresh, [refresh])` + `useCallback(fn, [])`，替身若不 memo，
 * 每次渲染都会得到新的 `refresh`，effect 就重跑，于是
 * `refresh → setData → 重渲染 → refresh …` 无限循环。
 */
function createReact() {
	const hooks = [];
	let cursor = 0;
	let rerender = null;

	const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

	const React = {
		createElement(type, props, ...children) {
			return { type, props: { ...props, children: children.length <= 1 ? children[0] : children } };
		},
		useState(initial) {
			const index = cursor++;
			if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
			const set = (next) => {
				hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
				if (rerender !== null) rerender();
			};
			return [hooks[index], set];
		},
		useCallback(fn, deps) {
			const index = cursor++;
			const prev = hooks[index];
			if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.fn;
			hooks[index] = { deps, fn };
			return fn;
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const prev = hooks[index];
			if (prev === undefined || !sameDeps(prev.deps, deps)) {
				if (typeof prev?.cleanup === "function") prev.cleanup();
				hooks[index] = { deps, cleanup: fn() };
			}
		},
	};

	return {
		React,
		render(Component) {
			const render = () => {
				cursor = 0;
				return Component();
			};
			rerender = render;
			return render();
		},
		cleanup() {
			for (let index = 0; index < hooks.length; index += 1) {
				const slot = hooks[index];
				if (typeof slot?.cleanup === "function") {
					slot.cleanup();
					hooks[index] = { deps: slot.deps, cleanup: undefined };
				}
			}
		},
	};
}

/**
 * 真加载客户端文件。它是 dsh 的 **classic script**（不是 ESM）：文件体自己调
 * `window.__ModuleLoader__.load({ id, factory })`。所以只能 `new Function("window", src)`
 * 跑一遍 —— 源码是仓库里自己的文件，和 `selftest-squad.mjs` 里同样的做法。
 */
function loadClient(React) {
	let captured;
	const window = {
		__ModuleLoader__: {
			load(definition) {
				captured = definition;
			},
		},
	};
	new Function("window", clientSource)(window);
	assert.ok(captured !== undefined, "客户端文件没有调 window.__ModuleLoader__.load");
	const required = [];
	const require = (name) => {
		required.push(name);
		if (name === "react") return React;
		throw new Error(`客户端不该 require baseline 之外的包：${name}`);
	};
	return { definition: captured, exports: captured.factory(require), required };
}

const { exports: client } = loadClient(createReact().React);

// ── 1. 纯函数 ──────────────────────────────────────────────────────────────

/** 造两支能区分的队：命中范围覆盖队名 / 目标 / 成员名 / 角色 / 黑板五种。 */
const SQUADS = [
	{
		name: "登录改造",
		objective: "把登录改成 OAuth",
		owner: "main-1",
		members: [
			{ label: "实现-A", role: "实现", task: "改代码" },
			{ label: "调研-B", role: "调研", task: "查上游" },
		],
		board: [{ at: 1, from: "主 agent", text: "先冻结接口再动代码" }],
	},
	{
		name: "支付拆分",
		objective: "把支付拆成独立服务",
		owner: "main-1",
		members: [{ label: "审查-C", role: "审查", task: "审这一版" }],
		board: [{ at: 2, from: "主 agent", text: "注意幂等键" }],
	},
];

check("filterSquads：队名命中", () => {
	const hit = client.filterSquads(SQUADS, "支付");
	assert.equal(hit.length, 1);
	assert.equal(hit[0].name, "支付拆分");
});

check("filterSquads：目标命中（队名里没有这个词）", () => {
	const hit = client.filterSquads(SQUADS, "oauth");
	assert.equal(hit.length, 1, "大小写不敏感：OAuth 用小写查也该中");
	assert.equal(hit[0].name, "登录改造");
});

check("filterSquads：成员名命中", () => {
	const hit = client.filterSquads(SQUADS, "调研-B");
	assert.equal(hit.length, 1);
	assert.equal(hit[0].name, "登录改造");
});

check("filterSquads：角色与黑板正文也命中", () => {
	assert.equal(client.filterSquads(SQUADS, "审查").length, 1, "角色要能搜");
	assert.equal(client.filterSquads(SQUADS, "幂等键").length, 1, "黑板正文要能搜");
	assert.equal(client.filterSquads(SQUADS, "审查")[0].name, "支付拆分");
});

check("filterSquads：空查询（含纯空白）原样返回全部", () => {
	assert.equal(client.filterSquads(SQUADS, ""), SQUADS, "空串要原样返回入参本身");
	assert.equal(client.filterSquads(SQUADS, "   "), SQUADS, "纯空白不算查询");
	assert.equal(client.filterSquads(SQUADS, undefined), SQUADS, "没给查询串也当没过滤");
	assert.equal(client.filterSquads(undefined, "x").length, 0, "入参不是数组时给空数组，别抛");
});

check("filterSquads：无匹配返回空数组", () => {
	assert.deepEqual(client.filterSquads(SQUADS, "zzz-不存在"), []);
	assert.deepEqual(client.filterSquads([], "登录"), [], "没有队时搜什么都空");
});

check("filterSquads：只过滤显示，不改数据", () => {
	const before = JSON.stringify(SQUADS);
	client.filterSquads(SQUADS, "支付");
	assert.equal(JSON.stringify(SQUADS), before, "过滤是纯函数，不能顺手改入参");
});

check("formatDuration：0 → 0s（以及各种非数/负数都归 0s）", () => {
	assert.equal(client.formatDuration(0), "0s");
	assert.equal(client.formatDuration(undefined), "0s");
	assert.equal(client.formatDuration(-5), "0s");
	assert.equal(client.formatDuration(Number.NaN), "0s");
});

check("formatDuration：59s 还是秒", () => {
	assert.equal(client.formatDuration(59_000), "59s");
	assert.equal(client.formatDuration(1), "0s", "不足半秒会被舍到 0s");
});

check("formatDuration：90s 进分档，且带 m", () => {
	const text = client.formatDuration(90_000);
	assert.equal(text, "1m30s");
	assert.match(text, /m/, "分钟档必须带 m");
});

check("formatDuration：过 1 小时进时档，且带 h；再过 1 天进天档", () => {
	const text = client.formatDuration(2 * 3600_000 + 5 * 60_000);
	assert.equal(text, "2h05m");
	assert.match(text, /h/, "小时档必须带 h");
	assert.equal(client.formatDuration(27 * 3600_000), "1d03h", "超过一天就折成天");
});

// ── 2. 真渲染 ──────────────────────────────────────────────────────────────

const settle = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const reply = (status, payload) => async () => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => JSON.stringify(payload),
});

/** 面板里是 5 秒轮询的真定时器 —— 不换掉，node 会因为还挂着 interval 而不退出。 */
async function withFakeTimers(fn) {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	globalThis.setInterval = () => ({});
	globalThis.clearInterval = () => {};
	try {
		return await fn();
	} finally {
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
}

/** 树上所有文字（任意深度）。 */
const textsOf = (node) => {
	const out = [];
	const visit = (n) => {
		if (typeof n === "string") {
			out.push(n);
			return;
		}
		if (n === null || n === undefined || typeof n !== "object") return;
		if (Array.isArray(n)) {
			for (const child of n) visit(child);
			return;
		}
		visit(n.props?.children);
	};
	visit(node);
	return out;
};

/** 找一个满足条件的节点（这里用来找搜索框）。 */
const findNode = (node, predicate) => {
	let found = null;
	const visit = (n) => {
		if (found !== null || n === null || n === undefined || typeof n !== "object") return;
		if (Array.isArray(n)) {
			for (const child of n) visit(child);
			return;
		}
		if (predicate(n)) {
			found = n;
			return;
		}
		visit(n.props?.children);
	};
	visit(node);
	return found;
};

const member = (over) => ({
	label: "实现-A",
	role: "实现",
	task: "改代码",
	worktree: "/tmp/wt-a",
	status: "在跑",
	note: null,
	updatedAt: 1,
	running: true,
	events: 3,
	...over,
});

const squad = (over) => ({
	name: "登录改造",
	objective: "把登录改成 OAuth",
	note: null,
	owner: "main-1",
	adoptedFrom: null,
	cwd: "/home/sanjiu/dsh-team-workflow/.dsh-worktrees/squad-panel",
	usage: { inputTokens: 1234, outputTokens: 340, cacheReadTokens: 12345 },
	createdAt: 1,
	closed: null,
	members: [],
	board: [{ at: 1, from: "主 agent", text: "先冻结接口再动代码" }],
	...over,
});

/** 渲染一次面板：喂一份快照，返回渲染出的树。 */
async function renderPanel(squads) {
	const rt = createReact();
	const { exports } = loadClient(rt.React);
	const tree = await withFetch(
		(url) => (url.endsWith("/squads") ? reply(200, { ok: true, count: squads.length, squads })() : reply(200, { ok: true })()),
		() =>
			withFakeTimers(async () => {
				rt.render(exports.SquadPage);
				await settle();
				const rendered = rt.render(exports.SquadPage);
				rt.cleanup();
				return rendered;
			}),
	);
	return { tree, texts: textsOf(tree).join(" | "), rt, exports };
}

await checkAsync("面板渲染：成员的耗时 / token / 重试 / 待投都在", async () => {
	const { texts } = await renderPanel([
		squad({
			members: [
				member({
					durationMs: 90_000,
					attempts: 3,
					inbox: 2,
					usage: { inputTokens: 1234, outputTokens: 340, cacheReadTokens: 12345 },
				}),
			],
		}),
	]);
	assert.match(texts, /耗时 1m30s/, `耗时要显示成人看的：${texts}`);
	assert.match(texts, /跑了 3 次/, "重试过就要说");
	assert.match(texts, /待投 2 条/, "待投队列不为空就要说");
	assert.match(texts, /in 1\.2k \/ out 340 \/ cacheRead 12\.3k/, `token 要紧凑可读：${texts}`);
});

await checkAsync("面板渲染：小队卡的合计 token / 工作目录 / 接管徽章都在", async () => {
	const { texts } = await renderPanel([squad({ adoptedFrom: "session-old-1" })]);
	assert.match(texts, /合计 in 1\.2k \/ out 340 \/ cacheRead 12\.3k/, `合计要显示：${texts}`);
	assert.match(texts, /…\/\.dsh-worktrees\/squad-panel/, "路径太长只留尾部两段");
	assert.doesNotMatch(texts, /home\/sanjiu/, "中间那几段不该占地方");
	assert.match(texts, /重启后接管/, "接管来的队必须标出来");
});

await checkAsync("面板渲染：搜索框在，且 onChange 真能改变显示", async () => {
	const { tree, rt, exports } = await renderPanel([
		squad({ name: "登录改造", objective: "把登录改成 OAuth" }),
		squad({ name: "支付拆分", objective: "拆服务" }),
	]);
	const input = findNode(tree, (n) => n.type === "input" && n.props?.type === "search");
	assert.ok(input !== null, "面板顶部要有搜索框");
	assert.match(String(input.props.placeholder), /搜/, "占位文字要说明搜什么");
	assert.match(textsOf(tree).join(" | "), /登录改造/, "过滤前两支都该在");

	input.props.onChange({ target: { value: "支付" } });
	const filtered = rt.render(exports.SquadPage);
	const texts = textsOf(filtered).join(" | ");
	assert.match(texts, /支付拆分/, "命中的要留着");
	assert.doesNotMatch(texts, /登录改造/, "没命中的要从显示里去掉");
	assert.match(texts, /匹配 1 \/ 共 2 个/, "过滤时要把「匹配几条 / 共几条」都说出来");
	rt.cleanup();
});

await checkAsync("面板渲染：老形状快照（没有 REQ-015 字段）不炸，也不显示假的 0", async () => {
	const { texts } = await renderPanel([
		{
			name: "登录改造",
			objective: "把登录改成 OAuth",
			note: null,
			owner: "main-1",
			closed: null,
			members: [{ label: "实现-A", role: "实现", task: "改代码", worktree: "/tmp/wt-a", status: "在跑", note: null, running: true, events: 3, updatedAt: 1 }],
			board: [{ at: 1, from: "主 agent", text: "开始" }],
		},
	]);
	assert.doesNotMatch(texts, /undefined/, "字段没来不能渲染成 undefined");
	assert.doesNotMatch(texts, /耗时|待投|合计|跑了/, "没有数据就别显示这一行，更别显示 0");
	assert.match(texts, /实现-A/, "老快照照样要能渲染出成员");
});

await checkAsync("面板渲染：一条都没搜到时，说的是「没匹配」而不是「还没有小队」", async () => {
	const { tree, rt, exports } = await renderPanel([squad({ name: "登录改造" })]);
	const input = findNode(tree, (n) => n.type === "input" && n.props?.type === "search");
	input.props.onChange({ target: { value: "zzz-不存在" } });
	const texts = textsOf(rt.render(exports.SquadPage)).join(" | ");
	assert.match(texts, /没有匹配/, `要说清是搜不到：${texts}`);
	assert.doesNotMatch(texts, /还没有小队/, "有队但搜不到，不能说「还没有小队」");
	rt.cleanup();
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

if (failures > 0) {
	console.log(`\n✗ ${failures} 项失败`);
	process.exit(1);
}
console.log("✓ 自检通过：过滤纯函数（队名/目标/成员/角色/黑板、空查询、无匹配）/ 耗时格式化五档 / 面板真渲染（耗时·token·重试·待投·合计·工作目录·接管徽章·搜索框真的会过滤·老快照不炸）");
