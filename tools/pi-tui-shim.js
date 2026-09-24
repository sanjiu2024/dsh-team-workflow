/**
 * `@earendil-works/pi-tui` 的最小替身。
 *
 * pi-lens 里只有三个渲染模块碰它（`clients/deps/pi-tui.js` 的再导出、
 * `clients/tui-fit.js`、`clients/widget-state.js`、`tools/render-compact.js`），
 * 而 analyze-cli 那条冷跑路径只用到 `visibleWidth` / `truncateToWidth`
 * 和 `Text.prototype.setText`。pi-tui 本体是 pi 自带的运行时包（3.2MB + 两个原生依赖），
 * 为了三个函数把整棵树搬过来不值。
 *
 * 这个桩只保证上述几个 API 存在且行为可接受；它不参与任何真实渲染。
 * 宽度算法是"CJK 及更宽算 2 列"的简化版 —— 终端里够用，
 * 而且这里的结果只会进报告文本，不会进光标定位。
 */

/** 简化宽度：多数东亚字符占 2 列，其余占 1 列。 */
export function visibleWidth(text) {
	let width = 0;
	for (const ch of String(text)) width += ch.codePointAt(0) > 0x1100 ? 2 : 1;
	return width;
}

/** 按可见宽度截断，超出补省略号。 */
export function truncateToWidth(text, maxWidth, ellipsis = "...") {
	const source = String(text);
	const limit = Math.max(0, Number(maxWidth) || 0);
	if (visibleWidth(source) <= limit) return source;
	const tail = visibleWidth(ellipsis);
	let out = "";
	let width = 0;
	for (const ch of source) {
		const w = ch.codePointAt(0) > 0x1100 ? 2 : 1;
		if (width + w > limit - tail) break;
		out += ch;
		width += w;
	}
	return out + ellipsis;
}

/** pi-tui 的 `Text` 组件；这里只满足 `setText` / `render` 的最小契约。 */
export class Text {
	constructor(text = "") {
		this.text = String(text);
	}

	setText(text) {
		this.text = String(text);
	}

	render() {
		return [this.text];
	}

	toString() {
		return this.text;
	}
}
