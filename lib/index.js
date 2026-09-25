/**
 * dsh-team-workflow —— 把 pi-workflow 的团队基线搬进 DeepSeek Harness。
 *
 * 拆成几块，每块独立降级（缺哪个服务就关哪块，不让整包挂掉）：
 *   基线    team/RULES.md → systemPrompt order 600（SECTION_ORDERS.TEAM_POLICY）
 *   审计    session/event → <DSH_HOME>/storages/audit-log/<日期>.jsonl
 *   节流    session/event 统计 + compaction/pruner overlay
 *   rtk     系统提示路由 + tools/post-execute 输出压缩
 *   lens    可选：spawn pi-lens 的 analyze-cli
 *   lens工具 可选：pi-lens 的 12 个代码情报工具（默认全闲置，靠 lens_tools 按需点亮）
 *   context7 可选：第三方库文档查询（一个 docs 工具，内部先搜后取）
 *   命令    /team-baseline、/thrift、/audit-log
 *   交接    会话上下文压不动时：写交接文档 + 建新会话 + 注入未完成任务
 *   linux   可选：bash 工具（一次性 + 持久），让 AI 在 Windows 上也能跑 linux 命令
 *   更新    可选：启动时比对 git 远端，落后就 fetch + merge --ff-only（不阻塞启动）
 *
 * 无依赖、无 Config schema —— 配置靠 apply(ctx, config) 的默认值 + 手写校验，
 * 这样 dsh 用 link:/file: 装包时不会被传递依赖解析绊住。
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { AUTO_UPDATE_DEFAULTS, AUTO_UPDATE_FIELDS, installAutoUpdate } from "./auto-update.js";
import { BASH_DEFAULTS, BASH_FIELDS, installBashLinux } from "./bash-linux.js";
import { AUDIT_DEFAULTS, AUDIT_FIELDS, installAuditLog } from "./audit.js";
import { installBaseline } from "./baseline.js";
import { installCommands } from "./commands.js";
import { CONTEXT7_DEFAULTS, CONTEXT7_FIELDS, installContext7 } from "./context7.js";
import { HANDOFF_DEFAULTS, HANDOFF_FIELDS, installHandoff } from "./handoff.js";
import { installLens } from "./lens.js";
import { LENS_TOOLS_DEFAULTS, LENS_TOOLS_FIELDS, installLensTools } from "./lens-tools.js";
import { MC_DEFAULTS, MC_FIELDS, installMagicContext } from "./mc.js";
import { installRtk, RTK_DEFAULTS, RTK_FIELDS } from "./rtk.js";
import { installThrift, THRIFT_DEFAULTS, THRIFT_FIELDS } from "./thrift.js";
import { WEB_DEFAULTS, WEB_FIELDS, installWebSearch } from "./web.js";
import { readJsonConfig } from "./util.js";

export const name = "dsh-team-workflow";

/**
 * 必需服务：commands / systemPrompt / tools / sessions。
 * cordis 的 ctx 是访问器代理，**没 inject 的服务读一下就抛**
 * （`cannot get property "x" without inject`），不是返回 undefined。
 * 所以这几个都必须声明，之后再按存在与否自己降级。
 */
export const inject = ["commands", "systemPrompt", "tools", "sessions"];

const rootUrl = () => new URL("../", import.meta.url);
const rootFile = (relative) => fileURLToPath(new URL(relative, rootUrl()));

const SKILL_NAMES = [
	"commit-convention",
	"team-baseline-feedback",
	"api-review",
	"ui-review",
	"review",
];

