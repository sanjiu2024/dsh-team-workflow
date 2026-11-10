// Name resolution for every credential action except `list`.
//
// A user does not know what a "correct" credential name looks like — they will
// write `github token`, `gh`, or `github`, not whatever the panel happens to
// store. So a lookup is a five-step cascade that short-circuits at the first
// rule with any hit, and NEVER guesses when more than one credential matches:
//
//   1. exact  — the stored name, verbatim
//   2. slug   — the stored name folded by normalizeKey (case/space/punctuation)
//   3. alias  — any user-maintained alias folded the same way
//   4. service— the credential's service id (github, mysql, …)
//   5. keyword— every query word appears somewhere in the searchable text
//
// There is deliberately no edit distance or scoring: a hit must be explainable
// and reproducible, because the caller is about to hand a real secret to a
// program and every miss is an audit line.

import { normalizeKey } from './store.js'

/** Fields a keyword query may match against, in a fixed order. */
function searchableText(entry) {
  return [
    entry.name,
    entry.slug,
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    entry.service,
    entry.url,
    entry.note,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => normalizeKey(value))
    .join(' ')
}

/** Split a query into the words keyword matching requires, folded by normalizeKey. */
function queryWords(query) {
  return normalizeKey(query).split('-').filter((word) => word.length > 0)
}

/** Strip the fields a candidate list may expose: never secret or preview. */
function publicFields(entry) {
  const { preview, hasSecret, ...rest } = entry
  void preview
  void hasSecret
  return rest
}

/**
 * Find every entry matching `query` at the strongest rule that matches at all.
 *
 * The caller distinguishes "one hit" from "several hits"; this function returns
 * the full hit list so that decision is visible at the call site.
 *
 * @param {Array<object>} entries - `store.list()` output
 * @param {string} query
 * @returns {{ resolvedBy: string, matches: Array<object> }} resolvedBy is '' when nothing matched
 */
function matchByRule(entries, query) {
  const raw = typeof query === 'string' ? query.trim() : ''
  if (raw.length === 0) return { resolvedBy: '', matches: [] }
  const key = normalizeKey(raw)

  const byExact = entries.filter((entry) => entry.name === raw)
  if (byExact.length > 0) return { resolvedBy: 'exact', matches: byExact }

  if (key.length > 0) {
    const bySlug = entries.filter((entry) => normalizeKey(entry.slug ?? entry.name) === key)
    if (bySlug.length > 0) return { resolvedBy: 'slug', matches: bySlug }

    const byAlias = entries.filter((entry) =>
      (Array.isArray(entry.aliases) ? entry.aliases : []).some((alias) => normalizeKey(alias) === key),
    )
    if (byAlias.length > 0) return { resolvedBy: 'alias', matches: byAlias }

    const byService = entries.filter((entry) => entry.service !== null && entry.service !== undefined && normalizeKey(entry.service) === key)
    if (byService.length > 0) return { resolvedBy: 'service', matches: byService }
  }

  const words = queryWords(raw)
  if (words.length > 0) {
    const byKeyword = entries.filter((entry) => {
      const text = searchableText(entry)
      return words.every((word) => text.includes(word))
    })
    if (byKeyword.length > 0) return { resolvedBy: 'keyword', matches: byKeyword }
  }

  return { resolvedBy: '', matches: [] }
}

/**
 * Resolve one query to exactly one credential, or explain why it cannot.
 * @param {Array<object>} entries
 * @param {string} query
 * @returns {{status:'resolved',name:string,resolvedBy:string}
 *   | {status:'ambiguous',candidates:Array<object>,matches:Array<object>}
 *   | {status:'missing',candidates:Array<object>}}
 */
export function resolveName(entries, query) {
  const { resolvedBy, matches } = matchByRule(entries, query)
  if (matches.length === 0) return { status: 'missing', candidates: [] }
  if (matches.length > 1) {
    return { status: 'ambiguous', candidates: matches.map(publicFields), matches: matches.map(publicFields) }
  }
  return { status: 'resolved', name: matches[0].name, resolvedBy }
}

/**
 * Every entry matching a query, for the `search` action. A single hit is
 * reported with `resolvedBy`; several hits keep the full list and a
 * `candidates` view, so the caller can show them without choosing.
 * @param {Array<object>} entries
 * @param {string} query
 * @returns {Array<object>}
 */
export function searchEntries(entries, query) {
  return matchByRule(entries, query).matches
}

/** The rule that produced the current match set, for auditing. */
export function matchedBy(entries, query) {
  return matchByRule(entries, query).resolvedBy || null
}

export { publicFields }
