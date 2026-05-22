import type { VercelRequest, VercelResponse } from '@vercel/node'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : null
}

export interface Session {
  email: string
  circleUserId: number
  name: string
  avatarUrl: string
  spaceGroups: string[]
  isAdmin: boolean
}

// Groups that gate access to EAC tools
export const ALL_TOOLS   = ['connect', 'write-now'] as const
export const COWRITING   = ['connect']               as const

export async function getSession(req: VercelRequest): Promise<Session | null> {
  const token = parseCookie(req.headers.cookie ?? '', 'eac_session')
  if (!token) return null
  try {
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, JWT_SECRET)
    return {
      email:        payload.sub          as string,
      circleUserId: payload.circleUserId as number,
      name:         payload.name         as string,
      avatarUrl:    payload.avatarUrl    as string,
      spaceGroups:  (payload.spaceGroups as string[]) ?? [],
      isAdmin:      (payload.isAdmin     as boolean)  ?? false,
    }
  } catch {
    return null
  }
}

// Backward-compat helper used in routes that only need the email
export async function getSessionEmail(req: VercelRequest): Promise<string | null> {
  return (await getSession(req))?.email ?? null
}

export function hasAccess(session: Session, requiredGroups: readonly string[]): boolean {
  if (session.isAdmin) return true
  return requiredGroups.some(g => session.spaceGroups.includes(g))
}

// Call at the top of an API route handler.
// Returns the session if authorised, or writes a 401/403 and returns null.
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse,
  requiredGroups?: readonly string[]
): Promise<Session | null> {
  const session = await getSession(req)
  if (!session) {
    res.status(401).json({ error: 'Unauthorised' })
    return null
  }
  if (requiredGroups && !hasAccess(session, requiredGroups)) {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  return session
}
