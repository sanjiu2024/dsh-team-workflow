/**
 * 凭据保险库（REQ-037）：移植自 `kurumi1ksllq/DSH-plugins` 的 `dsh-credential-vault` 0.6.0。
 *
 * ## 为什么不直接 link 那个仓库
 *
 * 2026-11-10 用户的要求是「直接移植进我这个工作流里面」——不是装个外部 bundle。
 * 区别很实在：挂 `link:` 意味着这份能力依赖 D 盘那个 clone（换机器就没有），
 * 而移植进来是**一份代码、一个版本号、一起发版**，别人拉我们的包就带着。
 *
 * 搬的是**后端 2724 行**（`host.js` + `lib/`），**UI 没搬** ——
 * 那个在 `dsh-inventory` 里，是 18595 行客户端分片。管理界面用我们自己的 toolbox 做。
 * 上游代码**零修改**：路径与结构保持原样，改动全在这一层适配里。
 *
 * ## 和上游的两处差异
 *
 * 1. **顶层 `inject` 改成模块内 `ctx.inject`**。上游写的是
 *    `export const inject = ['tools', 'webServer', 'systemPrompt']` ——
 *    那是**整个插件级**的声明，缺任何一个服务，连团队基线都会一起不激活。
 *    这里改成模块内条件激活：没有 `webServer` 的 profile（headless）里，
 *    只有保险库不激活，其余照常。
 *
 * 2. **多一层开关 + 状态**。`enabled: false` 时连 store 都不建（不碰磁盘）。
 *
 * ## `use` 为什么不返回明文
 *
 * 上游的设计值得照抄：`action: "use"` 只返回环境变量名（`DSH_CRED_GITHUB_TOKEN`），
 * 值由宿主的 `dsh-shell-env` 注入到每次 shell 调用里。这样密钥**不进对话、不进会话日志**。
 * `reveal` 是逃生门，每次写审计。这个取舍在我们这边更重要 ——
 * `superagent` 的「凭据不进 agent」也是同一条原则。
 *
 * @module dsh-team-workflow/vault
 */

import { apply as applyVault, defaultVaultDir, TOOL_NAME } from "./host.js";

/** 需要哪些宿主服务才激活。少一个就整块不激活（不影响插件其它部分）。 */
const REQUIRED_SERVICES = ["tools", "webServer", "systemPrompt"];

export const VAULT_DEFAULTS = Object.freeze({
	/** 默认关：它会在 `$DSH_HOME` 下建加密文件和主密钥，没明确同意不建。 */
	enabled: false,
	/** 保险库目录。空 = `<DSH_HOME>/credential-vault`。 */
	vaultDir: "",
	/** `use` 发出去的环境变量名多久过期（毫秒）。上游默认 10 分钟。 */
	grantTtlMs: 600_000,
});

export const VAULT_FIELDS = {
	enabled: (v) => (typeof v === "boolean" ? v : undefined),
	vaultDir: (v) => (typeof v === "string" ? v : undefined),
	grantTtlMs: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 1000 ? Math.floor(v) : undefined),
};

/** 工具有没有真的注册上（面板/diagnostics 用）。 */
export { TOOL_NAME };

/**
 * 装保险库。
 *
 * @param {object} ctx 插件上下文
 * @param {{ config?: object, dshHome?: () => string, log?: (m: string) => void }} options
 * @returns {{ describe: () => string, dispose: () => void, state: object }}
 */
export function installVault(ctx, { config = {}, dshHome, log = () => {} } = {}) {
	const state = { status: "未启用", activated: false, tool: TOOL_NAME };
	const disposers = [];
	const cfg = { ...VAULT_DEFAULTS, ...config };

	if (cfg.enabled !== true) {
		state.status = "关闭（team/extensions/vault.json 的 enabled=false）";
		return { describe: () => state.status, dispose: () => {}, state };
	}

	// 「没激活」必须有声音（和 superagent 那处同一个理由：ctx.inject 缺依赖时静默不回调）。
	ctx.effect(() => {
		const timer = setTimeout(() => {
			if (state.activated) return;
			const missing = REQUIRED_SERVICES.filter((name) => {
				try {
					return ctx.get(name) === undefined;
				} catch {
					return true;
				}
			});
			state.status = `未激活：缺服务 ${missing.join(", ") || "(探测不到具体名字)"}`;
			log(`保险库未激活，缺服务：${missing.join(", ") || "(未知)"}`);
		}, 3000);
		timer.unref?.();
		return () => clearTimeout(timer);
	}, "team:vault:diagnose");

	ctx.inject(REQUIRED_SERVICES, (scope) => {
		const dir = cfg.vaultDir === "" ? defaultVaultDir() : cfg.vaultDir;
		state.activated = true;
		state.status = `已启用 · ${dir}`;
		try {
			// 上游的 apply 自己把工具、系统提示段、HTTP 路由都挂上；我们只转交 scope 与配置。
			applyVault(scope, {
				vaultDir: dir,
				grantTtlMs: cfg.grantTtlMs,
			});
		} catch (error) {
			// 挂载失败不能让宿主起不来 —— 记状态、留日志，其余功能照常。
			state.activated = false;
			state.status = `挂载失败：${String(error?.message ?? error)}`;
			log(`保险库挂载失败：${String(error?.message ?? error)}`);
		}
	});

	return {
		describe: () => state.status,
		dispose: () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 忽略 */
				}
			}
		},
		state,
	};
}
