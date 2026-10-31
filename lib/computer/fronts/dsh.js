/**
 * DSH 前端的 7 个工具定义 —— REQ-024 步骤 4 抽出。
 *
 * 这些定义里有大量**契约**，改一个字自检就会红：
 *   - 工具名与参数 schema（ctx.tools.register 只认标准 JSON Schema）；
 *   - 文案：`已移动` / `单击` / `参数错误` / `不支持图像输入` / `整屏截图` / `(x, y)`；
 *   - 每个操控类工具都必须先 approve、再 ensureArmed、再执行，失败一律回文本不抛；
 *   - 紧急解锁后所有操控返回 EMERGENCY_REFUSAL（而不是报错）。
 *
 * 为什么单独成文件：这是「DSH 前端」这一层的全部内容。CLI 前端与 MCP 前端
 * 会把同一套 core 换个壳暴露出去（REQ-024 §6），那时这里就是并排的第三个文件。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { EMERGENCY_REFUSAL } from "../core/config.js";
import { buildCommand, parseKeyCombo, parsePos } from "../core/protocol.js";
import { deny, shotOut, textOut } from "../core/output.js";
import { toParameterSchema } from "../../util.js";

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{daemon: any, lock: any, approve: Function, assertImageRoute: Function, config: Record<string, any>, elements: any}} core
 * @returns {() => void} 注销全部工具
 */
