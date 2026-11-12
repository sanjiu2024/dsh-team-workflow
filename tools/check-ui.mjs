#!/usr/bin/env node
/**
 * 从界面源码里挑出「一看就是 AI 拼的」写法。
 *
 * 移植自 minorun365/unslop-ai-app 的 tools/check-ui.mjs（Apache-2.0），
 * 规则逻辑原样保留，只把提示文案改成中文、输出格式对齐本仓库习惯。
 *
 * 用法：
 *   node tools/check-ui.mjs <文件或目录>...
 *   某一行包含 check-ui-ignore 就跳过（用于确实需要那个写法的地方）
 *
 * 退出码：0 = 没有指摘；1 = 有指摘；2 = 用法错误。
 * 零依赖：不装任何包，纯 node:fs 扫文本。
 *
 * 为什么只做正则扫描而不是 AST：这些规则全是「写法特征」，正则足够，
 * 而且能同时吃 html/css/jsx/tsx/vue/svelte —— AST 得为每种语言配解析器。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const EXTS = new Set([".html", ".htm", ".css", ".scss", ".jsx", ".tsx", ".js", ".ts", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "out", "coverage", "cdk.out"]);

/** #rrggbb → {h,s,l}，色相用于判断「紫蓝粉」那类 AI 标配色。 */
function hexToHsl(hex) {
	let h = hex.replace("#", "");
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	if (!d) return { h: 0, s: 0, l };
	const s = d / (1 - Math.abs(2 * l - 1));
	const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return { h: (hue * 60 + 360) % 360, s, l };
}

