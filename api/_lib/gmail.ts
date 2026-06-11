/**
 * Gmail OAuth 2.0 helpers + send
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID      — OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET  — OAuth 2.0 client secret
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase secret (service role) key
 *
 * Tokens are stored in the gmail_tokens table:
 *   admin_email (PK), refresh_token, gmail_email
 */

const REDIRECT_URI = 'https://hub.expertauthor.community/api/mail-merge-auth'
const SCOPE = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

// ── OAuth URL ────────────────────────────────────────────────────────────────

export function getAuthUrl(adminEmail: string): string {
  const state = Buffer.from(adminEmail).toString('base64url')
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID!,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export function decodeState(state: string): string {
  return Buffer.from(state, 'base64url').toString('utf8')
}

// ── Token exchange / refresh ─────────────────────────────────────────────────

async function googleTokenPost(extra: Record<string, string>): Promise<Record<string, string>> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...extra,
    }),
  })
  if (!res.ok) throw new Error(`Google token error: ${await res.text()}`)
  return res.json()
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; gmailEmail: string; displayName: string }> {
  const data = await googleTokenPost({ code, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
  if (!data.refresh_token) throw new Error('No refresh token — ensure prompt=consent was set')

  const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then(r => r.json())

  const gmailEmail  = info.email as string
  const displayName = (info.name as string) || ''

  // Write the name into Gmail's "Send mail as" settings — this is what Gmail
  // actually uses as the sender display name, not the From header in raw messages.
  if (displayName) {
    try {
      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(gmailEmail)}`,
        {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${data.access_token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ displayName }),
        }
      )
      console.log(`[gmail] sendAs display name set to "${displayName}" for ${gmailEmail}`)
    } catch (e) {
      console.warn('[gmail] sendAs update failed (non-fatal):', e)
    }
  }

  return { refreshToken: data.refresh_token, gmailEmail, displayName }
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const data = await googleTokenPost({ refresh_token: refreshToken, grant_type: 'refresh_token' })
  return data.access_token
}

// ── Supabase REST (gmail_tokens table) ──────────────────────────────────────

function sbUrl(path: string) {
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
  return `${base}/rest/v1/${path}`
}

function sbHeaders() {
  return {
    'apikey':        process.env.SUPABASE_SERVICE_KEY!,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=minimal',
  }
}

export async function storeTokens(adminEmail: string, refreshToken: string, gmailEmail: string, displayName?: string): Promise<void> {
  const res = await fetch(sbUrl('gmail_tokens'), {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      admin_email:   adminEmail,
      refresh_token: refreshToken,
      gmail_email:   gmailEmail,
      display_name:  displayName || null,
      updated_at:    new Date().toISOString(),
    }),
  })
  if (!res.ok) throw new Error(`Supabase store error: ${await res.text()}`)
}

export async function getConnectedEmail(adminEmail: string): Promise<string | null> {
  const res = await fetch(
    sbUrl(`gmail_tokens?admin_email=eq.${encodeURIComponent(adminEmail)}&select=gmail_email`),
    { headers: sbHeaders() },
  )
  if (!res.ok) return null
  const rows = await res.json() as { gmail_email: string }[]
  return rows[0]?.gmail_email ?? null
}

export async function disconnectGmail(adminEmail: string): Promise<void> {
  await fetch(
    sbUrl(`gmail_tokens?admin_email=eq.${encodeURIComponent(adminEmail)}`),
    { method: 'DELETE', headers: sbHeaders() },
  )
}

// ── Send ─────────────────────────────────────────────────────────────────────

function rfc2822Addr(name: string | undefined, email: string): string {
  if (!name?.trim()) return email
  const safe = name.replace(/"/g, '\\"')
  return `"${safe}" <${email}>`
}

export async function sendViaGmail(
  adminEmail: string,
  to: string,
  subject: string,
  body: string,
  replyTo?: string,
  toName?: string,
): Promise<void> {
  const tokenRes = await fetch(
    sbUrl(`gmail_tokens?admin_email=eq.${encodeURIComponent(adminEmail)}&select=refresh_token,gmail_email,display_name`),
    { headers: sbHeaders() },
  )
  const rows = tokenRes.ok ? await tokenRes.json() as { refresh_token: string; gmail_email: string; display_name: string | null }[] : []
  const row = rows[0]
  const refreshToken = row?.refresh_token  ?? null
  const fromEmail    = row?.gmail_email    ?? null
  const fromName     = row?.display_name   ?? undefined
  if (!refreshToken || !fromEmail) throw new Error('No Gmail connected for ' + adminEmail)

  const accessToken = await getAccessToken(refreshToken)

  // Fetch display name from Google account (live, so it always reflects current Google settings)
  let resolvedName = fromName
  try {
    const userInfo = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then(r => r.json())
    if (userInfo?.name) resolvedName = userInfo.name as string
  } catch { /* use stored display_name as fallback */ }

  // RFC 2822 message
  const date = new Date().toUTCString().replace(/GMT$/, '+0000')
  const msgHeaders = [
    `From: ${rfc2822Addr(resolvedName, fromEmail)}`,
    `To: ${rfc2822Addr(toName, to)}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    '',
    body,
  ]
  const raw = msgHeaders.join('\r\n')

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
  })

  if (!sendRes.ok) throw new Error(`Gmail send to ${to} failed: ${await sendRes.text()}`)
}
