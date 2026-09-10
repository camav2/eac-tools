/*
 * Author Editorial Q&A — suggest a question (author-facing, token-gated)
 *
 * POST { token }  →  { question }
 *
 * The author has clicked "suggest one for me" on the intake page. Returns a
 * single proposed question and writes NOTHING: it is a suggestion until they
 * accept it, and accepting is just the normal autosave of the question field.
 * That keeps a rejected suggestion from leaving a trace, and keeps this
 * endpoint free of the merge logic every writing path has to get right.
 *
 * Token-only auth, same shape and same reasoning as qna-intake: unknown and
 * wrong tokens return an identical 404, and only the question comes back —
 * never row internals.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY,
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { tokensMatch } from './_lib/qna-tokens'
import { suggestAuthorQuestion } from './_lib/anthropic'
import {
  authorEntries,
  baseQuestions,
  parseJsonArray,
  MAX_AUTHOR_QUESTIONS,
} from './_lib/qna-rows'

// Sonnet at medium effort, but somebody is watching a spinner — give it room
// to finish rather than fail at the default 15s.
export const maxDuration = 60

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!

/**
 * Button-mash guard.
 *
 * Per-instance and therefore best-effort — Vercel may run several — but the
 * case it exists for is one impatient author clicking twice, and for that a
 * single instance is where both clicks land. The real limit on abuse is that
 * the endpoint needs a 192-bit token issued to one person.
 */
const COOLDOWN_MS = 4000
const lastCall = new Map<string, number>()

async function atGet(path: string) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status}`)
  return res.json()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = String(req.body?.token ?? '')
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const data = await atGet('?pageSize=100')
    const row = (data.records ?? []).find((r: any) =>
      tokensMatch(r.fields['Intake Token'], token)
    )
    if (!row) return res.status(404).json({ error: 'This link is not valid.' })
    if (row.fields['Author Submitted At']) {
      return res.status(409).json({ error: 'This response has already been submitted.' })
    }

    const since = Date.now() - (lastCall.get(row.id) ?? 0)
    if (since < COOLDOWN_MS) {
      return res.status(429).json({ error: 'Just a moment — still thinking about the last one.' })
    }
    lastCall.set(row.id, Date.now())

    const base = baseQuestions(row)
    if (base.length === 0) {
      return res.status(400).json({ error: 'This interview has no questions yet.' })
    }

    const extras = authorEntries(row)
    if (extras.length >= MAX_AUTHOR_QUESTIONS) {
      return res.status(400).json({
        error: `You can add up to ${MAX_AUTHOR_QUESTIONS} questions of your own.`,
      })
    }

    // Their answers so far are what makes the suggestion follow a thread
    // rather than restate the brief. Transcripts count: an author who has
    // recorded everything has still told us plenty.
    const responses = parseJsonArray(row.fields['Responses'])
    const answersSoFar = responses.map((r: any) => ({
      question: String(r?.question ?? ''),
      answer:   String(r?.text ?? '').trim() || String(r?.transcript ?? '').trim(),
    }))

    const question = await suggestAuthorQuestion({
      authorName:        row.fields['Author Name'] ?? '',
      bookTitle:         row.fields['Book Title'] ?? '',
      existingQuestions: [...base, ...extras.map(e => e.question)],
      answersSoFar,
    })

    console.log(`[qna-suggest] ${row.fields['Author Name']}: suggested a question`)
    return res.status(200).json({ question })
  } catch (err) {
    console.error('[qna-suggest] request failed:', err)
    return res.status(500).json({
      error: "We couldn't come up with one just now. Please try again, or write your own.",
    })
  }
}
