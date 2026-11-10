// Small HTTP helpers shared by the API handler and the host plugin.
// The API routes bypass the /api authorization layer, so every state-changing
// request is checked against the request origin here.

/** Upper bound for a request body in bytes. */
export const MAX_BODY_BYTES = 128 * 1024

/** Write a JSON response with no-store caching. */
export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * Reject state-changing requests that did not come from this same host.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean} true when the request must be refused.
 */
export function isForbiddenOrigin(req) {
  const headers = req.headers || {}

  const fetchSite = headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') return true

  const origin = headers.origin
  if (origin === undefined) return false
  if (typeof origin !== 'string' || origin.length === 0) return true

  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }

  const host = headers.host
  return typeof host !== 'string' || host.length === 0 || originHost !== host
}

/**
 * Read and parse a JSON body, enforcing the byte cap while streaming.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      const error = new Error('payload-too-large')
      error.code = 'payload-too-large'
      throw error
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Shorten a string for a log line or an error message. */
export function truncate(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}
