/*
 * Gmail OAuth 2.0 flow for mail-merge tool
 *
 * GET /api/mail-merge-auth                   → initiate OAuth (redirect to Google)
 * GET /api/mail-merge-auth?action=status     → { connected, gmailEmail }
 * GET /api/mail-merge-auth?action=disconnect → delete stored tokens
 * GET /api/mail-merge-auth?code=&state=      → OAuth callback from Google
 *
 * Admin-only — requires eac_session JWT with isAdmin: true
 * (except the callback which uses the signed state parameter)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { getAuthUrl, decodeState, exchangeCode, storeTokens, getConnectedEmail, disconnectGmail } from './_lib/gmail'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const { code, state, action } = req.query as Record<string, string>

  // ── OAuth callback from Google ─────────────────────────────────────────────
  // No JWT required here — we trust the signed state parameter
  if (code && state) {
    try {
      const adminEmail = decodeState(state)
      if (!adminEmail || !adminEmail.includes('@')) throw new Error('Invalid state')

      const { refreshToken, gmailEmail } = await exchangeCode(code)
      await storeTokens(adminEmail, refreshToken, gmailEmail)
      console.log(`[mail-merge-auth] Connected ${gmailEmail} for ${adminEmail}`)
      return res.redirect(302, '/mail-merge?connected=1')
    } catch (err) {
      console.error('[mail-merge-auth] callback error:', err)
      return res.redirect(302, '/mail-merge?error=oauth_failed')
    }
  }

  // ── All other actions require admin JWT ────────────────────────────────────
  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  if (action === 'status') {
    const gmailEmail = await getConnectedEmail(session.email)
    return res.json({ connected: !!gmailEmail, gmailEmail: gmailEmail ?? null })
  }

  if (action === 'disconnect') {
    await disconnectGmail(session.email)
    console.log(`[mail-merge-auth] Disconnected Gmail for ${session.email}`)
    return res.json({ ok: true })
  }

  // ── Initiate OAuth (default) ───────────────────────────────────────────────
  const authUrl = getAuthUrl(session.email)
  return res.redirect(302, authUrl)
}
