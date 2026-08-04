/*
 * Author Editorial Q&A — draft assembly (admin)
 *
 * GET  ?authorItemId=…                     → current draft (if any) + source answers
 * POST { authorItemId, action: 'generate' } → AI first pass from the answers
 * POST { authorItemId, action: 'save', draft } → persist Cam's edited version
 * POST { authorItemId, action: 'approve' }  → mark the author has signed off
 *
 * The draft is stored as JSON ({ standfirst, items[], editorNotes }) rather
 * than prose, so the publish step can render it deterministically instead of
 * parsing paragraphs back into structure.
 *
 * Env vars required:
 *   JWT_SECRET, ANTHROPIC_API_KEY,
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { generateDraft } from './_lib/anthropic'

// Drafting six answers at high effort is not a 15-second job.
export const maxDuration = 300

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!

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

function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function findRow(authorItemId: string) {
  const data = await atGet('?pageSize=100')
  return (data.records ?? []).find(
    (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
  )
}

/** Only the shape the editor needs — validated so a malformed save can't
 *  poison the publish step later. */
function sanitiseDraft(input: any) {
  if (!input || typeof input !== 'object') return null
  if (!Array.isArray(input.items)) return null
  return {
    standfirst:  String(input.standfirst ?? ''),
    items: input.items
      .map((it: any) => ({
        question: String(it?.question ?? '').trim(),
        answer:   String(it?.answer ?? '').trim(),
      }))
      .filter((it: any) => it.question || it.answer),
    editorNotes: String(input.editorNotes ?? ''),
  }
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
    if (!row) return res.status(404).json({ error: 'No pipeline row for this author' })

    if (req.method === 'GET') {
      return res.status(200).json({
        authorName: row.fields['Author Name'] ?? '',
        bookTitle:  row.fields['Book Title'] ?? '',
        status:     row.fields['Status'] ?? '',
        draft:      parseJson(row.fields['Draft QnA']),
        generatedAt: row.fields['Draft Generated At'] ?? null,
        approvedAt:  row.fields['Approved At'] ?? null,
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const { action } = req.body ?? {}

    if (action === 'generate') {
      const responses = parseJson(row.fields['Responses'])
      if (!Array.isArray(responses) || responses.length === 0) {
        return res.status(400).json({ error: 'No responses to draft from' })
      }
      // Nothing to work with — better to say so than to hand the model a set
      // of empty answers and let it invent its way out.
      const answered = responses.filter(
        (r: any) => (r?.text ?? '').trim() || (r?.transcript ?? '').trim()
      )
      if (answered.length === 0) {
        return res.status(400).json({
          error: 'No answers yet. Transcribe any recordings first, or wait for written answers.',
        })
      }

      const draft = await generateDraft({
        authorName: row.fields['Author Name'] ?? '',
        bookTitle:  row.fields['Book Title'] ?? '',
        bucket:     row.fields['Bucket'] ?? '',
        answers:    responses.map((r: any) => ({
          question:   r?.question ?? '',
          text:       r?.text ?? '',
          transcript: r?.transcript ?? '',
        })),
      })

      await atPatch(row.id, {
        'Draft QnA':          JSON.stringify(draft),
        'Draft Generated At': new Date().toISOString(),
        'Status':             'Draft Ready',
      })

      console.log(
        `[qna-draft] generated for ${row.fields['Author Name']}: ` +
        `${answered.length} answers -> ${draft.items.length} items`
      )
      return res.status(200).json({ draft, status: 'Draft Ready' })
    }

    if (action === 'save') {
      const draft = sanitiseDraft(req.body?.draft)
      if (!draft) return res.status(400).json({ error: 'Malformed draft' })

      await atPatch(row.id, { 'Draft QnA': JSON.stringify(draft) })
      return res.status(200).json({ ok: true })
    }

    if (action === 'approve') {
      if (!row.fields['Draft QnA']) {
        return res.status(400).json({ error: 'There is no draft to approve' })
      }
      await atPatch(row.id, {
        'Approved At': new Date().toISOString(),
        'Status':      'Approved',
      })
      return res.status(200).json({ ok: true, status: 'Approved' })
    }

    return res.status(400).json({ error: 'action must be generate, save or approve' })
  } catch (err) {
    console.error('[qna-draft] request failed:', err)
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }
}
