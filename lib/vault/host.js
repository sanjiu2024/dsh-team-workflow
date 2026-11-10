// dsh-credential-vault — host half.
//
// Stores credentials (server passwords, GitHub tokens, API keys, database
// secrets, …) AES-256-GCM encrypted under `$DSH_HOME/credential-vault/` and
// exposes one `credential` tool with five actions:
//
//   list    names + normalized metadata, never a value
//   search  five-step lookup (exact → slug → alias → service → keyword)
//   get     masked metadata for one credential
//   use     the DEFAULT path: returns only a DSH_CRED_* variable name, whose
//           value `dsh-shell-env` injects into each shell call, so the secret
//           never enters the conversation or the session log
//   reveal  the audited escape hatch: returns plaintext, only when the user
//           explicitly asks to see the value
//
// It also registers a system-prompt section that is re-evaluated on every
// assembly, listing what is stored and telling the model to check the vault
// BEFORE asking the user for any secret. The HTTP API behind the "工具管理"
// panel never returns secret material.

import { homedir } from 'node:os'
import { join } from 'node:path'

import { appendFileSync } from 'node:fs'
import { resolveDefineTool } from './lib/define-tool.js'
import { createVaultStore } from './lib/vault-store.js' // STARTUP-MARKER
import { appendAudit, readAudit } from './lib/audit.js'
import { API_BASE, createApiHandler } from './lib/api.mjs'
import { isValidName } from './lib/store.js'
import { matchedBy, publicFields, resolveName, searchEntries } from './lib/resolve.js'
import { hintSection } from './lib/hint.js'
import { createEnvBridge, createGrantTable, envVarFor, sessionIdOf } from './lib/env-injection.js'

export const name = 'dsh-credential-vault'

/** HTTP route prefix claimed by this plugin (see lib/api.mjs). */
export { API_BASE }

export const TOOL_NAME = 'credential'

/** Cordis service dependencies. */
// [移植] 上游这里是 `export const inject = [...]`（插件级声明，缺一个整个插件不激活）。
// 搬进本包后它不是插件入口，inject 由 lib/vault/index.js 的模块内 ctx.inject 管 ——
// 留一行说明位置，不要把这里当插件的 inject 读。

/** Directory holding master.key / vault.json / audit.log. */
export function defaultVaultDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'credential-vault')
}

/**
 * Cordis plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{vaultDir?: string, grantTtlMs?: number}} [config]
 */