export function registerDshTools(ctx, { daemon, lock, approve, assertImageRoute, config, elements }) {
	const disposers = [];
	const register = (definition) => {
		disposers.push(ctx.tools.register(definition));
	};

	const stopped = () => ({ text: EMERGENCY_REFUSAL });

	register({
		name: "screenshot",
		description:
			"截取整个屏幕（含多显示器拼接的虚拟屏）并把 PNG 作为图片返回给你自己看 —— 用它查看当前屏幕状态，再决定下一步操作。" +
			"首次调用（本会话）需要用户审批。不锁定鼠标（只读）。",
		parameters: toParameterSchema({}),
		output: shotOut(),
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			if (!(await approve(exec, "screenshot", "截取整屏图像（AI 将看到屏幕上的一切）"))) {
				return deny("用户未批准截屏");
			}
			try {
				await assertImageRoute(exec, "截屏");
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
			const attachments = ctx.get?.("attachments");
			if (attachments === undefined || attachments === null || typeof attachments.saveImage !== "function") {
				return { text: "[失败] 无附件服务，图片无处存放（dsh attachments 未挂载）" };
			}
			const file = path.join(daemon.dir, `shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
			try {
				await daemon.send(buildCommand("shot", { file }), config.shotTimeoutMs);
				const data = fs.readFileSync(file);
				if (data.length < 8 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) {
					return { text: "[失败] 守护进程产出的不是 PNG（文件头不对）" };
				}
				const ref = await attachments.saveImage({ data, mediaType: "image/png", name: "screenshot.png" });
				return {
					image: {
						attachmentId: ref.attachmentId,
						mediaType: ref.mediaType,
						bytes: ref.bytes,
						width: ref.width,
						height: ref.height,
						...ref.name === undefined ? {} : { name: ref.name },
					},
					caption: `整屏截图 ${ref.width}x${ref.height} px（虚拟屏，可能含多个显示器）`,
				};
			} catch (err) {
				return { text: `[失败] 截图失败：${err?.message ?? err}` };
			} finally {
				fs.rmSync(file, { force: true });
			}
		},
	});

	// ── 步骤 6：带编号的观测（SoM）───────────────────────────────────────────
	// 与 screenshot 的区别：screenshot 给你一张整屏图，你得自己数像素找按钮；
	// observe_screen 给你「同一张图 + 每个可操作元素的编号与名字」，
	// 然后你可以用编号对应的坐标去调 mouse_click —— 不需要猜。
	register({
		name: "observe_screen",
		description:
			"观测当前窗口：返回一张画了编号的截图，同时列出每个可操作元素的「编号 / 角色 / 名字 / 坐标」。" +
			"用它看清界面上有什么、再决定点哪里 —— 比截屏后自己数像素可靠得多。" +
			"观测是只读的（不移动鼠标、不抢焦点），首次调用（本会话）需要用户审批。",
		parameters: toParameterSchema({}),
		output: shotOut(),
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			if (!(await approve(exec, "observe_screen", "观测当前窗口（AI 将看到窗口画面与可操作元素的编号清单）"))) {
				return deny("用户未批准观测");
			}
			try {
				await assertImageRoute(exec, "观测窗口");
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
			const attachments = ctx.get?.("attachments");
			if (attachments === undefined || attachments === null || typeof attachments.saveImage !== "function") {
				return { text: "[失败] 无附件服务，图片无处存放（dsh attachments 未挂载）" };
			}
			const jsonPath = path.join(daemon.outDir, "observe.json");
			const pngPath = path.join(daemon.outDir, "observe.png");
			try {
				const reply = await daemon.send(buildCommand("observe"), config.shotTimeoutMs);
				const count = Number(String(reply).split(" ")[1]);
				if (!Number.isFinite(count) || count < 1) {
					return { text: "[失败] 没有观测到任何可操作元素（窗口可能还没加载完，稍等再试）" };
				}
				const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
				// 记进编号表：模型接下来会用这些编号点击，版本号由表管理
				const ver = elements.load(parsed.hwnd, parsed.elements);
				const data = fs.readFileSync(pngPath);
				if (data.length < 8 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) {
					return { text: "[失败] 观测产出里没有合法 PNG（带编号的截图缺失）" };
				}
				const ref = await attachments.saveImage({ data, mediaType: "image/png", name: "observe.png" });
				// 清单只留「编号 / 角色 / 名字 / 中心坐标」：patterns 与尺寸对模型没用，
				// 而 80+ 个元素全字段铺开是 10KB 量级，会挤掉真正需要的上下文。
				const lines = parsed.elements.map((el, i) => {
					const name = el.name.length > 30 ? `${el.name.slice(0, 30)}…` : el.name;
					const cx = Math.round(el.x + el.w / 2);
					const cy = Math.round(el.y + el.h / 2);
					return `[${i + 1}] ${el.role} "${name}" @ (${cx}, ${cy})`;
				});
				const MAX = 80;
				const shown = lines.slice(0, MAX).join("\n");
				const more =
					lines.length > MAX ? `\n…另有 ${lines.length - MAX} 个元素未列出（先做眼前看得见的，或滚动后再观测）` : "";
				return {
					image: {
						attachmentId: ref.attachmentId,
						mediaType: ref.mediaType,
						bytes: ref.bytes,
						width: ref.width,
						height: ref.height,
						...(ref.name === undefined ? {} : { name: ref.name }),
					},
					caption: `窗口观测：${count} 个可操作元素（图上标着编号；下面给的是元素中心坐标，可直接传给 mouse_click）\n${shown}${more}`,
				};
			} catch (err) {
				return { text: `[失败] 观测失败：${err?.message ?? err}` };
			} finally {
				fs.rmSync(jsonPath, { force: true });
				fs.rmSync(pngPath, { force: true });
			}
		},
	});

	// ── 按编号操作（步骤 6 收口）──────────────────────────────────────────────
	// 比裸坐标点击安全的地方是三层闸：编号表版本（本地）、目标窗口内 role+name+坐标
	// 三重校验（daemon）、UIA pattern 而非物理坐标（不抢焦点、不移动鼠标）。
	// 任何一层不过就报错让模型重新观测 —— 绝不「坐标大概还在就点一下」。
	register({
		name: "click_element",
		description:
			"按 observe_screen 清单里的编号点击界面元素。会在目标窗口内校验「这个位置还是那个元素」才动手，" +
			"元素已经变了会报错并要求重新观测 —— 不会按旧坐标乱点。走 UIA 语义动作，不移动鼠标、不抢焦点。",
		parameters: toParameterSchema({
			n: { type: "integer", required: true, description: "observe_screen 清单里的编号（从 1 开始）" },
			version: {
				type: "integer",
				description: "可选：那次观测的版本号。给了就必须与当前一致，用来防「编号过期了还在点」",
			},
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const resolved = elements.resolve(args.n, args.version);
			if (resolved.error !== undefined) return { text: `[拒绝] ${resolved.error}` };
			const { el, hwnd } = resolved;
			const cx = Math.round(el.x + el.w / 2);
			const cy = Math.round(el.y + el.h / 2);
			const label = `${el.role} "${el.name}"`;
			if (!(await approve(exec, "click_element", `点击界面元素 ${label} @ (${cx}, ${cy})`))) {
				return deny(`用户未批准点击 ${label}`);
			}
			if (lock.isEmergency()) return stopped();
			try {
				const reply = await daemon.send(
					buildCommand("invoke", { hwnd, x: cx, y: cy, role: el.role, name: el.name }),
					config.runTimeoutMs,
				);
				const m = /^ok (\w+)$/.exec(String(reply));
				if (m !== null) return { text: `已用 ${m[1]} 动作点击 ${label}（第 ${args.n} 号）` };
				return { text: `[失败] ${reply}` };
			} catch (err) {
				return { text: `[失败] 点击失败：${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "cursor_position",
		description: "读取当前鼠标光标坐标（像素，屏幕左上角为原点）。",
		parameters: toParameterSchema({}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(_args, exec) {
			if (!(await approve(exec, "cursor_position", "读取鼠标坐标（只读）"))) return deny("用户未批准");
			try {
				const reply = await daemon.send(buildCommand("pos"), config.runTimeoutMs);
				const pos = parsePos(reply);
				if (pos === null) return { text: `[失败] 坐标解析失败：${reply}` };
				return { text: `(${pos.x}, ${pos.y})` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "mouse_move",
		description:
			"把鼠标移动到屏幕坐标 (x, y)（像素，左上角原点；多屏用虚拟屏坐标，可为负）。" +
			"执行期间真实鼠标输入被钩子锁定（防止人误碰），AI 的移动不受影响。首次操作需用户审批；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 2 分钟自动解锁。",
		parameters: toParameterSchema({
			x: { type: "integer", required: true, description: "目标 X 像素坐标。" },
			y: { type: "integer", required: true, description: "目标 Y 像素坐标。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (lock.isEmergency()) return stopped();
			const x = Number(args?.x);
			const y = Number(args?.y);
			if (!Number.isFinite(x) || !Number.isFinite(y)) return { text: "[参数错误] x/y 必须是整数坐标。" };
			if (!(await approve(exec, "mouse_move", `移动鼠标到 (${Math.round(x)}, ${Math.round(y)})`))) {
				return deny("用户未批准鼠标操作");
			}
			try {
				await lock.ensureArmed();
				await daemon.send(buildCommand("move", { x: Math.round(x), y: Math.round(y) }), config.runTimeoutMs);
				return { text: `已移动到 (${Math.round(x)}, ${Math.round(y)})。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "mouse_click",
		description:
			"在屏幕坐标点击（给了 x/y 先移动再点；不给就点在当前位置）。button: left/right/middle；count: 1 或 2（双击）。" +
			"执行期间真实鼠标输入被锁定；首次操作需用户审批；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 2 分钟自动解锁。",
		parameters: toParameterSchema({
			x: { type: "integer", description: "点击位置 X（省略则点当前位置）。" },
			y: { type: "integer", description: "点击位置 Y（省略则点当前位置）。" },
			button: { type: "string", enum: ["left", "right", "middle"], description: "按键，默认 left。" },
			count: { type: "integer", description: "点几下（2 = 双击），默认 1。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (lock.isEmergency()) return stopped();
			const hasPos = args?.x !== undefined && args?.y !== undefined;
			const x = hasPos ? Math.round(Number(args.x)) : undefined;
			const y = hasPos ? Math.round(Number(args.y)) : undefined;
			if (hasPos && (!Number.isFinite(x) || !Number.isFinite(y))) return { text: "[参数错误] x/y 必须是整数坐标。" };
			const button = ["left", "right", "middle"].includes(args?.button) ? args.button : "left";
			const count = Number(args?.count) >= 2 ? 2 : 1;
			const where = hasPos ? `(${x}, ${y})` : "当前位置";
			if (!(await approve(exec, "mouse_click", `${count === 2 ? "双击" : button + "击"}${where}（真实点击）`))) {
				return deny("用户未批准鼠标操作");
			}
			try {
				await lock.ensureArmed();
				await daemon.send(buildCommand("click", { button, count, ...(hasPos ? { x, y } : {}) }), config.runTimeoutMs);
				return { text: `已在 ${where} ${count === 2 ? "双击" : `${button} 单击`}。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "scroll",
		description: "在**当前鼠标位置**滚动滚轮（先 mouse_move 到目标再 scroll）。lines 正数向上、负数向下，每格约 3 行。执行期间真实鼠标输入被锁定；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 2 分钟自动解锁。",
		parameters: toParameterSchema({
			lines: { type: "integer", required: true, description: "滚动格数，正上负下（如 3 / -3）。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (lock.isEmergency()) return stopped();
			const lines = Math.trunc(Number(args?.lines));
			if (!Number.isFinite(lines) || lines === 0) return { text: "[参数错误] lines 必须是非 0 整数。" };
			if (!(await approve(exec, "scroll", `滚动 ${lines > 0 ? "向上" : "向下"} ${Math.abs(lines)} 格`))) {
				return deny("用户未批准鼠标操作");
			}
			try {
				await lock.ensureArmed();
				await daemon.send(buildCommand("scroll", { lines }), config.runTimeoutMs);
				return { text: `已滚动 ${lines}。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "type_text",
		description:
			"在**当前焦点的输入框**里逐字符打字（支持中文；按真实键盘事件注入，不是粘贴）。" +
			"打字前先用 screenshot + mouse_click 让目标输入框获得焦点。执行期间真实鼠标输入被锁定；首次操作需用户审批；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 2 分钟自动解锁。",
		parameters: toParameterSchema({
			text: { type: "string", required: true, description: "要输入的文本。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (lock.isEmergency()) return stopped();
			const text = String(args?.text ?? "");
			if (text.length === 0) return { text: "[参数错误] text 不能为空。" };
			if (text.length > 4000) return { text: "[参数错误] 单次最多 4000 字符，分批输入。" };
			if (!(await approve(exec, "type_text", `向当前焦点窗口键入 ${text.length} 字符（真实键盘输入）`))) {
				return deny("用户未批准键盘操作");
			}
			try {
				await lock.ensureArmed();
				await daemon.send(buildCommand("type", { text }), config.runTimeoutMs);
				return { text: `已输入 ${text.length} 字符。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	register({
		name: "key_press",
		description:
			"按一个键或组合键，如 `ctrl+s`、`shift+tab`、`enter`、`esc`、`f5`。" +
			"支持：ctrl/alt/shift/win + 字母数字 + enter/esc/tab/space/backspace/delete/方向键/f1-f12。执行期间真实鼠标输入被锁定；锁定期间 Ctrl+Alt+L 紧急解锁、停止操控 2 分钟自动解锁。",
		parameters: toParameterSchema({
			key: { type: "string", required: true, description: "键或组合键，如 `ctrl+s`。" },
		}),
		output: textOut(),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (lock.isEmergency()) return stopped();
			const key = String(args?.key ?? "");
			const vks = parseKeyCombo(key);
			if (vks === null) {
				return { text: `[参数错误] 无法识别按键 "${key}"（示例：ctrl+s、shift+tab、enter）。` };
			}
			if (!(await approve(exec, "key_press", `按下按键 ${key}（真实键盘输入）`))) {
				return deny("用户未批准键盘操作");
			}
			try {
				await lock.ensureArmed();
				await daemon.send(buildCommand("keys", { vks }), config.runTimeoutMs);
				return { text: `已按下 ${key}。` };
			} catch (err) {
				return { text: `[失败] ${err?.message ?? err}` };
			}
		},
	});

	return () => {
		for (const d of disposers.splice(0)) {
			try {
				d?.();
			} catch {
				/* ignore */
			}
		}
	};
}
