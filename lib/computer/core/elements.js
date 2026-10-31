/**
 * 观测编号表 —— REQ-024 步骤 6。
 *
 * 存在的理由只有一个：**编号会过期**。
 *
 * `observe_screen` 给模型一份「[7] Button "插件" @ (140,162)」的清单，模型可能隔几步
 * 才用第 7 号。这中间的界面完全可能已经变了（列表重排、弹窗覆盖、页面跳转），
 * 而按一个过期的坐标点下去，后果是静默的：点了、有反应、只是点错了东西。
 *
 * 所以每次观测生成一个新版本号，模型拿到的编号绑定「第几次观测」。用旧版本号来点击
 * 一律拒绝，让模型重新观测 —— 代价是一轮往返，收益是绝不点错。
 *
 * 注意这只是第一道闸。真正的兜底在 daemon 侧：`invoke` 会在目标窗口内按
 * role + name + 坐标三重校验，元素真的不在了就报错，绝不「坐标大概还在就点一下」。
 */

/**
 * @returns {{load: (hwnd: number, elements: any[]) => number, resolve: (n: number, expectVersion?: number) => {el: any, hwnd: number, version: number} | {error: string}, version: number, size: number, clear: () => void}}
 */
export function createElementTable() {
	let version = 0;
	let hwnd = 0;
	let elements = [];

	return {
		get version() {
			return version;
		},
		get size() {
			return elements.length;
		},

		/** 每次观测写入一份新表，并把版本号 +1。返回新版本号。 */
		load(h, list) {
			version += 1;
			hwnd = Number(h) || 0;
			elements = Array.isArray(list) ? list : [];
			return version;
		},

		/**
		 * 按编号取元素。1-based，与 observe_screen 清单里的 [n] 对应。
		 * @param {number} n
		 * @param {number} [expectVersion] 模型声称的版本号；给了就必须与当前一致
		 */
		resolve(n, expectVersion) {
			if (elements.length === 0) {
				return { error: "还没观测过界面 —— 先调用 observe_screen 拿一份带编号的清单" };
			}
			if (expectVersion !== undefined && expectVersion !== null && Number(expectVersion) !== version) {
				return {
					error: `编号已过期：你用的是第 ${expectVersion} 次观测的编号，当前是第 ${version} 次。请重新 observe_screen 再点`,
				};
			}
			const idx = Number(n);
			if (!Number.isInteger(idx) || idx < 1) {
				return { error: `编号必须是正整数，收到 ${n}` };
			}
			const el = elements[idx - 1];
			if (el === undefined) {
				return { error: `没有第 ${idx} 号元素（当前这次观测共 ${elements.length} 个）` };
			}
			return { el, hwnd, version };
		},

		clear() {
			elements = [];
			hwnd = 0;
		},
	};
}
