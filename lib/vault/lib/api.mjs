// HTTP API behind the sidebar panel. One prefix route:
//   GET  /credential-vault/api/list           -> { ok, entries } (masked)
//   GET  /credential-vault/api/entry?name=x   -> one masked entry
//   GET  /credential-vault/api/audit          -> recent audit records
//   POST /credential-vault/api/set            -> { name, kind, secret, username?, url?, note? }
//   POST /credential-vault/api/delete         -> { name }
//   POST /credential-vault/api/rotate         -> rotate the master key
//
// NO route returns secret material: `set` takes it, nothing sends it back.
// Every POST checks the request origin (routes registered with
// `ctx.webServer.register` bypass the /api authorization layer).

import { MAX_BODY_BYTES, isForbiddenOrigin, readJsonBody, sendJson } from './http.mjs'
import { appendAudit, readAudit, trimAudit } from './audit.js'
import { KINDS, VAULT_VERSION, validateMeta, isValidName, normalizeKey } from './store.js'
import { sealEnvelope, openEnvelope, EnvelopeError } from './envelope.mjs'
import { mergeImports } from './merge.mjs'

/** Body cap for the import route alone: envelope JSON for a large vault. */
export const IMPORT_MAX_BODY_BYTES = 8 * 1024 * 1024 + 64 * 1024
/** Business cap on the decrypted-import content string. */
const MAX_IMPORT_CONTENT_BYTES = 8 * 1024 * 1024

/** Fixed text for an unexpected store failure; never the raw error message. */
const STORE_FAILED_MESSAGE = 'the credential store rejected the request'

/** GET /entry?name=… — one masked entry, never the secret itself. */
export function entryPayload(store, queryName) {
  const name = typeof queryName === 'string' ? queryName.trim() : ''
  if (name.length === 0) throw new ApiError(400, 'invalid-name', 'name is required')
  let found
  try {
    found = store.get(name)
  } catch (error) {
    // An unsafe-name entry is kept on disk but refused by the store (issue #52).
    // The panel needs to OPEN this entry to rename or delete it, so the error
    // must be a structured response — a 500 here would make the entry invisible
    // and un-deletable, locking the promised escape hatch.
    if (/unsafe name/.test(error.message)) {
      throw new ApiError(409, 'unsafe-name', error.message)
    }
    throw error
  }
  if (found === null) throw new ApiError(404, 'not-found', `no credential named ${JSON.stringify(name)}`)
  return { ok: true, entry: found }
}

export const API_BASE = '/credential-vault/api'
export { MAX_BODY_BYTES }

class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** `POST /export`: build an encrypted envelope of the whole vault. */
function exportPayload(store, dir, body) {
  const passphrase = body?.passphrase
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
    appendAudit(dir, { name: null, outcome: 'rejected', source: 'api', action: 'export', reason: 'invalid passphrase length' })
    throw new ApiError(400, 'invalid-passphrase', 'passphrase must be 12-1024 characters')
  }
  const { entries, corrupt } = store.exportEntries()
  const envelope = sealEnvelope(passphrase, { sourceVaultVersion: VAULT_VERSION, entries, corruptCount: corrupt })
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const host = (typeof process !== 'undefined' && process.env && process.env.HOSTNAME) || 'vault'
  const filename = `${host}-${stamp}.dsvault`
  const content = JSON.stringify(envelope)
  // T4.vault D5: the export is the one bulk-plaintext path — the audit record
  // carries what was produced (filename + byte size) so it is attributable even
  // though the request itself stays unauthenticated (known limitation, unchanged).
  appendAudit(dir, {
    name: null, outcome: 'ok', source: 'api', action: 'export',
    sessionId: null, resolvedBy: null,
    reason: `${entries.length} entries, ${corrupt} corrupt`,
    filename,
    bytes: Buffer.byteLength(content),
  })
  return {
    ok: true,
    corrupt,
    filename,
    content,
  }
}

