// Encrypted credential store for dsh-credential-vault.
//
// Layout under `$DSH_HOME/credential-vault/`:
//   master.key  — 32 random bytes, created on first use, mode 0600
//   vault.json  — { version, entries: { [name]: { kind, secret, username?, url?, note?, createdAt, updatedAt } } }
//                 `secret` is base64(nonce ‖ AES-256-GCM ciphertext+tag), key = master.key
//   audit.log   — one JSON line per read, written by audit.js
//
// Plaintext exists only inside the process: the HTTP API never returns secret
// material to the panel (it returns `hasSecret` + a masked preview), and the
// `credential` tool returns the secret only to the session that asked for it.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fchmodSync, closeSync } from 'node:fs'
import { join } from 'node:path'

export const VAULT_VERSION = 3
export const KINDS = ['password', 'token', 'api-key', 'ssh-key', 'database', 'other']
const MASTER_KEY_BYTES = 32

/**
 * Fold one credential key (a name, alias or service) into a comparable form:
 * lower-cased, with every run of non-alphanumeric characters collapsed to a
 * single `-` and the ends trimmed. Non-ASCII letters survive, so a Chinese name
 * stays usable; only punctuation and whitespace are folded.
 *
 * This is the single normalizer for slugs, aliases and search queries, so
 * `github token`, `github-token` and `GitHub_Token` all compare equal.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The canonical identifier derived from a credential's display name. Deliberately
 * NOT stored: the name is the single source of truth, and the slug is recomputed
 * on every read so it can never drift from it.
 * @param {string} name
 * @returns {string}
 */
export function slugOf(name) {
  return normalizeKey(name)
}

/**
 * Field limits for the metadata that reaches the system prompt.
 *
 * `service` and `aliases` are interpolated verbatim into every prompt assembly,
 * so a newline there could start a new instruction line. They are therefore
 * single-line and short. `note` is exempt from the newline rule (it is prose for
 * humans and never enters the SYSTEM PROMPT; it does appear in tool results and
 * participates in keyword matching) but still length-capped.
 */
export const META_LIMITS = {
  service: 64,
  aliasLength: 64,
  aliasCount: 16,
  username: 128,
  url: 512,
  note: 512,
}

// Characters that must never appear in a single-line metadata field:
//   - C0/DEL and NEL (U+0085), LINE SEPARATOR (U+2028), PARAGRAPH SEPARATOR
//     (U+2029) are line breaks in JavaScript and in most Markdown renderers;
//   - the Unicode "format" category (Cf) covers zero-width spaces (U+200B),
//     BOM (U+FEFF) and bidi overrides (U+202E), which can disguise or reorder
//     the text a reader sees without changing its length.
export const CONTROL_CHARS = /[\r\n\u0000-\u001f\u007f\u0085\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/

/** A single-line string within `max` characters, or null when empty. */
function checkSingleLine(field, value, max) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`invalid ${field}: must be a string`)
  // Check the RAW value first: `trim()` would remove a trailing newline and let
  // it through as if it never existed (issue #53). Surrounding spaces are still
  // trimmed below, because that is normalisation, not smuggling.
  if (CONTROL_CHARS.test(value)) throw new Error(`invalid ${field}: must not contain line breaks or control characters`)
  const text = value.trim()
  if (text.length === 0) return null
  if (text.length > max) throw new Error(`invalid ${field}: longer than ${max} characters`)
  return text
}

/**
 * Validate and normalize the optional metadata of one credential.
 *
 * Throws instead of silently truncating: a user who typed too much must learn
 * that nothing was stored, not discover a shortened value later.
 * @param {{service?: unknown, aliases?: unknown, username?: unknown, url?: unknown, note?: unknown}} meta
 * @returns {{service: string|null, aliases: string[], username: string|null, url: string|null, note: string|null}}
 */
