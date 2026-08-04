/*
 * Opaque intake tokens for the Author Editorial Q&A public page.
 *
 * Deliberately NOT a JWT: the intake link has no account behind it, carries no
 * claims, and must be revocable by clearing one Airtable field. A random
 * server-side-stored string is the right primitive — 24 bytes = 192 bits of
 * entropy, unguessable and safe in a URL.
 */

import { randomBytes, timingSafeEqual } from 'crypto'

export function generateIntakeToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Constant-time token comparison. With 192-bit tokens a timing attack is
 * largely theoretical, but the comparison is cheap and the tokens gate
 * unpublished author content.
 */
export function tokensMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
