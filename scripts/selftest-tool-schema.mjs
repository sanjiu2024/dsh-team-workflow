#!/usr/bin/env node
/**
 * 自检：所有注册给模型的工具，`parameters` 必须是**合法 JSON Schema**。
 *
 * ── 为什么需要这个文件（真实事故）────────────────────────────────────────
 * 用户线上报 400：
 *
 *   Invalid schema for function 'bash':
 *   {"description":"这条命令做什么，5-10 个词的简短说明（显示给用户看）。",
 *    "type":"string"} is not of type "string"
 *
 * 根因：dsh 的 `ctx.tools.register()` 要的是**编译好的 JSON Schema**。
 * 「属性表 DSL」（`required: true` 标在属性上）只对 `defineTool()` 有效 ——
 * 它会调 `parameterSchemaSpecToJsonSchema()` 编译。本包不走 `defineTool`
 * （import 不了 `@deepseek-ai/*`），于是 DSL 被**原样透传**：
 *   · `register()` 只校验 `output.schema`，不碰 `parameters`
 *   · `schemaOf()`（`dsh-tools/lib/index.js:2934`）把 parameters 一字不改发给 provider
 * 结果顶层既没有 `type: "object"` 也没有 `properties` 包装；参数名恰好叫
 * `description` 时，它在 JSON Schema 里是注解关键字（值必须是字符串），
 * 而我们给的是对象 → provider 400。
 *
 * ── 为什么以前的自检测不出来 ────────────────────────────────────────────
 * 各 `selftest-*.mjs` 里的 `tools.register` 是**假实现**（只把 definition 存进
 * Map），从不校验 schema。所以这个 bug 从 0.6.0 活到了 1.1.0。
 * 这个文件用**真规则**校验（下面 `violations()`，对齐 dsh 的
 * `assertSupportedJsonSchema` 子集），且**不依赖 dsh 包**（本仓库零依赖）。
 *
 *   node scripts/selftest-tool-schema.mjs
 */
import * as assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const { toParameterSchema } = await import(new URL("lib/util.js", ROOT).href);

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
	} catch (error) {
		failures++;
		console.log(`✗ ${name}\n    ${error?.message ?? error}`);
	}
};

// ── dsh JSON Schema 子集的校验规则（不依赖 dsh，照它的规则抄）─────────────

/** dsh 允许的约束关键字（`dsh-tools` 的 CONSTRAINT_KEYWORDS） */
const CONSTRAINT_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
/** dsh 允许的注解关键字（值必须是 lossless JSON，description/title 还必须是字符串） */
const ANNOTATION_KEYWORDS = new Set(["description", "title", "$comment", "examples", "default", "deprecated", "readOnly", "writeOnly"]);

/**
 * 照 dsh 的规则检查一个 schema，返回违规说明（空数组 = 合法）。
 * 只实现我们会在 `parameters` 里用到的部分 —— 不是通用 JSON Schema 校验器。
 */
function violations(schema, path = "schema") {
	const out = [];
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
		out.push(`${path} 必须是对象`);
		return out;
	}
	for (const key of Object.keys(schema)) {
		if (CONSTRAINT_KEYWORDS.has(key)) continue;
		if (ANNOTATION_KEYWORDS.has(key)) {
			if ((key === "description" || key === "title") && typeof schema[key] !== "string") {
				out.push(`${path}.${key} 必须是字符串（实际 ${typeof schema[key]}）`);
			}
			continue;
		}
		// 这条正是 400 的来源：DSL 的 `required: true` 落在属性上时，
		// 属性层不认识 `required`，顶层又会把参数名当注解关键字。
		out.push(`${path}.${key} 不是合法关键字`);
	}
	const hasType = Object.hasOwn(schema, "type");
	const hasOneOf = Object.hasOwn(schema, "oneOf");
	if (hasType && hasOneOf) out.push(`${path} 不能同时有 type 和 oneOf`);
	if (!hasType && !hasOneOf) out.push(`${path} 必须有 type 或 oneOf`);
	if (hasType && typeof schema.type !== "string") out.push(`${path}.type 必须是字符串`);

	if (Object.hasOwn(schema, "required")) {
		if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
			out.push(`${path}.required 必须是字符串数组`);
		} else {
			const props = schema.properties ?? {};
			for (const name of schema.required) {
				if (!Object.hasOwn(props, name)) out.push(`${path}.required 里的 "${name}" 不在 properties 中`);
			}
		}
	}
	if (Object.hasOwn(schema, "properties")) {
		if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
			out.push(`${path}.properties 必须是对象`);
		} else {
			for (const [name, sub] of Object.entries(schema.properties)) {
				out.push(...violations(sub, `${path}.properties.${name}`));
			}
		}
	}
	if (Object.hasOwn(schema, "items")) out.push(...violations(schema.items, `${path}.items`));
	return out;
}

