/**
 * 从宿主取包的导出（`ctx.loader.import`）。
 *
 * 为什么需要它、以及**为什么不能只用 `loader.unwrapExports`**：
 * `unwrapExports` 按 `__esModule` 语义把命名空间**换成 default**
 * （`cordis-plugin-loader/lib/index.js:664`：
 * `(e = e.default ?? e, !e.__esModule) ? e : e.default ?? e`），而 dsh 那些包的 default 往往是
 * 函数、命名导出挂在命名空间上 —— 只信它就等于把命名导出全丢掉。2026-10-09 真机踩过：
 * 小队成员一启动就报「dsh-llm 没导出 BlockAssembler」（REQ-011 §8.1）。
 *
 * 所以三个来源按序找：**原始命名空间 → 它的 default → unwrap 结果**。
 * 谁再需要宿主导出，都走这里 —— 别再各写一份（那是同一个 bug 的第二份拷贝）。
 */

/** 在候选对象里找第一个是函数的 `name`。找不到返回 undefined。 */
export function pickExport(candidates, name) {
	for (const candidate of candidates) {
		if (candidate && typeof candidate[name] === "function") return candidate[name];
	}
	return undefined;
}

/** 把一次 `loader.import` 的结果摊成候选列表（顺序即优先级）。 */
export function exportCandidates(loader, raw) {
	let unwrapped;
	try {
		unwrapped = typeof loader?.unwrapExports === "function" ? loader.unwrapExports(raw) : undefined;
	} catch {
		// unwrapExports 抛错不该让整个加载失败 —— 命名空间本身通常就够用
		unwrapped = undefined;
	}
	return [raw, raw?.default, unwrapped];
}

/**
 * 造一个带缓存的宿主导出加载器。
 *
 * 失败**不缓存**：下一次调用还应该能重试（换 profile、升级 dsh 都可能把它修好）。
 *
 * @param ctx - 插件 context（只用 `ctx.loader`）
 * @returns `{ load(specifier, names) }`；`load` 返回 `{ [name]: 函数 }`，缺哪个就是 undefined
 */
export function makeHostLoader(ctx) {
	const cache = new Map();
	return {
		async load(specifier, names) {
			const key = `${specifier}\u0000${names.join(",")}`;
			if (!cache.has(key)) {
				const promise = (async () => {
					const loader = ctx?.loader;
					if (!loader || typeof loader.import !== "function") {
						throw new Error(`ctx.loader 不可用，加载不了 ${specifier}`);
					}
					const candidates = exportCandidates(loader, await loader.import(specifier));
					const picked = {};
					for (const name of names) picked[name] = pickExport(candidates, name);
					return picked;
				})();
				promise.catch(() => cache.delete(key));
				cache.set(key, promise);
			}
			return cache.get(key);
		},
	};
}