export function validateMeta(meta = {}) {
  // `undefined` means "the caller did not mention this field" and is passed
  // through as `undefined` so a partial update can keep the stored value.
  // `null` or `''` means "clear it" and normalises to `null` (issue #57).
  const service = meta.service === undefined ? undefined : checkSingleLine('service', meta.service, META_LIMITS.service)
  const username = meta.username === undefined ? undefined : checkSingleLine('username', meta.username, META_LIMITS.username)
  const url = meta.url === undefined ? undefined : checkSingleLine('url', meta.url, META_LIMITS.url)

  let note = null
  if (meta.note !== undefined && meta.note !== null) {
    if (typeof meta.note !== 'string') throw new Error('invalid note: must be a string')
    const trimmed = meta.note.trim()
    if (trimmed.length > META_LIMITS.note) throw new Error(`invalid note: longer than ${META_LIMITS.note} characters`)
    note = trimmed.length > 0 ? trimmed : null
  }
  if (meta.note === undefined) note = undefined

  // Validate the RAW list before normalizing: normalizeAliases() drops non-strings,
  // blanks and duplicates, which would silently swallow input (and let 20 copies of
  // one alias slip past the count limit).
  const rawAliases = meta.aliases
  if (rawAliases !== undefined && rawAliases !== null && !Array.isArray(rawAliases)) {
    throw new Error('invalid aliases: must be an array of strings')
  }
  const list = Array.isArray(rawAliases) ? rawAliases : []
  if (list.length > META_LIMITS.aliasCount) {
    throw new Error(`invalid aliases: at most ${META_LIMITS.aliasCount} entries`)
  }
  for (const alias of list) {
    if (typeof alias !== 'string') throw new Error('invalid aliases: must be an array of strings')
    // Blank entries are normalisation, not silently-dropped data: the panel adds
    // trailing commas, and `normalizeAliases` trims them away.
    if (alias.trim().length === 0) continue
    if (CONTROL_CHARS.test(alias)) throw new Error('invalid aliases: must not contain line breaks or control characters')
    if (alias.length > META_LIMITS.aliasLength) {
      throw new Error(`invalid aliases: each alias must be at most ${META_LIMITS.aliasLength} characters`)
    }
  }
  const aliases = normalizeAliases(list)

  return { service, aliases: meta.aliases === undefined ? undefined : aliases, username, url, note }
}

/**
 * Normalize a user-maintained alias list: keep only non-empty strings, trim
 * them, and drop entries that fold to the same key (first spelling wins).
 * @param {unknown} aliases
 * @returns {string[]}
 */
export function normalizeAliases(aliases) {
  if (!Array.isArray(aliases)) return []
  const seen = new Set()
  const result = []
  for (const raw of aliases) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (value.length === 0) continue
    const key = normalizeKey(value)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/** Master key file path. */
export function masterKeyPath(dir) {
  return join(dir, 'master.key')
}

export function vaultFilePath(dir) {
  return join(dir, 'vault.json')
}

/**
 * Names that are `Object.prototype` own properties cannot be used as vault keys.
 *
 * In 0.3.0 `entries` was a plain object, so `__proto__` wrote the prototype
 * instead of an entry (the credential silently vanished while `entries` started
 * answering for a name that was never stored), and `toString` made every lookup
 * walk the prototype chain and return a phantom credential. `entries` is now
 * prototype-free, but the name guard stays as the first line of defence — it is
 * what stops such an entry from being written or read back in the first place.
 *
 * The deny-list is preferred over a charset whitelist because a whitelist would
 * reject legitimate names like `阿里云 ECS 密码`. Note it is dynamic: a plugin
 * that adds a property to `Object.prototype` would make that name unusable, which
 * is acceptable for a defence-in-depth check but is why it is not the only guard.
 * @param {string} name
 * @returns {boolean}
 */
export function isDangerousKey(name) {
  return name === '__proto__' || Object.hasOwn(Object.prototype, name)
}

/** Validate a credential name: non-empty, printable, no separators, not a prototype key. */
export function isValidName(name) {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 128 &&
    !/[/\\]/.test(name) &&
    // Reuse the one control-character definition instead of keeping a second,
    // narrower regex here — that divergence is exactly how U+2028 slipped
    // through the name check while metadata already rejected it (issue #54).
    !CONTROL_CHARS.test(name) &&
    !isDangerousKey(name)
  )
}

/** Write a file with mode 0600 via an exclusive fd (chmod before close). */
function writePrivateFileSync(path, data) {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, data)
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}

/**
 * Load or create the master key. The key file is 0600.
 * @returns {{ key: Buffer, created: boolean }}
 */
export function loadOrCreateMasterKey(dir) {
  mkdirSync(dir, { recursive: true })
  const keyPath = masterKeyPath(dir)
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath)
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(`master key at ${keyPath} is ${key.length} bytes, expected ${MASTER_KEY_BYTES}`)
    }
    return { key, created: false }
  }
  const key = randomBytes(MASTER_KEY_BYTES)
  writePrivateFileSync(keyPath, key)
  return { key, created: true }
}

