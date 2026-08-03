/*
 * Author Editorial Q&A — admin author list
 *
 * GET  — chronological list of authors (from Webflow), left-joined with any
 *        existing pipeline row in Airtable so status/bucket show inline.
 * POST — assign a bucket (Recent/Established) and create/update the
 *        pipeline row. (Phase 2)
 *
 * Admin-gated throughout — no public access.
 *
 * Env vars required:
 *   JWT_SECRET
 *   WEBFLOW_API_TOKEN
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { listAuthorsChronological } from './_lib/webflow'

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!

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

  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

  if (req.method === 'GET') {
    try {
      const [authors, pipelineData] = await Promise.all([
        listAuthorsChronological(),
        atGet('?pageSize=100'),
      ])

      const pipelineByAuthorId = new Map(
        (pipelineData.records ?? []).map((r: any) => [r.fields['Webflow Author Item ID'], r])
      )

      const rows = authors.map(a => {
        const pipeline: any = pipelineByAuthorId.get(a.authorItemId)
        return {
          ...a,
          recordId: pipeline?.id ?? null,
          bucket:   pipeline?.fields?.Bucket ?? null,
          status:   pipeline?.fields?.Status ?? 'Not Started',
        }
      })

      return res.status(200).json({ authors: rows })
    } catch (err) {
      console.error('[qna-authors] GET failed:', err)
      return res.status(500).json({ error: 'Failed to load authors' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
