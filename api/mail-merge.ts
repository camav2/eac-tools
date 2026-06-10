/*
 * Mail merge API
 *
 * GET  /api/mail-merge?action=groups                     → list Circle access groups
 * GET  /api/mail-merge?action=members&accessGroupId={n}  → list members in group
 * POST /api/mail-merge                                   → send merge emails
 *   { accessGroupId, subject, body, testOnly? }
 *
 * Admin-only. Emails are sent plain-text via the admin's connected Gmail account.
 * Supported merge fields: {{first_name}} {{last_name}} {{name}} {{email}}
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
import { listAccessGroups, getMembersInAccessGroup } from './_lib/circle'
import { getConnectedEmail, sendViaGmail } from './_lib/gmail'

function merge(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, accessGroupId } = req.query as Record<string, string>

    if (action === 'groups') {
      const groups = await listAccessGroups()
      return res.json({ groups })
    }

    if (action === 'members' && accessGroupId) {
      const members = await getMembersInAccessGroup(Number(accessGroupId))
      return res.json({ members, count: members.length })
    }

    return res.status(400).json({ error: 'Missing action or accessGroupId' })
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { accessGroupId, subject, body, testOnly } = req.body as {
    accessGroupId?: number
    subject?:       string
    body?:          string
    testOnly?:      boolean
  }

  if (!accessGroupId || !subject?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'accessGroupId, subject, and body are required' })
  }

  const gmailEmail = await getConnectedEmail(session.email)
  if (!gmailEmail) return res.status(400).json({ error: 'No Gmail account connected — visit /mail-merge to connect' })

  // For test send, use the admin's own details as the single recipient
  const recipients = testOnly
    ? [{
        email:      session.email,
        name:       session.name,
        first_name: session.name.split(' ')[0] ?? session.name,
        last_name:  session.name.split(' ').slice(1).join(' '),
      }]
    : await getMembersInAccessGroup(Number(accessGroupId))

  if (recipients.length === 0) {
    return res.json({ ok: true, sent: 0, total: 0 })
  }

  const errors: string[] = []
  let sent = 0

  for (const m of recipients) {
    const vars: Record<string, string> = {
      first_name: m.first_name || m.name.split(' ')[0] || '',
      last_name:  m.last_name  || m.name.split(' ').slice(1).join(' ') || '',
      name:       m.name       || m.first_name || '',
      email:      m.email      || '',
    }

    try {
      await sendViaGmail(session.email, m.email, merge(subject, vars), merge(body, vars))
      sent++
      console.log(`[mail-merge] sent to ${m.email} (${sent}/${recipients.length})`)
    } catch (err: any) {
      console.error(`[mail-merge] failed for ${m.email}:`, err?.message)
      errors.push(m.email)
    }
  }

  return res.json({
    ok:     errors.length < recipients.length,
    sent,
    total:  recipients.length,
    ...(errors.length > 0 ? { errors } : {}),
  })
}
