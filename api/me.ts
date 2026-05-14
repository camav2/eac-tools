import type { VercelRequest, VercelResponse } from '@vercel/node'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const cookieHeader = req.headers.cookie ?? ''
  const token = parseCookie(cookieHeader, 'eac_session')

  if (!token) {
    return res.status(200).json({ user: null })
  }

  try {
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, JWT_SECRET)
    return res.status(200).json({
      user: {
        email: payload.sub,
        name: payload.name,
        avatarUrl: payload.avatarUrl,
        circleUserId: payload.circleUserId,
      },
    })
  } catch {
    return res.status(200).json({ user: null })
  }
}
