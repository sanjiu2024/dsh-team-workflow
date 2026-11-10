// Zero-plaintext credential USE for dsh-credential-vault.
//
// The problem this solves: any value that reaches the model lands in the session
// log, in the tool-call arguments it copies it into, in job labels, and often in
// a `.git/config`. Encryption at rest does not help once the plaintext is in the
// transcript.
//
// So `use` never returns a value. It records a short-lived grant for one session
// and hands back the NAME of an environment variable. `dsh-shell-env` rebuilds
// its `DSH_*` snapshot per shell execution without entering the request prefix,
// so the value exists only inside the child process:
//
//   model writes   git clone "https://x-access-token:$DSH_CRED_GITHUB_TOKEN@…"
//   session log    contains $DSH_CRED_GITHUB_TOKEN, never the secret
//
// Honest boundary: this stops accidental leaks (paste, URL, file, log). It does
// not stop deliberate exfiltration by an agent running as the same OS user —
// that needs an external KMS or a separate low-privilege user.

import { createHash } from 'node:crypto'

import { normalizeKey } from './store.js'

/** How long a `use` grant stays valid, in milliseconds. */
export const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000

/**
 * The environment variable that carries one credential.
 *
 * `dsh-shell-env` validates the part after `DSH_` against `/^[A-Z][A-Z0-9_]*$/`,
 * so a Chinese or otherwise non-ASCII name CANNOT be used verbatim — a single
 * such name used to make `register()` throw during `apply()` and take the whole
 * plugin down. The key is therefore derived:
 *
 *   - ASCII letters/digits survive, other runs become one underscore
 *     (`github-token` → `DSH_CRED_GITHUB_TOKEN`, unchanged and readable);
 *   - a name that lost characters to that folding (or that starts with a digit,
 *     or is empty) gets a short stable hash suffix, so `阿里云 ECS 密码` and
 *     `阿里云 RDS 密码` stay distinct.
 *
 * The mapping is deterministic: the same name always yields the same key, and
 * `use` reports the exact key, so the model never has to guess it.
 * @param {string} name
 * @returns {string}
 */
export function envVarFor(name) {
  const slug = normalizeKey(name)
  const ascii = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const folded = ascii.replace(/_/g, '').length !== slug.replace(/-/g, '').length
  const needsHash = folded || ascii.length === 0 || /^[0-9]/.test(ascii)
  const base = ascii.length === 0 ? 'CRED' : /^[0-9]/.test(ascii) ? `CRED_${ascii}` : ascii
  const suffix = needsHash ? `_${createHash('sha256').update(slug).digest('hex').slice(0, 6).toUpperCase()}` : ''
  return `DSH_CRED_${base}${suffix}`
}

/**
 * The declaration set for `shellEnv.register()`: one entry per credential.
 * Only names and descriptions — the resolver supplies values per execution.
 *
 * Two credentials that would fold to the SAME variable name are never declared:
 * silently keeping the first one meant `use` handed back a variable holding a
 * different credential's value. Such keys are reported as `collisions` so the
 * caller can refuse them loudly instead.
 * @param {Array<object>} entries
 * @returns {{variables: Record<string, {description: string}>, collisions: Array<{key: string, names: string[]}>}}
 */
export function declarationsFor(entries) {
  const owners = new Map()
  for (const entry of entries) {
    const key = envVarFor(entry.name)
    const names = owners.get(key) ?? []
    names.push(entry.name)
    owners.set(key, names)
  }
  const variables = {}
  const collisions = []
  const keys = [...owners.keys()].sort()
  for (const key of keys) {
    const names = owners.get(key)
    if (names.length > 1) {
      collisions.push({ key, names })
      continue
    }
    variables[key] = { description: `Value of the "${names[0]}" credential from the credential vault.` }
  }
  return { variables, collisions }
}

/** The session id a tool execution or shell execution belongs to, or null. */
export function sessionIdOf(execution) {
  return execution?.agent?.session?.header?.id ?? null
}

/**
 * In-memory grant table: which session may read which credential right now.
 * Never persisted, so a restart silently drops every grant.
 * @param {{ttlMs?: number, now?: () => number}} [options]
 */
