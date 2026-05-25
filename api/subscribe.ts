/*
 * Subscribe API — Brevo contact upsert via shared helper
 * Used by the gate form on book-canvas and any standalone opt-in.
 * Routes to the correct list based on the `tool` field (defaults to book-canvas).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { addContactToList, BREVO_LISTS } from './_lib/brevo'

const ALLOWED_ORIGINS = ['https://tools.expertauthor.community']

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // 1. Origin check — block direct API hits from outside the site
  const origin = (req.headers['origin'] ?? req.headers['referer'] ?? '') as string
  if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const { email, name, tool, website } = req.body

  // 2. Honeypot — bots fill hidden fields, humans don't
  if (website) {
    return res.status(200).json({ ok: true })
  }

  // 3. Email validation
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email required' })
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
