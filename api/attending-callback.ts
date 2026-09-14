/*
 * Attending — LinkedIn OAuth callback
 *
 * Registered as the redirect URI in the LinkedIn developer app:
 *   https://hub.expertauthor.community/api/attending-callback
 *
 * Exchanges the code, reads the OIDC identity, and stores both in a signed,
 * httpOnly, 2-hour cookie. Always redirects back to /attending — never renders.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  LI_COOKIE, STATE_COOKIE,
  cookie, exchangeCode, getUserInfo, parseCookie, postingEnabled, signLinkedInToken,
} from './_lib/linkedin'

const SITE         = 'https://hub.expertauthor.community'
const REDIRECT_URI = SITE + '/api/attending-callback'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const { code, state, error } = req.query as Record<string, string | undefined>

  // Member hit "Cancel" on LinkedIn's consent screen.
  if (error) {
    console.log('[attending] oauth declined:', error)
    return res.redirect(302, '/attending?error=declined')
  }

  // CSRF: the state we set before the redirect must come back unchanged.
  const expected = parseCookie(req.headers.cookie ?? '', STATE_COOKIE)
  if (!code || !state || !expected || state !== expected) {
    console.error('[attending] state mismatch or missing code')
    return res.redirect(302, '/attending?error=state')
  }

  try {
    const accessToken = await exchangeCode(code, REDIRECT_URI)
    const user        = await getUserInfo(accessToken)

    const jwt = await signLinkedInToken({ ...user, accessToken, canPost: postingEnabled() })

    res.setHeader('Set-Cookie', [
      cookie(LI_COOKIE, jwt, 2 * 60 * 60),
      cookie(STATE_COOKIE, '', 0),
    ])
    console.log('[attending] connected:', user.email || user.sub)
    return res.redirect(302, '/attending?connected=1')
  } catch (err) {
    console.error('[attending] callback failed:', err)
    return res.redirect(302, '/attending?error=auth')
  }
}
