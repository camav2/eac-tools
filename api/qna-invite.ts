/*
 * Author Editorial Q&A — the invitation email (admin)
 *
 * GET  ?authorItemId=…   → the drafted email: who it goes to, subject, body
 * POST { authorItemId, to, subject, body }
 *                        → sends it, and records what was sent and to whom
 *
 * Cam sees the draft and can edit every part of it before anything leaves.
 * The GET never sends; the POST sends exactly what it is given rather than
 * re-drafting, so what was approved on screen is what the author receives.
 *
 * Sent from Cameron's connected Gmail with Kelly copied, so a reply lands in
 * a thread they can both see. Sender and copy are fixed here rather than
 * passed in — a send screen that lets you type any From address is a mistake
 * waiting for a tired evening.
 *
 * Env vars required:
 *   JWT_SECRET,
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   AIRTABLE_CUSTOMERS_BASE_ID, AIRTABLE_CUSTOMERS_TABLE_ID,
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { sendViaGmailAddress } from './_lib/gmail'
import { findCustomerByName } from './_lib/customers'
import { baseQuestions } from './_lib/qna-rows'
import { calendarUrl, dueDateFrom, formatDue, DEADLINE_DAYS } from './_lib/qna-deadline'

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!

const FROM_ADDRESS = 'cameron@expertauthor.community'
const CC_ADDRESS   = 'kelly@expertauthor.community'
const INTAKE_BASE_URL = 'https://hub.expertauthor.community/qna-intake'

// A lookup across a few hundred customer rows plus a Gmail send is not a
// 15-second job on a cold function.
export const maxDuration = 60

async function atGet(path: string) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status}`)
  return res.json()
}

async function atPatch(recordId: string, fields: Record<string, unknown>) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}/${recordId}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Airtable PATCH failed: ${res.status} ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function findRow(authorItemId: string) {
  const data = await atGet('?pageSize=100')
  return (data.records ?? []).find(
    (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
  )
}

function firstName(full: string): string {
  return String(full || '').trim().split(/\s+/)[0] || 'there'
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The default draft.
 *
 * EAC house style: hyphens rather than em dashes, no exclamation marks, one
 * thought per line. It opens on the author's own book rather than on us,
 * because the first line decides whether the rest gets read — and it says
 * plainly that this is not a testimonial, which is the single thing most
 * likely to stop an author replying.
 *
 * Cam edits this on screen, so it is a starting point rather than a template
 * to be defended.
 */
function draftEmail(authorName: string, bookTitle: string, link: string, dueDate: string) {
  const subject = `A few questions about ${bookTitle}`
  const due = formatDue(dueDate)
  const cal = calendarUrl(dueDate, bookTitle, link)

  const body = [
    `<p>Hi ${esc(firstName(authorName))},</p>`,
    `<p>I'd like to interview you about <em>${esc(bookTitle)}</em>.</p>`,
    `<p>We're building an editorial home for the Expert Author Community. Somewhere that shares the thinking and lived experience behind meaningful books, not just the covers.</p>`,
    `<p><strong>This isn't a testimonial.</strong> I'm not after kind words about us.</p>`,
    `<p>What I'm interested in is what the writing and the publishing actually taught you. The things you'd tell another expert who was about to start.</p>`,
    `<p>There are six questions. Type your answers or record them out loud, whichever suits you. Everything saves as you go, so you can stop and come back.</p>`,
    // The date sits directly above the button. A deadline further down the
    // page than the thing it applies to is a deadline people miss.
    `<p>Could you get them back to me by <strong>${esc(due)}</strong>?</p>`,
    `<p><a href="${esc(link)}" style="display:inline-block;background:#00003D;color:#ffffff;` +
      `text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:700;">` +
      `Answer the questions</a></p>`,
    // Offered right after the deadline, because the moment somebody reads a
    // date is the only moment they will act on putting it somewhere.
    `<p style="font-size:14px;"><a href="${esc(cal)}">Add ${esc(due)} to my calendar</a></p>`,
    `<p>We'll shape what you say into an edited Q&amp;A and send it to you for approval before anything is published.</p>`,
    `<p>Thanks for considering it.</p>`,
    `<p>Cameron</p>`,
  ].join('\n')

  return { subject, body }
}

