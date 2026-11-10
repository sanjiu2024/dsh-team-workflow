// Password-encrypted export envelope for dsh-credential-vault (issue #51).
//
// The exported `.dsvault` file is the ONLY sanctioned way credential data leaves
// the vault, and it is protected by a user passphrase, not by master.key: the
// file must be safe to carry on a USB stick or a private git remote, where the
// master key is not.
//
// Design decisions (spec §4.1, fixed by adversarial review):
//   - scrypt with LARGE built-in parameters (N=2^17) so offline guessing is slow;
//   - the KDF parameters in the envelope are compared against these built-ins
//     EXACTLY. A forged envelope claiming N=2^30 must not become a 128 GiB
//     allocation request, so anything but the constants is rejected up front;
//   - AES-256-GCM with the envelope HEADER as additional authenticated data, so
//     rewriting `exportedAt` or bumping `version` fails authentication instead of
//     enabling rollback/downgrade games;
//   - one error for wrong passphrase, tampering and non-canonical parameters:
//     callers cannot use the error to distinguish "wrong password" from "altered
//     file", which removes the oracle. The local CLI may log details to stderr.
//
// The passphrase never touches disk and is never part of any log line.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export const ENVELOPE_FORMAT = 'dsh-credential-vault-export'
export const ENVELOPE_VERSION = 1

/** The ONE legal scrypt parameter set. Compared exactly, never scaled. */
export const ENVELOPE_KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1 })

/** Minimum passphrase length. Shorter is refused before any KDF work. */
export const MIN_PASSPHRASE_LENGTH = 12

/** Error thrown for every authentication/shape failure of an envelope. */
export class EnvelopeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EnvelopeError'
    this.code = 'bad-passphrase-or-tampered'
  }
}

/** NFC-normalise and validate a passphrase; throws EnvelopeError on bad input. */
function normalizePassphrase(passphrase) {
  const text = typeof passphrase === 'string' ? passphrase.normalize('NFC') : ''
  if (text.length < MIN_PASSPHRASE_LENGTH) {
    throw new EnvelopeError(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`)
  }
  return text
}

/** The authenticated header (format, version, kdf params, exportedAt). salt/iv/cipher.name are bound via the derived key and the canonical check; they need no separate AAD. */
function headerOf(envelope) {
  const { format, version, exportedAt, kdf } = envelope
  return [
    format,
    String(version),
    kdf.name,
    String(kdf.N),
    String(kdf.r),
    String(kdf.p),
    exportedAt,
  ].join('|')
}

/** Canonical KDF check — the guard against forged-allocation DoS. */
function assertCanonicalKdf(kdf) {
  if (
    !kdf || kdf.name !== ENVELOPE_KDF.name ||
    kdf.N !== ENVELOPE_KDF.N || kdf.r !== ENVELOPE_KDF.r || kdf.p !== ENVELOPE_KDF.p ||
    typeof kdf.salt !== 'string' || kdf.salt.length === 0
  ) {
    throw new EnvelopeError('envelope kdf parameters are not canonical')
  }
}

/** Derive the envelope key. `maxmem` covers N=2^17,r=8 (128 MiB) plus headroom. */
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, {
    N: ENVELOPE_KDF.N, r: ENVELOPE_KDF.r, p: ENVELOPE_KDF.p,
    maxmem: 192 * 1024 * 1024,
  })
}

/**
 * Encrypt `payload` under `passphrase` into a `.dsvault` envelope object.
 * @param {string} passphrase
 * @param {object} payload - plain JSON object (the export payload)
 * @param {{now?: () => Date}} [options]
 * @returns {object} envelope
 */
export function sealEnvelope(passphrase, payload, options = {}) {
  const normalized = normalizePassphrase(passphrase)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const exportedAt = (typeof options.now === 'function' ? options.now() : new Date()).toISOString()

  const envelope = {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    exportedAt,
    kdf: { ...ENVELOPE_KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: '' },
    payload: '',
  }

  const key = deriveKey(normalized, envelope.kdf.salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(headerOf(envelope), 'utf8'))
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])

  envelope.cipher.tag = cipher.getAuthTag().toString('base64')
  envelope.payload = body.toString('base64')
  return envelope
}

/**
 * Decrypt a `.dsvault` envelope object with `passphrase`.
 * @param {string} passphrase
 * @param {object} envelope
 * @returns {object} the plain payload
 */
export function openEnvelope(passphrase, envelope) {
  const normalized = normalizePassphrase(passphrase)
  if (!envelope || typeof envelope !== 'object') throw new EnvelopeError('envelope is not an object')
  if (envelope.format !== ENVELOPE_FORMAT || envelope.version !== ENVELOPE_VERSION) {
    throw new EnvelopeError('unknown envelope format or version')
  }
  assertCanonicalKdf(envelope.kdf)
  if (!envelope.cipher || envelope.cipher.name !== 'aes-256-gcm') {
    throw new EnvelopeError('unknown cipher')
  }

  const key = deriveKey(normalized, envelope.kdf.salt)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'base64'))
  decipher.setAAD(Buffer.from(headerOf(envelope), 'utf8'))
  decipher.setAuthTag(Buffer.from(envelope.cipher.tag, 'base64'))
  let plaintext
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.payload, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // Wrong passphrase, tampered payload, tampered header or forged KDF params
    // all land here. One error, no oracle.
    throw new EnvelopeError('decryption failed')
  }
  return JSON.parse(plaintext)
}
