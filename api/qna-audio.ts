/*
 * Author Editorial Q&A — audio upload (author-facing, token-gated)
 *
 * POST /api/qna-audio?token=…&q=<index>   body: raw audio bytes
 *
 * Stores the recording and records its path against that question. No
 * transcription happens here — the author uploads and moves on; transcription
 * is a back-end step triggered from the admin screen.
 *
 * The body parser is disabled so the raw audio stream arrives intact; the
 * token therefore travels in the query string rather than a JSON body.
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { tokensMatch } from './_lib/qna-tokens'
import { uploadAudio, extensionFor } from './_lib/qna-storage'

export const config = { api: { bodyParser: false } }

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!
// Vercel caps request bodies at 4.5 MB. The intake page records well under
// this; the guard is here so a crafted request fails cleanly rather than
// mid-upload.
const MAX_BYTES = 4_000_000

const ALLOWED_TYPES = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav']

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

async function readBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BYTES) throw new Error('TOO_LARGE')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = String(req.query.token ?? '')
  const qIndex = Number(req.query.q)
  if (!token) return res.status(400).json({ error: 'Missing token' })
  if (!Number.isInteger(qIndex) || qIndex < 0) {
    return res.status(400).json({ error: 'Invalid question index' })
  }

  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim()
  if (!ALLOWED_TYPES.includes(contentType)) {
    return res.status(415).json({ error: `Unsupported audio type: ${contentType || 'none'}` })
  }

  try {
    const data = await atGet('?pageSize=100')
    const row = (data.records ?? []).find((r: any) =>
      tokensMatch(r.fields['Intake Token'], token)
    )
    if (!row) return res.status(404).json({ error: 'This link is not valid.' })
    if (row.fields['Author Submitted At']) {
      return res.status(409).json({ error: 'This response has already been submitted.' })
    }

    const questions = parseJsonField(row.fields['Question Set']) ?? []
    if (qIndex >= questions.length) {
      return res.status(400).json({ error: 'Invalid question index' })
    }

    let audio: Buffer
    try {
      audio = await readBody(req)
    } catch (err) {
      if (err instanceof Error && err.message === 'TOO_LARGE') {
        return res.status(413).json({ error: 'That recording is too long. Please keep answers under about 10 minutes.' })
      }
      throw err
    }
    if (!audio.length) return res.status(400).json({ error: 'Empty upload' })

    // Timestamped filename so a re-record never overwrites the prior take
    // mid-request; the row always points at the newest.
    const path = `${row.id}/q${qIndex}-${Date.now()}.${extensionFor(contentType)}`
    await uploadAudio(path, audio, contentType)

    // Merge into the existing responses array — never rebuild it, or a saved
    // text answer for another question would be lost.
    const existing = parseJsonField(row.fields['Responses']) ?? []
    const responses = questions.map((q: string, i: number) => ({
      question:    q,
      text:        existing[i]?.text ?? '',
      audioPath:   existing[i]?.audioPath,
      audioType:   existing[i]?.audioType,
      transcript:  existing[i]?.transcript,
    }))
    responses[qIndex].audioPath = path
    responses[qIndex].audioType = contentType
    // A fresh recording invalidates any transcript of the previous take.
    responses[qIndex].transcript = undefined

    await atPatch(row.id, { 'Responses': JSON.stringify(responses) })

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[qna-audio] upload failed:', err)
    // Surface the underlying reason rather than a generic message. An author
    // seeing this can't act on the detail, but it's the difference between
    // "something broke" and a diagnosable report — and the alternative was
    // reading server logs to find a one-line bug.
    const detail = err instanceof Error ? err.message : ''
    return res.status(500).json({
      error: detail ? `Upload failed: ${detail}` : 'Upload failed. Please try again.',
    })
  }
}