/**
 * The due date to use for this send.
 *
 * Prefers the one the drafted email was written with, so the date the author
 * reads and the date on the row are the same even if Cam drafted the email
 * yesterday and sent it this morning. Anything unparseable or implausible
 * falls back to a fresh calculation rather than being trusted.
 */
function resolveDueDate(supplied: unknown): string {
  const fresh = dueDateFrom()
  if (typeof supplied !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(supplied)) return fresh

  const today = dueDateFrom(new Date(), 0)
  const ceiling = dueDateFrom(new Date(), DEADLINE_DAYS + 14)
  return supplied >= today && supplied <= ceiling ? supplied : fresh
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

  try {
    const authorItemId = String(
      (req.method === 'GET' ? req.query.authorItemId : req.body?.authorItemId) ?? ''
    )
    if (!authorItemId) return res.status(400).json({ error: 'authorItemId is required' })

    const row = await findRow(authorItemId)
    if (!row) return res.status(404).json({ error: 'No pipeline row — assign a bucket first' })

    const authorName = row.fields['Author Name'] ?? ''
    const bookTitle  = row.fields['Book Title'] ?? ''
    const token      = row.fields['Intake Token']

    // Without a token there is no link to send, and an invitation to nowhere
    // is worse than no invitation.
    if (!token) {
      return res.status(400).json({ error: 'Create the intake link first, then send.' })
    }
    if (!baseQuestions(row).length) {
      return res.status(400).json({ error: 'Generate and save a question set first.' })
    }

    const link = `${INTAKE_BASE_URL}?token=${encodeURIComponent(token)}`

    if (req.method === 'GET') {
      // A stored address wins over a fresh lookup: if Cam corrected it last
      // time, that correction is the better answer.
      const stored = row.fields['Author Email']
      const found  = stored ? null : await findCustomerByName(authorName).catch(err => {
        console.error('[qna-invite] customer lookup failed:', err)
        return null
      })

      const dueDate = dueDateFrom()
      const draft = draftEmail(authorName, bookTitle, link, dueDate)

      return res.status(200).json({
        authorName,
        bookTitle,
        to:        stored ?? found?.email ?? '',
        toSource:  stored ? 'saved' : (found ? 'customers' : 'none'),
        from:      FROM_ADDRESS,
        cc:        CC_ADDRESS,
        subject:   draft.subject,
        body:      draft.body,
        link,
        dueDate,
        dueLabel:  formatDue(dueDate),
        sentAt:    row.fields['Invite Sent At'] ?? null,
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { to, subject, body, dueDate } = req.body ?? {}
    const recipient = String(to ?? '').trim()
    const due = resolveDueDate(dueDate)

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return res.status(400).json({ error: 'A valid email address is required.' })
    }
    if (!String(subject ?? '').trim()) return res.status(400).json({ error: 'Subject is required.' })
    if (!String(body ?? '').trim())    return res.status(400).json({ error: 'Body is required.' })

    // Sent exactly as approved. Re-drafting here would mean the author could
    // receive something Cam never read.
    await sendViaGmailAddress(
      FROM_ADDRESS,
      recipient,
      String(subject).trim(),
      String(body),
      undefined,
      authorName,
      CC_ADDRESS
    )

    const now = new Date().toISOString()
    const fields: Record<string, unknown> = {
      'Author Email':   recipient,
      'Invite Sent At': now,
      'Response Due':   due,
    }
    // Don't drag a further-along author backwards just because the invite was
    // sent again.
    if (row.fields.Status === 'Questions Generated' || row.fields.Status === 'Not Started') {
      fields['Status'] = 'Sent to Author'
    }
    await atPatch(row.id, fields)

    console.log(`[qna-invite] invite for ${authorName} sent to ${recipient}, cc ${CC_ADDRESS}`)
    return res.status(200).json({ ok: true, to: recipient, sentAt: now })
  } catch (err) {
    console.error('[qna-invite] request failed:', err)
    const detail = err instanceof Error ? err.message : ''
    // Surfaced rather than swallowed: "No Gmail connected for
    // cameron@expertauthor.community" is the difference between a fix and an
    // afternoon in the logs.
    return res.status(500).json({ error: detail || 'Could not send the invitation.' })
  }
}
