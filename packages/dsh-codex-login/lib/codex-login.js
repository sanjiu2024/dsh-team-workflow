/**
 * ChatGPT (Codex) 登录入口（REQ-039）。
 *
 * ## 它解决什么问题
 *
 * dsh 0.2.2-rc.1 **有**这个能力，但**没有入口**：
 *
 * - pi-ai 的 catalog 里有 `openai-codex` provider（`env: []` 不要 API key，
 *   `baseURL: https://chatgpt.com/backend-api` 走 ChatGPT 订阅额度）
 * - OAuth 实现完整（`loginOpenAICodex` 浏览器回调 1455 / `loginOpenAICodexDeviceCode` 设备码）
 * - `dsh-llm-pi-ai` **无条件**给每个 catalog provider 注册了
 *   `ctx.authorization.registerFlow(...)`（源码注释原话：
 *   "Registration is unconditional on configuration"）
 *
 * **但 `authorization.list()` 全树零调用方** —— 模型设置页里 `authorization` 出现 0 次
 * （只做 API key + baseURL），账号页是 DeepSeek 账号的引导步骤（`step: done`）。
 * 结果是：人在模型页点开 `openai-codex`，只能看到「API 地址 + 模型目录」，
 * **永远签不进去** —— 而这个 provider 是 OAuth-only，没有 key 可填。
 *
 * 这个模块补的就是那个入口：把已经注册好的 flow 接出来，用设备码登录
 * （不占 1455 端口，不和 Codex CLI 抢），把凭据写进 dsh 的 credentials。
 *
 * ## 为什么是「启动 / 查状态」两个动作，不是一次请求
 *
 * `authorization.begin()` **要等到人完成授权才返回** —— 它是阻塞的。而工具箱的 op
 * 是同步返回的，一次请求里等 15 分钟会超时。所以拆开：
 *
 * ```text
 * POST /codex-login/start   → 起一次后台登录，立刻返回（带设备码）
 * GET  /codex-login/status  → 问现在到哪了（pending / authorized / failed）
 * POST /codex-login/cancel  → 取消
 * ```
 *
 * @module dsh-team-workflow/codex-login
 */

/** 路由前缀。和 vault 一样走 webServer 的 exact 路由。 */
export const CODEX_LOGIN_ROUTE = "/codex-login";

/** 默认要授权的凭据 key —— `dsh-llm-pi-ai` 注册 flow 时用的就是它。 */
export const DEFAULT_PROVIDER_KEY = "llm-pi-ai/openai-codex";

/**
 * 进程内唯一的那份状态。
 *
 * 为什么用模块级变量而不是让调用方传引用：工具箱（lib/toolbox.js）和 HTTP 路由
 * 要读同一份状态，而工具箱是**按需动态 import** 这个模块的 —— 只要模块是单例，
 * 拿到的就是同一个对象。用 globalThis 也能做到，但那是在污染全局命名空间。
 */
let ACTIVE = null;

/** 当前已激活的 codex-login 实例（没激活就是 null）。 */
export function activeCodexLogin() {
	return ACTIVE;
}

export const CODEX_LOGIN_DEFAULTS = Object.freeze({
	enabled: false,
	/** 授权成功后写进哪个 credentials 记录。改这个就要改 `dsh-llm-pi-ai` 的 RECORD_SCOPE。 */
	providerKey: DEFAULT_PROVIDER_KEY,
	/** flow 的方法 id。`dsh-llm-pi-ai` 只注册一个 `oauth`。 */
	method: "oauth",
});