export function createGrantTable(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_GRANT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  /** @type {Map<string, Map<string, {secret: string, expiresAt: number}>>} */
  const bySession = new Map()

  function prune(sessionId) {
    const grants = bySession.get(sessionId)
    if (grants === undefined) return grants
    for (const [name, grant] of grants) {
      if (grant.expiresAt <= now()) grants.delete(name)
    }
    if (grants.size === 0) bySession.delete(sessionId)
    return grants
  }

  return {
    ttlMs,

    /**
     * Record that one session may use one credential until it expires.
     *
     * `options.ttlMs` caps the grant BELOW the table default (T4.vault M1):
     * a credential that declares `ttlSeconds` gets a shorter-lived grant. An
     * override LONGER than the default is clamped, so a credential can never
     * extend the deployment-wide window.
     */
    issue(sessionId, name, secret, options = {}) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('credential: "use" requires a session id')
      }
      const requested = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : ttlMs
      const expiresAt = now() + Math.min(requested, ttlMs)
      const grants = bySession.get(sessionId) ?? new Map()
      grants.set(name, { secret, expiresAt })
      bySession.set(sessionId, grants)
      return { envVar: envVarFor(name), expiresAt: new Date(expiresAt).toISOString() }
    },

    /** Every unexpired secret the session may use, keyed by credential name. */
    valuesFor(sessionId) {
      const grants = prune(sessionId)
      if (grants === undefined) return new Map()
      return new Map([...grants].map(([name, grant]) => [name, grant.secret]))
    },

    /** Drop one session's grants (used when a session ends). */
    clear(sessionId) {
      bySession.delete(sessionId)
    },
  }
}

/**
 * Bind the vault to the shell environment registry.
 *
 * `register` is `(contributor) => disposer`, i.e. `ctx.shellEnv.register`. The
 * declaration set follows the vault: `sync()` re-registers when the set of
 * credential names changes, because `shellEnv` requires every returned key to be
 * declared up front.
 *
 * @param {{
 *   store: {list: () => Array<object>},
 *   grants: ReturnType<typeof createGrantTable>,
 *   register: (contributor: object) => (() => void) | undefined,
 * }} options
 */
export function createEnvBridge({ store, grants, register }) {
  let disposer = null
  let declaredSignature = null
  let ready = false
  let collisions = []

  function resolveWith(variables) {
    return (execution) => {
      const sessionId = sessionIdOf(execution)
      if (sessionId === null) return {}
      const granted = grants.valuesFor(sessionId)
      if (granted.size === 0) return {}
      const values = {}
      for (const [name, secret] of granted) {
        const key = envVarFor(name)
        if (Object.hasOwn(variables, key)) values[key] = secret
      }
      return values
    }
  }

  return {
    get ready() {
      return ready
    },

    /** Re-register when the credential name set changed; idempotent otherwise. */
    sync() {
      if (typeof register !== 'function') return false
      const entries = store.listMeta()
      const declared = declarationsFor(entries)
      const variables = declared.variables
      collisions = declared.collisions
      const signature = Object.keys(variables).sort().join(',')
      if (signature === declaredSignature && ready) return true
      if (typeof disposer === 'function') disposer()
      let next = null
      try {
        next = register({
          name: 'credential-vault',
          variables,
          resolve: resolveWith(variables),
        }) ?? null
      } catch {
        // A rejected declaration must degrade to "the safe path is unavailable"
        // — `use` then fails loudly — instead of failing plugin load.
        ready = false
        declaredSignature = null
        disposer = null
        return false
      }
      disposer = next
      declaredSignature = signature
      ready = true
      return true
    },

    /** The currently declared variable names. */
    declared() {
      return declaredSignature === null ? [] : declaredSignature.split(',').filter(Boolean)
    },

    /** The credential names sharing one variable name, when that happens. */
    collisionFor(envVar) {
      const hit = collisions.find((entry) => entry.key === envVar)
      return hit === undefined ? null : [...hit.names]
    },

    dispose() {
      if (typeof disposer === 'function') disposer()
      disposer = null
      declaredSignature = null
      ready = false
    },
  }
}
