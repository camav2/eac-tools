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

async function atWrite(method: 'POST' | 'PATCH', path: string, fields: Record<string, unknown>) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Airtable ${method} failed: ${res.status} ${body.slice(0, 300)}`)
  }
  return res.json()
}

const VALID_BUCKETS = ['Recent', 'Established'] as const

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

  if (req.method === 'POST') {
    try {
      const { authorItemId, bookItemId, authorName, bookTitle, publishedDate, bucket } = req.body ?? {}

      if (!authorItemId || typeof authorItemId !== 'string') {
        return res.status(400).json({ error: 'authorItemId is required' })
      }
      if (!VALID_BUCKETS.includes(bucket)) {
        return res.status(400).json({ error: 'bucket must be Recent or Established' })
      }

      // Re-fetch rather than trust a client-supplied recordId — keeps this
      // handler the single source of truth for create-vs-update.
      const pipelineData = await atGet('?pageSize=100')
      const existing = (pipelineData.records ?? []).find(
        (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
      )

      let record: any
      if (existing) {
        record = await atWrite('PATCH', `/${existing.id}`, { Bucket: bucket })
      } else {
        record = await atWrite('POST', '', {
          'Author Name':             authorName ?? '',
          'Book Title':              bookTitle ?? '',
          'Bucket':                  bucket,
          'Status':                  'Not Started',
          'Book Published Date':     publishedDate ?? undefined,
          'Webflow Author Item ID':  authorItemId,
          'Webflow Book Item ID':    bookItemId ?? '',
          'Source Tool':             'editorial-qna',
        })
      }

      return res.status(200).json({
        recordId: record.id,
        bucket:   record.fields.Bucket,
        status:   record.fields.Status,
      })
    } catch (err) {
      console.error('[qna-authors] POST failed:', err)
      return res.status(500).json({ error: 'Failed to save bucket assignment' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