export const CODEX_LOGIN_FIELDS = Object.freeze({
	enabled: (value) => (typeof value === "boolean" ? value : undefined),
	providerKey: (value) => (typeof value === "string" && value.includes("/") ? value : undefined),
	method: (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
});

/**
 * 装这个子系统。
 *
 * @param {object} ctx cordis 上下文
 * @param {{ config?: object, log?: (message: string) => void }} [options]
 * @returns {{ describe: () => string, dispose: () => void, state: object }}
 */
export function installCodexLogin(ctx, options = {}) {
	const cfg = { ...CODEX_LOGIN_DEFAULTS, ...(options.config ?? {}) };
	const log = typeof options.log === "function" ? options.log : () => {};

	/** 一次登录尝试的全部可观察状态。前端只读它。 */
	const state = {
		status: "关闭",
		/** idle | pending | authorized | failed | cancelled */
		phase: "idle",
		/** 设备码登录时给人看的 8 位码 */
		code: "",
		/** 浏览器要打开的地址 */
		url: "",
		/** 成功时的账号标识（ChatGPT account id） */
		accountId: "",
		error: "",
		startedAt: "",
	};

	if (cfg.enabled !== true) {
		state.status = "关闭（team/extensions/codex-login.json 的 enabled=false）";
		return { describe: () => state.status, dispose: () => {}, state };
	}

	let authorization;
	let controller = null;

	/**
	 * 起一次登录。
	 *
	 * 为什么立刻返回而不是 await：`begin()` 要等人授权（设备码 900 秒有效）。
	 * 这里把 promise 挂到后台，`state.phase` 就是进度。
	 */
	const start = () => {
		if (authorization === undefined) {
			return { ok: false, error: "宿主没有 authorization 服务（这个版本没有登录通道）" };
		}
		if (state.phase === "pending") {
			return { ok: true, ...snapshot(), note: "已经在等授权了，别重复起" };
		}
		const flow = authorization.describe(cfg.providerKey);
		if (flow === undefined) {
			return {
				ok: false,
				error: `没有为 "${cfg.providerKey}" 注册登录流程 —— 说明 dsh-llm-pi-ai 没挂，或它的 catalog 里没有这个 provider`,
			};
		}
		controller = new AbortController();
		state.phase = "pending";
		state.code = "";
		state.url = "";
		state.error = "";
		state.accountId = "";
		state.startedAt = new Date().toISOString();
		log(`开始登录 ${cfg.providerKey}`);

		const running = authorization.begin({
			key: cfg.providerKey,
			method: cfg.method,
			signal: controller.signal,
			interaction: {
				/** pi-ai 用它通知「去这个链接输这个码」。 */
				notify(notice) {
					if (notice === null || typeof notice !== "object") return;
					if (notice.type === "device_code") {
						state.code = String(notice.userCode ?? "");
						state.url = String(notice.verificationUri ?? "");
					} else if (notice.type === "auth_url") {
						state.url = String(notice.url ?? "");
					} else if (typeof notice.message === "string" && notice.message !== "") {
						// 其余通知（"Continue in your browser" 之类）只进日志，不覆盖设备码
						log(notice.message);
					}
				},
				/**
				 * pi-ai 用它问「浏览器还是设备码」。
				 *
				 * 默认设备码：不占 1455 端口（那个端口和 Codex CLI 共用，常被占），
				 * 也不需要回调服务器。想要浏览器登录就改配置里的 method —— 但 flow 的
				 * 方法 id 只有 `oauth`，选择发生在这一层。
				 */
				async prompt(request) {
					if (request?.type === "select") return "device_code";
					// 其它交互（极少）：返回空串，让 flow 用默认值
					return "";
				},
			},
		});

		running
			.then((outcome) => {
				const status = String(outcome?.status ?? "");
				if (status === "authorized") {
					state.phase = "authorized";
					log(`登录成功：${cfg.providerKey}`);
				} else if (status === "cancelled") {
					state.phase = "cancelled";
					log("登录被取消");
				} else {
					state.phase = "failed";
					state.error = status === "" ? "流程没有返回状态" : status;
					log(`登录失败：${state.error}`);
				}
			})
			.catch((error) => {
				state.phase = "failed";
				state.error = String(error?.message ?? error);
				log(`登录异常：${state.error}`);
			});

		return { ok: true, ...snapshot() };
	};

	const cancel = () => {
		if (authorization === undefined || state.phase !== "pending") return { ok: true, ...snapshot() };
		try {
			authorization.cancel(cfg.providerKey);
		} catch (error) {
			log(`取消失败：${String(error?.message ?? error)}`);
		}
		controller?.abort();
		return { ok: true, ...snapshot() };
	};

	/** 给前端/CLI 的一份只读快照。 */
	const snapshot = () => ({
		phase: state.phase,
		code: state.code,
		url: state.url,
		accountId: state.accountId,
		error: state.error,
		startedAt: state.startedAt,
		providerKey: cfg.providerKey,
	});

	// `authorization` 不在 REQUIRED_SERVICES 里 —— 缺它只该让这个子系统不激活，
	// 不该让整个插件挂掉（这个包要装进别人的 profile）。
	ctx.inject(["authorization"], (scope) => {
		authorization = scope.authorization;
		const flow = authorization?.describe?.(cfg.providerKey);
		state.status = flow === undefined
			? `已启用，但 "${cfg.providerKey}" 没有登录流程（dsh-llm-pi-ai 没挂？）`
			: `已启用 · ${flow.label} · 可登录`;
	});

	// HTTP 面：三个 exact 路由。没挂 webServer 的 profile 就没有面板，但状态还在。
	if (typeof ctx.webServer?.register === "function") {
		const handler = async (req, res) => {
			const send = (code, body) => {
				try {
					res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(body));
				} catch {
					/* 连接已断，没什么可做的 */
				}
			};
			const pathname = new URL(req?.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/";
			const method = String(req?.method ?? "GET").toUpperCase();
			if (pathname === `${CODEX_LOGIN_ROUTE}/status`) {
				if (method !== "GET") return send(405, { ok: false, error: "method-not-allowed" });
				return send(200, { ok: true, ...snapshot() });
			}
			if (pathname === `${CODEX_LOGIN_ROUTE}/start`) {
				if (method !== "POST") return send(405, { ok: false, error: "method-not-allowed" });
				const result = start();
				return send(result.ok === true ? 200 : 400, result);
			}
			if (pathname === `${CODEX_LOGIN_ROUTE}/cancel`) {
				if (method !== "POST") return send(405, { ok: false, error: "method-not-allowed" });
				return send(200, cancel());
			}
			return send(404, { ok: false, error: "not-found" });
		};
		for (const routePath of [`${CODEX_LOGIN_ROUTE}/status`, `${CODEX_LOGIN_ROUTE}/start`, `${CODEX_LOGIN_ROUTE}/cancel`]) {
			ctx.effect(() => ctx.webServer.register({ kind: "exact", path: routePath, handler }));
		}
	}

	ACTIVE = { state, start, cancel, snapshot };
	return {
		describe: () => state.status,
		dispose: () => {
			controller?.abort();
		},
		state,
		start,
		cancel,
		snapshot,
	};
}
