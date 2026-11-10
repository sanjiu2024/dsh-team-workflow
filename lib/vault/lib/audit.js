// Read audit log for dsh-credential-vault: one JSON line per credential read,
// appended under the vault directory. Best-effort — a failing append never fails
// the tool call itself.
//
// A record answers "who read what, how did they find it, and did they use the
// safe path": `sessionId` attributes the read to one agent session, `resolvedBy`
// names the matching rule that produced the credential, and `action` separates
// the zero-plaintext `use` path from the audited `reveal` escape hatch.
// No record ever contains a value.

import { chmodSync, closeSync, existsSync, fchmodSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const AUDIT_FILE = 'audit.log'
export const AUDIT_MAX_LINES = 2000

/** Warn once per process when the audit file mode cannot be tightened (#103 D11). */
let modeWarned = false

/** Append one audit record. Fields never include secret material. */
export function appendAudit(dir, record) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    name: record.name ?? null,
    outcome: record.outcome ?? 'ok',
    source: record.source ?? 'tool',
    ...(typeof record.action === 'string' && record.action.length > 0 ? { action: record.action } : {}),
    ...(typeof record.sessionId === 'string' && record.sessionId.length > 0 ? { sessionId: record.sessionId } : {}),
    ...(typeof record.resolvedBy === 'string' && record.resolvedBy.length > 0
      ? { resolvedBy: record.resolvedBy }
      : {}),
    ...('reason' in record ? { reason: String(record.reason).slice(0, 200) } : {}),
    ...(Number.isFinite(record.bytes) ? { bytes: record.bytes } : {}),
    ...(typeof record.filename === 'string' && record.filename.length > 0 ? { filename: record.filename } : {}),
  }) + '\n'
  try {
    // The log names which credentials were read and when: keep it 0600 like the
    // vault itself, even when an older file was created with a wider mode.
    const file = join(dir, AUDIT_FILE)
    const fd = openSync(file, 'a', 0o600)
    try {
      try {
        fchmodSync(fd, 0o600)
      } catch {
        // fchmod on an append fd is refused on some platforms; fall back to a
        // path chmod and warn once instead of silently keeping 0644 forever
        // (observed in the field, #103 D11).
        try {
          chmodSync(file, 0o600)
        } catch (chmodError) {
          if (!modeWarned) {
            modeWarned = true
            console.warn('credential: audit log mode cannot be tightened to 0600 (' + chmodError.message + ')')
          }
        }
      }
      writeFileSync(fd, line, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    /* diagnostics only */
  }
}

/** Read the last `limit` audit records, newest first. */
export function readAudit(dir, limit = 100) {
  const file = join(dir, AUDIT_FILE)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
  const capped = typeof limit === 'number' && limit > 0 ? limit : 100
  return lines
    .slice(-capped)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { at: null, name: null, outcome: 'corrupt', source: null }
      }
    })
}

/**
 * Trim the audit file to the most recent AUDIT_MAX_LINES lines, keeping every
 * reveal record. Called after an append; failure is silent.
 */
export function trimAudit(dir) {
  try {
    const file = join(dir, AUDIT_FILE)
    if (!existsSync(file)) return
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
    if (lines.length <= AUDIT_MAX_LINES) return
    // T4.vault M6: reveal records are the audited plaintext escape hatch — the
    // whole point of writing them is that the user can later answer "who saw
    // the value". Dropping them when the log rolls over would defeat that, so
    // a trim keeps EVERY reveal line and fills the remaining budget with the
    // most recent ordinary lines (chronological order preserved).
    // Decorate-sort-undecorate: parse each line ONCE (a comparator that re-parses
    // costs ~2·n·log n JSON.parse calls on every trim, and the API trims after
    // every request once the log is past the cap).
    const decorated = lines.map((line) => {
      let keep = false
      let time = Infinity
      try {
        const record = JSON.parse(line)
        keep = record?.action === 'reveal'
        time = Date.parse(record?.at ?? null)
        if (Number.isNaN(time)) time = Infinity
      } catch {
        // A corrupt line has no audit value worth protecting either way.
      }
      return { line, keep, time }
    })
    const protectedLines = decorated.filter((d) => d.keep)
    const ordinary = decorated.filter((d) => !d.keep)
    const budget = Math.max(0, AUDIT_MAX_LINES - protectedLines.length)
    const kept = [...protectedLines, ...ordinary.slice(-budget)]
      .sort((a, b) => a.time === b.time ? 0 : a.time < b.time ? -1 : 1)
      .map((d) => d.line)
    // Rewrite through a 0600 temp file + rename: an in-place writeFileSync used
    // to leave a truncated audit log behind on a crash, and silently kept the
    // legacy 0644 mode of an older file (#103 D2/D11).
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, kept.join('\n') + '\n', 'utf8')
      fchmodSync(fd, 0o600)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch {
    /* diagnostics only */
  }
}
