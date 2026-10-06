/**
 * 可选安装的第三方插件（REQ-008）：**决定**这一半是纯函数，动作在 `bin/dsh-team.mjs`。
 *
 * 为什么拆开：装工作流时顺带装别人家的插件，判据很容易写错（已装的当成没装、
 * 非交互环境当成答否、非 web profile 里装界面插件），而这些判据全都是纯逻辑 ——
 * 放在这里就能被自检逐个钉住，不用真去改安装树。
 *
 * 名字/仓库/版本要求的来源与查证日期见 `docs/requirements/REQ-008-可选安装第三方插件.md` §5。
 */

/** 带 web 界面的 profile 才有意义：这三个都是 `platform: "web"` 的界面插件 */
export const WEB_APP_BUNDLE = "@deepseek-ai/dsh-web-app";

/** `--no-plugins`：一个都别问、也别装 */
export const SKIP_ALL_FLAG = "no-plugins";

/**
 * 三个插件。`key` 就是 flag 后缀（`--with-sidebar`）。
 * `note` 里许可那一条不是装饰：`dsh-pet` 的 LICENSE 是 MIT，但 README 另有素材条款
 * （禁商用、二创须署名）—— 询问时要把链接给出去，让用户自己定。
 */
export const OPTIONAL_PLUGINS = [
	{
		key: "sidebar",
		name: "dsh-better-sidebar",
		repo: "https://github.com/omdsh-dev/DSH-better-sidebar",
		what: "右侧栏工作台（编辑器 / 文件树 / Git / 侧边对话）",
		need: "dsh ≥ 0.2.0-rc.1",
		note: "MIT",
	},
	{
		key: "wallpaper",
		name: "dsh-plugin-wallpaper-engine",
		repo: "https://github.com/elysia395/dsh-wallpaper-engine",
		what: "把本机 Wallpaper Engine 壁纸渲染到界面后面",
		need: "dsh ≥ 0.1.5-rc.1；「帧率上限」另需外部 ffmpeg（缺了它自己会关）",
		note: "MIT",
	},
	{
		key: "pet",
		name: "dsh-pet",
		repo: "https://github.com/PC2005-cloud/dsh-pet",
		what: "桌面宠物（浏览器 overlay，可选 Electron 透明置顶小窗）",
		need: "dsh 0.2.0-rc.1 / rc.2 兼容（0.1.7-rc.2 不兼容）",
		note: "MIT；另见 README 的素材条款：素材禁商用，二创须署名原作者",
	},
];

/**
 * 认不出来的 `--with-xxx` / `--without-xxx`（比如把 `--with-pet` 敲成 `--with-pets`）。
 *
 * 必须报错而不是忽略：楔错的 flag 静默无效，等于「我说了要装，什么都没发生」——
 * 这正是本项目一直在堵的那类静默。
 */
export function unknownPluginFlags(flags = {}) {
	const known = new Set(OPTIONAL_PLUGINS.map((item) => item.key));
	const bad = [];
	for (const name of Object.keys(flags)) {
		// 后缀允许为空：`--with-` 这种残缺 flag 也得报出来，不能静默无操作
		const matched = /^(?:with|without)-(.*)$/.exec(name);
		if (matched && !known.has(matched[1])) bad.push(name);
	}
	return bad;
}

/** profile 带 web 界面吗（`dsh.profile.bundles` 里有 `@deepseek-ai/dsh-web-app`） */
function hasWebApp(profilePkg) {
	const bundles = profilePkg?.dsh?.profile?.bundles;
	return Array.isArray(bundles) && bundles.includes(WEB_APP_BUNDLE);
}

/** 已装插件的名字 → 版本（`dependencies` 里有的） */
export function installedVersions(profilePkg) {
	const deps = profilePkg?.dependencies;
	return deps && typeof deps === "object" ? { ...deps } : {};
}

/** 装一个插件要跑的命令参数（交给 `dsh`，它会转发给 pnpm） */
export function pluginAddArgs(profile, name) {
	return ["plugin", "--profile", profile, "add", `${name}@latest`];
}

