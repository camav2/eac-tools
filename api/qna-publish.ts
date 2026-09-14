/*
 * Author Editorial Q&A — publishing (admin)
 *
 * GET  ?authorItemId=…                       → what would be published
 * POST { authorItemId, action:'stage', title?, description? }
 *                                            → creates the DRAFT blog post and
 *                                              writes the author-page summary
 * POST { authorItemId, action:'publish' }    → puts both live
 *
 * TWO STEPS ON PURPOSE. Staging writes to Webflow's working copy, which is
 * invisible to the public; publishing is what the world sees. Cam authorises
 * anything going live on the EAC site, so nothing here publishes as a side
 * effect of anything else.
 *
 * Only an APPROVED row can be staged. The author was promised, in the
 * invitation and again in the receipt, that they would see the edit before
 * anyone else - publishing an unapproved draft would break that promise in the
 * one place it cannot be taken back.
 *
 * Env vars required:
 *   JWT_SECRET, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   WEBFLOW_API_TOKEN
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import {
  createBlogPost,
  findBlogPostBySlugs,
  getAuthorHeadshotUrl,
  getBlogPost,
  publishAuthorItem,
  publishBlogPost,
  writeEditorialQna,
} from './_lib/webflow'
import {
  authorSummaryHtml,
  blogUrl,
  candidateSlugs,
  defaultTitle,
  metaDescription,
  postBodyHtml,
  slugify,
  type Draft,
} from './_lib/qna-post'

// Creating an item, reading a headshot and patching the author is several
// Webflow round trips.
export const maxDuration = 60

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

async function findRow(authorItemId: string) {
  const data = await atGet('?pageSize=100')
  return (data.records ?? []).find(
    (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
  )
}

function parseDraft(raw: unknown): Draft | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const d = JSON.parse(raw)
    return Array.isArray(d?.items) ? d as Draft : null
  } catch {
    return null
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

    const authorName = String(row.fields['Author Name'] ?? '')
    const bookTitle  = String(row.fields['Book Title'] ?? '')
    const draft      = parseDraft(row.fields['Draft QnA'])
    const approved   = Boolean(row.fields['Approved At'])

    // Whether a post already exists is asked of Webflow, not remembered here.
    // Nothing about this feature needs a column in Airtable, and a hand-made
    // field would be one more thing standing between it and working.
    const existing = await findBlogPostBySlugs(
      candidateSlugs(authorName, bookTitle)
    ).catch(err => {
      console.error('[qna-publish] blog lookup failed:', err)
      return null
    })

    if (req.method === 'GET') {
      const title = defaultTitle(authorName, bookTitle)
      return res.status(200).json({
        authorName,
        bookTitle,
        approved,
        hasDraft: Boolean(draft),
        status:   row.fields['Status'] ?? '',
        // Report where it actually lives rather than where it would have gone
        // - the slug differs if it hit a collision.
        staged: existing ? { ...existing, url: blogUrl(existing.slug) } : null,
        preview: draft ? {
          title,
          slug:        slugify(title),
          description: metaDescription(draft),
          bodyHtml:    postBodyHtml(draft),
          summaryHtml: authorSummaryHtml(draft, slugify(title)),
          editorNotes: draft.editorNotes ?? '',
        } : null,
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const action = String(req.body?.action ?? '')

    if (action === 'stage') {
      if (!draft) return res.status(400).json({ error: 'Generate and save a draft first.' })
      if (!approved) {
        return res.status(400).json({
          error: 'The author has not approved this yet. They were promised they would see it first.',
        })
      }
      if (existing) {
        return res.status(409).json({ error: 'A post already exists for this author.' })
      }

      const title = String(req.body?.title ?? '').trim() || defaultTitle(authorName, bookTitle)
      const description = String(req.body?.description ?? '').trim() || metaDescription(draft)

      // Best-effort: a missing headshot is a post without a picture, not a
      // failed publish.
      const imageUrl = await getAuthorHeadshotUrl(authorItemId)

      const post = await createBlogPost({
        title,
        slug: slugify(title),
        bodyHtml: postBodyHtml(draft),
        description,
        imageUrl,
      })

      // The summary links to the slug Webflow actually kept, not the one we
      // asked for. A collision would otherwise leave the author page pointing
      // at a page that does not exist.
      await writeEditorialQna(authorItemId, authorSummaryHtml(draft, post.slug))
      console.log(`[qna-publish] staged ${authorName} as ${post.slug}`)

      return res.status(200).json({
        ok: true, staged: { ...post, url: blogUrl(post.slug) },
      })
    }

    if (action === 'publish') {
      if (!existing) return res.status(400).json({ error: 'Stage the post first.' })
      if (!approved) {
        return res.status(400).json({ error: 'The author has not approved this yet.' })
      }

      // Post first, then the author page. If the second fails the interview is
      // live and the author page simply lacks its link; the opposite order puts
      // a link to a 404 on a live page.
      await publishBlogPost(existing.id)
      await publishAuthorItem(authorItemId)

      const post = await getBlogPost(existing.id).catch(() => null)
      await atPatch(row.id, { 'Status': 'Published' })
      console.log(`[qna-publish] published ${authorName}`)

      return res.status(200).json({ ok: true, url: post ? blogUrl(post.slug) : null })
    }

    return res.status(400).json({ error: "action must be 'stage' or 'publish'" })
  } catch (err) {
    console.error('[qna-publish] request failed:', err)
    const detail = err instanceof Error ? err.message : ''
    return res.status(500).json({ error: detail || 'Publishing failed.' })
  }
}