/** `POST /import`: decrypt, validate the whole batch, then merge in one write. */
function importPayload(store, dir, body) {
  const passphrase = body?.passphrase
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
    appendAudit(dir, { name: null, outcome: 'rejected', source: 'api', action: 'import', reason: 'invalid passphrase length' })
    throw new ApiError(400, 'invalid-passphrase', 'passphrase must be 12-1024 characters')
  }
  const content = typeof body?.content === 'string' ? body.content : ''
  if (content.length === 0) throw new ApiError(400, 'invalid-content', 'content is required')
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_CONTENT_BYTES) {
    throw new ApiError(413, 'content-too-large', 'content exceeds 8 MiB')
  }
  const mode = body?.mode === 'overwrite' ? 'overwrite' : 'skip'

  let payload
  try {
    const parsed = JSON.parse(content)
    payload = openEnvelope(passphrase, parsed)
  } catch (error) {
    // JSON 损坏与解密失败都可能是"文件被改"——统一错误码避免 oracle（spec §4.1）。
    // 纯粹的 JSON 语法错误仍单独报，帮助用户发现"复制时少了尾巴"。
    const isJsonSyntax = error instanceof SyntaxError
    appendAudit(dir, {
      name: null, outcome: 'rejected', source: 'api', action: 'import',
      reason: isJsonSyntax ? 'invalid-json' : 'bad-passphrase-or-tampered',
    })
    if (isJsonSyntax) throw new ApiError(400, 'invalid-json', 'content is not valid JSON')
    throw new ApiError(400, 'bad-passphrase-or-tampered', 'cannot decrypt this file')
  }
  if (!payload || !Array.isArray(payload.entries)) {
    throw new ApiError(400, 'bad-passphrase-or-tampered', 'cannot decrypt this file')
  }

  // Phase 1: the whole batch must pass the same validation the store applies.
  const localMeta = store.listMeta()
  const localBySlug = new Map(localMeta.map((entry) => [normalizeKey(entry.name), entry]))
  const seenIds = new Set()
  const seenSlugs = new Set()
  for (const entry of payload.entries) {
    if (typeof entry.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.id)) {
      throw new ApiError(400, 'invalid-metadata', `entry "${entry.name ?? '?'}" has an invalid uuid id`)
    }
    if (typeof entry.name !== 'string' || !isValidName(entry.name)) {
      throw new ApiError(400, 'invalid-metadata', `entry name is invalid`)
    }
    if (typeof entry.secret !== 'string' || entry.secret.length === 0) {
      throw new ApiError(400, 'invalid-metadata', `entry "${entry.name}" has no secret`)
    }
    if (typeof entry.kind !== 'string' || !KINDS.includes(entry.kind)) {
      throw new ApiError(400, 'invalid-metadata', `entry "${entry.name}" has an unknown kind`)
    }
    // T4.vault M1: an imported TTL must obey the same rule the panel enforces.
    if (entry.ttlSeconds !== undefined && entry.ttlSeconds !== null && (!Number.isInteger(entry.ttlSeconds) || entry.ttlSeconds <= 0)) {
      throw new ApiError(400, 'invalid-metadata', `entry "${entry.name}" has an invalid ttlSeconds`)
    }
    try {
      validateMeta({
        service: entry.service ?? null,
        aliases: entry.aliases ?? [],
        username: entry.username ?? null,
        url: entry.url ?? null,
        note: entry.note ?? null,
      })
    } catch (error) {
      throw new ApiError(400, 'invalid-metadata', `entry "${entry.name}": ${error.message}`)
    }
    const slug = normalizeKey(entry.name)
    if (seenIds.has(entry.id)) throw new ApiError(400, 'invalid-metadata', `duplicate id ${entry.id} in the import file`)
    if (seenSlugs.has(slug)) throw new ApiError(400, 'invalid-metadata', `duplicate slug "${slug}" in the import file`)
    seenIds.add(entry.id)
    seenSlugs.add(slug)
  }

  // Phase 2: snapshot merge.
  const localEntries = localMeta.map((entry) => ({
    id: entry.id,
    name: entry.name,
    updatedAt: entry.updatedAt,
  }))
  const merged = mergeImports({ localEntries, incomingEntries: payload.entries, mode })
  if (merged.writes.length > 0) store.applyImport(merged.writes)
  appendAudit(dir, {
    name: null, outcome: 'ok', source: 'api', action: 'import',
    sessionId: null, resolvedBy: null,
    reason: `${merged.imported} imported, ${merged.updated} updated, ${merged.skipped} skipped, ${merged.conflicts.length} conflicts`,
  })
  return {
    ok: true,
    imported: merged.imported,
    updated: merged.updated,
    skipped: merged.skipped,
    stale: merged.stale,
    corrupt: payload.corruptCount ?? 0,
    conflicts: merged.conflicts,
  }
}

/**
 * Build the request handler for the plugin's prefix route.
 * @param {{ store: object, maxBodyBytes?: number }} service
 */