/** 装不上时用户该跑的那一行。只拼字符串、不加引号（纯函数，不认识 shell 的引号规则）——
 *  能这么干的前提是调用方已把 profile 名限成可直接粘贴的字符集（见 `bin/dsh-team.mjs`） */
export function retryCommand(profile, key) {
	return `dsh-team plugins --profile ${profile} --with-${key}`;
}

/**
 * 每个插件该走哪条路：`install`（装/升）、`ask`（问用户）、`skip`（说明原因）。
 *
 * 判据顺序是有讲究的：**先看显式 flag，再看已装**。反过来的话，用户
 * `--with-sidebar` 点名要升级时会被「已装」挡掉 —— 点名就是明确意图。
 */
export function pluginDecisions({ profilePkg, flags = {}, interactive = true } = {}) {
	const installed = installedVersions(profilePkg);
	const rows = [];

	if (!hasWebApp(profilePkg)) {
		for (const item of OPTIONAL_PLUGINS) {
			rows.push({ key: item.key, name: item.name, action: "skip", reason: `这个 profile 不带 web 界面：bundles 里没有 ${WEB_APP_BUNDLE}` });
		}
		return rows;
	}

	// 点过名 = 用户在用 flag 表态（多半是脚本里），这时其余的一律按默认（不装）算，
	// 不再回头问 —— 否则「--with-sidebar」在交互终端里会变成「装 sidebar，顺便问你俩」
	const named = OPTIONAL_PLUGINS.some((item) => flags[`with-${item.key}`] !== undefined);

	if (flags[SKIP_ALL_FLAG] !== undefined) {
		for (const item of OPTIONAL_PLUGINS) {
			rows.push({ key: item.key, name: item.name, action: "skip", reason: `你写了 --${SKIP_ALL_FLAG}` });
		}
		return rows;
	}

	for (const item of OPTIONAL_PLUGINS) {
		const current = installed[item.name];
		if (flags[`without-${item.key}`] !== undefined) {
			rows.push({ key: item.key, name: item.name, action: "skip", reason: `你写了 --without-${item.key}` });
			continue;
		}
		if (flags[`with-${item.key}`] !== undefined) {
			rows.push({
				key: item.key,
				name: item.name,
				action: "install",
				reason: current === undefined ? `你写了 --with-${item.key}` : `你写了 --with-${item.key}，把已装的 ${current} 升到最新`,
			});
			continue;
		}
		if (current !== undefined) {
			// 不声不响地升级别人profile里的东西是最没道理的一种副作用
			rows.push({ key: item.key, name: item.name, action: "skip", reason: `已装 ${current}` });
			continue;
		}
		if (interactive && !named) {
			rows.push({ key: item.key, name: item.name, action: "ask", reason: "" });
			continue;
		}
		rows.push({
			key: item.key,
			name: item.name,
			action: "skip",
			reason: named ? `这次只按点名的来；要它就写 --with-${item.key}` : `非交互环境不询问；要装就用 --with-${item.key} 点名`,
		});
	}
	return rows;
}

/**
 * 把插件名补进 `dsh.profile.bundles`（幂等，不动别的字段，不改入参）。
 *
 * 为什么要自己补：a 包只有声明了 `dsh.bundle.patch` 才会被 dsh 自动追加，
 * 没声明的只当普通依赖并警告 —— 与其假设，不如装完读回来自己确认一次。
 */
export function withPluginBundles(profilePkg, names) {
	const bundles = Array.isArray(profilePkg?.dsh?.profile?.bundles) ? profilePkg.dsh.profile.bundles : [];
	const next = [...bundles];
	for (const name of names) {
		if (!next.includes(name)) next.push(name);
	}
	if (next.length === bundles.length && next.every((v, i) => v === bundles[i])) return profilePkg;
	return {
		...profilePkg,
		dsh: { ...profilePkg?.dsh, profile: { ...profilePkg?.dsh?.profile, bundles: next } },
	};
}

/**
 * 装到的那个包，是不是我们表里那家（`repository` / `homepage` 任一对得上就算）。
 *
 * 判据是弱的一点办法都没有：装的是 npm 名，名字和仓库不是一回事，同名抢注包会被
 * 装进用户的 profile。所以装完读一眼它自己的 package.json —— 对不上就报出来，
 * 不静默放过。地址写法五花八门（`git+https://….git`、`github:user/repo`），
 * 所以只取 `github.com/<path>` 这段来比。
 */