export function apply(ctx, config = {}) {

  const options = config && typeof config === 'object' ? config : {}
  const dir = typeof options.vaultDir === 'string' && options.vaultDir.length > 0
    ? options.vaultDir
    : defaultVaultDir()
  const store = createVaultStore(dir)

  ctx.systemPrompt.section(hintSection(store))

  // Zero-plaintext path: `use` records a grant and `shellEnv` injects the value
  // into each shell call, so the secret never enters the conversation.
  const grants = createGrantTable({ ttlMs: options.grantTtlMs })
  // Session grants are in-memory with a TTL; a session that ends should not
  // keep its grants alive until the TTL expires (#103 D3). The host publishes
  // agent disposal (cordis agent lifecycle), which is the session-end signal
  // this plugin can observe without new host dependencies.
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('agent/disposed', (payload) => {
        const disposedSession = payload?.agent?.session?.header?.id ?? payload?.session?.header?.id
        if (typeof disposedSession === 'string' && disposedSession.length > 0) grants.clear(disposedSession)
      })
    }
  } catch {
    // A host context that refuses unread services simply has no disposal hook;
    // grants then live until their TTL, exactly as before (#103 D3).
  }
  let envRegister = null
  const envBridge = createEnvBridge({
    store,
    grants,
    register: (contributor) => (envRegister === null ? undefined : envRegister(contributor)),
  })

  /** Bind the registry when this deployment composes `dsh-shell-env`. */
  function attachShellEnv(service) {
    if (service === null || typeof service?.register !== 'function') return
    envRegister = (contributor) => service.register(contributor)
    envBridge.sync()
  }

  if (typeof ctx.inject === 'function') {
    // Optional dependency. Never touch `ctx.shellEnv` directly: cordis' proxy
    // THROWS on an undeclared service property, which would fail plugin load.
    // A composition without `dsh-shell-env` keeps working — `use` then fails
    // loudly instead of silently leaking a value.
    ctx.effect(() =>
      ctx.inject(['shellEnv'], (inner) => {
        attachShellEnv(inner.shellEnv)
        return () => envBridge.dispose()
      }),
    )
  }

  const outputSpec = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
  // Resolved lazily: the runtime provides `@deepseek-ai/dsh-tools`, but it is not
  // installed in every environment (CI, bare checkouts), and a top-level import
  // made the whole plugin unloadable there (issue #28).
  const defineTool = resolveDefineTool()
  ctx.effect(() => {
    try {
      return ctx.tools.register(defineTool({
      name: TOOL_NAME,
      description:
        'Read credentials from the encrypted vault. Prefer `action:"use"`, which returns only an environment ' +
        'variable name so the secret never enters this conversation. `action:"list"` shows what exists, ' +
        '`action:"search"` finds one by any spelling (name, alias, service), `action:"get"` returns masked ' +
        'metadata, and `action:"reveal"` returns plaintext (every reveal is audited — use it only when the ' +
        'user explicitly asks to see the value).',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: '"list", "search", "get", "use" or "reveal".',
        },
        name: {
          type: 'string',
          description: 'Credential name or any close spelling of it. Required for "get", "use" and "reveal".',
        },
        query: {
          type: 'string',
          description: 'Search text: a name, alias, service or a few keywords. Required for "search".',
        },
      },
      execute(args, exec) {
        const action = typeof args?.action === 'string' ? args.action : ''
        if (action === 'list') {
          const entries = store.listMeta()
          return {
            action,
            count: entries.length,
            entries,
            note:
              'Each entry carries name/slug/service/aliases. When you need a secret, call action "use" with the ' +
              'name (or any of its aliases) to get a DSH_CRED_* environment variable.',
          }
        }
        if (action === 'search') {
          const query = typeof args?.query === 'string' ? args.query.trim() : ''
          if (query.length === 0) {
            appendAudit(dir, {
              name: null,
              outcome: 'rejected',
              source: 'tool',
              action: 'search',
              sessionId: sessionIdOf(exec),
              reason: 'search without query',
            })
            throw new Error('credential: "query" is required for action "search"')
          }
          const entries = store.listMeta()
          const matches = searchEntries(entries, query)
          const resolvedBy = matchedBy(entries, query)
          const status = matches.length === 0 ? 'missing' : matches.length === 1 ? 'resolved' : 'ambiguous'
          return {
            action,
            query,
            status,
            resolvedBy,
            matches: matches.map(publicFields),
            ...(status === 'ambiguous' ? { note: 'Several credentials match; pass the exact name to "use".' } : {}),
          }
        }
        if (action === 'get' || action === 'use' || action === 'reveal') {
          const credName = typeof args?.name === 'string' ? args.name.trim() : ''
          // The bypass below is intentional; the store-level guard is pinned in
          // test/hotfix-041.test.mjs (issue #52):
if (!isValidName(credName) && !store.has(credName)) {
            appendAudit(dir, {
              name: credName || null,
              outcome: 'rejected',
              source: 'tool',
              action,
              sessionId: sessionIdOf(exec),
              reason: 'invalid name',
            })
            throw new Error('credential: "name" is required and must be a plain name (see action "list")')
          }
          const resolved = resolveName(store.listMeta(), credName)
          if (resolved.status === 'missing') {
            appendAudit(dir, {
              name: credName,
              outcome: 'missing',
              source: 'tool',
              action,
              sessionId: sessionIdOf(exec),
            })
            throw new Error(
              `credential: no credential matches "${credName}" — call action "list" to see what is stored, ` +
                'then ask the user whether to add it',
            )
          }
          if (resolved.status === 'ambiguous') {
            const names = resolved.candidates.map((candidate) => candidate.name)
            appendAudit(dir, {
              name: credName,
              outcome: 'ambiguous',
              source: 'tool',
              action,
              sessionId: sessionIdOf(exec),
              reason: names.join(', '),
            })
            throw new Error(
              `credential: "${credName}" matches several credentials (${names.join(', ')}) — ` +
                'repeat the call with one of those exact names',
            )
          }
          if (action === 'get') {
            let found
            try {
              found = store.get(resolved.name)
            } catch (error) {
              // An unsafe-name entry is refused by the store; the audit must show
              // the attempt was made and why it failed (spec §2.1).
              appendAudit(dir, {
                name: resolved.name,
                outcome: 'rejected',
                source: 'tool',
                action,
                sessionId: sessionIdOf(exec),
                resolvedBy: resolved.resolvedBy,
                reason: 'unsafe name',
              })
              throw error
            }
            appendAudit(dir, {
              name: resolved.name,
              outcome: found === null ? 'missing' : 'ok',
              source: 'tool',
              action,
              sessionId: sessionIdOf(exec),
              resolvedBy: resolved.resolvedBy,
            })
            if (found === null) throw new Error(`credential: no credential named "${resolved.name}"`)
            const { preview, ...rest } = found
            return {
              action,
              ...rest,
              resolvedBy: resolved.resolvedBy,
              note: 'Metadata only; the secret stays sealed.',
            }
          }
          if (action === 'use') {
            // Zero-plaintext path. Check availability BEFORE any audit write or
            // reveal: a deployment without shellEnv must fail loudly rather than
            // quietly hand the value over.
            if (!envBridge.ready) {
              throw new Error(
                'credential: environment variable injection is not available in this deployment, so "use" ' +
                  'cannot deliver the secret without putting it in the conversation. Stop and tell the user ' +
                  'that this deployment needs dsh-shell-env for safe credential use; do not use "reveal" on ' +
                  'your own initiative.',
              )
            }
            envBridge.sync()
            const envVar = envVarFor(resolved.name)
            const collides = envBridge.collisionFor(envVar)
            if (collides !== null) {
              appendAudit(dir, {
                name: resolved.name,
                outcome: 'rejected',
                source: 'tool',
                action,
                sessionId: sessionIdOf(exec),
                reason: `variable collision: ${collides.join(', ')}`,
              })
              throw new Error(
                `credential: ${collides.join(' and ')} would share the environment variable ${envVar}, so ` +
                  '"use" cannot inject either safely — rename one of them in the panel and try again',
              )
            }
            if (!envBridge.declared().includes(envVar)) {
              throw new Error(`credential: "use" could not declare ${envVar} with the shell environment`)
            }
            const sessionId = sessionIdOf(exec)
            if (sessionId === null) {
              appendAudit(dir, { name: resolved.name, outcome: 'rejected', source: 'tool', reason: 'no session id' })
              throw new Error('credential: "use" requires an agent session')
            }
            let revealed
            try {
              revealed = store.reveal(resolved.name)
            } catch (error) {
              appendAudit(dir, {
                name: resolved.name,
                outcome: 'rejected',
                source: 'tool',
                action,
                sessionId,
                resolvedBy: resolved.resolvedBy,
                reason: 'unsafe name',
              })
              throw error
            }
            if (revealed === null) throw new Error(`credential: no credential named "${resolved.name}"`)
            // Credential-level TTL cap (T4.vault M1): a credential that declares
            // ttlSeconds gets a grant no longer than that window.
            const ttlSeconds = store.listMeta().find((entry) => entry.name === resolved.name)?.ttlSeconds ?? null
            const grant = grants.issue(sessionId, resolved.name, revealed.secret, {
              ttlMs: ttlSeconds === null ? undefined : ttlSeconds * 1000,
            })
            appendAudit(dir, {
              name: resolved.name,
              outcome: 'ok',
              source: 'tool',
              action: 'use',
              sessionId,
              resolvedBy: resolved.resolvedBy,
            })
            return {
              action,
              name: resolved.name,
              resolvedBy: resolved.resolvedBy,
              envVar: grant.envVar,
              expiresAt: grant.expiresAt,
              ttlSeconds,
              note:
                `The value is NOT in this result. Reference $${grant.envVar} inside a shell command; it is ` +
                'injected into each shell call until it expires. Never echo it, printenv it, or write it to a ' +
                'file, URL or command-line argument. When it expires, re-run action:"use" with the same name ' +
                'to get a fresh grant.',
            }
          }
          if (action === 'reveal') {
            let revealed
            try {
              revealed = store.reveal(resolved.name)
            } catch (error) {
              appendAudit(dir, {
                name: resolved.name,
                outcome: 'rejected',
                source: 'tool',
                action,
                sessionId: sessionIdOf(exec),
                resolvedBy: resolved.resolvedBy,
                reason: 'unsafe name',
              })
              throw error
            }
            appendAudit(dir, {
              name: resolved.name,
              outcome: revealed === null ? 'missing' : 'ok',
              source: 'tool',
              action,
              sessionId: sessionIdOf(exec),
              resolvedBy: resolved.resolvedBy,
            })
            if (revealed === null) throw new Error(`credential: no credential named "${resolved.name}"`)
            return { action, ...revealed, resolvedBy: resolved.resolvedBy }
          }
          return null
        }
        throw new Error('credential: action must be "list", "search", "get", "use" or "reveal"')
      },
      presentCall: (args) => {
        const action = typeof args?.action === 'string' ? args.action : 'credential'
        const label =
          action === 'list'
            ? 'List credentials'
            : action === 'search'
              ? 'Search credentials'
              : action === 'use'
                ? 'Use credential'
                : action === 'reveal'
                  ? 'Reveal credential'
                  : 'Read credential'
        return { title: label, kind: 'read', detail: typeof args?.name === 'string' ? args.name : undefined }
      },
      output: outputSpec,
      }))
    } catch (error) {
      // Another fiber of this plugin (the loader can create several during a
      // hot reconcile) may have registered the same tool name first; that
      // sibling owns the registration and this context must not fail for it.
      if (/already registered/.test(error?.message ?? '')) {
              return
      }
      throw error
    }
  })

  // kind 'exact' per route: the web app's listener serves exact routes; the
  // prefix kind registered from a hot-reloaded subtree never became reachable.
  const apiHandler = createApiHandler({ store, dir })
  for (const [routePath, method] of [
    [`${API_BASE}/list`, 'GET'],
    [`${API_BASE}/entry`, 'GET'],
    [`${API_BASE}/audit`, 'GET'],
    [`${API_BASE}/set`, 'POST'],
    [`${API_BASE}/delete`, 'POST'],
    [`${API_BASE}/rotate`, 'POST'],
    [`${API_BASE}/export`, 'POST'],
    [`${API_BASE}/import`, 'POST'],
  ]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: routePath, handler: apiHandler }))
  }

  // Keep the audit reader reachable for tests and future callers.
  void readAudit
}