// ── 1. toParameterSchema：编译规则 ──────────────────────────────────────────

check("toParameterSchema：DSL 属性表 → 顶层 type:object + properties 包装", () => {
	const out = toParameterSchema({
		command: { type: "string", required: true, description: "命令。" },
		workdir: { type: "string", description: "目录。" },
	});
	assert.equal(out.type, "object");
	assert.deepEqual(Object.keys(out.properties).sort(), ["command", "workdir"]);
	assert.deepEqual(out.required, ["command"], "required 要收进数组");
	assert.equal(out.properties.command.required, undefined, "属性自身不能再带 required");
});

check("toParameterSchema：用户报错的那份参数（description 撞注解关键字）", () => {
	// 这就是 400 的原始输入。
	const out = toParameterSchema({
		command: { type: "string", required: true, description: "要执行的 bash 命令。" },
		description: { type: "string", description: "这条命令做什么，5-10 个词的简短说明（显示给用户看）。" },
	});
	// 关键：顶层不能有 description（它是注解关键字，值必须字符串）。
	assert.equal(out.description, undefined, "顶层不能出现 description");
	// 它必须被收进 properties 里 —— 作为一个**属性名**，那里对象是合法的。
	assert.equal(out.properties.description.type, "string");
	assert.equal(typeof out.properties.description.description, "string");
	assert.deepEqual(violations(out), [], "必须合法");
});

check("toParameterSchema：没有必填参数时不产生空 required 数组", () => {
	const out = toParameterSchema({ a: { type: "string", description: "x" } });
	assert.equal(Object.hasOwn(out, "required"), false, "空 required 会显得像「有必填」");
	assert.deepEqual(violations(out), []);
});

check("toParameterSchema：空参数表（bash_close 那种）", () => {
	const out = toParameterSchema({});
	assert.equal(out.type, "object");
	assert.deepEqual(out.properties, {});
	assert.deepEqual(violations(out), []);
});

check("toParameterSchema：已经是 JSON Schema 就原样返回（两种写法共存）", () => {
	// context7.js / lens.js / lens-tools.js 用的是完整 JSON Schema 字面量，不能被改坏。
	const already = {
		type: "object",
		required: ["library"],
		properties: { library: { type: "string", description: "库名。" } },
		additionalProperties: false,
	};
	assert.equal(toParameterSchema(already), already, "应原样返回（引用相等）");
	assert.deepEqual(violations(already), []);
});

check("toParameterSchema：oneOf 形态也不动", () => {
	const already = { oneOf: [{ type: "object", properties: {} }] };
	assert.equal(toParameterSchema(already), already);
});

check("toParameterSchema：保留 additionalProperties / items / enum 等约束", () => {
	const out = toParameterSchema({
		mode: { type: "string", enum: ["a", "b"], description: "模式。" },
		tags: { type: "array", items: { type: "string" }, description: "标签。" },
	});
	assert.deepEqual(out.properties.mode.enum, ["a", "b"]);
	assert.equal(out.properties.tags.items.type, "string");
	assert.deepEqual(violations(out), []);
});

