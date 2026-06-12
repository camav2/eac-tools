/*
 * Mail merge background worker
 *
 * POST /api/mail-merge-worker?jobId={uuid}
 *   Sends the next batch of emails for a queued job.
 *   Returns { status, sent, total, errors? }.
 *   Frontend calls this in a loop until status === 'completed'.
 *
 * Admin-only. Job must belong to the calling admin.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
import { sendViaGmail } from './_lib/gmail'

const BATCH_SIZE = 40   // emails per worker call (~20s at 500ms delay)
const DELAY_MS   = 500  // ms between each send

function merge(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

const TITLE_RE = /^(dr|mr|mrs|ms|miss|prof|sir|mx|rev|hon)\.?$/i

function extractFirstName(raw: string): string {
  if (!raw?.trim()) return ''
  const parts = raw.trim().split(/\s+/)
  if (parts.length > 1 && TITLE_RE.test(parts[0])) parts.shift()
  const name = parts[0] ?? ''
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
}

// ── Supabase REST ─────────────────────────────────────────────────────────────

function sbUrl(path: string) {
  return `${(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1/${path}`
}

function sbHeaders(prefer = 'return=minimal') {
  return {
    'apikey':        process.env.SUPABASE_SERVICE_KEY!,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        prefer,
  }
}

async function getJob(jobId: string) {
  const res = await fetch(sbUrl(`mail_merge_jobs?id=eq.${jobId}&select=*`), {
    headers: sbHeaders('return=representation'),
  })
  if (!res.ok) return null
  const rows = await res.json() as any[]
  return rows[0] ?? null
}

async function updateJob(jobId: string, patch: Record<string, unknown>) {
  await fetch(sbUrl(`mail_merge_jobs?id=eq.${jobId}`), {
    method:  'PATCH',
    headers: sbHeaders(),
    body:    JSON.stringify(patch),
  })
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  const { jobId } = req.query as Record<string, string>
  if (!jobId) return res.status(400).json({ error: 'jobId required' })

  const job = await getJob(jobId)
  if (!job)                               return res.status(404).json({ error: 'Job not found' })
  if (job.admin_email !== session.email)  return res.status(403).json({ error: 'Forbidden' })

  // Already finished — just return current state
  if (job.status === 'completed' || job.status === 'failed') {
    return res.json({ status: job.status, sent: job.sent_count, total: job.total_count, errors: job.errors })
  }

  await updateJob(jobId, { status: 'running' })

  const recipients: any[] = job.recipients
  const start  = job.sent_count as number
  const end    = Math.min(start + BATCH_SIZE, recipients.length)
  const batch  = recipients.slice(start, end)
  const errors: string[] = Array.isArray(job.errors) ? [...job.errors] : []
  let sent = start

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  for (let i = 0; i < batch.length; i++) {
    const m = batch[i]
    const vars: Record<string, string> = {
      first_name: extractFirstName(m.first_name || (m.name ?? '').split(' ')[0] || ''),
      last_name:  m.last_name  || (m.name ?? '').split(' ').slice(1).join(' ') || '',
      name:       m.name       || m.first_name || '',
      email:      m.email      || '',
    }
    try {
      await sendViaGmail(
        session.email,
        m.email,
        merge(job.subject, vars),
        merge(job.body,    vars),
        job.reply_to || undefined,
        m.name || [m.first_name, m.last_name].filter(Boolean).join(' '),
      )
      sent++
      console.log(`[worker] ${jobId} sent to ${m.email} (${sent}/${recipients.length})`)
    } catch (err: any) {
      console.error(`[worker] ${jobId} failed for ${m.email}:`, err?.message)
      errors.push(m.email)
      sent++ // advance past failed recipient so we don't get stuck
    }
    if (i < batch.length - 1) await sleep(DELAY_MS)
  }

  const done = sent >= recipients.length
  await updateJob(jobId, {
    status:     done ? 'completed' : 'running',
    sent_count: sent,
    errors,
  })

  return res.json({
    status: done ? 'completed' : 'running',
    sent,
    total:  recipients.length,
    ...(errors.length > 0 ? { errors } : {}),
  })
}
