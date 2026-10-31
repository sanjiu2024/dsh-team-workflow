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
 * @param {{daemon: any, lock: any, approve: Function, assertImageRoute: Function, config: Record<string, any>}} core
 * @returns {() => void} 注销全部工具
 */
export function registerDshTools(ctx, { daemon, lock, approve, assertImageRoute, config }) {
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
