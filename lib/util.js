/**
 * 公共工具：路径、配置读取、脱敏、时间格式。
 * 只用 node: 内置模块 —— 插件的解析路径就靠这个避开依赖地狱。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** dsh 主目录（`DSH_HOME` 优先），与内核 resolveDshHome 同序。 */
export function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim() !== "") return env;
	return path.join(os.homedir(), ".dsh");
}

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");

/** ISO8601 带本地偏移，例如 2026-09-21T10:31:02.123+08:00 */
export function isoLocal(d) {
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
	);
}

export function dayFile(d) {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
}

export function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function clip(s, limit) {
	if (!Number.isFinite(limit)) return s;
	return s.length > limit ? s.slice(0, limit) : s;
}

export function safeStringify(value) {
	try {
		const out = JSON.stringify(value);
		return typeof out === "string" ? out : "null";
	} catch {
		return "null";
	}
}

/** 取 toolResult 的字符数口径：字符串就它本身，否则 JSON 序列化 */
export function textOf(value) {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return safeStringify(value);
}

/**
 * 读一个 JSON 配置文件，失败只报一次并回退默认值。
 * @param {string} file 绝对路径
 * @param {object} defaults 默认值
 * @param {Record<string, (v: unknown) => any>} fields 字段校验器；返回 undefined 表示不采纳
 */
export function readJsonConfig(file, defaults, fields, warn = () => {}) {
	const out = { ...defaults };
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		if (err?.code !== "ENOENT") warn(`读取 ${file} 失败：${err?.message ?? err}`);
		else warn(`没有 ${file}，使用内置默认值`, true);
		return out;
	}
	if (!raw || typeof raw !== "object") return out;
	for (const [key, check] of Object.entries(fields)) {
		const value = check(raw[key]);
		if (value !== undefined) out[key] = value;
	}
	return out;
}

// —— 脱敏 ——

/** 摘要字段（自身就是 hex 摘要）不参与脱敏，否则会被兜底规则打成 <redacted> */
export const HASH_KEY_RE = /sha256$/i;

/** 路径/ID 这类结构字段：跑凭据规则，但不跑「长 hex/base64」兜底 */
const STRUCTURE_KEY_RE =
	/^(?:filePath|baseDir|path|cwd|sessionFile|toolCallId|sessionId|model|provider|note)$/;

const REDACT_RULES = [
	["auth-header", /authorization\s*[:=]\s*(?:bearer\s+)?[^\s"',;}\]]+/gi, "<redacted:auth-header>"],
	["bearer", /\bbearer\s+[^\s"',;}\]]+/gi, "<redacted:bearer>"],
	[
		"credential-kv",
		/(?:api[_-]?key|apikey|password|passwd|secret|token)\s*[\\"']*\s*[:=]\s*[\\"']*[^\s\\"',;}\]]+/gi,
		"<redacted:credential-kv>",
	],
	[
		"token-prefix",
		/\b(?:sk[-_][A-Za-z0-9_-]{8,}|xoxb-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,})\b/g,
		"<redacted:token-prefix>",
	],
	["url-userinfo", /([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi, "$1<redacted:url-userinfo>@"],
];

export function redactStructure(s) {
	let out = s;
	for (const [, re, rep] of REDACT_RULES) out = out.replace(re, rep);
	return out;
}

export function redact(s) {
	let out = redactStructure(s);
	out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, "<redacted:long-hex>");
	return out.replace(/[A-Za-z0-9_+=-]{32,}/g, (tok) =>
		/\d/.test(tok) ? "<redacted:long-b64>" : tok,
	);
}

/** 深度 ≤4 遍历所有字符串字段 */
export function walkStrings(node, fn, depth = 0) {
	if (depth > 4 || !node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walkStrings(item, fn, depth + 1);
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (typeof value === "string") fn(node, key, value);
		else if (value && typeof value === "object") walkStrings(value, fn, depth + 1);
	}
}

/** 写盘前对所有字符串字段过一遍脱敏（摘要字段除外） */
export function redactRecord(rec) {
	walkStrings(rec, (parent, key, value) => {
		if (HASH_KEY_RE.test(key)) return;
		parent[key] = STRUCTURE_KEY_RE.test(key) ? redactStructure(value) : redact(value);
	});
}

// —— dsh 工具参数表 ——

/**
 * 属性表 DSL → dsh 要的 JSON Schema。
 *
 * **为什么必须有这个函数**（这是真事故，不是洁癖）：
 * dsh 的 `ctx.tools.register()` 要的是**编译好的** JSON Schema
 * （`ToolDefinition.parameters`）。属性表 DSL（`required: true` 标在属性上）
 * 只对 `defineTool()` 有效 —— 它会调 `parameterSchemaSpecToJsonSchema()` 编译。
 * 我们注册时不走 `defineTool`（本包 import 不了 `@deepseek-ai/*`），
 * 于是 DSL 被原样透传：`register()` 只校验 `output.schema`，
 * `schemaOf()`（`dsh-tools/lib/index.js:2934`）把 `parameters` **一字不改**发给
 * provider。结果：
 *
 *   · 顶层没有 `type: "object"`，也没有 `properties` 包装
 *   · 参数名恰好叫 `description` 时，它在 JSON Schema 里是**注解关键字**
 *     （值必须是字符串），而我们给的是对象 → provider 直接 400：
 *     `Invalid schema for function 'bash': {"description":{...},"type":"string"}
 *      is not of type "string"`
 *
 * 这个 bug 静默了很久：本仓库自检用的 `tools.register` 是**假实现**
 * （只把 definition 存进 Map），从不校验 schema，所以测不出来。
 *
 * 编译规则（对齐 `dsh-tools` 的 `parameterSchemaSpecToJsonSchema`）：
 *   · 每个属性的 `required: true` → 收集进顶层 `required: ["名", ...]`
 *   · 属性自身不再带 `required`（它不是合法 JSON Schema 关键字，会让 provider 报错）
 *   · 顶层补 `type: "object"` 与 `properties`
 *
 * 已经是 JSON Schema 形态（顶层带 `type`/`oneOf`）时**原样返回** ——
 * 这样 `context7.js` / `lens.js` / `lens-tools.js` 的写法不受影响，两种写法共存。
 *
 * @param {object} spec 属性表 DSL，或已经编好的 JSON Schema
 * @returns {object} dsh 能直接发给 provider 的 JSON Schema
 */
export function toParameterSchema(spec) {
	// 已经是 JSON Schema（顶层自己带 type 或 oneOf）→ 不动它。
	if (spec && typeof spec === "object" && (typeof spec.type === "string" || spec.oneOf !== undefined)) {
		return spec;
	}
	const properties = {};
	const required = [];
	for (const [name, raw] of Object.entries(spec ?? {})) {
		if (!raw || typeof raw !== "object") continue;
		// 拆出 required，剩下的就是属性自己的 schema。
		const { required: isRequired, ...rest } = raw;
		if (isRequired === true) required.push(name);
		properties[name] = rest;
	}
	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}
