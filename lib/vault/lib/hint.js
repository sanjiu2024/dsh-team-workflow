// The model-facing prompt section for the credential vault.
//
// The text is a FUNCTION, not a string: `dsh-system-prompt` re-evaluates a
// section's `text` on every assembly, so the credential index below follows the
// vault without a restart and without a second registration.
//
// Two jobs, in this order:
//   1. tell the model what is stored (names + metadata, never values);
//   2. tell it what to do about that — check the vault BEFORE asking the user,
//      use credentials through `DSH_CRED_*` environment variables, and treat
//      `reveal` as an audited escape hatch.

export const HINT_SECTION_NAME = 'dsh-credential-vault:hint'

/** How many entries the index lists before truncating. Bounds the prompt cost. */
export const HINT_INDEX_LIMIT = 50

/**
 * Strip the last chance for prompt injection out of one metadata string.
 *
 * The store validates these on write, but a vault written by an older build (or
 * edited by hand) can still hold a newline, and this text goes into EVERY prompt
 * assembly — so the index never trusts its input: control characters become
 * spaces and the value is capped.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function flatten(value, max) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\r\n\t\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** How many aliases one index line shows before it summarises the rest. */
const INDEX_ALIAS_LIMIT = 8

/**
 * Hard cap for the metadata part of one line (the name is never truncated).
 *
 * Sized to fit the worst LEGAL metadata without dropping anything visible:
 * `(database, <64 service>; aliases: <8 × 64 aliases>)` measures 616 characters,
 * and the whole line (name of 128 + "- " prefix) reaches 747. A cap below 616
 * silently hid the last aliases (issue #56).
 */
const INDEX_DETAILS_MAX = 640

/**
 * Total character budget for the whole index.
 *
 * A per-line cap alone does not bound the prompt: 50 entries with the longest
 * legal metadata still run to tens of KB. The budget is enforced across lines and
 * whatever does not fit is reported as a count instead — the model then has to
 * `search`, which is a deliberate trade-off (issue #56), not an accident.
 */
export const HINT_INDEX_BUDGET = 8000

/**
 * One line of the credential index: names and metadata only, never a value.
 *
 * The NAME is rendered in full and never truncated: it is the identifier the
 * model has to pass to `use`, and truncating the whole line made two different
 * 128-character names render identically (issue #55). Only the metadata tail is
 * capped.
 */
function indexLine(entry) {
  const name = flatten(entry.name, 128) || '(unnamed)'
  const details = [flatten(entry.kind ?? 'other', 32) || 'other']
  const service = flatten(entry.service, 64)
  if (service.length > 0) details.push(service)
  const allAliases = Array.isArray(entry.aliases)
    ? entry.aliases.map((alias) => flatten(alias, 64)).filter((alias) => alias.length > 0)
    : []
  const aliases = allAliases.slice(0, INDEX_ALIAS_LIMIT)
  const hidden = allAliases.length - aliases.length
  const suffix = aliases.length > 0 ? `; aliases: ${aliases.join(', ')}${hidden > 0 ? ` +${hidden}` : ''}` : ''
  let tail = `(${details.join(', ')}${suffix})`
  if (tail.length > INDEX_DETAILS_MAX) tail = `${tail.slice(0, INDEX_DETAILS_MAX)}…)`
  return `- ${name} ${tail}`
}

/**
 * Render the prompt section for the current vault contents.
 * @param {Array<object>} entries - `store.list()` output
 * @returns {string}
 */
export function buildHintText(entries) {
  const list = Array.isArray(entries) ? entries : []
  const shown = list.slice(0, HINT_INDEX_LIMIT)

  let index
  if (list.length === 0) {
    index = 'The vault is empty right now — no credentials are stored.'
  } else {
    const lines = ['Stored credentials (names and metadata only):']
    let used = lines[0].length
    let rendered = 0
    for (const entry of shown) {
      const line = indexLine(entry)
      if (used + line.length + 1 > HINT_INDEX_BUDGET) break
      lines.push(line)
      used += line.length + 1
      rendered += 1
    }
    const remaining = list.length - rendered
    if (remaining > 0) {
      lines.push(`- …and ${remaining} more; call action:"search" to find the rest.`)
    }
    index = lines.join('\n')
  }

  return [
    'Credential vault (dsh-credential-vault): the user keeps passwords, tokens, API keys and database secrets in an encrypted vault you can read through the `credential` tool.',
    '',
    index,
    '',
    'Rules — follow them exactly:',
    '1. BEFORE asking the user for any password, token, API key or connection secret, check this vault: call `credential` with action:"list" or action:"search". If something matches, use it instead of asking. Never ask the user "what is it called" or "where is it stored" while the vault has a matching entry.',
    '2. A name you were given may not be the stored spelling. action:"search" matches by name, alias and service, and action:"get"/"use"/"reveal" accept any close spelling too. If a lookup reports several matches, repeat it with one of the exact names it lists — never guess.',
    '3. To USE a secret, call action:"use" with its name. The result contains no value, only an environment variable name — the exact name is the envVar field of that result, so never derive it yourself: ASCII names map to DSH_CRED_<SLUG>, and names that fold (non-ASCII or digit-leading) get a stable hash suffix so distinct credentials stay distinct. That variable is injected into every shell command you run until the grant expires; when it has expired, re-run action:"use" with the same name to get a fresh one.',
    '4. Never echo, print, or run `env`/`printenv` for a DSH_CRED_* variable, and never write its value into a file, URL, git remote, command-line argument, or message. The value must stay in the variable.',
    '5. action:"reveal" returns the plaintext itself and is written to the audit log the user reads in the panel. Use it ONLY when the user explicitly asks to see the value, and then say that the read was audited. If `use` reports that this deployment has no environment-variable injection, stop and tell the user — do not fall back to reveal on your own.',
    '6. Only the user adds or edits credentials, service ids and aliases in the panel. You read them; you never write them.',
  ].join('\n')
}

/**
 * The section definition registered with `ctx.systemPrompt.section()`.
 *
 * The index reads metadata only (never decrypts), and any failure degrades to a
 * one-line fallback: a prompt that throws would break every request in the
 * session, which is far worse than an index that says "use the tool instead".
 */
export function hintSection(store) {
  return {
    name: HINT_SECTION_NAME,
    order: 160,
    text: () => {
      try {
        return buildHintText(store.listMeta())
      } catch {
        return (
          'Credential vault (dsh-credential-vault): the credential index could not be read right now. ' +
          'Use the `credential` tool with action:"list" or action:"search" to see what is stored, and still ' +
          'check it BEFORE asking the user for any password, token or connection secret.'
        )
      }
    },
  }
}
