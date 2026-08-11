/*
 * Book Canvas follow-up — daily cron
 *
 * Sends a personal research email from cameron@expertauthor.community to
 * everyone (member or public) who completed the Book Screening Canvas and
 * hasn't had a follow-up yet. The email's one job is to start a reply
 * conversation that surfaces the person's real, unspoken challenge.
 *
 * Flow per record: Claude generates a one-line observation + one question
 * from their actual canvas answers -> sent via Cameron's connected Gmail
 * (mail-merge OAuth) -> record stamped with Follow-Up Sent At + the question.
 *
 * Schedule: daily 23:00 UTC (9am AEST) via vercel.json cron.
 * Protection: requires Authorization: Bearer CRON_SECRET (Vercel injects it
 * for cron invocations when the env var is set).
 *
 * Env vars required:
 *   CRON_SECRET, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, ANTHROPIC_API_KEY,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sendViaGmailAddress } from './_lib/gmail'
import { generateCanvasFollowUp } from './_lib/anthropic'

export const maxDuration = 300

const BOOK_CANVAS_TABLE = 'tblqezI9SqgelqJA5'
const FROM_GMAIL        = 'cameron@expertauthor.community'

const BATCH_CAP     = 10                       // sends per run; backlog drains daily
const MIN_AGE_MS    = 3 * 60 * 60 * 1000       // don't follow up within 3h of completion
const SEND_DELAY_MS = 500

// The results email comes from EAC; this one comes from a person. Skip our own
// addresses so test completions never email the team.
const SKIP_DOMAINS = ['expertauthor.community']

const FALLBACK = {
  observation: 'I read every canvas that comes through, including yours.',
  question:    'What were you hoping the canvas would tell you that it didn\'t?',
}

const PILLAR_FIELDS: Record<string, string> = {
  'Purpose':        'Purpose',
  'Positioning':    'Positioning',
  'Audience':       'Audience',
  'Problem / Need': 'Problem / Need',
  'Market Fit':     'Market Fit',
  'Unique Value':   'Unique Value',
  'Platform':       'Platform',
  'Objective':      'Objective',
  'Strategy':       'Strategy',
}

// ── Airtable REST ─────────────────────────────────────────────────────────────

function atUrl(path: string) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${BOOK_CANVAS_TABLE}${path}`
}

function atHeaders() {
  return {
    Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  }
}

interface CanvasRecord { id: string; fields: Record<string, unknown> }

async function listRecords(params: Record<string, string>): Promise<CanvasRecord[]> {
  const qs = new URLSearchParams(params)
  const res = await fetch(atUrl(`?${qs}`), { headers: atHeaders() })
  const json = await res.json()
  if (!res.ok) throw json
  return (json.records ?? []) as CanvasRecord[]
}

async function stampRecord(id: string, question: string): Promise<void> {
  const res = await fetch(atUrl(`/${id}`), {
    method: 'PATCH',
    headers: atHeaders(),
    body: JSON.stringify({
      fields: {
        'Follow-Up Sent At':  new Date().toISOString(),
        'Follow-Up Question': question,
      },
    }),
  })
  if (!res.ok) throw await res.json()
}

// ── Email assembly ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildBody(firstName: string, observation: string, question: string): string {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,'
  const para = (t: string) => `<p>${t}</p>`
  return [
    para(greeting),
    para('Cameron here from the Expert Author Community - I look after the tools side of things, including the Book Screening Canvas you completed.'),
    para(escapeHtml(observation)),
    para(escapeHtml(question)),
    para('Hit reply - it comes straight to me, and it shapes what we build next.'),
    para('Cameron<br>Expert Author Community'),
  ].join('\n')
}

const SUBJECT = 'A question about your book canvas'

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (!process.env.CRON_SECRET) {
    console.error('[canvas-followup] CRON_SECRET not configured — refusing to run')
    return res.status(500).json({ error: 'CRON_SECRET not configured' })
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // Pending: completed in the last 7 days, no follow-up yet. The 7-day window
    // means a broken cron doesn't dump weeks of stale "personal" emails when fixed.
    const pending = await listRecords({
      filterByFormula:
        `AND({Follow-Up Sent At} = BLANK(), {Email} != '', ` +
        `IS_AFTER({Submitted At}, DATEADD(NOW(), -7, 'days')))`,
      'sort[0][field]':     'Submitted At',
      'sort[0][direction]': 'asc',
      maxRecords: '100',
    })

    // Emails already followed up in the last 30 days — completing the canvas
    // twice shouldn't earn two "personal" emails.
    const recent = await listRecords({
      filterByFormula: `IS_AFTER({Follow-Up Sent At}, DATEADD(NOW(), -30, 'days'))`,
      'fields[]': 'Email',
      maxRecords: '500',
    })
    const alreadySent = new Set(
      recent.map(r => String(r.fields['Email'] ?? '').toLowerCase()).filter(Boolean)
    )

    const now = Date.now()
    const seenThisRun = new Set<string>()
    const queue: CanvasRecord[] = []

    for (const r of pending) {
      const email = String(r.fields['Email'] ?? '').toLowerCase()
      if (!email) continue
      const domain = email.split('@')[1] ?? ''
      if (SKIP_DOMAINS.includes(domain)) continue
      if (alreadySent.has(email) || seenThisRun.has(email)) continue
      const submitted = Date.parse(String(r.fields['Submitted At'] ?? ''))
      if (!submitted || now - submitted < MIN_AGE_MS) continue
      seenThisRun.add(email)
      queue.push(r)
      if (queue.length >= BATCH_CAP) break
    }

    console.log(`[canvas-followup] pending=${pending.length} queued=${queue.length}`)

    let sent = 0
    const errors: string[] = []

    for (const r of queue) {
      const email     = String(r.fields['Email'])
      const firstName = String(r.fields['First Name'] ?? '').trim()

      let content = FALLBACK
      try {
        const pillars: Record<string, string> = {}
        for (const [label, field] of Object.entries(PILLAR_FIELDS)) {
          pillars[label] = String(r.fields[field] ?? '')
        }
        content = await generateCanvasFollowUp({
          firstName,
          isMember: !!r.fields['Is Member'],
          pillars,
        })
      } catch (err) {
        console.error(`[canvas-followup] generation failed for ${email}, using fallback:`, err)
      }

      try {
        await sendViaGmailAddress(
          FROM_GMAIL,
          email,
          SUBJECT,
          buildBody(firstName, content.observation, content.question),
          undefined,
          firstName || undefined,
        )
        await stampRecord(r.id, content.question)
        sent++
        console.log(`[canvas-followup] sent to ${email}`)
      } catch (err) {
        // Not stamped — retried on the next run.
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${email}: ${msg}`)
        console.error(`[canvas-followup] send failed for ${email}:`, err)
      }

      await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS))
    }

    return res.status(200).json({ ok: true, queued: queue.length, sent, errors })
  } catch (err) {
    console.error('[canvas-followup] handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
