/*
 * Author Editorial Q&A — mint an intake link
 *
 * POST — admin-only. Generates (or returns the existing) opaque token for an
 *        author and flips the pipeline row to "Sent to Author". Returns the
 *        link for Cam to send manually — nothing is emailed from here.
 *
 * Re-minting is deliberate: POST with regenerate=true issues a fresh token and
 * invalidates the old link (useful if a link is forwarded or leaks).
 *
 * Env vars required:
 *   JWT_SECRET, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { generateIntakeToken } from './_lib/qna-tokens'

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!
const INTAKE_BASE_URL = 'https://hub.expertauthor.community/qna-intake'

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { authorItemId, regenerate } = req.body ?? {}
    if (!authorItemId || typeof authorItemId !== 'string') {
      return res.status(400).json({ error: 'authorItemId is required' })
    }

    const data = await atGet('?pageSize=100')
    const row = (data.records ?? []).find(
      (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
    )
    if (!row) {
      return res.status(404).json({ error: 'No pipeline row — assign a bucket first' })
    }

    // Questions must exist before a link can be sent — otherwise the author
    // opens an empty page.
    const rawQuestions = row.fields['Question Set']
    let questions: unknown = null
    try { questions = rawQuestions ? JSON.parse(rawQuestions) : null } catch { /* ignore */ }
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Generate and save a question set first' })
    }

    const existingToken = row.fields['Intake Token']
    const token = (existingToken && !regenerate) ? existingToken : generateIntakeToken()

    // Don't regress a further-along status (e.g. an author who already
    // responded) just because Cam re-opened the send screen.
    const currentStatus = row.fields.Status
    const shouldAdvance = currentStatus === 'Questions Generated' || currentStatus === 'Not Started'

    const fields: Record<string, unknown> = { 'Intake Token': token }
    if (token !== existingToken) fields['Token Created At'] = new Date().toISOString()
    if (shouldAdvance) fields['Status'] = 'Sent to Author'

    await atPatch(row.id, fields)

    return res.status(200).json({
      url:    `${INTAKE_BASE_URL}?token=${encodeURIComponent(token)}`,
      status: shouldAdvance ? 'Sent to Author' : currentStatus,
    })
  } catch (err) {
    console.error('[qna-send] POST failed:', err)
    return res.status(500).json({ error: 'Failed to create intake link' })
  }
}
