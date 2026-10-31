/**
 * 工具输出形状（schema + render）—— REQ-024 步骤 3 抽出。
 *
 * 为什么单独成文件：这两个形状里有三条踩过的坑，都写在注释里 ——
 * （a）ctx.tools.register 只认标准 JSON Schema，required 必须是数组；
 * （b）render 必须返回 [text, image] 两块，模型才真的看到图；
 * （c）截图的 schema 一旦漂移，模型会拿到一个它解析不了的对象而静默不显示。
 * 混在 400 行安装逻辑里，这些约束没有地方可以被单独读到。
 */

export const textOut = () => ({
	schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
	render: (_args, value) => [{ type: "text", text: value.text }],
});
export const shotOut = () => ({
	schema: {
		// 标准 JSON Schema：required 必须是数组，property 内不能有 `required: true`
		// —— `ctx.tools.register()` 的 assertSupportedJsonSchema 只认这一种
		// （照 dsh-tool-fs 内部方言写会直接拒载，实测 1.6.0 启动失败）。
		type: "object",
		additionalProperties: false,
		required: ["image", "caption"],
		properties: {
			image: {
				type: "object",
				additionalProperties: false,
				required: ["attachmentId", "mediaType", "bytes", "width", "height"],
				properties: {
					attachmentId: { type: "string" },
					mediaType: { type: "string" },
					bytes: { type: "integer" },
					width: { type: "integer" },
					height: { type: "integer" },
					name: { type: "string" },
				},
			},
			caption: { type: "string" },
		},
	},
	render: (_args, value) => [
		{ type: "text", text: value.caption },
		{ type: "image", attachment: value.image },
	],
});

export const deny = (why) => ({ text: `[审批被拒] ${why}` });
