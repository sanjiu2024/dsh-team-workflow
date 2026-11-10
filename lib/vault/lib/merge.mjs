// Two-phase snapshot merge for vault imports (issue #51).
//
// Pure function: no IO, no reading the vault twice, no order dependence. Phase
// one validates the WHOLE incoming batch (a malformed file is rejected outright
// rather than half-applied); phase two decides every entry against a SNAPSHOT of
// the local vault, so the outcome of one entry never depends on processing order.
//
// The merge deliberately does NOT call store.set(): `set` overwrites by name,
// which would let an incoming "same name, different id" entry silently replace a
// local one — the exact hazard this merge exists to prevent.

import { KINDS, isValidName, normalizeKey, validateMeta } from './store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The decision for one incoming entry, against the local snapshot. */
function decide(entry, localById, localBySlug, mode) {
  const localSameId = localById.get(entry.id)
  if (localSameId !== undefined) {
    if (localSameId.name === entry.name) {
      // Rule 1: same credential. skip keeps the local entry; overwrite replaces
      // it — unless the local copy is NEWER, which is reported as stale/conflict
      // instead of silently regressing the user's data.
      if (mode === 'overwrite') {
        if ((localSameId.updatedAt ?? '') > (entry.updatedAt ?? '')) {
          return { action: 'conflict', reason: 'local-newer', local: localSameId }
        }
        return { action: 'overwrite', local: localSameId }
      }
      const stale = (localSameId.updatedAt ?? '') > (entry.updatedAt ?? '')
      return { action: 'skip', stale }
    }
    // Rule 2: the same id under a different name. Renaming is not supported and
    // "overwriting" would strand the local entry under its old key, so both
    // modes refuse.
    return { action: 'conflict', reason: 'same-id-different-name', local: localSameId }
  }

  // Rule 3: the id is new, but the name (or its slug) belongs to another id.
  // set() would silently overwrite that local entry, so the merge refuses in
  // both modes and leaves the decision to the user.
  const localByName = localBySlug.get(normalizeKey(entry.name))
  if (localByName !== undefined) {
    return { action: 'conflict', reason: 'name-taken', local: localByName }
  }

  return { action: 'import' }
}

/**
 * Merge a validated incoming batch into the local entries.
 * @param {{
 *   localEntries: Array<object>,
 *   incomingEntries: Array<object>,
 *   mode: 'skip'|'overwrite',
 * }} options
 * @returns {{
 *   imported: number, updated: number, skipped: number, stale: number,
 *   conflicts: Array<{incomingName: string, localName: string, reason: string}>,
 *   writes: Array<object>,   // plain entries (secret in plaintext) for the caller to seal
 * }}
 */
export function mergeImports({ localEntries, incomingEntries, mode }) {
  if (mode !== 'skip' && mode !== 'overwrite') {
    throw new Error(`merge: mode must be "skip" or "overwrite", got ${JSON.stringify(mode)}`)
  }

  // ---- phase 1: validate the whole batch before touching anything ----------
  // The full metadata check lives in `validateIncomingEntries` (exported) so the
  // CLI runs EXACTLY the same rules as the HTTP API — the CLI is agent-reachable,
  // and skipping the check there would let a crafted file inject newlines into
  // the prompt index or drop `__proto__` into the store.
  validateIncomingEntries(incomingEntries)

  const seenIds = new Set()
  const seenSlugs = new Set()
  for (const entry of incomingEntries) {
    if (typeof entry.id !== 'string' || !UUID_RE.test(entry.id)) {
      throw new Error(`merge: incoming entry "${entry.name ?? '?'}" has an invalid uuid id`)
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error('merge: incoming entry has no name')
    }
    const slug = normalizeKey(entry.name)
    if (seenIds.has(entry.id)) throw new Error(`merge: duplicate id ${entry.id} in the incoming file`)
    if (seenSlugs.has(slug)) throw new Error(`merge: duplicate slug "${slug}" in the incoming file`)
    seenIds.add(entry.id)
    seenSlugs.add(slug)
  }

  // ---- phase 2: decide against the local snapshot --------------------------
  const localById = new Map(localEntries.map((entry) => [entry.id, entry]))
  const localBySlug = new Map(localEntries.map((entry) => [normalizeKey(entry.name), entry]))

  const result = { imported: 0, updated: 0, skipped: 0, stale: 0, conflicts: [], writes: [] }

  for (const entry of incomingEntries) {
    const decision = decide(entry, localById, localBySlug, mode)
    if (decision.action === 'skip') {
      result.skipped += 1
      if (decision.stale) result.stale += 1
      continue
    }
    if (decision.action === 'conflict') {
      result.conflicts.push({
        incomingName: entry.name,
        localName: decision.local?.name ?? null,
        reason: decision.reason,
      })
      continue
    }
    result.writes.push({ ...entry })
    if (decision.action === 'overwrite') result.updated += 1
    else result.imported += 1
  }

  return result
}

/**
 * Phase-1 validation for an incoming import batch: the SAME rules the HTTP API
 * applies. Exported so the CLI (`bin/vault-sync.mjs`) and the API cannot drift —
 * the CLI is agent-reachable, and an unchecked import could land a newline in a
 * prompt-index field or a `__proto__` key in the store.
 * @param {Array<object>} entries
 * @returns {void} throws on the first invalid entry
 */
export function validateIncomingEntries(entries) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry.id !== 'string' || !UUID_RE.test(entry.id)) {
      throw new Error(`merge: incoming entry "${entry.name ?? '?'}" has an invalid uuid id`)
    }
    if (typeof entry.name !== 'string' || !isValidName(entry.name)) {
      throw new Error('merge: incoming entry name is invalid')
    }
    if (typeof entry.secret !== 'string' || entry.secret.length === 0) {
      throw new Error(`merge: entry "${entry.name}" has no secret`)
    }
    if (typeof entry.kind !== 'string' || !KINDS.includes(entry.kind)) {
      throw new Error(`merge: entry "${entry.name}" has an unknown kind`)
    }
    validateMeta({
      service: entry.service ?? null,
      aliases: entry.aliases ?? [],
      username: entry.username ?? null,
      url: entry.url ?? null,
      note: entry.note ?? null,
    })
  }
}