export function createApiHandler(service) {
  const { store, dir } = service
  const maxBodyBytes = Number.isFinite(service.maxBodyBytes) ? service.maxBodyBytes : MAX_BODY_BYTES

  const routes = {
    [`${API_BASE}/list`]: { methods: ['GET'], run: () => ({ ok: true, entries: store.list() }) },
    [`${API_BASE}/audit`]: { methods: ['GET'], run: () => ({ ok: true, records: readAudit(store.dir, 100) }) },
    [`${API_BASE}/entry`]: {
      methods: ['GET'],
      run: ({ req }) => entryPayload(store, new URL(req?.url ?? '/', 'http://127.0.0.1').searchParams.get('name')),
    },
    [`${API_BASE}/set`]: {
      methods: ['POST'],
      run: ({ body }) => {
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name.length === 0) throw new ApiError(400, 'invalid-name', 'name is required')
        const secret = typeof body?.secret === 'string' ? body.secret : ''
        if (secret.length > 64 * 1024) throw new ApiError(413, 'secret-too-large', 'secret exceeds 64 KiB')
        const kind = typeof body?.kind === 'string' && KINDS.includes(body.kind) ? body.kind : 'other'
        // Same rules the store applies: `service` and `aliases` reach the system
        // prompt verbatim, so a newline or an oversized value must be refused here
        // too — with a 400 the panel can explain, not a store-level 500.
        // Only forward metadata the request actually mentioned: a keep-secret edit
        // sends `{name, kind, secret:''}` and must not blank the stored fields
        // (issue #57). An explicitly empty value still clears, because the key IS
        // present and validateMeta turns '' into null.
        const has = (key) => Object.hasOwn(body ?? {}, key)
        // Credential-level TTL (T4.vault M1): forwarded only when the request
        // mentions it, so a keep-secret edit that omits the field cannot clear it.
        let ttl
        if (has('ttlSeconds')) {
          ttl = body.ttlSeconds
          if (ttl !== null && (!Number.isInteger(ttl) || ttl <= 0)) {
            throw new ApiError(400, 'invalid-ttl', 'ttlSeconds must be a positive integer or null')
          }
        }
        let meta
        try {
          meta = validateMeta({
            service: has('service') ? body.service : undefined,
            aliases: has('aliases') ? body.aliases : undefined,
            username: has('username') ? body.username : undefined,
            url: has('url') ? body.url : undefined,
            note: has('note') ? body.note : undefined,
          })
        } catch (error) {
          throw new ApiError(400, 'invalid-metadata', error.message)
        }
        // The panel sends "other" for an unknown kind; anything the enum does not
        // know must be refused rather than silently downgraded.
        if (typeof body?.kind === 'string' && body.kind.length > 0 && !KINDS.includes(body.kind)) {
          throw new ApiError(400, 'invalid-kind', `kind must be one of ${KINDS.join(', ')}`)
        }
        try {
          // An empty secret means "keep the stored one" — but only for an entry
          // that already exists. Creating a credential out of nothing is refused,
          // and so is "editing" a name nobody created.
          if (secret.length === 0) {
            const updated = store.update(name, { kind, ...meta, ...(has('ttlSeconds') ? { ttlSeconds: ttl } : {}) })
            if (!updated) throw new ApiError(400, 'invalid-secret', 'secret is required')
            return { ok: true, name, updated: true, keptSecret: true }
          }
          return { ok: true, ...store.set(name, { kind, secret, ...meta, ...(has('ttlSeconds') ? { ttlSeconds: ttl } : {}) }) }
        } catch (error) {
          if (error instanceof ApiError) throw error
          // Never forward `error.message`: it is free-form and a future throw
          // could interpolate secret material straight onto the wire.
          throw new ApiError(400, 'store-failed', STORE_FAILED_MESSAGE)
        }
      },
    },
    [`${API_BASE}/delete`]: {
      methods: ['POST'],
      run: ({ body }) => {
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (name.length === 0) throw new ApiError(400, 'invalid-name', 'name is required')
        return { ok: true, deleted: store.delete(name) }
      },
    },
    [`${API_BASE}/rotate`]: {
      methods: ['POST'],
      run: () => ({ ok: true, resealed: store.rotateKey() }),
    },
    [`${API_BASE}/export`]: {
      methods: ['POST'],
      run: ({ body }) => exportPayload(store, dir, body),
    },
    [`${API_BASE}/import`]: {
      methods: ['POST'],
      bodyLimit: IMPORT_MAX_BODY_BYTES,
      run: ({ body }) => importPayload(store, dir, body),
    },
  }

  return async function handler(req, res) {
    let pathname = '/'
    try {
      pathname = new URL(req?.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
      const method = String(req?.method ?? 'GET').toUpperCase()
      const route = routes[pathname]

      if (!route) {
        sendJson(res, 404, { ok: false, error: 'not-found' })
        return
      }
      if (!route.methods.includes(method)) {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: route.methods.join(', ') })
        return
      }
      if (method !== 'GET' && isForbiddenOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden-origin' })
        return
      }

      let body = {}
      if (method === 'POST') {
        try {
          body = await readJsonBody(req, route.bodyLimit ?? maxBodyBytes)
        } catch (error) {
          if (error?.code === 'payload-too-large') {
            sendJson(res, 413, { ok: false, error: 'payload-too-large' })
            return
          }
          sendJson(res, 400, { ok: false, error: 'invalid-json' })
          return
        }
      }

      const payload = await route.run({ body, req })
      trimAudit(store.dir)
      sendJson(res, 200, payload)
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { ok: false, error: error.code, message: error.message })
        return
      }
      // The catch-all must not echo `error.message` either: this branch fires on
      // errors nobody anticipated, which is exactly when the text may carry
      // arbitrary data (including a secret). The detail goes to the log only.
      console.error('[credential-vault] unhandled route failure', pathname, error)
      sendJson(res, 500, { ok: false, error: 'internal-error', path: pathname })
    }
  }
}
