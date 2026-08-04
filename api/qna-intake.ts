/*
 * Author Editorial Q&A — public intake endpoint
 *
 * GET  ?token=…            → questions + any previously saved answers
 * POST { token, action }   → 'save' autosaves a draft; 'submit' finalises
 *
 * TOKEN-ONLY AUTH — a new shape for this repo. There is no session and no
 * login: the author opens a link from an email, possibly in an email client's
 * in-app browser or on a different device, so the origin check used by
 * idea-test/unblocker cannot be the gate here. The token IS the credential.
 *
 * Deliberate choices:
 *  - Unknown token and wrong token return the same 404, so the endpoint can't
 *    be used to probe which tokens exist.
 *  - Only the author-facing fields are ever returned — never Cam Notes,
 *    internal status, or the Webflow/Airtable record IDs.
 *  - Once submitted the row is read-only; a re-opened link shows a thank-you
 *    rather than an editable form.
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { tokensMatch } from './_lib/qna-tokens'

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

/**
 * Fetches every row and compares tokens in JS rather than building a
 * filterByFormula string — no formula-injection surface, and the table is
 * small enough (one row per author) that this is cheap.
 */
async function findRowByToken(token: string) {
  const data = await atGet('?pageSize=100')
  return (data.records ?? []).find((r: any) => tokensMatch(r.fields['Intake Token'], token))
}

function parseJsonField(raw: unknown): any[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Author-facing view of a pipeline row. Never widen this without a reason. */
function publicView(row: any) {
  const questions = parseJsonField(row.fields['Question Set']) ?? []
  const responses = parseJsonField(row.fields['Responses']) ?? []
  return {
    authorName: row.fields['Author Name'] ?? '',
    bookTitle:  row.fields['Book Title'] ?? '',
    questions,
    answers:    questions.map((_: unknown, i: number) => responses[i]?.text ?? ''),
    submitted:  Boolean(row.fields['Author Submitted At']),
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const token = String(
    (req.method === 'GET' ? req.query.token : req.body?.token) ?? ''
  )
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const row = await findRowByToken(token)
    // Same response for "no such token" and "malformed token" — don't confirm
    // which tokens exist.
    if (!row) return res.status(404).json({ error: 'This link is not valid.' })

    if (req.method === 'GET') {
      return res.status(200).json(publicView(row))
    }

    if (req.method === 'POST') {
      if (row.fields['Author Submitted At']) {
        return res.status(409).json({ error: 'This response has already been submitted.' })
      }

      const { action, answers, consent } = req.body ?? {}
      const questions = parseJsonField(row.fields['Question Set']) ?? []

      if (!Array.isArray(answers)) {
        return res.status(400).json({ error: 'answers must be an array' })
      }

      // Store question alongside answer so the draft step (Phase 6) has the
      // pair without re-reading the question set.
      const responses = questions.map((q: string, i: number) => ({
        question: q,
        text:     typeof answers[i] === 'string' ? answers[i] : '',
      }))

      if (action === 'save') {
        await atPatch(row.id, { 'Responses': JSON.stringify(responses) })
        return res.status(200).json({ ok: true })
      }

      if (action === 'submit') {
        if (consent !== true) {
          return res.status(400).json({ error: 'Consent is required to submit.' })
        }
        if (responses.every(r => !r.text.trim())) {
          return res.status(400).json({ error: 'Please answer at least one question before submitting.' })
        }

        const now = new Date().toISOString()
        await atPatch(row.id, {
          'Responses':           JSON.stringify(responses),
          'Consent Given':       true,
          'Consent Timestamp':   now,
          'Author Submitted At': now,
          'Status':              'Author Responded',
        })
        return res.status(200).json({ ok: true, submitted: true })
      }

      return res.status(400).json({ error: 'action must be "save" or "submit"' })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('[qna-intake] request failed:', err)
    return res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
}