function rgbaIsColored(str) {
	const m = str.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
	if (!m) return false;
	const [r, g, b] = m.slice(1, 4).map(Number);
	return Math.max(r, g, b) - Math.min(r, g, b) > 40;
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{2705}\u{274C}\u{2728}]/u;
const stripComments = (line) => line.replace(/\/\/.*$|<!--.*?-->|\/\*.*?\*\//g, "");

const RULES = [
	{
		id: "side-stripe",
		msg: "卡片只在一侧有粗色边。改用面、圆角、浅阴影，状态用小圆点或文字",
		test: (line) => {
			const css = line.match(/border-(left|right|top|bottom)(-width)?\s*:\s*(\d+(?:\.\d+)?)px/);
			if (css && Number(css[3]) >= 3) return true;
			return /\bborder-[lrtb]-(4|8|\[[3-9]px\]|\[\d{2}px\])\b/.test(line);
		},
	},
	{
		id: "emoji",
		msg: "界面文字里用了 emoji。换成同一套线性图标，或者干脆不画",
		test: (line, ctx) => !ctx.isCss && EMOJI.test(stripComments(line)),
	},
	{
		id: "gradient-text",
		msg: "文字上了渐变。改单色",
		test: (line) => /background-clip\s*:\s*text|\bbg-clip-text\b/.test(line),
	},
	{
		id: "loud-gradient",
		msg: "紫／蓝紫／粉的艳渐变。底色用无彩色，重色只留在 1~2 个有意义的位置",
		test: (line) => {
			if (/\b(from|via|to)-(purple|violet|fuchsia|pink|indigo)-\d{3}\b/.test(line)) return true;
			if (!/gradient\(/.test(line)) return false;
			return (line.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || [])
				.map(hexToHsl)
				.some((c) => c.h >= 255 && c.h <= 335 && c.s > 0.45 && c.l > 0.25 && c.l < 0.8);
		},
	},
	{
		id: "glow",
		msg: "彩色发光阴影。层次靠明度差和细线做",
		test: (line) => /box-shadow\s*:[^;]*\b(rgba|hsla)\(/.test(line) && rgbaIsColored(line),
	},
	{
		id: "transition-all",
		msg: "transition: all。写明要动哪个属性；悬停只让底色变一档",
		// 两种写法都要抓：CSS 的 `transition: all` 和 Tailwind 的 `transition-all` class
		test: (line) => /transition\s*:\s*all\b|\btransition-all\b/.test(line),
	},
	{
		id: "hover-scale",
		msg: "悬停放大。改成底色变化",
		test: (line) => /(hover:)?scale-(10[1-9]|1[1-9]\d)\b/.test(line) || /:hover[^{]*\{[^}]*transform\s*:\s*scale\(/.test(line),
	},
	{
		id: "looping-motion",
		msg: "常驻循环动画（pulse/ping/bounce）。只给真正在进行中的东西用",
		test: (line) => /\banimate-(pulse|ping|bounce|spin)\b/.test(line) || /animation\s*:[^;]*\b(infinite)\b/.test(line),
	},
	{
		id: "heavy-weight",
		msg: "字重 800 以上。标题到 600~700 就够",
		test: (line) => /\bfont-(weight\s*:\s*|)?(8|9)\d{2}\b/.test(line) || /\bfont-(black|extrabold)\b/.test(line),
	},
	{
		id: "tracked-uppercase",
		msg: "全大写 + 拉字距的标签。中文界面直接用正常文字",
		test: (line) => /(uppercase)/.test(line) && /tracking-/.test(line),
	},
	{
		id: "italic",
		msg: "斜体。中文字体只是被机械倾斜，改用颜色或字重区分",
		test: (line) => /\bitalic\b|font-style\s*:\s*italic/.test(line),
	},
	{
		id: "off-grid-spacing",
		msg: "间距不在 4px 栅格上",
		test: (line) => {
			const m = line.match(/\b(?:padding|margin|gap|top|right|bottom|left)[a-z-]*\s*:\s*(\d+)px/g) || [];
			return m.some((decl) => Number(decl.match(/(\d+)px/)[1]) % 4 !== 0);
		},
	},
	{
		id: "small-input-font",
		msg: "输入框字号小于 16px。iOS Safari 聚焦时会放大整页",
		test: (line) => /font-size\s*:\s*(1[0-5]|[0-9])px/.test(line) && /input|textarea|select/.test(line),
	},
	{
		id: "hover-menu",
		msg: "悬停才展开的菜单。触屏点不出来，改成点击展开",
		test: (line) => /group-hover:|:hover\s*>\s*(ul|\.menu|nav)/.test(line),
	},
	{
		id: "key-hint",
		msg: "标了键盘快捷键（kbd）。需要当着人操作的界面要能用鼠标走完",
		test: (line) => !/^\s*(\/\/|\*)/.test(line) && /<kbd|class="[^"]*\bkbd\b/.test(line),
	},
	{
		id: "waiting-copy",
		msg: "用来填空白态的等待话术或寒暄。要么什么都不写，要么只写下一步该按什么",
		test: (line, ctx) =>
			!ctx.isCss && /(正在思考|让我想想|稍等片刻|马上就好|很高兴为您|希望对你有帮助)/.test(stripComments(line)),
	},
	{
		id: "hype-copy",
		msg: "堆功效的形容词。写清楚它到底做什么",
		test: (line, ctx) =>
			!ctx.isCss && /(无缝|极致|颠覆|一站式|强大|智能化|全方位|开箱即用)/.test(stripComments(line)),
	},
	{
		id: "exclamation",
		msg: "界面文案里有感叹号。用陈述句",
		test: (line, ctx) => !ctx.isCss && /[！!]/.test(stripComments(line).replace(/!important/g, "")),
	},
];

function walk(p, out) {
	const st = statSync(p);
	if (st.isDirectory()) {
		for (const name of readdirSync(p)) {
			if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
			walk(join(p, name), out);
		}
	} else if (EXTS.has(extname(p).toLowerCase()) && !/\.min\.|-[A-Za-z0-9_-]{8}\.(js|css)$/.test(p)) {
		out.push(p);
	}
}

const args = process.argv.slice(2);
if (!args.length) {
	console.error("用法: node tools/check-ui.mjs <文件或目录>...");
	process.exit(2);
}

const files = [];
for (const a of args) walk(a, files);

let count = 0;
for (const file of files) {
	const isCss = [".css", ".scss"].includes(extname(file).toLowerCase());
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (line.includes("check-ui-ignore") || line.length > 1000) return;
		for (const rule of RULES) {
			if (rule.test(line, { isCss })) {
				count++;
				console.log(`${relative(process.cwd(), file)}:${i + 1}  [${rule.id}] ${rule.msg}`);
			}
		}
	});
}

console.log(`\n扫了 ${files.length} 个文件，${count} 条指摘`);
process.exit(count ? 1 : 0);