/** Encrypt one UTF-8 secret under the master key. Returns base64(nonce ‖ ct‖tag). */
export function sealSecret(key, plaintext) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const sealed = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([nonce, sealed]).toString('base64')
}

/** Reverse of `sealSecret`; throws when the ciphertext was tampered with. */
export function openSecret(key, sealedBase64) {
  const raw = Buffer.from(String(sealedBase64), 'base64')
  if (raw.length < 12 + 16) throw new Error('sealed secret is truncated')
  const nonce = raw.subarray(0, 12)
  const body = raw.subarray(12, raw.length - 16)
  const tag = raw.subarray(raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** Empty in-memory vault shape. */
export function emptyVault() {
  return { version: VAULT_VERSION, entries: Object.create(null) }
}

/**
 * Copy one parsed `entries` object into a prototype-free map.
 *
 * JSON.parse already stores `__proto__` as an own property (so parsing alone
 * cannot pollute), but every downstream `entries[name]` lookup would still
 * consult the prototype chain. A null-prototype object makes an unknown name a
 * plain `undefined` instead of a phantom hit.
 * @param {Record<string, unknown>} parsed
 * @returns {Record<string, unknown>}
 */
function adoptEntries(parsed) {
  const entries = Object.create(null)
  for (const key of Object.keys(parsed)) {
    // KEEP even a dangerous key (issue #52): 0.3.0 allowed these names to be
    // created, so such an entry can be real user data. Dropping it here made the
    // next unrelated write erase it from disk for good. It is carried through
    // untouched and flagged by the read paths instead; only an explicit
    // `delete()` removes it. `entries` has no prototype, so an own key is inert.
    entries[key] = parsed[key]
  }
  return entries
}

/** Read and parse vault.json; a missing file is an empty vault. */
export function readVault(dir) {
  const file = vaultFilePath(dir)
  if (!existsSync(file)) return emptyVault()
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new Error(`vault file at ${file} has no entries object`)
  }
  const version = typeof parsed.version === 'number' ? parsed.version : VAULT_VERSION
  // A FUTURE version may carry fields this build does not understand (like the
  // stable ids added in v3). Reading it and writing it back would silently strip
  // those fields, so refuse instead of degrading (issue #51).
  if (version > VAULT_VERSION) {
    throw new Error(`unsupported-vault-version: vault at ${file} is version ${version}, this build understands up to ${VAULT_VERSION}`)
  }
  return { version, entries: adoptEntries(parsed.entries) }
}

/** SHA-256 of the vault file bytes, or null when it does not exist yet (#103 D1). */
export function vaultFingerprint(dir) {
  const file = vaultFilePath(dir)
  if (!existsSync(file)) return null
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Throw when the vault file changed since \`stamp\` — the optimistic guard for
 * every read-mutate-write sequence (#103 D1). All mutations here are
 * synchronous, so this defends against a second host process sharing the
 * directory, not against in-process interleave. */
export function assertVaultUnchanged(dir, stamp) {
  if (vaultFingerprint(dir) !== stamp) {
    throw new Error('credential: vault changed on disk during the mutation; retry the operation')
  }
}

/** Write vault.json atomically (temp file + rename) with 0600 permissions. */
export function writeVault(dir, vault) {
  mkdirSync(dir, { recursive: true })
  const file = vaultFilePath(dir)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writePrivateFileSync(tmp, JSON.stringify(vault, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (error) {
    // The temp file is never a valid vault.json; leaving it behind would make
    // the directory look corrupted to a human scanning for what went wrong.
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean */
    }
    throw error
  }
}

/**
 * Masked preview safe to show in the panel: first 4 and last 2 characters for
 * long secrets, `***` otherwise. Never returns more than 8 characters.
 */
export function maskSecret(plaintext) {
  const text = String(plaintext ?? '')
  if (text.length <= 8) return '***'
  return `${text.slice(0, 4)}…${text.slice(-2)}`
}

/** Verify a plaintext guess against a stored sealed secret in constant time. */
export function verifySecret(key, sealedBase64, guess) {
  const current = openSecret(key, sealedBase64)
  const a = createHash('sha256').update(current).digest()
  const b = createHash('sha256').update(String(guess ?? '')).digest()
  return timingSafeEqual(a, b)
}
