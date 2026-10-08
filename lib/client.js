/**
 * dsh-team-workflow · Web GUI 客户端半区：**定时任务面板**（REQ-007）+ **小队面板**（REQ-009）
 *
 * 两个面板共用一个文件，是因为 dsh 的 `clientExportOf` 只认 `exports["./client"]`
 * **一个**值（`dsh-client-modules/lib/index.js:171-181`）—— 一个包只有一个客户端
 * 入口，没有第二个位置可放。两者各自探活、各自注册，互不影响。
 *
 * 定时任务面板的形态移植自 `dsh-tauri-scheduler`，实现全部重写（那个包改编自
 * MichengAI/dsh-automation，Apache-2.0）。来源与修改声明见
 * 仓库根目录 `THIRD_PARTY_NOTICES.md`。
 *
 * 这是 dsh 的**客户端插件**产物，不是 ESM 模块 —— 它是个 classic script，
 * 调 `window.__ModuleLoader__.load({id, factory})` 把自己注册进浏览器的模块表。
 * dsh 的 host 侧只做 `readFileSync` + 原样 HTTP 吐到 `/plugins/<包名>/client.js`，
 * **没有任何转译器**。所以这个文件是手写的、零构建的 —— 也因此不写 JSX，
 * 一律 `React.createElement`（下面 `h()` 就是它）。
 *
 * 三条设计约束：
 *   1. **不 require 任何非 baseline 的包**。只 require `react`。连
 *      `@deepseek-ai/dsh-client-ui-primitives` 都不用 —— 那会让本包的客户端半区
 *      多一条对 dsh 内部包版本的耦合。样式全内联。
 *      （baseline 里能免声明 require 的：react / react-dom / react/jsx-runtime /
 *        @deepseek-ai/cordis / dsh-client-ui-primitives / dsh-client-store /
 *        dsh-client-ui-slots / dsh-client-ui-dockkit）
 *   2. **探活失败就不注册面板**。宿主侧 `enabled: false` 时 `/options` 返回 404，
 *      这里就什么都不挂 —— 这就是「可选安装」在 UI 上的落点。
 *   3. **槽位注册全包 try/catch**。`slots.register` 对未声明的槽位会**抛**
 *      （`slot "X" is not declared`），dsh 版本一变槽位名就可能没了。
 *      抛了只降级，不能让整个客户端半区炸掉。
 *
 * 挂载点（和官方 schedule 面板同路径）：
 *   sidebar.panellist  → 侧栏一行入口，`id` 与下面 main 的 `key` 相同
 *   main               → 内容页（keyed 槽位，靠 id 匹配选中）
 *
 * 小队面板为什么不按「当前会话」过滤：`main` 是 keyed 槽位，**不绑会话**
 * （`dsh-client-ui-layout` 的注释原话："other keys receive no Session binding"），
 * 组件拿不到「用户在哪个会话里」。所以它显示**全量**小队、每条带上所有者会话 id
 * 分组显示（详见 REQ-009 §6.3）。
 */

