import type { VercelRequest, VercelResponse } from '@vercel/node'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

// Emails that always get admin access, regardless of what is in the JWT.
// Checked at request time so a change to this env var takes effect immediately
// without requiring the user to log out and back in.
function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  return list.includes(email.toLowerCase())
}

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const token = parseCookie(req.headers.cookie ?? '', 'eac_session')
  if (!token) return res.status(200).json({ user: null })

  try {
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, JWT_SECRET)
    const email   = payload.sub as string

    // Admin if the JWT says so, OR if the email is in the ADMIN_EMAILS env var.
    // The env var check means admins don't need to log out after being added.
    const admin   = (payload.isAdmin as boolean) || isAdminEmail(email)

    return res.status(200).json({
      user: {
        email,
        name:         payload.name         as string,
        avatarUrl:    payload.avatarUrl    as string,
        circleUserId: payload.circleUserId as number,
        isAdmin:      admin,
        spaceGroups:  (payload.spaceGroups as string[]) ?? [],
      },
    })
  } catch (err) {
    console.error('[me] jwtVerify error:', err)
    return res.status(200).json({ user: null })
  }
}