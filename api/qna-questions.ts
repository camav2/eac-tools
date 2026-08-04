/*
 * Author Editorial Q&A — question generation and review
 *
 * GET  — author context (Webflow bio) + the pipeline row's current question
 *        set, if one has been generated/saved yet.
 * POST — action=generate: call Claude for a fresh set of 6, save + return it.
 *        action=save: persist Cam's edited set as-is.
 *
 * Admin-gated throughout — no public access. A bucket must already be
 * assigned (Phase 2) before questions can be generated for an author.
 *
 * Env vars required:
 *   JWT_SECRET, WEBFLOW_API_TOKEN, ANTHROPIC_API_KEY,
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { getAuthorContext } from './_lib/webflow'
import { generateQuestions } from './_lib/anthropic'

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

async function findPipelineRow(authorItemId: string) {
  const data = await atGet('?pageSize=100')
  return (data.records ?? []).find(
    (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
  )
}

function parseQuestions(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

  if (req.method === 'GET') {
    try {
      const authorItemId = String(req.query.authorItemId ?? '')
      if (!authorItemId) return res.status(400).json({ error: 'authorItemId is required' })

      const [context, pipelineRow] = await Promise.all([
        getAuthorContext(authorItemId).catch(err => {
          console.error('[qna-questions] Webflow context fetch failed:', err)
          return {}
        }),
        findPipelineRow(authorItemId),
      ])

      if (!pipelineRow) {
        return res.status(404).json({ error: 'No pipeline row for this author — assign a bucket first' })
      }

      return res.status(200).json({
        recordId:  pipelineRow.id,
        bucket:    pipelineRow.fields.Bucket ?? null,
        bookTitle: pipelineRow.fields['Book Title'] ?? '',
        publishedDate: pipelineRow.fields['Book Published Date'] ?? null,
        context,
        questions: parseQuestions(pipelineRow.fields['Question Set']),
      })
    } catch (err) {
      console.error('[qna-questions] GET failed:', err)
      return res.status(500).json({ error: 'Failed to load question review' })
    }
  }

  if (req.method === 'POST') {
    try {
      const { authorItemId, action } = req.body ?? {}
      if (!authorItemId || typeof authorItemId !== 'string') {
        return res.status(400).json({ error: 'authorItemId is required' })
      }

      const pipelineRow = await findPipelineRow(authorItemId)
      if (!pipelineRow) {
        return res.status(404).json({ error: 'No pipeline row for this author — assign a bucket first' })
      }

      if (action === 'generate') {
        const bucket = pipelineRow.fields.Bucket
        if (bucket !== 'Recent' && bucket !== 'Established') {
          return res.status(400).json({ error: 'Author has no bucket assigned' })
        }

        const context = await getAuthorContext(authorItemId).catch(err => {
          console.error('[qna-questions] Webflow context fetch failed:', err)
          return {}
        })

        const questions = await generateQuestions({
          authorName:    pipelineRow.fields['Author Name'] ?? '',
          bookTitle:     pipelineRow.fields['Book Title'] ?? '',
          bucket,
          publishedDate: pipelineRow.fields['Book Published Date'] ?? null,
          shortSummary:  (context as any).shortSummary,
          longSummary:   (context as any).longSummary,
        })

        await atPatch(pipelineRow.id, {
          'Question Set': JSON.stringify(questions),
          'Status':       'Questions Generated',
        })

        return res.status(200).json({ questions })
      }

      if (action === 'save') {
        const { questions } = req.body ?? {}
        if (!Array.isArray(questions) || questions.length !== 6 || questions.some(q => typeof q !== 'string' || !q.trim())) {
          return res.status(400).json({ error: 'questions must be an array of exactly 6 non-empty strings' })
        }

        await atPatch(pipelineRow.id, {
          'Question Set': JSON.stringify(questions),
          'Status':       'Questions Generated',
        })

        return res.status(200).json({ questions })
      }

      return res.status(400).json({ error: 'action must be "generate" or "save"' })
    } catch (err) {
      console.error('[qna-questions] POST failed:', err)
      return res.status(500).json({ error: 'Failed to save questions' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
