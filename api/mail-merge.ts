/*
 * Mail merge API
 *
 * GET  /api/mail-merge?action=sources                     → { circleGroups, brevoLists }
 * GET  /api/mail-merge?action=members&source=circle&sourceId={n}
 * GET  /api/mail-merge?action=members&source=brevo&sourceId={n}
 * POST /api/mail-merge { source, sourceId, subject, body, testOnly? }
 *
 * Admin-only. Emails sent plain-text via the admin's connected Gmail.
 * Merge fields: {{first_name}} {{last_name}} {{name}} {{email}}
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
import { listSpaceGroups, getMembersInSpaceGroup } from './_lib/circle'
import { listBrevoLists, getMembersFromBrevoList } from './_lib/brevo'
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
    const { action, source, sourceId } = req.query as Record<string, string>

    if (action === 'sources') {
      const [circleGroups, brevoLists] = await Promise.all([
        listSpaceGroups(),
        listBrevoLists(),
      ])
      return res.json({ circleGroups, brevoLists })
    }

    if (action === 'members' && source && sourceId) {
      const id = Number(sourceId)
      const members = source === 'brevo'
        ? await getMembersFromBrevoList(id)
        : await getMembersInSpaceGroup(id)
      return res.json({ members, count: members.length })
    }

    return res.status(400).json({ error: 'Missing action or required params' })
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { source, sourceId, subject, body, replyTo, testOnly } = req.body as {
    source?:   string
    sourceId?: number
    subject?:  string
    body?:     string
    replyTo?:  string
    testOnly?: boolean
  }

  if (!source || !sourceId || !subject?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'source, sourceId, subject, and body are required' })
  }

  const gmailEmail = await getConnectedEmail(session.email)
  if (!gmailEmail) return res.status(400).json({ error: 'No Gmail account connected' })

  const recipients = testOnly
    ? [{
        email:      session.email,
        name:       session.name,
        first_name: session.name.split(' ')[0] ?? session.name,
        last_name:  session.name.split(' ').slice(1).join(' '),
      }]
    : source === 'brevo'
      ? await getMembersFromBrevoList(Number(sourceId))
      : await getMembersInSpaceGroup(Number(sourceId))

  if (recipients.length === 0) return res.json({ ok: true, sent: 0, total: 0 })

  // Throttle sends to protect the Gmail account from rate-limiting.
  // Default: 1000ms between each email. Override with MAIL_MERGE_DELAY_MS env var.
  const delayMs = Math.max(0, Number(process.env.MAIL_MERGE_DELAY_MS ?? 1000))
  const sleep   = (ms: number) => new Promise(r => setTimeout(r, ms))

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
      await sendViaGmail(session.email, m.email, merge(subject, vars), merge(body, vars), replyTo || undefined)
      sent++
      console.log(`[mail-merge] sent to ${m.email} (${sent}/${recipients.length})`)
    } catch (err: any) {
      console.error(`[mail-merge] failed for ${m.email}:`, err?.message)
      errors.push(m.email)
    }
    if (sent < recipients.length) await sleep(delayMs)
  }

  return res.json({
    ok:    errors.length < recipients.length,
    sent,
    total: recipients.length,
    ...(errors.length > 0 ? { errors } : {}),
  })
}
