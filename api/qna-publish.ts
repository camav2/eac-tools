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
  getPostFooterData,
  listBlogPosts,
  publishAuthorItem,
  publishBlogPost,
  updateBlogPost,
  writeBlogBody,
  writeEditorialQna,
} from './_lib/webflow'
import { findRoundup, linkNameInHtml } from './_lib/qna-roundup'
import { parseMedia, signedUrlFor as signedMediaUrl } from './_lib/qna-media'
import {
  authorSummaryHtml,
  blogUrl,
  candidateSlugs,
  choosePostImage,
  defaultTitle,
  footerHtml,
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

/**
 * The images an author sent, signed so Webflow can fetch them.
 *
 * Webflow re-hosts whatever URL it is given on its own CDN, so a signed link
 * that lives an hour is long enough - the file it pulls is permanent even
 * though the link is not.
 *
 * Only images. A PDF or a video cannot be a post's main image, and offering
 * one as a choice would be offering a broken post.
 */
async function uploadedImages(row: any) {
  const files = parseMedia(row.fields['Author Media']).filter(
    f => f.type.startsWith('image/')
  )
  return Promise.all(
    files.map(async f => ({
      name: f.name,
      url:  await signedMediaUrl(f.path, 3600).catch(err => {
        console.error('[qna-publish] media sign failed:', err)
        return null
      }),
    }))
  ).then(list => list.filter(f => f.url))
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

/**
 * Whether the round-up mentions this author, and whether it already links to
 * their interview.
 *
 * Read-only. Editing a live article that ranks is never a side effect of
 * loading a screen - it is its own button, pressed on purpose.
 */
async function roundupStatus(authorName: string, interviewUrl: string) {
  try {
    const posts = await listBlogPosts()
    const roundup = findRoundup(posts)
    if (!roundup) return { found: false as const, reason: 'no round-up post found' }

    const result = linkNameInHtml(roundup.bodyHtml, authorName, interviewUrl)
    return {
      found: true as const,
      postName: roundup.name,
      postSlug: roundup.slug,
      outcome: result.outcome,
      context: result.context ?? null,
    }
  } catch (err) {
    console.error('[qna-publish] roundup check failed:', err)
    return { found: false as const, reason: 'could not read the blog' }
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
    const bookItemId = String(row.fields['Webflow Book Item ID'] ?? '')
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
      const [footer, uploads] = await Promise.all([
        getPostFooterData(authorItemId, bookItemId).catch(err => {
          console.error('[qna-publish] footer data failed:', err)
          return null
        }),
        uploadedImages(row).catch(() => [] as Array<{ name: string; url: string | null }>),
      ])
      return res.status(200).json({
        authorName,
        bookTitle,
        approved,
        hasDraft: Boolean(draft),
        status:   row.fields['Status'] ?? '',
        // Report where it actually lives rather than where it would have gone
        // - the slug differs if it hit a collision.
        staged: existing ? { ...existing, url: blogUrl(existing.slug) } : null,
        // Only worth asking about once the interview has somewhere to point.
        roundup: existing ? await roundupStatus(authorName, blogUrl(existing.slug)) : null,
        // Every picture this post could use, best first, for Cam to choose
        // between. The author's own photograph leads because that is the whole
        // reason the upload box exists.
        images: [
          ...uploads.map(u => ({ label: u.name, url: u.url, source: 'author' })),
          ...(footer?.bookHeroUrl ? [{ label: 'Book cover on a background', url: footer.bookHeroUrl, source: 'book' }] : []),
          ...(footer?.bookCoverUrl ? [{ label: 'Book cover', url: footer.bookCoverUrl, source: 'book' }] : []),
        ],
        preview: draft ? {
          title,
          slug:        slugify(title),
          description: metaDescription(draft),
          bodyHtml:    postBodyHtml(draft) + (footer ? '\n' + footerHtml(footer) : ''),
          summaryHtml: authorSummaryHtml(draft, slugify(title)),
          editorNotes: draft.editorNotes ?? '',
          hasLinkedin: Boolean(footer?.authorLinkedin),
          buyLinks:    footer?.buyLinks?.length ?? 0,
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


      const title = String(req.body?.title ?? '').trim() || defaultTitle(authorName, bookTitle)
      const description = String(req.body?.description ?? '').trim() || metaDescription(draft)

      const [footer, uploads, headshotUrl] = await Promise.all([
        getPostFooterData(authorItemId, bookItemId).catch(err => {
          console.error('[qna-publish] footer data failed:', err)
          return null
        }),
        uploadedImages(row).catch(() => [] as Array<{ name: string; url: string | null }>),
        // Best-effort throughout: a missing picture is a post without one, not
        // a failed publish.
        getAuthorHeadshotUrl(authorItemId),
      ])

      // Cam's choice if he made one, otherwise the best available.
      const chosen = String(req.body?.imageUrl ?? '').trim()
      const imageUrl = chosen || choosePostImage({
        uploadedImageUrl: uploads[0]?.url,
        bookHeroUrl:      footer?.bookHeroUrl,
        bookCoverUrl:     footer?.bookCoverUrl,
        headshotUrl,
      })

      const bodyHtml = postBodyHtml(draft) + (footer ? '\n' + footerHtml(footer) : '')

      // Staging twice is how a post catches up with a changed draft, a new
      // headline or a different photograph. Refusing the second attempt left
      // Cam deleting items in Webflow by hand to get another go.
      let post: { id: string; slug: string }
      if (existing) {
        await updateBlogPost(existing.id, { title, bodyHtml, description, imageUrl })
        post = { id: existing.id, slug: existing.slug }
        console.log(`[qna-publish] restaged ${authorName} as ${post.slug}`)
      } else {
        post = await createBlogPost({ title, slug: slugify(title), bodyHtml, description, imageUrl })
        console.log(`[qna-publish] staged ${authorName} as ${post.slug}`)
      }

      // The summary links to the slug Webflow actually kept, not the one we
      // asked for. A collision would otherwise leave the author page pointing
      // at a page that does not exist.
      await writeEditorialQna(authorItemId, authorSummaryHtml(draft, post.slug))

      return res.status(200).json({
        ok: true,
        restaged: Boolean(existing),
        staged: { ...post, url: blogUrl(post.slug) },
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

    if (action === 'link-roundup') {
      if (!existing) return res.status(400).json({ error: 'Stage the post first.' })

      const interviewUrl = blogUrl(existing.slug)
      const posts = await listBlogPosts()
      const roundup = findRoundup(posts)
      if (!roundup) return res.status(404).json({ error: 'No round-up post found.' })

      const result = linkNameInHtml(roundup.bodyHtml, authorName, interviewUrl)
      if (result.outcome === 'already') {
        return res.status(200).json({ ok: true, outcome: 'already' })
      }
      if (result.outcome === 'not-found') {
        return res.status(404).json({
          error: `${authorName} is not mentioned in "${roundup.name}" outside an existing link.`,
        })
      }

      // Staged, not published. The round-up is a live article; its change goes
      // out when Cam publishes it, the same as everything else here.
      await writeBlogBody(roundup.id, result.html)
      console.log(`[qna-publish] linked ${authorName} in ${roundup.slug}`)

      return res.status(200).json({
        ok: true, outcome: 'linked', context: result.context ?? null,
        postName: roundup.name, postSlug: roundup.slug,
      })
    }

    return res.status(400).json({ error: "action must be 'stage', 'publish' or 'link-roundup'" })
  } catch (err) {
    console.error('[qna-publish] request failed:', err)
    const detail = err instanceof Error ? err.message : ''
    return res.status(500).json({ error: detail || 'Publishing failed.' })
  }
}