function readVersion() {
	try {
		return JSON.parse(fs.readFileSync(rootFile("package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** 读包内 team/extensions/*.json 的默认值，再叠调用方 config（config 优先） */
function layered(file, defaults, fields, override) {
	return {
		...defaults,
		...readJsonConfig(rootFile(file), {}, fields, () => {}),
		...(override ?? {}),
	};
}

export function apply(ctx, config = {}) {
	const root = fileURLToPath(rootUrl());
	const rulesFile = rootFile("team/RULES.md");
	const modelsFile = rootFile("team/models.template.json");
	const skillsDir = rootFile("skills");

	// —— 1. 团队规范进系统提示：核心功能 ——
	ctx.effect(() => installBaseline(ctx, rulesFile), "team:baseline");

	// —— 2. 审计日志 ——
	const auditConfig = layered("team/extensions/audit-log.json", AUDIT_DEFAULTS, AUDIT_FIELDS, config.audit);
	const audit = installAuditLog(ctx, auditConfig);
	ctx.effect(() => audit.dispose, "team:audit-log");

	// —— 3. 上下文节流 ——
	const thrift = installThrift(ctx, {
		defaults: layered("team/extensions/context-thrift.json", THRIFT_DEFAULTS, THRIFT_FIELDS, config.thrift),
	});
	ctx.effect(() => thrift.dispose, "team:thrift");

	// —— 4. rtk ——
	const rtkConfig = layered("team/extensions/rtk.json", RTK_DEFAULTS, RTK_FIELDS, config.rtk);
	const rtk = installRtk(ctx, rtkConfig);

	// —— 5. pi-lens（找不到就自己关掉）——
	const lens = installLens(ctx, rootUrl(), config.lens);

	// —— 5b. pi-lens 工具集：默认只注册一个 lens_tools 入口，12 个真工具按需点亮。
	// 全常驻会让地板涨 75%（真实成本 +8.7%），而实测这些工具几乎没人用。
	const lensToolsConfig = layered("team/extensions/lens-tools.json", LENS_TOOLS_DEFAULTS, LENS_TOOLS_FIELDS, config.lensTools);
	const lensTools = lensToolsConfig.enabled ? installLensTools(ctx, rootUrl(), lensToolsConfig) : { enabled: false, status: "已关闭" };

	// —— 6. 联网搜索 provider（web 服务不在就自己跳过）——
	const webConfig = layered("team/extensions/web-search.json", WEB_DEFAULTS, WEB_FIELDS, config.web);
	installWebSearch(ctx, webConfig);

	// —— 6b. context7 文档查询（免 key 的公开 HTTP API，不走 MCP）——
	const context7Config = layered("team/extensions/context7.json", CONTEXT7_DEFAULTS, CONTEXT7_FIELDS, config.context7);
	const context7 = installContext7(ctx, context7Config);

	// —— 7. magic-context（bundle 不在就自己关掉）——
	const mcConfig = layered("team/extensions/magic-context.json", MC_DEFAULTS, MC_FIELDS, config.mc);
	const mcPromise = installMagicContext({ ctx, packageRootUrl: rootUrl(), config: mcConfig, log: (m) => ctx.logger.info(m) });

	// —— 7b. 会话交接（sessionController 不在就自己关掉）——
	const handoff = installHandoff(ctx, {
		defaults: layered("team/extensions/handoff.json", HANDOFF_DEFAULTS, HANDOFF_FIELDS, config.handoff),
	});

	// —— 7c. linux/bash 命令（Windows 上靠 Git Bash；自己起进程，不走 ctx.shell）——
	// dsh 的 ctx.shell 是单例，Windows 上被 pwsh 占着；开 dsh 自己的 tool-bash
	// 只会得到「名叫 bash、实际跑 PowerShell」的工具。所以这条自己注册工具。
	const bashLinux = installBashLinux(ctx, {
		config: layered("team/extensions/bash-linux.json", BASH_DEFAULTS, BASH_FIELDS, config.bashLinux),
	});

	// —— 7d. 启动时自动更新（fire-and-forget：刻意不 await）——
	// 本包是 git 软链（不是 npm 包），所以「更新」实质是拉代码：
	// fetch（只读）+ merge --ff-only（可并发，不会替用户决定合并策略）。
	// 不 await：git fetch 走网络，慢起来能把启动拖住。状态对象是活的，
	// /team-baseline 随时能读；失败只影响它自己那一行。
	const autoUpdate = installAutoUpdate(ctx, {
		config: layered("team/extensions/auto-update.json", AUTO_UPDATE_DEFAULTS, AUTO_UPDATE_FIELDS, config.autoUpdate),
		cwd: root,
	});

	// —— 8. 命令 ——
	const skillCount = SKILL_NAMES.filter((n) => fs.existsSync(rootFile(`skills/${n}/SKILL.md`))).length;

	ctx.effect(
		() =>
			installCommands(ctx, {
				version: readVersion(),
				root,
				rulesFile,
				rulesExists: fs.existsSync(rulesFile),
				modelsExists: fs.existsSync(modelsFile),
				skillsDir,
				skillCount,
				audit: {
					enabled: auditConfig.enabled,
					dir: audit.dir,
					get count() {
						return audit.seq;
					},
					maxFieldChars: auditConfig.maxFieldChars,
					recordFullPrompt: auditConfig.recordFullPrompt,
				},
				thrift,
				rtk,
				lens,
				lensTools,
				context7,
				mcPromise,
				handoff,
				bashLinux,
				autoUpdate,
			}),
		"team:commands",
	);

	ctx.logger.info(
		`[team] dsh-team-workflow 已加载：审计=${auditConfig.enabled} rtk=${rtk.active} lens=${lens.enabled} lens工具=${lensTools.enabled} context7=${context7.enabled} 交接=${handoff.enabled} bash=${bashLinux.enabled}`,
	);
}

export default { name, inject, apply };
