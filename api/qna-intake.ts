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
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   WEBFLOW_API_TOKEN (headshot and cover — best-effort)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { tokensMatch } from './_lib/qna-tokens'
import { signedUrlFor } from './_lib/qna-storage'
import { getQnaMedia } from './_lib/webflow'
import {
  authorEntries,
  baseQuestions,
  buildResponses,
  dropEmptyAuthorQuestions,
  isAnswered,
  orphanedAnswers,
  parseJsonArray,
  sanitiseAuthorQuestions,
} from './_lib/qna-rows'

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

function parseJsonObject(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Signs Kelly's voice clips for playback. Best-effort throughout: the voiced
 * intro is a nice touch, not a dependency — a signing failure must never stop
 * an author from answering, so a broken clip is simply absent.
 *
 * A long expiry is fine here: unlike an author's own recording, these are
 * Kelly reading questions that the page already shows in full.
 */
async function signVoiceClips(row: any, questionCount: number) {
  const map = parseJsonObject(row.fields['Voice Audio'])
  if (!Object.keys(map).length) return { intro: null, questions: [] as (string | null)[] }

  const sign = (path?: string) =>
    path
      ? signedUrlFor(path, 86400).catch(err => {
          console.error('[qna-intake] voice sign failed:', err)
          return null
        })
      : Promise.resolve(null)

  const [intro, ...questions] = await Promise.all([
    sign(map.intro),
    ...Array.from({ length: questionCount }, (_, i) => sign(map[`q${i}`])),
  ])
  return { intro, questions }
}

/**
 * Author-facing view of a pipeline row. Never widen this without a reason.
 *
 * `questions` is Cam's set and `authorQuestions` is what the author appended;
 * the page renders them as one column, but they are sent apart because only
 * the second is editable and only the first has a voice clip.
 * `answers` and `hasAudio` run across both, in page order.
 */
function publicView(row: any) {
  const base = baseQuestions(row)
  const responses = parseJsonArray(row.fields['Responses'])
  const extras = authorEntries(row)

  const all = [
    ...base.map((question, i) => ({
      question,
      text:      responses[i]?.text ?? '',
      audioPath: responses[i]?.audioPath,
    })),
    ...extras,
  ]

  return {
    authorName: row.fields['Author Name'] ?? '',
    bookTitle:  row.fields['Book Title'] ?? '',
    questions:  base,
    authorQuestions: extras.map(e => e.question),
    answers:    all.map(e => e.text ?? ''),
    // Whether a recording exists — never the storage path itself, which the
    // author has no use for and which shouldn't leave the server.
    hasAudio:   all.map(e => Boolean(e.audioPath)),
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
      const view = publicView(row)

      // Both are presentation only, and both are allowed to fail quietly —
      // an author must never be blocked from answering because Webflow or
      // Supabase had a bad moment. Fetched together so the page waits once.
      const [voice, media] = await Promise.all([
        signVoiceClips(row, view.questions.length).catch(err => {
          console.error('[qna-intake] voice signing failed:', err)
          return { intro: null, questions: [] as (string | null)[] }
        }),
        getQnaMedia(
          row.fields['Webflow Author Item ID'],
          row.fields['Webflow Book Item ID']
        ).catch(err => {
          console.error('[qna-intake] media fetch failed:', err)
          return {}
        }),
      ])

      return res.status(200).json({ ...view, voice, media })
    }

    if (req.method === 'POST') {
      if (row.fields['Author Submitted At']) {
        return res.status(409).json({ error: 'This response has already been submitted.' })
      }

      const { action, answers, consent, authorQuestions } = req.body ?? {}

      if (!Array.isArray(answers)) {
        return res.status(400).json({ error: 'answers must be an array' })
      }

      const base = baseQuestions(row)
      const existingExtras = authorEntries(row)

      // An absent key means an older cached page that predates author
      // questions — keep what is stored. An explicit array, empty included,
      // is the current page stating the full list. Conflating the two would
      // let a stale tab silently delete a question the author wrote.
      const extras = authorQuestions === undefined
        ? existingExtras.map(e => e.question)
        : sanitiseAuthorQuestions(authorQuestions)

      const questions = [...base, ...extras]

      // Audio and transcripts are carried across from the stored row — a text
      // autosave must never wipe a recording the author already uploaded.
      const existing = [
        ...parseJsonArray(row.fields['Responses']).slice(0, base.length),
        ...existingExtras,
      ]
      const responses = buildResponses(questions, base.length, existing, answers)

      if (action === 'save') {
        await atPatch(row.id, { 'Responses': JSON.stringify(responses) })
        return res.status(200).json({ ok: true })
      }

      if (action === 'submit') {
        if (consent !== true) {
          return res.status(400).json({ error: 'Consent is required to submit.' })
        }
        // Every question Cam asked has to be answered — an interview missing
        // half its answers isn't publishable, and chasing it afterwards costs
        // far more than the friction of saying so here. An audio-only answer
        // is a complete answer; typing is never required.
        //
        // Enforced server-side as well as on the page because the page's
        // submit button is only a courtesy: the endpoint is the gate.
        const missing = base
          .map((_, i) => i)
          .filter(i => !isAnswered(responses[i]))
        if (missing.length) {
          return res.status(400).json({
            error: missing.length === base.length
              ? `Please answer all ${base.length} questions before sending.`
              : `Please answer ${missing.length === 1 ? 'question' : 'questions'} ` +
                `${missing.map(i => i + 1).join(', ')} before sending.`,
            missing,
          })
        }

        // Refuse rather than discard: an answer typed under a blank question
        // is still the author's words, and dropping it to tidy the row would
        // be a silent loss.
        const orphans = orphanedAnswers(responses, base.length)
        if (orphans.length) {
          return res.status(400).json({
            error: 'One of your own questions is blank. Please write the question, or clear the answer under it.',
            orphans,
          })
        }

        // What's left to drop carries no words of theirs: a slot opened and
        // thought better of, or a question they never answered.
        const final = dropEmptyAuthorQuestions(responses, base.length)

        const now = new Date().toISOString()
        await atPatch(row.id, {
          'Responses':           JSON.stringify(final),
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
