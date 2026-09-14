/*
 * Attending — LinkedIn connect endpoints
 *
 * GET ?action=start   → redirect the member to LinkedIn's consent screen
 * GET ?action=me      → current LinkedIn identity + photo as a data: URL
 * GET ?action=logout  → clear the LinkedIn cookie
 *
 * The OAuth callback lives in its own file (api/attending-callback.ts) so the
 * redirect URI registered in the LinkedIn app is a clean path with no query
 * string — LinkedIn matches redirect URIs exactly and query params are fragile.
 *
 * Env vars required:
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, JWT_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  LI_COOKIE, STATE_COOKIE,
  authorizeUrl, cookie, fetchPhotoDataUrl, linkedInConfigured,
  parseCookie, postingEnabled, verifyLinkedInToken,
} from './_lib/linkedin'

const SITE         = 'https://hub.expertauthor.community'
const REDIRECT_URI = SITE + '/api/attending-callback'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const action = (req.query.action as string) || 'me'

  // ── start ─────────────────────────────────────────────────────────────────
  if (action === 'start') {
    if (!linkedInConfigured()) {
      return res.redirect(302, '/attending?error=not_configured')
    }
    const state = crypto.randomUUID()
    res.setHeader('Set-Cookie', cookie(STATE_COOKIE, state, 600))
    return res.redirect(302, authorizeUrl(state, REDIRECT_URI))
  }

  // ── logout ────────────────────────────────────────────────────────────────
  if (action === 'logout') {
    res.setHeader('Set-Cookie', cookie(LI_COOKIE, '', 0))
    return res.status(200).json({ ok: true })
  }

  // ── me ────────────────────────────────────────────────────────────────────
  const token = await verifyLinkedInToken(parseCookie(req.headers.cookie ?? '', LI_COOKIE))
  if (!token) {
    return res.status(200).json({
      connected:      false,
      postingEnabled: postingEnabled(),
      configured:     linkedInConfigured(),
    })
  }

  // Fetched here rather than stored in the cookie: the bytes are far too big
  // for a 4KB cookie, and the CDN URL needs re-resolving anyway.
  const photo = await fetchPhotoDataUrl(token.picture)

  return res.status(200).json({
    connected:      true,
    name:           token.name,
    email:          token.email,
    photo:          photo?.dataUrl ?? null,
    // Diagnostics only — which rendition we got and how big it really is.
    // Lets us tell "LinkedIn gave us 100px" apart from "the canvas is wrong".
    photoSource:    photo?.source ?? null,
    photoWidth:     photo?.width  ?? null,
    photoHeight:    photo?.height ?? null,
    canPost:        token.canPost,
    postingEnabled: postingEnabled(),
    configured:     true,
  })
}
