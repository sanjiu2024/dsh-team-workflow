// Vault store facade: one object binding a directory to a loaded master key.
// Both the HTTP API and the `credential` tool use this; only `reveal` returns
// plaintext, and only the tool path calls it.

import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, fchmodSync, closeSync } from 'node:fs'
import {
  KINDS,
  VAULT_VERSION,
  isDangerousKey,
  isValidName,
  loadOrCreateMasterKey,
  maskSecret,
  masterKeyPath,
  normalizeAliases,
  normalizeKey,
  openSecret,
  readVault,
  sealSecret,
  validateMeta,
  slugOf,
  assertVaultUnchanged,
  vaultFilePath,
  vaultFingerprint,
  writeVault,
} from './store.js'

const MASTER_KEY_BYTES = 32

/** Write a file with mode 0600 via an exclusive fd. */
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
 * Create a store over `dir`. The master key is loaded once; `rotateKey`
 * replaces it in place.
 */
export function createVaultStore(dir) {
  mkdirSync(dir, { recursive: true })
  let key = loadOrCreateMasterKey(dir).key
  // D4 recovery (#103): rotate stages the re-sealed vault as vault.json.new and
  // then swaps key + vault with two adjacent renames. A crash between them
  // leaves new key + old vault, which fails to unseal; the staged file is the
  // real state, so adopt it once, here, before any store method runs.
  try {
    const probe = readVault(dir)
    const canary = Object.values(probe.entries).find((value) => typeof value.secret === 'string' && value.secret.length > 0)
    if (canary !== undefined) {
      try {
        openSecret(key, canary.secret)
      } catch {
        // Only adopt the staged file when it actually decrypts with the loaded
        // key: a blind overwrite would turn ANY unseal failure (a corrupted
        // entry, a broken key) into a wholesale vault replacement (#103 B2).
        let stagedVerified = false
        const staged = `${vaultFilePath(dir)}.new`
        if (existsSync(staged)) {
          try {
            // The staged file was written sealed with the NEW key; verify by
            // re-reading the canary from it through the same store machinery.
            const stagedEntries = JSON.parse(readFileSync(staged, 'utf8')).entries ?? {}
            const stagedCanary = Object.values(stagedEntries).find((value) => typeof value.secret === 'string' && value.secret.length > 0)
            if (stagedCanary === undefined) throw new Error('staged vault has no verifiable entry')
            openSecret(key, stagedCanary.secret)
            stagedVerified = true
          } catch (verifyError) {
            throw new Error('credential: rotate recovery rejected the staged vault (' + verifyError.message + '); keeping the on-disk state untouched')
          }
          if (stagedVerified) {
            renameSync(staged, vaultFilePath(dir))
          }
        }
      }
    }
  } catch {
    // A vault that cannot even be parsed is not this recovery's business; the
    // per-entry corrupt handling below keeps the store usable either way.
  }

  function entry(name) {
    const vault = readVault(dir)
    // Defence-in-depth only: `readVault` returns prototype-free entries and
    // KEEPS dangerous keys (issue #52 — they are user data), so an own key can
    // be a real entry. This guard exists for a future change that makes
    // `entries` a plain object again.
    if (!Object.hasOwn(vault.entries, name)) return null
    const found = vault.entries[name]
    return found === undefined ? null : { name, ...found }
  }

  /**
   * Refuse to READ a credential whose name is an `Object.prototype` key.
   *
   * Such an entry can only exist because 0.3.0 allowed creating it. It is kept on
   * disk (issue #52 — deleting it silently would destroy user data), but handing
   * its secret to a caller is exactly the "phantom credential" hazard the name
   * guard exists to prevent, so reading fails loudly and names the way out.
   */
  function assertSafeRead(name) {
    if (!isDangerousKey(name)) return
    throw new Error(
      `credential "${name}" has an unsafe name (an Object.prototype property); ` +
        'rename or delete it in the panel before using it',
    )
  }

  /**
   * Reject a write whose name folds to the same slug as a DIFFERENT existing
   * credential. `github token` and `github-token` would otherwise both exist and
   * silently shadow each other in alias/slug lookups, so the store refuses the
   * second one and names the occupant to the caller.
   */
  function assertNoSlugCollision(vault, name) {
    const slug = slugOf(name)
    for (const existing of Object.keys(vault.entries)) {
      if (existing === name) continue
      if (slugOf(existing) === slug) {
        throw new Error(
          `credential name "${name}" collides with the existing credential "${existing}" ` +
            `(both normalize to "${slug}"); rename one of them`,
        )
      }
    }
  }

  /**
   * Validate the optional credential-level TTL (T4.vault M1).
   *
   * `undefined` (field absent) and `null` (explicitly clear) are both legal and
   * mean "no credential TTL": the grant then uses the default window. Anything
   * else must be a positive integer of seconds — a TTL of 0 would make every
   * `use` grant expire instantly, and a fractional/string value is a caller bug.
   * @param {unknown} value
   * @returns {number | null}
   */
  function validateTtlSeconds(value) {
    if (value === undefined || value === null) return null
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('credential: ttlSeconds must be a positive integer number of seconds or null')
    }
    return value
  }

  return {
    dir,

    /**
     * List entries with a masked preview, without ever returning secret material.
     *
     * One damaged entry (a rotated-away key, a half-written rotate) must not take
     * the whole panel down: its preview degrades to null and it is flagged
     * `corrupt`, while every healthy entry keeps its preview.
     */
    list() {
      const vault = readVault(dir)
      return Object.entries(vault.entries)
        .map(([name, value]) => {
          const hasSecret = typeof value.secret === 'string' && value.secret.length > 0
          let preview = null
          let corrupt = false
          if (hasSecret) {
            try {
              preview = maskSecret(openSecret(key, value.secret))
            } catch {
              corrupt = true
            }
          }
          const unsafeName = isDangerousKey(name)
          return {
            name,
            slug: slugOf(name),
            id: value.id ?? null,
            unsafeName,
            kind: value.kind ?? 'other',
            service: value.service ?? null,
            aliases: normalizeAliases(value.aliases),
            hasSecret,
            preview,
            corrupt,
            username: value.username ?? null,
            url: value.url ?? null,
            note: value.note ?? null,
            ttlSeconds: value.ttlSeconds ?? null,
            createdAt: value.createdAt ?? null,
            updatedAt: value.updatedAt ?? null,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    /**
     * List entries using METADATA ONLY — never decrypts a single value.
     *
     * Callers that do not display a preview (the prompt index, name resolution)
     * must use this: `list()` decrypts every entry to build its preview, so one
     * damaged entry used to break prompt assembly and every lookup in the store.
     */
    listMeta() {
      const vault = readVault(dir)
      return Object.entries(vault.entries)
        .map(([name, value]) => ({
          name,
          slug: slugOf(name),
          id: value.id ?? null,
          unsafeName: isDangerousKey(name),
          kind: value.kind ?? 'other',
          service: value.service ?? null,
          aliases: normalizeAliases(value.aliases),
          hasSecret: typeof value.secret === 'string' && value.secret.length > 0,
          username: value.username ?? null,
          url: value.url ?? null,
          note: value.note ?? null,
          ttlSeconds: value.ttlSeconds ?? null,
          createdAt: value.createdAt ?? null,
          updatedAt: value.updatedAt ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    /**
     * Existence check WITHOUT the unsafe-name read guard: the tool layer needs to
     * tell "a legacy entry with a dangerous name" apart from "a typo", because the
     * former must reach the store's read guard (and its audit trail) while the
     * latter is rejected up front.
     */
    has(name) {
      const vault = readVault(dir)
      return Object.hasOwn(vault.entries, name)
    },

    /** One masked entry or null. */
    get(name) {
      assertSafeRead(name)
      const found = entry(name)
      if (found === null) return null
      const { secret, ...rest } = found
      return {
        ...rest,
        slug: slugOf(name),
        kind: rest.kind ?? 'other',
        service: rest.service ?? null,
        aliases: normalizeAliases(rest.aliases),
        ttlSeconds: rest.ttlSeconds ?? null,
        hasSecret: typeof secret === 'string' && secret.length > 0,
        preview: secret ? maskSecret(openSecret(key, secret)) : null,
      }
    },

    /** Create or overwrite one credential. */
    set(name, { kind = 'other', secret, username = null, url = null, note = null, service = null, aliases = [], ttlSeconds } = {}) {
      if (!isValidName(name)) throw new Error('invalid credential name')
      if (!KINDS.includes(kind)) throw new Error('invalid kind, expected one of ' + KINDS.join(', '))
      if (typeof secret !== 'string' || secret.length === 0) throw new Error('secret must be a non-empty string')
      const ttl = validateTtlSeconds(ttlSeconds)
      const rawMeta = validateMeta({ service, username, url, note, aliases })
      // `set` creates the whole entry, so "not provided" simply means null here.
      const meta = {
        service: rawMeta.service ?? null,
        aliases: rawMeta.aliases ?? [],
        username: rawMeta.username ?? null,
        url: rawMeta.url ?? null,
        note: rawMeta.note ?? null,
      }
      const stamp = vaultFingerprint(dir)
      const vault = readVault(dir)
      assertNoSlugCollision(vault, name)
      vault.version = VAULT_VERSION
      const now = new Date().toISOString()
      const previous = vault.entries[name]
      vault.entries[name] = {
        id: previous?.id ?? randomUUID(),
        kind,
        secret: sealSecret(key, secret),
        username: meta.username,
        url: meta.url,
        note: meta.note,
        service: meta.service,
        aliases: meta.aliases,
        ttlSeconds: ttl,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      assertVaultUnchanged(dir, stamp)
      writeVault(dir, vault)
      return { name, updated: previous !== undefined }
    },

    /**
     * Update the metadata of an EXISTING credential without touching its secret.
     *
     * Editing a stored credential usually means changing where it is used, not
     * rotating it. The panel's editor submits an empty secret for exactly that
     * case, so this is the path that keeps the sealed value intact. Returns
     * false when the name is unknown — the caller decides what that means; it
     * must never silently create a secret-less entry.
     */
    update(name, { kind, username, url, note, service, aliases, ttlSeconds } = {}) {
      if (!isValidName(name)) throw new Error('invalid credential name')
      const stamp = vaultFingerprint(dir)
      const vault = readVault(dir)
      const previous = vault.entries[name]
      if (previous === undefined) return false
      const nextKind = kind === undefined ? (previous.kind ?? 'other') : kind
      if (!KINDS.includes(nextKind)) throw new Error('invalid kind, expected one of ' + KINDS.join(', '))

      // Validate only the fields the caller actually supplied; a partial update
      // must not blank the untouched ones.
      const meta = validateMeta({
        service: service === undefined ? undefined : service,
        username: username === undefined ? undefined : username,
        url: url === undefined ? undefined : url,
        note: note === undefined ? undefined : note,
        aliases: aliases === undefined ? undefined : aliases,
      })

      vault.version = VAULT_VERSION
      vault.entries[name] = {
        ...previous,
        kind: nextKind,
        username: username === undefined ? (previous.username ?? null) : meta.username,
        url: url === undefined ? (previous.url ?? null) : meta.url,
        note: note === undefined ? (previous.note ?? null) : meta.note,
        service: service === undefined ? (previous.service ?? null) : meta.service,
        aliases: aliases === undefined ? normalizeAliases(previous.aliases) : meta.aliases,
        ttlSeconds: ttlSeconds === undefined ? (previous.ttlSeconds ?? null) : validateTtlSeconds(ttlSeconds),
        updatedAt: new Date().toISOString(),
      }
      assertVaultUnchanged(dir, stamp)
      writeVault(dir, vault)
      return true
    },

    /** Delete one credential; returns whether it existed. */
    delete(name) {
      const stamp = vaultFingerprint(dir)
      const vault = readVault(dir)
      if (vault.entries[name] === undefined) return false
      delete vault.entries[name]
      assertVaultUnchanged(dir, stamp)
      writeVault(dir, vault)
      return true
    },

    /**
     * Batch export: the ONLY bulk path that produces plaintext. Returns full
     * entries (all metadata + secrets) for the export file; a damaged entry is
     * skipped and counted rather than failing the whole export (spec §4.0).
     */
    exportEntries() {
      const stamp = vaultFingerprint(dir)
      const vault = readVault(dir)
      const entries = []
      let corrupt = 0
      let migrated = false
      for (const [name, value] of Object.entries(vault.entries)) {
        let secret
        try {
          secret = openSecret(key, value.secret)
        } catch {
          corrupt += 1
          continue
        }
        // Spec §3.1: a pre-v3 entry has no id. Forge a real UUID NOW and persist
        // it to the local vault — a derived id (name+createdAt) could be forged
        // by a third party, so derived ids must never enter an export file. The
        // write is the documented one-time migration cost of the first export.
        let id = value.id
        if (typeof id !== 'string' || id.length === 0) {
          id = randomUUID()
          value.id = id
          migrated = true
        }
        entries.push({
          id,
          name,
          kind: value.kind ?? 'other',
          service: value.service ?? null,
          aliases: normalizeAliases(value.aliases),
          username: value.username ?? null,
          url: value.url ?? null,
          note: value.note ?? null,
          // T4.vault M1: TTL metadata must ride the export file, or a vault
          // moved between hosts silently widens every grant window.
          ttlSeconds: value.ttlSeconds ?? null,
          createdAt: value.createdAt ?? null,
          updatedAt: value.updatedAt ?? null,
          secret,
        })
      }
      if (migrated) {
        assertVaultUnchanged(dir, stamp)
        writeVault(dir, vault)
      }
      return { entries, corrupt }
    },

    /**
     * Atomically apply a merged import batch: seal every entry with THIS vault's
     * key, back up the current file once, then a single writeVault.
     */
    applyImport(writes) {
      const stamp = vaultFingerprint(dir)
      const vault = readVault(dir)
      // Spec §6.3: back up the CURRENT file before the batch lands, so an
      // interrupted or regretted import can be rolled back by hand. A brand-new
      // vault has no vault.json yet — nothing to roll back, so no backup either.
      if (existsSync(vaultFilePath(dir))) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bakPath = `${vaultFilePath(dir)}.bak-${stamp}`
        copyFileSync(vaultFilePath(dir), bakPath)
        chmodSync(bakPath, 0o600)
      }
      const now = new Date().toISOString()
      for (const entry of writes) {
        vault.entries[entry.name] = {
          id: entry.id,
          kind: entry.kind ?? 'other',
          secret: sealSecret(key, entry.secret),
          username: entry.username ?? null,
          url: entry.url ?? null,
          note: entry.note ?? null,
          service: entry.service ?? null,
          aliases: normalizeAliases(entry.aliases),
          // T4.vault M1: TTL metadata must survive the export→import roundtrip,
          // or a vault moved between hosts silently widens every grant window.
          ttlSeconds: entry.ttlSeconds ?? null,
          createdAt: entry.createdAt ?? now,
          updatedAt: entry.updatedAt ?? now,
        }
      }
      vault.version = VAULT_VERSION
      assertVaultUnchanged(dir, stamp)
      writeVault(dir, vault)
    },

    /**
     * The only path that produces plaintext for a SINGLE credential. The
     * `credential` tool calls this; the HTTP API must not.
     */
    reveal(name) {
      assertSafeRead(name)
      const found = entry(name)
      if (found === null) return null
      return {
        name,
        id: found.id ?? null,
        kind: found.kind ?? 'other',
        username: found.username ?? null,
        url: found.url ?? null,
        note: found.note ?? null,
        ttlSeconds: found.ttlSeconds ?? null,
        secret: openSecret(key, found.secret),
      }
    },

    /** Rotate the master key: re-seal every entry, replace master.key. */
    rotateKey() {
      const stamp = vaultFingerprint(dir)
      const vault = readVault(dir)
      const fresh = randomBytes(MASTER_KEY_BYTES)
      // Re-seal with the NEW key (decrypting with the old one), then stage the
      // re-sealed vault as vault.json.new BEFORE the key swap (#103 D4): the
      // key rename and the vault rename become two adjacent operations, and a
      // crash between them leaves new key + old vault + staged .new, which the
      // load-time recovery adopts. The optimistic guard rules out a concurrent
      // writer between the read and the stage.
      for (const [name, value] of Object.entries(vault.entries)) {
        if (typeof value.secret === 'string') vault.entries[name].secret = sealSecret(fresh, openSecret(key, value.secret))
      }
      writePrivateFileSync(`${vaultFilePath(dir)}.new`, JSON.stringify(vault, null, 2) + '\n')
      copyFileSync(masterKeyPath(dir), `${masterKeyPath(dir)}.bak`)
      writePrivateFileSync(`${masterKeyPath(dir)}.new`, fresh)
      renameSync(`${masterKeyPath(dir)}.new`, masterKeyPath(dir))
      assertVaultUnchanged(dir, stamp)
      renameSync(`${vaultFilePath(dir)}.new`, vaultFilePath(dir))
      key = fresh
      return Object.keys(vault.entries).length
    },
  }
}
