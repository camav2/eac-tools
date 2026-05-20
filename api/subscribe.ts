/*
 * Subscribe API — Brevo contact upsert via shared helper
 * Used by the gate form on book-canvas and any standalone opt-in.
 * Routes to the correct list based on the `tool` field (defaults to book-canvas).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { addContactToList, BREVO_LISTS } from './_lib/brevo'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email, name, tool } = req.body

  if (!email) {
    return res.status(400).json({ error: 'Email required' })
  }

  const resolvedTool = (tool && tool in BREVO_LISTS)
    ? tool as keyof typeof BREVO_LISTS
    : 'book-canvas'

  await addContactToList({
    email,
    firstName: name || '',
    tool:      resolvedTool,
  })

  return res.status(200).json({ ok: true })
}
