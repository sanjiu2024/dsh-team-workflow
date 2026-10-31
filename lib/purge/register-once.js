/**
 * 注册类调用的**进程级**去重：命令、工具各一份。
 *
 * 为什么必须有（2026-10-31，dsh 0.2.1-rc.5 实测）：
 *   宿主按 **agent** 调 apply —— 主代理挂一次、每个子代理再各挂一次。而 `commands` /
 *   `tools` 是**全局服务**（rc.5 里它们由 `ScopedLayers.effect(this.ctx, ...)` 落到
 *   context-global 层，`this.ctx` 是服务自己的 ctx，不随调用方变），所以第二次 apply 里
 *   同名注册直接抛：
 *     command "purge" is already registered (for a per-agent variant, mount a
 *       command-injected plugin under that agent's `agent.ctx`)
 *     tool "purge_status" is already registered (for a per-agent variant, register
 *       through that agent's `agent.ctx` instead)
 *   整个 apply 因此失败，工具箱里那行显示成「purge 挂载失败」，/purge 命令与
 *   purge_* / redteam_* 工具全都拿不到。
 *
 * 记的是「服务对象 → 已注册名字」，不是模块级 Set：
 *   - 服务对象在同一进程里唯一，**跨模块副本也认同一个 key**（插件被 loader 用两条
 *     不同 specifier 加载时会有两份模块实例，各有一份模块级 Set —— 那种写法挡不住）；
 *   - 宿主已经抛 already registered（别的插件抢先注册了同名），也当成"已经有了"，
 *     不让它把整个 purge 半边拖垮。
 */

/** service 对象 → 已注册的名字。WeakMap：服务被换掉后旧记录自动回收。 */
const SERVICE_NAMES = new WeakMap();

function namesOf(service) {
	let names = SERVICE_NAMES.get(service);
	if (!names) {
		names = new Set();
		SERVICE_NAMES.set(service, names);
	}
	return names;
}

/** 宿主对同名重复注册的报错文案（rc.5 的 commands / tools 都是这一句）。 */
function isAlreadyRegistered(error) {
	const msg = String((error && error.message) || error);
	return msg.includes("already registered") || msg.includes("already exists");
}

/**
 * 同名只注册一次。
 *
 * @param service 宿主的全局注册服务（`commands` / `tools`）；不是对象时直接放弃注册
 * @param name    注册名；同一 service 上同名只算一次
 * @param action  真正调宿主的那一下
 * @returns 这次是否真的注册上了
 */
export function registerOnce(service, name, action) {
	if (!service || typeof service !== "object" || typeof name !== "string" || !name) return false;
	const names = namesOf(service);
	if (names.has(name)) return false;
	names.add(name);
	try {
		action();
		return true;
	} catch (error) {
		// 宿主说已经注册过 → 保留记录（再试也一样），其余错误把记录退回去，让重试有意义。
		if (isAlreadyRegistered(error)) return false;
		names.delete(name);
		throw error;
	}
}

/** `/purge` 这类会话命令：`commands.register({ name, description, input, handler })`。 */
export function registerCommandOnce(commands, spec) {
	return registerOnce(commands, spec && spec.name, () => commands.register(spec));
}

/** 模型工具：`tools.register({ name, description, parameters, output, execute })`。 */
export function registerToolOnce(tools, spec) {
	return registerOnce(tools, spec && spec.name, () => tools.register(spec));
}
