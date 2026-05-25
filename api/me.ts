import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  const session = await getSession(req)
  if (!session) return res.status(200).json({ user: null })
  return res.status(200).json({
    user: {
      email:        session.email,
      name:         session.name,
      avatarUrl:    session.avatarUrl,
      circleUserId: session.circleUserId,
      spaceGroups:  session.spaceGroups,
      isAdmin:      session.isAdmin,
    },
  })
}