window.__ModuleLoader__.load({
	id: "dsh-team-workflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 面板 id —— sidebar.panellist 的 `id` 与 main 的 `key` 必须一致 */
		const PANEL_ID = "team-scheduler";
		const API = "/api/team/scheduler";

		/** 小队面板（REQ-009）。同一个客户端入口里挂第二个面板，各自独立探活。 */
		const SQUAD_PANEL_ID = "team-squad";
		const SQUAD_API = "/api/team/squad";

		/* ═══════════════ API ═══════════════ */

		async function callApi(base, path, { method = "GET", body } = {}) {
			const init = { method, headers: { accept: "application/json" } };
			if (body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			const response = await fetch(`${base}${path}`, init);
			const text = await response.text();
			let payload;
			try {
				payload = text === "" ? {} : JSON.parse(text);
			} catch {
				throw new Error(`服务端返回的不是 JSON（HTTP ${response.status}）`);
			}
			if (!response.ok || payload.ok === false) {
				throw new Error(payload.error ?? `HTTP ${response.status}`);
			}
			return payload;
		}

		const call = (path, options) => callApi(API, path, options);
		const callSquad = (path, options) => callApi(SQUAD_API, path, options);

		/* ═══════════════ 样式（内联，不引 CSS 体系） ═══════════════ */

		const C = {
			page: { height: "100%", overflowY: "auto", padding: "20px 24px", fontSize: 13, lineHeight: 1.6 },
			head: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
			title: { fontSize: 16, fontWeight: 600, margin: 0 },
			spacer: { flex: 1 },
			btn: {
				padding: "4px 12px",
				borderRadius: 6,
				border: "1px solid var(--dsh-border, #d0d0d8)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				fontSize: 12,
			},
			btnPrimary: {
				padding: "5px 14px",
				borderRadius: 6,
				border: "1px solid transparent",
				background: "var(--dsh-accent, #3b6cf6)",
				color: "#fff",
				cursor: "pointer",
				fontSize: 12,
			},
			card: {
				border: "1px solid var(--dsh-border, #e2e2ea)",
				borderRadius: 8,
				padding: "12px 14px",
				marginBottom: 10,
			},
			muted: { opacity: 0.6 },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			input: {
				padding: "5px 8px",
				borderRadius: 6,
				border: "1px solid var(--dsh-border, #d0d0d8)",
				background: "transparent",
				color: "inherit",
				fontSize: 12,
				minWidth: 90,
			},
			textarea: {
				padding: "6px 8px",
				borderRadius: 6,
				border: "1px solid var(--dsh-border, #d0d0d8)",
				background: "transparent",
				color: "inherit",
				fontSize: 12,
				width: "100%",
				minHeight: 72,
				resize: "vertical",
				fontFamily: "inherit",
			},
			tab: (active) => ({
				padding: "4px 12px",
				borderRadius: 6,
				cursor: "pointer",
				fontSize: 12,
				background: active ? "var(--dsh-hover, rgba(127,127,127,.16))" : "transparent",
				border: "1px solid transparent",
				fontWeight: active ? 600 : 400,
			}),
			badge: (color) => ({
				padding: "1px 7px",
				borderRadius: 999,
				fontSize: 11,
				background: color,
				color: "#fff",
			}),
		};

		const STATUS_COLOR = {
			succeeded: "#2f9e44",
			failed: "#e03131",
			running: "#3b6cf6",
			cancelled: "#868e96",
			interrupted: "#f08c00",
		};

		const STATUS_LABEL = {
			succeeded: "成功",
			failed: "失败",
			running: "运行中",
			cancelled: "已取消",
			interrupted: "被中断",
		};

		/* ═══════════════ 小工具 ═══════════════ */

		const fmtTime = (stamp) => (typeof stamp === "number" && stamp > 0 ? new Date(stamp).toLocaleString("zh-CN") : "—");

		const fmtDuration = (ms) => {
			if (typeof ms !== "number" || ms < 0) return "—";
			if (ms < 1000) return `${ms}ms`;
			if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
			return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
		};

		const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
		// 客户端是独立的 classic script，import 不到宿主那份 WEEKDAY_LABELS，
		// 只能各留一份 —— 改的时候两边都要改（宿主：lib/scheduler.js 的 WEEKDAY_LABELS）。
		const WEEKDAY_LABEL = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };

		const KIND_LABEL = {
			once: "一次性",
			hourly: "每小时",
			daily: "每天",
			interval: "固定间隔",
			workdays: "工作日",
			weekly: "每周",
			monthly: "每月",
			custom: "自定义天数",
		};

		const PERMISSION_LABEL = {
			"read-only": "只读",
			"workspace-write": "可写工作区",
			"danger-full-access": "完全访问（危险）",
		};

		function emptyDraft() {
			return {
				name: "",
				prompt: "",
				kind: "daily",
				time: "09:00",
				minute: 0,
				everyMinutes: 60,
				everyDays: 3,
				day: 1,
				weekdays: ["MO"],
				at: "",
				anchor: "",
				workspaceId: "",
				permission: "read-only",
				provider: "",
				model: "",
				reasoningEffort: "",
			};
		}

		/**
		 * 数字输入 → number。
		 * 空串不能走 `Number()`：`Number("") === 0`，清空输入会静默变成 0，
		 * 然后被后端的范围校验挡下，用户看到的是一句跟他操作对不上的报错。
		 * 这里原样把空串送回去，让后端的 `explainScheduleProblem` 指名道姓说出
		 * 是哪个字段（「hourly 需要 minute（0-59 的整数）」），而不是一句笼统的
		 * 「schedule 不合法」。
		 */
		function toNumber(raw) {
			if (raw === "" || raw === undefined || raw === null) return raw;
			const n = Number(raw);
			return Number.isNaN(n) ? raw : n;
		}

		/** 草稿 → 后端要的 schedule 对象 */
		function draftToSchedule(draft) {
			switch (draft.kind) {
				case "once":
					return { kind: "once", at: draft.at };
				case "hourly":
					return { kind: "hourly", minute: toNumber(draft.minute) };
				case "interval": {
					const schedule = { kind: "interval", everyMinutes: toNumber(draft.everyMinutes) };
					if (draft.anchor !== "") schedule.anchor = draft.anchor;
					return schedule;
				}
				case "custom":
					return { kind: "custom", everyDays: toNumber(draft.everyDays), time: draft.time, anchor: draft.anchor };
				case "weekly":
					return { kind: "weekly", time: draft.time, weekdays: draft.weekdays };
				case "monthly":
					return { kind: "monthly", time: draft.time, day: toNumber(draft.day) };
				default:
					return { kind: draft.kind, time: draft.time };
			}
		}

		/* ═══════════════ 新建表单 ═══════════════ */

		function ScheduleFields(props) {
			const { draft, patch } = props;
			const field = (label, node) => h("label", { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } }, label, node);
			const input = (key, type, extra) =>
				h("input", {
					style: Object.assign({}, C.input, extra),
					type: type ?? "text",
					value: draft[key],
					onChange: (e) => patch({ [key]: e.target.value }),
				});

			const parts = [];
			switch (draft.kind) {
				case "once":
					parts.push(field("运行时间（ISO 或本地时间）", input("at", "text", { minWidth: 220 })));
					break;
				case "hourly":
					parts.push(field("第几分（0-59）", input("minute", "number", { minWidth: 70 })));
					break;
				case "interval":
					parts.push(field("每多少分钟", input("everyMinutes", "number", { minWidth: 80 })));
					parts.push(field("锚点（可空，ISO）", input("anchor", "text", { minWidth: 200 })));
					break;
				case "custom":
					parts.push(field("每多少天", input("everyDays", "number", { minWidth: 70 })));
					parts.push(field("时刻 HH:MM", input("time", "time", { minWidth: 90 })));
					parts.push(field("锚点（必填，ISO）", input("anchor", "text", { minWidth: 200 })));
					break;
				case "weekly":
					parts.push(field("时刻 HH:MM", input("time", "time", { minWidth: 90 })));
					parts.push(
						field(
							"星期几",
							h(
								"div",
								{ style: C.row },
								WEEKDAYS.map((day) =>
									h(
										"button",
										{
											key: day,
											type: "button",
											style: {
												...C.btn,
												background: draft.weekdays.includes(day) ? "var(--dsh-accent, #3b6cf6)" : "transparent",
												color: draft.weekdays.includes(day) ? "#fff" : "inherit",
											},
											onClick: () => {
												const next = draft.weekdays.includes(day)
													? draft.weekdays.filter((d) => d !== day)
													: [...draft.weekdays, day];
												patch({ weekdays: next });
											},
										},
										WEEKDAY_LABEL[day],
									),
								),
							),
						),
					);
					break;
				case "monthly":
					parts.push(field("几号（1-31）", input("day", "number", { minWidth: 70 })));
					parts.push(field("时刻 HH:MM", input("time", "time", { minWidth: 90 })));
					break;
				default:
					parts.push(field("时刻 HH:MM", input("time", "time", { minWidth: 90 })));
			}
			// 每个元素都要 key：否则 React 按位置复用，切计划类型时输入框会串值
			return h(
				"div",
				{ style: { ...C.row, alignItems: "flex-end", gap: 12 } },
				parts.map((node, i) => h("div", { key: `f${i}` }, node)),
			);
		}

		function CreateForm(props) {
			const { options, onCreated, onCancel } = props;
			const [draft, setDraft] = React.useState(emptyDraft);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const patch = (delta) => setDraft((prev) => ({ ...prev, ...delta }));

			const submit = async () => {
				setBusy(true);
				setError(null);
				try {
					const body = {
						name: draft.name,
						prompt: draft.prompt,
						schedule: draftToSchedule(draft),
						permission: draft.permission,
					};
					if (draft.workspaceId !== "") body.workspaceId = draft.workspaceId;
					if (draft.provider !== "" && draft.model !== "") {
						body.provider = draft.provider;
						body.model = draft.model;
						if (draft.reasoningEffort !== "") body.reasoningEffort = draft.reasoningEffort;
					}
					await call("/tasks", { method: "POST", body });
					onCreated();
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};

			const label = (t) => h("div", { style: { fontSize: 11, marginBottom: 3, ...C.muted } }, t);

			return h(
				"div",
				{ style: { ...C.card, background: "var(--dsh-hover, rgba(127,127,127,.06))" } },
				h("div", { style: { fontWeight: 600, marginBottom: 10 } }, "新建定时任务"),
				options?.defaultModel
					? h(
							"div",
							{ style: { fontSize: 11, marginBottom: 10, ...C.muted } },
							`provider / model 留空就用当前默认模型：${options.defaultModel.provider} / ${options.defaultModel.model}`,
						)
					: null,
				label("任务名"),
				h("input", {
					style: { ...C.input, width: "100%", marginBottom: 10 },
					value: draft.name,
					placeholder: "例如：每个工作日写日报",
					onChange: (e) => patch({ name: e.target.value }),
				}),
				label("要执行的指令（到点在全新会话里原样发给模型）"),
				h("textarea", {
					style: { ...C.textarea, marginBottom: 10 },
					value: draft.prompt,
					placeholder: "例如：检查昨天的 git 提交，写一份变更摘要到 docs/daily/ 下。",
					onChange: (e) => patch({ prompt: e.target.value }),
				}),
				h(
					"div",
					{ style: { ...C.row, marginBottom: 10 } },
					h(
						"label",
						{ style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } },
						"计划类型",
						h(
							"select",
							{
								style: C.input,
								value: draft.kind,
								onChange: (e) => patch({ kind: e.target.value }),
							},
							(options?.scheduleKinds ?? ["once", "hourly", "daily", "interval", "workdays", "weekly", "monthly", "custom"]).map((kind) =>
								h("option", { key: kind, value: kind }, KIND_LABEL[kind] ?? kind),
							),
						),
					),
				),
				h(ScheduleFields, { draft, patch }),
				h(
					"div",
					{ style: { ...C.row, marginTop: 12, marginBottom: 4 } },
					h(
						"label",
						{ style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } },
						"工作目录",
						h(
							"select",
							{
								style: { ...C.input, minWidth: 220 },
								value: draft.workspaceId,
								onChange: (e) => patch({ workspaceId: e.target.value }),
							},
							h("option", { value: "" }, "（默认：自动目录）"),
							(options?.workspaces ?? []).map((ws) => h("option", { key: ws.id, value: ws.id }, `${ws.title} — ${ws.path}`)),
						),
					),
					h(
						"label",
						{ style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 11 } },
						"权限",
						h(
							"select",
							{
								style: C.input,
								value: draft.permission,
								onChange: (e) => patch({ permission: e.target.value }),
							},
							// 后端按 maxPermission 天花板滤过一遍：不列出选了必然被拒的档位
							(options?.permissions ?? ["read-only", "workspace-write"]).map((p) =>
								h("option", { key: p, value: p }, PERMISSION_LABEL[p] ?? p),
							),
						),
					),
				),
				h(
					"div",
					{ style: { fontSize: 11, marginTop: 6, ...C.muted } },
					`提示：任务无人值守执行，审批策略会被强制设为 never —— 「权限」是唯一的安全边界。默认 read-only，上限 ${options?.maxPermission ?? "workspace-write"}。`,
				),
				error ? h("div", { style: { color: "#e03131", marginTop: 10 } }, `创建失败：${error}`) : null,
				h(
					"div",
					{ style: { ...C.row, marginTop: 14 } },
					h("button", { type: "button", style: C.btnPrimary, disabled: busy, onClick: submit }, busy ? "创建中…" : "创建"),
					h("button", { type: "button", style: C.btn, onClick: onCancel }, "取消"),
				),
			);
		}

		/* ═══════════════ 任务卡片 ═══════════════ */

		function TaskCard(props) {
			const { task, onChanged, onError } = props;
			const [busy, setBusy] = React.useState(false);
			const act = async (fn) => {
				setBusy(true);
				try {
					await fn();
					onChanged();
				} catch (err) {
					onError(err.message);
				} finally {
					setBusy(false);
				}
			};
			const btn = (text, fn, extra) =>
				h(
					"button",
					{ type: "button", style: Object.assign({}, C.btn, extra), disabled: busy, onClick: () => act(fn) },
					text,
				);

			return h(
				"div",
				{ style: C.card },
				h(
					"div",
					{ style: C.row },
					h("span", { style: { fontWeight: 600 } }, task.name),
					task.enabled ? null : h("span", { style: C.badge("#868e96") }, "已停用"),
					task.running ? h("span", { style: C.badge(STATUS_COLOR.running) }, "运行中") : null,
					h("span", { style: C.spacer }),
					// 显式说意图，不用服务端取反：按钮是按**面板自己那份快照**画的，
					// 另一个窗口或 CLI 改过之后，标着「停用」的按钮会把任务启用。
					btn(task.enabled ? "停用" : "启用", () => call("/tasks/toggle", { method: "POST", body: { id: task.id, enabled: !task.enabled } })),
					btn("立即运行", () => call("/tasks/run", { method: "POST", body: { id: task.id } })),
					btn(
						"删除",
						() => call("/tasks", { method: "DELETE", body: { id: task.id } }),
						{ color: "#e03131" },
					),
				),
				h(
					"div",
					{ style: { ...C.row, marginTop: 6, ...C.muted } },
					h("span", null, task.scheduleText),
					h("span", null, "·"),
					h("span", null, `下次 ${fmtTime(task.nextRunAt)}`),
					// 「启用着，但算不出下一次」是个必须看得见的状态：它和「已停用」长得不一样
					// （那个有徽标），也和正常任务长得不一样，但都不会再触发。不给信号的话，
					// 用户只会以为任务在跑，可能几个月后才发现它一直没跑。
					task.enabled === true && (task.nextRunAt === null || task.nextRunAt === undefined)
						? h("span", { style: C.badge("#f08c00") }, "算不出下次，不会触发")
						: null,
					h("span", null, "·"),
					h("span", null, `上次 ${fmtTime(task.lastRunAt)}`),
				),
				h("div", { style: { marginTop: 6, ...C.mono, ...C.muted, whiteSpace: "pre-wrap", maxHeight: 60, overflow: "hidden" } }, task.prompt),
			);
		}

		/* ═══════════════ 运行历史 ═══════════════ */

		function RunList(props) {
			const { runs, onError } = props;
			if (runs.length === 0) return h("div", { style: C.muted }, "还没有运行记录。");
			return h(
				"div",
				null,
				runs.map((run) =>
					h(
						"div",
						{ key: run.id, style: C.card },
						h(
							"div",
							{ style: C.row },
							h("span", { style: C.badge(STATUS_COLOR[run.status] ?? "#868e96") }, STATUS_LABEL[run.status] ?? run.status),
							// 「成功但没有 turn/end」不能和干净收尾长得一样：模型崩了、会话被
							// 异常收尾都是这个形状。判定按成功算（避免假失败），但这里必须标出来。
							// 「一个事件都没有」是它的子集，但更值得怀疑 —— 两者都标等于没说，
							// 所以只标更具体的那一个。
							run.noEvents === true
								? h("span", { style: C.badge("#e8590c") }, "没观测到事件")
								: run.incomplete === true
									? h("span", { style: C.badge("#f08c00") }, "收尾不完整")
									: null,
							h("span", { style: { fontWeight: 600 } }, run.taskName ?? run.taskId),
							h("span", { style: C.muted }, run.trigger === "manual" ? "手动" : "定时"),
							h("span", { style: C.spacer }),
							h("span", { style: C.muted }, fmtTime(run.startedAt)),
							h("span", { style: C.muted }, fmtDuration(run.durationMs)),
							h(
								"button",
								{
									type: "button",
									style: C.btn,
									onClick: async () => {
										try {
											await call("/history", { method: "DELETE", body: { id: run.id } });
											props.onChanged?.();
										} catch (err) {
											onError(err.message);
										}
									},
								},
								"删",
							),
						),
						run.error ? h("div", { style: { color: "#e03131", marginTop: 6, fontSize: 12 } }, run.error) : null,
						run.summary
							? h(
									"div",
									{ style: { marginTop: 6, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto", opacity: 0.85 } },
									run.summary,
								)
							: null,
						run.sessionId ? h("div", { style: { marginTop: 4, fontSize: 11, ...C.mono, ...C.muted } }, `会话 ${run.sessionId}`) : null,
					),
				),
			);
		}

		/* ═══════════════ 主页面 ═══════════════ */

		function SchedulerPage() {
			const [tab, setTab] = React.useState("tasks");
			const [tasks, setTasks] = React.useState([]);
			const [runs, setRuns] = React.useState([]);
			const [options, setOptions] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [creating, setCreating] = React.useState(false);
			const [loading, setLoading] = React.useState(true);

			const refresh = React.useCallback(async () => {
				try {
					const [taskResult, runResult] = await Promise.all([call("/tasks"), call("/history")]);
					setTasks(taskResult.tasks ?? []);
					setRuns(runResult.runs ?? []);
					setError(null);
				} catch (err) {
					setError(err.message);
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				let alive = true;
				call("/options")
					.then((payload) => {
						if (alive) setOptions(payload);
					})
					.catch(() => {});
				void refresh();
				// 固定 5 秒一次。原来注释写「有任务在跑就刷勤点」，但实现一直是
				// 固定间隔 —— 注释留着会让人以为有动态逻辑，直接改成实话。
				// 5 秒足够：任务最细的计划粒度是 1 分钟。
				const timer = setInterval(() => {
					if (alive) void refresh();
				}, 5000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [refresh]);

			let body;
			if (loading) {
				body = h("div", { style: C.muted }, "加载中…");
			} else if (tab === "runs") {
				body = h(RunList, { runs, onChanged: refresh, onError: setError });
			} else if (tasks.length === 0) {
				body = h("div", { style: C.muted }, "还没有定时任务。点右上角「新建任务」。");
			} else {
				body = tasks.map((task) => h(TaskCard, { key: task.id, task, onChanged: refresh, onError: setError }));
			}

			return h(
				"div",
				{ style: C.page },
				h(
					"div",
					{ style: C.head },
					h("h2", { style: C.title }, "定时任务"),
					options?.timeZone ? h("span", { style: { ...C.muted, fontSize: 11 } }, `时区 ${options.timeZone}`) : null,
					options ? h("span", { style: { ...C.muted, fontSize: 11 } }, `并发上限 ${options.maxConcurrent}，当前在跑 ${options.runningCount ?? 0}`) : null,
					h("span", { style: C.spacer }),
					h("button", { type: "button", style: C.btn, onClick: () => void refresh() }, "刷新"),
					h("button", { type: "button", style: C.btnPrimary, onClick: () => setCreating((v) => !v) }, creating ? "收起" : "新建任务"),
				),
				error ? h("div", { style: { color: "#e03131", marginBottom: 12 } }, `出错了：${error}`) : null,
				creating
					? h(CreateForm, {
							options,
							onCancel: () => setCreating(false),
							onCreated: () => {
								setCreating(false);
								void refresh();
							},
						})
					: null,
				h(
					"div",
					{ style: { ...C.row, marginBottom: 12 } },
					h("button", { type: "button", style: C.tab(tab === "tasks"), onClick: () => setTab("tasks") }, `任务（${tasks.length}）`),
					h("button", { type: "button", style: C.tab(tab === "runs"), onClick: () => setTab("runs") }, `运行历史（${runs.length}）`),
				),
				body,
			);
		}

		/** 侧栏入口的图标。纯 SVG，不依赖图标库。 */
		function SchedulerIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
				h("circle", { cx: 12, cy: 12, r: 9 }),
				h("path", { d: "M12 7v5l3 2" }),
			);
		}

		/* ═══════════════ 小队（REQ-009） ═══════════════ */

		/** 成员状态 → 颜色。键与 lib/squad.js 的 MEMBER_STATUS 一字不差。 */
		const MEMBER_COLOR = {
			在跑: "#3b6cf6",
			完成: "#2f9e44",
			卡住: "#e03131",
		};

		const shortId = (id) => (typeof id === "string" && id.length > 10 ? `${id.slice(0, 10)}…` : (id ?? "—"));

		/**
		 * 读某个成员的转录（REQ-011）。
		 *
		 * C 路之后成员**不是 dsh 会话**（小队自己驱动它的循环），所以没有
		 * `uiWorkspace.openSession` 可调 —— 转录是我们自己的数据，走只读路由拿。
		 * 三件套（owner + 队名 + 成员名）缺一不可：小队名只在所有者的表里唯一。
		 */
		const transcriptPath = (squad, member) =>
			`/transcript?owner=${encodeURIComponent(squad.owner)}&squad=${encodeURIComponent(squad.name)}&member=${encodeURIComponent(member.label)}`;

		/** 侧栏入口的图标。纯 SVG，不依赖图标库。 */
		function SquadIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
				h("circle", { cx: 12, cy: 7, r: 3 }),
				h("circle", { cx: 5, cy: 17, r: 2.5 }),
				h("circle", { cx: 19, cy: 17, r: 2.5 }),
				h("path", { d: "M12 10v3M12 13l-6 2M12 13l6 2" }),
			);
		}

		/**
		 * 小队页。
		 *
		 * 中央面板那个槽位不绑会话，所以组件 props 里没有「当前会话」这种东西，
		 * 数据一律走 `/api/team/squad/squads`（全量），按所有者分组显示。
		 * 成员的转录单独按需拉（`/transcript`）—— 它可能很长，不该塞进 5 秒一次的轮询里。
		 */
		function SquadPage() {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [selected, setSelected] = React.useState(null);
			const [hint, setHint] = React.useState("");
			/** `{key, loading, data?, error?}` —— key = owner/队名/成员名，同一时刻只看一个 */
			const [transcript, setTranscript] = React.useState(null);

			const refresh = React.useCallback(async () => {
				try {
					setData(await callSquad("/squads"));
					setError(null);
				} catch (err) {
					setError(err?.message ?? String(err));
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				void refresh();
				// 成员是**随时**往黑板上写进展的，面板得自己跟上：5 秒一轮，
				// 只打本机回环，代价可以忽略。手动「刷新」按钮也在。
				const timer = setInterval(() => void refresh(), 5000);
				return () => clearInterval(timer);
			}, [refresh]);

			const squads = data?.squads ?? [];
			// 选中的队被收掉时不留悬空选中。名字只在**同一个所有者**下唯一，
			// 所以选中键必须是 owner + 名字。
			const keyOf = (squad) => `${squad.owner}/${squad.name}`;
			const current = squads.find((squad) => keyOf(squad) === selected) ?? squads[0] ?? null;

			const head = h(
				"div",
				{ style: C.head },
				h("h2", { style: C.title }, "小队"),
				h("span", { style: C.muted }, loading ? "读取中…" : `${squads.length} 个`),
				h("span", { style: C.spacer }),
				hint !== "" ? h("span", { style: { ...C.muted, color: "#f08c00" } }, hint) : null,
				h("button", { type: "button", style: C.btn, onClick: () => void refresh() }, "刷新"),
			);

			if (error !== null) {
				return h(
					"div",
					{ style: C.page },
					head,
					h(
						"div",
						{ style: { ...C.card, borderColor: "#e03131" } },
						`读不到小队数据：${error}`,
						h("div", { style: { ...C.muted, marginTop: 6 } }, "宿主侧是不是把 squad 关了？（team/extensions/squad.json 的 enabled）"),
					),
				);
			}

			if (squads.length === 0) {
				return h(
					"div",
					{ style: C.page },
					head,
					h(
						"div",
						{ style: C.card },
						"还没有小队。",
						h("div", { style: { ...C.muted, marginTop: 6 } }, "让主 agent 用 squad_new 建一个，再用 squad_spawn 派成员进去（当场就在后台跑起来）。"),
						h("div", { style: { ...C.muted, marginTop: 6 } }, "小队状态在 dsh 进程内存里，只在当前会话有效（不落盘）。"),
					),
				);
			}

			/** 转录里一条事件怎么显示（`/transcript` 的 entries 形状见 lib/squad.js）。 */
			const transcriptRow = (entry, index) =>
				h(
					"div",
					{ key: `${entry.at ?? index}-${index}`, style: { ...C.mono, marginTop: 4, whiteSpace: "pre-wrap" } },
					h(
						"span",
						{ style: C.badge(entry.role === "tool" ? (entry.isError ? "#e03131" : "#868e96") : "#3b6cf6") },
						entry.role === "tool" ? (entry.name ?? "tool") : `模型${entry.step === null ? "" : ` · 第 ${entry.step} 步`}`,
					),
					entry.calls.length > 0 ? `  → ${entry.calls.map((call) => call.name).join(" / ")}` : "",
					entry.text === "" ? "" : `\n${entry.text}`,
				);

			/**
			 * 拉一个成员的转录。`owner` / 队名 / 成员名 三件套缺一不可
			 * （同名队在不同所有者下是两个队），所以面板里的键也是这三样拼的。
			 */
			const openTranscript = async (squad, member) => {
				const key = `${keyOf(squad)}/${member.label}`;
				setTranscript({ key, loading: true });
				try {
					setTranscript({ key, loading: false, data: await callSquad(transcriptPath(squad, member)) });
				} catch (err) {
					const detail = err?.message ?? String(err);
					setTranscript({ key, loading: false, error: detail });
					setHint(`读不到「${member.label}」的转录：${detail}`);
				}
			};

			const memberBlock = (squad, member) => {
				const key = `${keyOf(squad)}/${member.label}`;
				const shown = transcript !== null && transcript.key === key ? transcript : null;
				return h(
					"div",
					{ key: member.label, style: { ...C.card, marginBottom: 6 } },
					h(
						"div",
						{ style: C.row },
						h("span", { style: C.badge(MEMBER_COLOR[member.status] ?? "#868e96") }, member.status),
						h("strong", null, member.label),
						h("span", { style: C.muted }, member.role),
						h("span", { style: { ...C.mono, ...C.muted } }, `转录 ${member.events} 条`),
						h("span", { style: C.spacer }),
						h(
							"button",
							{
								type: "button",
								style: C.btn,
								onClick: () => {
									if (shown !== null) {
										setTranscript(null);
										return;
									}
									void openTranscript(squad, member);
								},
							},
							shown === null ? "看转录" : "收起转录",
						),
					),
					h("div", { style: { marginTop: 4 } }, member.task),
					member.note !== null ? h("div", { style: { ...C.muted, marginTop: 4 } }, `结论：${member.note}`) : null,
					member.worktree !== null ? h("div", { style: { ...C.mono, ...C.muted, marginTop: 4 } }, member.worktree) : null,
					// 转录是**只读**的：成员不是 dsh 会话，面板改不了它，只能看它干了什么。
					shown === null
						? null
						: h(
								"div",
								{ style: { ...C.card, marginTop: 6, background: "#f8f9fa" } },
								shown.loading === true ? h("div", { style: C.muted }, "读取中…") : null,
								shown.error !== undefined ? h("div", { style: { color: "#e03131" } }, `读不到转录：${shown.error}`) : null,
								shown.data !== undefined
									? h(
											"div",
											null,
											h(
												"div",
												{ style: C.muted },
												`成员自己的循环：${shown.data.member.status}${shown.data.member.note === null ? "" : ` —— ${shown.data.member.note}`}`,
											),
											shown.data.entries.length === 0 ? h("div", { style: C.muted }, "还没有转录。") : shown.data.entries.map(transcriptRow),
										)
									: null,
							),
				);
			};

			const boardBlock = (entry, index) =>
				h(
					"div",
					{ key: `${entry.at}-${index}`, style: { ...C.card, marginBottom: 6 } },
					h(
						"div",
						{ style: C.row },
						h("span", { style: { ...C.mono, ...C.muted } }, fmtTime(entry.at)),
						h("strong", null, entry.from),
					),
					h("div", { style: { whiteSpace: "pre-wrap", marginTop: 4 } }, entry.text),
				);

			const squadCard = (squad) => {
				const isCurrent = current !== null && keyOf(squad) === keyOf(current);
				const done = squad.members.filter((m) => m.status === "完成").length;
				return h(
					"div",
					{ key: keyOf(squad), style: { ...C.card, padding: 0 } },
					h(
						"div",
						{
							style: { ...C.row, padding: "10px 14px", cursor: "pointer" },
							onClick: () => setSelected(keyOf(squad)),
						},
						h("strong", null, squad.name),
						squad.closed !== null ? h("span", { style: C.badge("#868e96") }, "已收队") : null,
						h("span", { style: C.muted }, `${done}/${squad.members.length} 完成`),
						h("span", { style: { ...C.mono, ...C.muted } }, `黑板 ${squad.board.length} 条`),
						h("span", { style: C.spacer }),
						h("span", { style: { ...C.mono, ...C.muted } }, `所有者 ${shortId(squad.owner)}`),
					),
					h("div", { style: { padding: "0 14px 10px" } }, squad.objective),
					isCurrent
						? h(
								"div",
								{ style: { padding: "0 14px 12px" } },
								h("div", { style: { ...C.muted, margin: "6px 0" } }, "成员"),
								squad.members.length === 0 ? h("div", { style: C.muted }, "还没有成员。") : squad.members.map((member) => memberBlock(squad, member)),
								h("div", { style: { ...C.muted, margin: "10px 0 6px" } }, `共享黑板（${squad.board.length} 条，最近 50）`),
								squad.board.length === 0
									? h("div", { style: C.muted }, "黑板还是空的。成员有它自己的 board 工具，进展不用都回到主 agent 那里转述。")
									: squad.board.slice(-50).reverse().map(boardBlock),
							)
						: null,
				);
			};

			return h("div", { style: C.page }, head, squads.map(squadCard));
		}

		/* ═══════════════ 装配 ═══════════════ */

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				let cancelled = false;
				let disposers = [];

				// 探活：宿主侧 enabled=false 时这里 404，于是什么都不注册 ——
				// 这就是「可选安装」在 UI 上的落点。
				call("/options")
					.then(() => {
						if (cancelled) return;
						disposers = [
							ctx.slots.inject("sidebar.panellist", () => {
								try {
									return ctx.slots.register(
										{ name: "sidebar.panellist", id: PANEL_ID, order: 12, label: "定时任务" },
										SchedulerIcon,
									);
								} catch (err) {
									// 浏览器端没有 logger 可注入，console 是唯一出口。
									// 这里只会在「槽位没声明」这种插件间契约不一致时响，
									// 静默吞掉会让人以为面板是「没启用」而不是「注册失败」。
									console.warn("[team-scheduler] 侧栏入口注册失败", err);
									return () => {};
								}
							}),
							ctx.slots.inject("main", () => {
								try {
									return ctx.slots.register({ name: "main", key: PANEL_ID }, SchedulerPage);
								} catch (err) {
									console.warn("[team-scheduler] 主面板注册失败", err);
									return () => {};
								}
							}),
						];
					})
					.catch(() => {
						// 宿主侧没启用 → 面板不注册。这是正常路径，不是错误。
					});

				return () => {
					cancelled = true;
					for (const dispose of disposers) {
						try {
							dispose();
						} catch {
							/* 忽略 */
						}
					}
					disposers = [];
				};
			}, "team-scheduler: panel");

			// 小队面板（REQ-009）：同一个客户端入口里的第二个面板，**独立探活** ——
			// squad 关掉时只有它自己不注册，定时任务面板照常（反之亦然）。
			ctx.effect(() => {
				let cancelled = false;
				let disposers = [];

				callSquad("/options")
					.then(() => {
						if (cancelled) return;
						disposers = [
							ctx.slots.inject("sidebar.panellist", () => {
								try {
									return ctx.slots.register(
										{ name: "sidebar.panellist", id: SQUAD_PANEL_ID, order: 13, label: "小队" },
										SquadIcon,
									);
								} catch (err) {
									console.warn("[team-squad] 侧栏入口注册失败", err);
									return () => {};
								}
							}),
							ctx.slots.inject("main", () => {
								try {
									return ctx.slots.register({ name: "main", key: SQUAD_PANEL_ID }, SquadPage);
								} catch (err) {
									console.warn("[team-squad] 主面板注册失败", err);
									return () => {};
								}
							}),
						];
					})
					.catch(() => {
						// 宿主侧没启用 squad（或 profile 没有 webServer）→ 面板不注册。
						// 这是正常路径，不是错误。
					});

				return () => {
					cancelled = true;
					for (const dispose of disposers) {
						try {
							dispose();
						} catch {
							/* 忽略 */
						}
					}
					disposers = [];
				};
			}, "team-squad: panel");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.SchedulerPage = SchedulerPage;
		// 测试要能直接渲染它（面板不再需要 ctx —— 转录走只读路由，不碰 uiWorkspace）。
		exports.SquadPage = SquadPage;
		return module.exports;
	},
});