check("toParameterSchema：required:false 不进 required", () => {
	const out = toParameterSchema({ a: { type: "string", required: false, description: "x" } });
	assert.equal(out.required, undefined);
	assert.equal(out.properties.a.required, undefined);
});

// ── 2. 真跑：装所有工具，逐个按 dsh 规则校验 ──────────────────────────────

/** 假的 ctx：只收工具，但**校验用的是真规则**（上面 violations）。 */
function collector() {
	const tools = new Map();
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		effect: () => () => {},
		on: () => () => {},
		inject: () => () => {},
		tools: {
			register: (definition) => {
				if (tools.has(definition.name)) throw new Error(`重复注册 ${definition.name}`);
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			},
		},
	};
	return { ctx, tools };
}

const { installBashLinux, BASH_DEFAULTS } = await import(new URL("lib/bash-linux.js", ROOT).href);
const { installWorktree, WORKTREE_DEFAULTS } = await import(new URL("lib/worktree.js", ROOT).href);

{
	const { ctx, tools } = collector();
	installBashLinux(ctx, { config: { ...BASH_DEFAULTS } });
	installWorktree(ctx, { config: { ...WORKTREE_DEFAULTS } });

	check("真跑：至少装上了 8 个工具（这个自检本身要有效）", () => {
		assert.ok(tools.size >= 8, `实际 ${tools.size} 个：${[...tools.keys()].join(", ")}`);
	});

	for (const [name, definition] of tools) {
		check(`真跑：${name} 的 parameters 是合法 JSON Schema`, () => {
			const bad = violations(definition.parameters);
			assert.deepEqual(bad, [], `${name} 的 parameters 非法：\n      ${bad.join("\n      ")}`);
		});
		check(`真跑：${name} 的 parameters 有 type:object + properties（DSL 没被漏编译）`, () => {
			assert.equal(definition.parameters?.type, "object", "顶层必须 type:object");
			assert.ok(definition.parameters?.properties !== undefined, "必须有 properties 包装");
		});
	}

	check("真跑：bash 的 required 是数组、且 command 必填", () => {
		const bash = tools.get("bash");
		assert.deepEqual(bash.parameters.required, ["command"]);
	});

	check("真跑：worktree_drop 的 force/keepBranch 不是必填（默认必须走安全那条路）", () => {
		const drop = tools.get("worktree_drop");
		assert.ok(!drop.parameters.required.includes("force"), "force 不能必填");
		assert.ok(!drop.parameters.required.includes("keepBranch"), "keepBranch 不能必填");
		assert.deepEqual(drop.parameters.required, ["name"]);
	});
}

// ── 3. 反例：这个自检必须真的能抓到那个 bug ──────────────────────────────

check("反例：DSL 原样当 schema 必须被判非法（否则本自检是摆设）", () => {
	// 用户报 400 的原始形态
	const raw = {
		command: { type: "string", required: true, description: "要执行的 bash 命令。" },
		description: { type: "string", description: "这条命令做什么。" },
	};
	const bad = violations(raw);
	assert.ok(bad.length > 0, "必须能识别出「DSL 没编译」这种非法形态");
});

check("反例：顶层 description 是对象必须被判非法（400 的直接成因）", () => {
	const bad = violations({ type: "object", properties: {}, description: { type: "string" } });
	assert.ok(
		bad.some((v) => v.includes("description")),
		`顶层 description 是对象必须报错，实际 ${JSON.stringify(bad)}`,
	);
});

check("反例：required 写成对象/非数组必须被判非法", () => {
	assert.ok(violations({ type: "object", properties: {}, required: { a: true } }).length > 0);
});

check("反例：required 指向不存在的属性必须被判非法（dsh 也这么查）", () => {
	assert.ok(violations({ type: "object", properties: {}, required: ["nope"] }).length > 0);
});

console.log(
	failures === 0
		? "\n✓ 自检通过：参数表编译 / 8 个工具的 parameters 合法（对齐 dsh 子集）/ 反例可被抓到"
		: `\n✗ ${failures} 项失败`,
);
process.exit(failures === 0 ? 0 : 1);
