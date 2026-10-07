/**
 * 本包 HTTP 路由的公共件：**请求信任栅栏** + JSON 读写的两个小工具。
 *
 * 为什么单独一个文件：调度器面板（REQ-007）与小队面板（REQ-009）都要挂
 * `/api/team/*` 路由，而**这道栅栏是安全件，不能复制两份** —— 复制出去的那份
 * 一旦漏了修补，就是一条没人盯着的口子。所以放在这里，两边 import 同一个。
 *
 * 从 `lib/scheduler.js` 原样搬过来（纯移动，逻辑一字未改）。
 */
/**
 * 请求信任栅栏。**dsh 的 web server 自己不鉴权**（`dsh-host-webserver` 直接
 * `listen`，全包没有 Authorization / CSRF），所以挂上去的路由默认对「本机任何
 * 进程 + 用户浏览器里的任何页面」都是开的。
 *
 * 不设这道栅栏的话，最坏情况是：用户打开一个恶意网页，那个页面用
 * `fetch(url, {mode:'no-cors', headers:{'content-type':'text/plain'}, body:...})`
 * 就能 POST 建任务 —— `text/plain` 不触发预检，而 body 照样能解析成 JSON。
 * 更糟的是 DNS rebinding：攻击者把域名解析到 127.0.0.1，就能**读走**全部任务
 * 的 prompt 与运行历史。
 *
 * 判据照抄本机同 profile 的第三方插件 `@linxin666/dsh-client-ui-git-graph`
 * （`lib/index.js:1315-1333`）—— 它已经在生产里跑着同一套：
 *   1. socket 的 remoteAddress 必须是回环（这一条是权威，不看 X-Forwarded-For）
 *   2. Host 头必须也是回环（挡 DNS rebinding）
 *   3. `sec-fetch-site: cross-site` 直接拒（挡跨站发起的请求）
 *   4. 有 Origin 时它必须与 Host 同源
 *
 * 只放行回环，不接 paired-device 那条路：本包的调度器面板只在 web profile 用，
 * 就是本机 127.0.0.1 上的那个 GUI。
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
	const parts = normalized.split(".");
	if (parts.length !== 4) return false;
	return parts[0] === "127";
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isLoopbackAddress(hostname);
}

/** @returns {boolean} 这个请求能不能进调度器的路由 */
export function isTrustedRequest(req) {
	if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
	const host = req?.headers?.host;
	if (typeof host !== "string" || host === "") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

export function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

/** 输入不合法（回 400）。其它异常一律 500 —— 别把内部故障说成用户的错 */
export class BadRequest extends Error {}

export function readJsonBody(req, res, { limit = 1024 * 1024 } = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
	let overLimit = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				fail(new BadRequest("请求体过大"));
				// 不能在这里 `req.destroy()`：socket 一没，外层 catch 里那个 400 还没
				// 发出去就丢了，客户端只看到 ECONNRESET，不知道是自己超限。
				// 排空剩下的（不再累积）让响应能正常写回去；但排空本身无上限，
				// 本地进程可以一直灌数据占住连接。响应写完就把连接断掉。
				// 这两件事**只做一次**：`settled` 挡的是重复 reject，挡不住重复注册 ——
				// 每个后续 chunk 都重注册一次 `res.once("finish")` 的话，长流会堆出
				// 成百上千个监听器（还会触发 MaxListenersExceededWarning）。
				if (!overLimit) {
					overLimit = true;
					req.resume();
					res?.once?.("finish", () => {
						try {
							req.destroy();
						} catch {
							/* 忽略 */
						}
					});
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (raw === "") return resolve({});
			try {
				const parsed = JSON.parse(raw);
				resolve(parsed && typeof parsed === "object" ? parsed : {});
			} catch {
				fail(new BadRequest("请求体不是合法 JSON"));
			}
		});
		req.on("error", fail);
		// 客户端中途断连：没有 close/aborted 的话这个 promise 永不 settle，
		// handler 就一直挂在那里（每次断连漏一个）
		req.on("close", () => fail(new BadRequest("连接已关闭")));
		req.on("aborted", () => fail(new BadRequest("连接已中断")));
	});
}
