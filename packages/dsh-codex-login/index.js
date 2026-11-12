// dsh-codex-login — host half.
//
// Gives the ChatGPT (Codex) provider a sign-in button.
//
// ## The gap it fills
//
// `@deepseek-ai/dsh` 0.2.2-rc.1 ships everything needed to use a ChatGPT
// subscription for GPT models — except a way to start the sign-in:
//
//   · pi-ai's catalog has `openai-codex` with `env: []` (no API key by design)
//     and `defaultBaseURL: "https://chatgpt.com/backend-api"`
//   · its OAuth implementation is complete (`loginOpenAICodex` with a browser
//     callback on :1455, `loginOpenAICodexDeviceCode`, `refreshOpenAICodexToken`)
//   · `dsh-llm-pi-ai` registers an authorization flow for every catalog provider
//     unconditionally — its own comment says so
//   · **but nothing calls `authorization.list()`**, and the Models settings page
//     does not mention `authorization` at all
//
// So a user opening `openai-codex` sees only "API address" and "model catalog".
// There is no key to paste, so the provider is unreachable from the GUI.
//
// This plugin is the missing surface. It registers three routes and one tool:
//
//   POST /codex-login/start    begin a device-code sign-in, return immediately
//   GET  /codex-login/status   progress (idle / pending / authorized / failed)
//   POST /codex-login/cancel   withdraw the attempt
//   codex_login                the same two actions as a tool, for agent use
//
// ## Why start and status are separate calls
//
// `authorization.begin()` does not return until the human finishes authorizing,
// and a device code is valid for ~15 minutes. A single request/response call
// would time out, so `start` kicks the attempt off in the background and
// `status` reports where it got to.
//
// ## Why device code is the default
//
// The browser path binds :1455, which the Codex CLI also uses and which is
// frequently already taken. Device code needs no listener.

import { CODEX_LOGIN_DEFAULTS, CODEX_LOGIN_FIELDS, CODEX_LOGIN_ROUTE, activeCodexLogin, installCodexLogin } from './lib/codex-login.js'

export const name = 'dsh-codex-login'

// `authorization` is deliberately NOT here: a profile without it should lose
// this feature, not fail to load the whole plugin. It is read through a
// conditional inject inside install().
export const inject = ['webServer']

/** Config schema, hand-rolled: this package keeps zero runtime dependencies. */
export const Config = {
	enabled: { type: 'boolean', default: CODEX_LOGIN_DEFAULTS.enabled },
	providerKey: { type: 'string', default: CODEX_LOGIN_DEFAULTS.providerKey },
	method: { type: 'string', default: CODEX_LOGIN_DEFAULTS.method },
}

/**
 * Validate and fill one config object.
 *
 * Unknown keys are dropped rather than rejected: a profile written for a newer
 * version of this plugin should still load on an older one.
 *
 * @param {unknown} raw
 * @returns {{ enabled: boolean, providerKey: string, method: string }}
 */
export function normalizeConfig(raw) {
	const input = raw !== null && typeof raw === 'object' ? raw : {}
	const out = { ...CODEX_LOGIN_DEFAULTS }
	for (const key of Object.keys(CODEX_LOGIN_DEFAULTS)) {
		const validate = CODEX_LOGIN_FIELDS[key]
		const value = validate(input[key])
		if (value !== undefined) out[key] = value
	}
	return out
}

/**
 * Register the sign-in surface.
 *
 * @param {object} ctx cordis context
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
	const config = normalizeConfig(rawConfig)
	const log = (message) => ctx.logger?.info?.(`[codex-login] ${message}`)

	const instance = installCodexLogin(ctx, { config, log })
	ctx.effect(() => instance.dispose, 'codex-login')

	// A tool so an agent can walk the user through it without the panel.
	// Registered through a conditional inject: `tools` is optional here too.
	ctx.inject(['tools'], (scope) => {
		const tools = scope.tools
		if (tools === undefined || typeof tools.register !== 'function') return
		const define = tools.defineTool ?? tools.define
		if (typeof define !== 'function') return
		try {
			tools.register(
				define({
					name: 'codex_login',
					description:
						'Start a ChatGPT (Codex) sign-in, or check how the last one went. ' +
						'`action:"start"` returns a device code and a URL — give both to the user; ' +
						'`action:"status"` reports idle / pending / authorized / failed. ' +
						'On success the credential is stored and the openai-codex provider becomes usable after a restart.',
					parameters: {
						type: 'object',
						properties: {
							action: { type: 'string', enum: ['start', 'status', 'cancel'], description: 'What to do. Defaults to status.' },
						},
						additionalProperties: false,
					},
					async execute(args) {
						const action = typeof args?.action === 'string' ? args.action : 'status'
						if (action === 'start') {
							const result = instance.start()
							if (result.ok !== true) return { ok: false, text: `启动失败：${result.error ?? '未知'}` }
							return {
								ok: true,
								text: [
									'已开始登录。把下面两行给用户：',
									`  打开：${result.url}`,
									`  输入码：${result.code}（900 秒内有效）`,
									'授权完成后用 action:"status" 看结果。',
								].join('\n'),
							}
						}
						if (action === 'cancel') {
							instance.cancel()
							return { ok: true, text: '已取消。' }
						}
						return { ok: true, text: JSON.stringify(instance.snapshot(), null, 2) }
					},
				}),
			)
		} catch (error) {
			log(`注册 codex_login 工具失败：${String(error?.message ?? error)}`)
		}
	})

	log(`已挂载（enabled=${config.enabled}，路由前缀 ${CODEX_LOGIN_ROUTE}）`)
}

export { CODEX_LOGIN_DEFAULTS, CODEX_LOGIN_ROUTE, activeCodexLogin }
