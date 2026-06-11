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
import { listBrevoLists, getMembersFromBrevoList, listBrevoSegments, getMembersFromBrevoSegment } from './_lib/brevo'
import { getConnectedEmail, sendViaGmail } from './_lib/gmail'

function merge(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

// ── Supabase REST ─────────────────────────────────────────────────────────────

function sbUrl(path: string) {
  return `${(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1/${path}`
}

function sbHeaders() {
  return {
    'apikey':        process.env.SUPABASE_SERVICE_KEY!,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  }
}

async function createJob(data: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(sbUrl('mail_merge_jobs'), {
    method:  'POST',
    headers: sbHeaders(),
    body:    JSON.stringify(data),
  })
  if (!res.ok) { console.error('Failed to create job:', await res.text()); return null }
  const rows = await res.json() as any[]
  return rows[0]?.id ?? null
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
      const [circleGroups, brevoLists, brevoSegments] = await Promise.all([
        listSpaceGroups(),
        listBrevoLists(),
        listBrevoSegments(),
      ])
      return res.json({ circleGroups, brevoLists, brevoSegments })
    }

    if (action === 'members' && source && sourceId) {
      const id = Number(sourceId)
      const members = source === 'brevo-list'    ? await getMembersFromBrevoList(id)
                    : source === 'brevo-segment' ? await getMembersFromBrevoSegment(id)
                    : await getMembersInSpaceGroup(id)
      return res.json({ members, count: members.length })
    }

    if (action === 'history') {
      const r = await fetch(
        sbUrl('mail_merge_jobs?select=id,subject,created_at,admin_email,sent_count,total_count,excluded_count,excluded_emails,source_label&status=eq.completed&order=created_at.desc&limit=20'),
        { headers: sbHeaders() }
      )
      const jobs = r.ok ? await r.json() : []
      return res.json({ jobs })
    }

    if (action === 'contact-history') {
      const email = String(req.query.email ?? '')
      if (!email) return res.status(400).json({ error: 'email required' })
      const filterVal = encodeURIComponent(JSON.stringify([{ email }]))
      const r = await fetch(
        sbUrl(`mail_merge_jobs?select=id,subject,created_at,admin_email&status=eq.completed&recipients=cs.${filterVal}&order=created_at.desc&limit=10`),
        { headers: sbHeaders() }
      )
      const jobs = r.ok ? await r.json() : []
      return res.json({ jobs })
    }

    return res.status(400).json({ error: 'Missing action or required params' })
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { source, sourceId, subject, body, replyTo, testOnly, excludedEmails, sourceLabel } = req.body as {
    source?:         string
    sourceId?:       number
    subject?:        string
    body?:           string
    replyTo?:        string
    testOnly?:       boolean
    excludedEmails?: string[]
    sourceLabel?:    string
  }

  if (!source || !sourceId || !subject?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'source, sourceId, subject, and body are required' })
  }

  const gmailEmail = await getConnectedEmail(session.email)
  if (!gmailEmail) return res.status(400).json({ error: 'No Gmail account connected' })

  // ── Test send: immediate, no queue ─────────────────────────────────────────
  if (testOnly) {
    const m = { email: session.email, name: session.name, first_name: session.name.split(' ')[0] ?? session.name, last_name: session.name.split(' ').slice(1).join(' ') }
    const vars: Record<string, string> = { first_name: m.first_name, last_name: m.last_name, name: m.name, email: m.email }
    try {
      await sendViaGmail(session.email, m.email, merge(subject, vars), merge(body, vars), replyTo || undefined, session.name, m.name)
      return res.json({ ok: true, sent: 1, total: 1 })
    } catch (err: any) {
      return res.status(500).json({ error: err?.message ?? 'Send failed' })
    }
  }

  // ── Full send: fetch recipients, create queued job ─────────────────────────
  const allRecipients = source === 'brevo-list'    ? await getMembersFromBrevoList(Number(sourceId))
                      : source === 'brevo-segment' ? await getMembersFromBrevoSegment(Number(sourceId))
                      : await getMembersInSpaceGroup(Number(sourceId))

  const excluded = new Set<string>(Array.isArray(excludedEmails) ? excludedEmails : [])
  const recipients = excluded.size > 0 ? allRecipients.filter(r => !excluded.has(r.email)) : allRecipients

  if (recipients.length === 0) return res.json({ ok: true, sent: 0, total: 0 })

  // Strip attributes — only needed for preview, not for sending
  const jobRecipients = recipients.map(({ email, name, first_name, last_name }) => ({ email, name, first_name, last_name }))

  const jobId = await createJob({
    admin_email:     session.email,
    recipients:      jobRecipients,
    subject,
    body,
    reply_to:        replyTo || null,
    total_count:     recipients.length,
    excluded_count:  excluded.size,
    excluded_emails: excluded.size > 0 ? Array.from(excluded) : [],
    source_label:    sourceLabel || null,
  })

  if (!jobId) return res.status(500).json({ error: 'Failed to create send job' })

  return res.json({ jobId, total: recipients.length })
}