export function repoMatches(pkgJson, repo) {
	const want = githubPath(repo);
	if (!want) return true; // 表里没写 github 地址就不判断，别误报
	// `repository` / `homepage` 都可能是数组写法（npm 允许），先拍平再逐个取 url
	const fields = [].concat(pkgJson?.repository ?? [], pkgJson?.homepage ?? []);
	const paths = fields
		.map((value) => githubPath(typeof value === "string" ? value : (value?.url ?? "")))
		.filter(Boolean);
	// 一条 github 路径都解析不出来（包里没写来源、或写的是别的托管站）→ 判断不了，
	// **返回 true**：这是个「顺手核对」，宁可漏报也不能让用户以为装到了假包
	if (paths.length === 0) return true;
	return paths.includes(want);
}

/** 从任意写法里抠出 `github.com/<owner>/<repo>`（小写、去 .git / 尾巴 / 协议） */
function githubPath(value) {
	const text = String(value ?? "");
	// 三种写法都认：完整 URL（`https://github.com/a/b.git`）、`github:a/b`、以及裸的
	// `a/b`（npm 官方约定：`repository` 里光写 `owner/repo` 就是 github）
	const matched =
		/github\.com[/:]([^/]+)\/([^/\s#?]+)/i.exec(text) ??
		/^github:([^/]+)\/([^/\s#?]+)$/i.exec(text.trim()) ??
		// 裸简写只认**不含点**的两段（`PC2005-cloud/dsh-pet`）。带点的要么是域名
		// （`mysite.io/docs`、`bitbucket.org/team`）、要么是文件路径（`docs/README.md`），
		// 放进来会让「判断不了就返回 true」的兜底失效，反过来说用户装到了假包
		/^([\w-]+)\/([\w-]+)$/.exec(text.trim());
	if (!matched) return "";
	return `${matched[1]}/${matched[2]}`.toLowerCase().replace(/\.git$/, "");
}

/**
 * 汇总行。三条状态各自的措辞固定，失败那一条必须带重试命令 ——
 * 用户拿到的是「下一步跑什么」，不是「哪里错了」。
 */
export function summarizePlugins(rows, profile, { dryRun = false } = {}) {
	const lines = [];
	let failed = 0;
	const installedNames = [];
	for (const row of rows) {
		if (row.status === "installed") {
			// dry-run 什么都没装：这里必须说「会装」，不能说「已装」——报一件没发生的事
			// 是本项目一直在堵的那类假话
			lines.push(
				dryRun
					? `✓（dry-run）会装 ${row.name}@latest 到 profile "${profile}"`
					: `✓ ${row.name}${row.version ? `@${row.version}` : ""} 已装进 profile "${profile}"`,
			);
			if (!dryRun) installedNames.push(row.name);
		} else if (row.status === "failed" && row.installed) {
			// 包已经在 node_modules 里了，只是 bundles 没写成 —— 印「没装上」就是在说假话，
			// 而且用户看完不知道要不要先卸掉：这条也进卸载清单
			failed += 1;
			lines.push(`⚠ ${row.name} 装上了，但${row.detail ?? "收尾没做完"}`);
			if (!dryRun) installedNames.push(row.name);
		} else if (row.status === "failed") {
			failed += 1;
			lines.push(`✗ ${row.name} 没装上：${row.detail ?? "未知原因"}`);
			lines.push(`  重试：${retryCommand(profile, row.key)}`);
		} else {
			lines.push(`· ${row.name} 跳过（${row.reason ?? "你没选"}）`);
		}
	}
	if (failed > 0 && !dryRun) {
		lines.push(`工作流本身已装好，不受上面 ${failed} 个插件的影响；重启 dsh 后生效。`);
	}
	if (installedNames.length > 0) {
		// 只装不卸是耍流氓：把卸的命令给出去（本包自己不实现卸载，那是 pnpm 的事）
		lines.push(`要卸掉：dsh plugin --profile ${profile} remove ${installedNames.join(" ")}`);
	}
	return lines;
}
