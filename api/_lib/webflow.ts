/*
 * Webflow Data API v2 helpers — Author Editorial Q&A tool
 *
 * Env vars required:
 *   WEBFLOW_API_TOKEN — CMS read/write token scoped to the EAC site
 *   WEBFLOW_SITE_ID    — the EAC site ID (used by callers, not this file)
 *
 * Collection IDs are hardcoded — stable, same convention as book-canvas.ts
 * hardcoding its Airtable table ID.
 */

const AUTHORS_COLLECTION_ID = '685f7bfce32a3300b7f84b94'
const BOOKS_COLLECTION_ID   = '685f75e25af91f61114955d4'

const WEBFLOW_API = 'https://api.webflow.com/v2'

async function wfFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${WEBFLOW_API}${path}`, {
    ...options,
    headers: {
      Authorization:  `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Webflow API ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function listAllItems(collectionId: string): Promise<any[]> {
  const items: any[] = []
  const limit = 100
  let offset = 0
  while (true) {
    const data = await wfFetch(`/collections/${collectionId}/items?limit=${limit}&offset=${offset}`)
    items.push(...(data.items ?? []))
    const total = data.pagination?.total ?? items.length
    offset += limit
    if (offset >= total || (data.items ?? []).length === 0) break
  }
  return items
}

function linkUrl(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'url' in (value as Record<string, unknown>)) {
    return (value as { url?: string }).url
  }
  return undefined
}

export interface AuthorListEntry {
  authorItemId: string
  authorName: string
  authorSlug: string
  authorPhotoUrl?: string
  bookItemId: string
  bookTitle: string
  publishedDate: string | null
  linkedinUrl?: string
}

/**
 * Books joined to Authors, sorted by publish date descending (newest first).
 * Webflow's list-items endpoint only supports sorting by lastPublished/name/slug,
 * so this fetches everything and sorts client-side — fine at this collection size.
 */
export async function listAuthorsChronological(): Promise<AuthorListEntry[]> {
  const [books, authors] = await Promise.all([
    listAllItems(BOOKS_COLLECTION_ID),
    listAllItems(AUTHORS_COLLECTION_ID),
  ])

  const authorsById = new Map(authors.map(a => [a.id, a]))

  const entries: AuthorListEntry[] = books
    .filter(b => b.fieldData?.['author-2'])
    .map(b => {
      const author = authorsById.get(b.fieldData['author-2'])
      return {
        authorItemId:  b.fieldData['author-2'] as string,
        authorName:    author?.fieldData?.name ?? '(unknown author)',
        authorSlug:    author?.fieldData?.slug ?? '',
        authorPhotoUrl: linkUrl(author?.fieldData?.['author-headshot']),
        bookItemId:    b.id as string,
        bookTitle:     b.fieldData?.name ?? '(untitled)',
        publishedDate: b.fieldData?.['book-published-date'] ?? null,
        linkedinUrl:   linkUrl(author?.fieldData?.linkedin),
      }
    })

  entries.sort((a, b) => {
    if (!a.publishedDate) return 1
    if (!b.publishedDate) return -1
    return b.publishedDate.localeCompare(a.publishedDate)
  })

  return entries
}

export interface AuthorContext {
  shortSummary?: string
  longSummary?: string
  linkedinUrl?: string
  websiteUrl?: string
}

export async function getAuthorContext(authorItemId: string): Promise<AuthorContext> {
  const data = await wfFetch(`/collections/${AUTHORS_COLLECTION_ID}/items/${authorItemId}`)
  const f = data.fieldData ?? {}
  return {
    shortSummary: f['short-summary'],
    longSummary:  f['long-summary'],
    linkedinUrl:  linkUrl(f.linkedin),
    websiteUrl:   linkUrl(f['author-website']),
  }
}

export interface QnaMedia {
  authorPhotoUrl?: string
  authorPhotoAlt?: string
  bookCoverUrl?: string
  bookCoverAlt?: string
}

/**
 * Headshot and book cover for the author-facing intake page.
 *
 * Both halves are independent and best-effort: an author with no headshot, or
 * a book with no cover, still gets a working page. Seeing their own face and
 * their own book at the top is what makes the request feel addressed to them
 * rather than mail-merged — it is decoration with a job, but it is still
 * decoration, and nothing here may block someone from answering.
 *
 * Read live rather than denormalised onto the Airtable row: the page loads
 * once per author, a replaced headshot should just appear, and this avoids two
 * more columns to keep in step.
 */
export async function getQnaMedia(
  authorItemId?: string,
  bookItemId?: string
): Promise<QnaMedia> {
  const [author, book] = await Promise.all([
    authorItemId
      ? wfFetch(`/collections/${AUTHORS_COLLECTION_ID}/items/${authorItemId}`).catch(err => {
          console.error('[webflow] author media fetch failed:', err)
          return null
        })
      : null,
    bookItemId
      ? wfFetch(`/collections/${BOOKS_COLLECTION_ID}/items/${bookItemId}`).catch(err => {
          console.error('[webflow] book media fetch failed:', err)
          return null
        })
      : null,
  ])

  const headshot = author?.fieldData?.['author-headshot']
  const cover    = book?.fieldData?.['book-thumbnail']

  return {
    authorPhotoUrl: linkUrl(headshot),
    authorPhotoAlt: author?.fieldData?.['alt-text-for-image'] || author?.fieldData?.name,
    bookCoverUrl:   linkUrl(cover),
    bookCoverAlt:   book?.fieldData?.['alt-text-for-image'] || book?.fieldData?.name,
  }
}

/**
 * Writes the Editorial Q&A field to the item's staged (working) copy.
 * Webflow keeps a working copy separate from the live site — this PATCH does
 * not go live until the item or site is explicitly published. That publish
 * step stays a separate, Cam-triggered action (see api/qna-publish.ts).
 */
export async function writeEditorialQna(authorItemId: string, html: string): Promise<void> {
  await wfFetch(`/collections/${AUTHORS_COLLECTION_ID}/items/${authorItemId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fieldData: { 'editorial-q-a': html },
    }),
  })
}
