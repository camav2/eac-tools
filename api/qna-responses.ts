/*
 * Author Editorial Q&A — response review + transcription (admin)
 *
 * GET  ?authorItemId=…                     → answers, signed audio URLs, transcripts
 * POST { authorItemId, questionIndex }     → transcribe that one recording
 *
 * Transcription is deliberately one question per request, driven by a client
 * loop, rather than all six in a single call: each invocation stays short
 * (well inside the function timeout), the admin sees progress as it goes, and
 * a failure on one answer doesn't lose the others. Same shape as the existing
 * mail-merge worker.
 *
 * Env vars required:
 *   JWT_SECRET, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { signedUrlFor, downloadAudio } from './_lib/qna-storage'
import { transcribeAudio } from './_lib/elevenlabs'

// A single long recording can take a while through Scribe; the default 15s
// is not enough headroom.
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

function parseJsonField(raw: unknown): any[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function findRow(authorItemId: string) {
  const data = await atGet('?pageSize=100')
  return (data.records ?? []).find(
    (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
  )
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

  try {
    if (req.method === 'GET') {
      const authorItemId = String(req.query.authorItemId ?? '')
      if (!authorItemId) return res.status(400).json({ error: 'authorItemId is required' })

      const row = await findRow(authorItemId)
      if (!row) return res.status(404).json({ error: 'No pipeline row for this author' })

      const responses = parseJsonField(row.fields['Responses']) ?? []

      // Sign each recording so the admin page can play it without the bucket
      // being public. Best-effort: a broken signature shouldn't blank the page.
      const withUrls = await Promise.all(
        responses.map(async (r: any) => ({
          question:   r.question ?? '',
          text:       r.text ?? '',
          transcript: r.transcript ?? '',
          hasAudio:   Boolean(r.audioPath),
          audioUrl:   r.audioPath
            ? await signedUrlFor(r.audioPath).catch(err => {
                console.error('[qna-responses] sign failed:', err)
                return null
              })
            : null,
        }))
      )

      return res.status(200).json({
        authorName:  row.fields['Author Name'] ?? '',
        bookTitle:   row.fields['Book Title'] ?? '',
        status:      row.fields['Status'] ?? '',
        submittedAt: row.fields['Author Submitted At'] ?? null,
        responses:   withUrls,
      })
    }

    if (req.method === 'POST') {
      const { authorItemId, questionIndex } = req.body ?? {}
      if (!authorItemId || typeof authorItemId !== 'string') {
        return res.status(400).json({ error: 'authorItemId is required' })
      }
      if (!Number.isInteger(questionIndex) || questionIndex < 0) {
        return res.status(400).json({ error: 'questionIndex is required' })
      }

      const row = await findRow(authorItemId)
      if (!row) return res.status(404).json({ error: 'No pipeline row for this author' })

      const responses = parseJsonField(row.fields['Responses']) ?? []
      const target = responses[questionIndex]
      if (!target?.audioPath) {
        return res.status(400).json({ error: 'No recording for that question' })
      }

      const { buffer, contentType } = await downloadAudio(target.audioPath)
      const transcript = await transcribeAudio(
        buffer,
        target.audioType || contentType,
        `q${questionIndex}`
      )

      responses[questionIndex] = { ...target, transcript: transcript.text }
      await atPatch(row.id, { 'Responses': JSON.stringify(responses) })

      return res.status(200).json({ transcript: transcript.text })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('[qna-responses] request failed:', err)
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }
}
