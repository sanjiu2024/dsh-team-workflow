/**
 * `@deepseek-ai/dsh-tools` is a RUNTIME package: the DSH process provides it, the
 * bundle does not ship it, and it is not published under a version this checkout
 * can install (npm carries 0.0.1-rc.1 while the running harness is on 0.2.x).
 *
 * Importing it at module top level made the whole plugin unloadable anywhere the
 * runtime's node_modules is not on the resolution path — which is every clean CI
 * runner, so `pnpm test` died with ERR_MODULE_NOT_FOUND on a package nobody
 * touched (issue #28).
 *
 * Resolution is therefore lazy and forgiving: use the real `defineTool` when the
 * runtime is there, fall back to a local implementation with the same public
 * shape when it is not. The fallback is deliberately small — the plugin only
 * relies on `name`, `description`, `parameters`, `output.render` and a validated
 * `execute` — but it does keep the one behaviour that matters: required
 * parameters are checked BEFORE the tool body runs.
 */

import { createRequire } from 'node:module'

/**
 * Resolve the runtime's `defineTool`, or the local fallback.
 * @returns {(spec: object) => object}
 */
export function resolveDefineTool() {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('@deepseek-ai/dsh-tools')
    if (typeof mod?.defineTool === 'function') return mod.defineTool
  } catch {
    // Not installed: the runtime is absent (tests, a bare checkout, CI).
  }
  return FALLBACK_DEFINE_TOOL
}

/** Turn a parameter spec into the JSON-schema-ish shape a registry expects. */
function parametersOf(spec) {
  const properties = {}
  const required = []
  for (const [name, value] of Object.entries(spec ?? {})) {
    const entry = value ?? {}
    properties[name] = {
      type: entry.type ?? 'string',
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.enum === undefined ? {} : { enum: entry.enum }),
    }
    if (entry.required === true) required.push(name)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** Required-parameter violations, empty when the arguments are acceptable. */
function validateArgs(parameters, args) {
  const problems = []
  const required = Array.isArray(parameters.required) ? parameters.required : []
  for (const name of required) {
    const value = args?.[name]
    if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
      // Wording matches the runtime's ToolArgsError so callers (and existing
      // tests) cannot tell which implementation resolved.
      problems.push(`missing required property "${name}"`)
    }
  }
  return problems
}

/**
 * Minimal stand-in for the runtime's `defineTool`.
 *
 * Same shape as the real one for everything this bundle uses, so a caller cannot
 * tell which implementation resolved. Execution validates required arguments
 * first and throws before the tool body runs, exactly like the real pipeline.
 * @param {object} spec
 * @returns {object} a registry-ready definition
 */
export function FALLBACK_DEFINE_TOOL(spec) {
  const parameters = parametersOf(spec?.parameters)
  const userExecute = spec?.execute
  const userRender = spec?.output?.render ?? (() => [])
  return {
    name: spec?.name,
    description: spec?.description,
    parameters,
    output: {
      schema: spec?.output?.schema ?? { type: 'object', additionalProperties: true },
      render: (args, value) => userRender(args, value),
    },
    ...(spec?.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    async execute(args, exec) {
      const problems = validateArgs(parameters, args)
      if (problems.length > 0) {
        const error = new Error(`invalid arguments: ${problems.join('; ')}`)
        error.name = 'ToolArgsError'
        throw error
      }
      return userExecute(args, exec)
    },
    ...(typeof spec?.presentCall === 'function' ? { presentCall: spec.presentCall } : {}),
    ...(typeof spec?.presentResult === 'function' ? { presentResult: spec.presentResult } : {}),
  }
}
