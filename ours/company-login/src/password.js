/**
 * Password hashing for the one company account: scrypt with a random salt,
 * stored as `scrypt:N:r:p:<salt b64url>:<hash b64url>`. The separator is not
 * `$`, so the value survives an unquoted line in a shell env file. Only the
 * hash is ever configured; nothing here logs or returns the password.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const N = 32768
const R = 8
const P = 1
const KEY_BYTES = 32
const SALT_BYTES = 16
/** Upper bounds accepted from a stored hash, so a mistyped value cannot ask for unbounded memory. */
const MAX_N = 1 << 20
const MAX_R = 16
const MAX_P = 4

function derive(password, salt, n, r, p, length) {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, length, { N: n, r, p, maxmem: 256 * n * r }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

/** Hash a password with a fresh salt. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('password must be at least 8 characters')
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, N, R, P, KEY_BYTES)
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join(':')
}

/** Parse a stored hash; throws with a message that never includes the value. */
export function parseHash(stored) {
  const parts = typeof stored === 'string' ? stored.trim().split(':') : []
  const [scheme, n, r, p, salt, key] = parts
  const numbers = [n, r, p].map(Number)
  if (parts.length !== 6 || scheme !== 'scrypt' || numbers.some(v => !Number.isSafeInteger(v) || v < 1)
    || numbers[0] > MAX_N || (numbers[0] & (numbers[0] - 1)) !== 0 || numbers[1] > MAX_R || numbers[2] > MAX_P) {
    throw new Error('password hash is not in the scrypt:N:r:p:salt:hash format written by bin/hash-password.mjs')
  }
  const saltBytes = Buffer.from(salt, 'base64url')
  const keyBytes = Buffer.from(key, 'base64url')
  if (saltBytes.byteLength < 8 || keyBytes.byteLength < 16) throw new Error('password hash has a truncated salt or key')
  return { n: numbers[0], r: numbers[1], p: numbers[2], salt: saltBytes, key: keyBytes }
}

/** Compare a password with a parsed hash in time independent of where they differ. */
export async function verifyPassword(password, parsed) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return false
  const key = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.key.byteLength)
  return timingSafeEqual(key, parsed.key)
}

/** Compare two short strings without an early exit on the first differing byte. */
export function sameText(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  const length = Math.max(x.byteLength, y.byteLength, 1)
  const px = Buffer.alloc(length)
  const py = Buffer.alloc(length)
  x.copy(px)
  y.copy(py)
  return timingSafeEqual(px, py) && x.byteLength === y.byteLength
}
