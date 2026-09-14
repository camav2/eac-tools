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

// ── Blog ─────────────────────────────────────────────────────────────────────

const BLOG_COLLECTION_ID = '6870006917acd593b9a7f477'

/** Cameron's Blog Authors record. The byline on every published interview. */
const BLOG_AUTHOR_CAMERON = '6a6acf05de94fe5c48050dd4'

/** Option ID, not the label — Webflow rejects the label. "Author Community". */
const BLOG_CATEGORY_AUTHOR_COMMUNITY = '2b26c8d83a838028e2dc0e4815f235a0'

export interface BlogPostInput {
  title: string
  slug: string
  bodyHtml: string
  description: string
  /** The author's headshot, reused as the post image. Optional. */
  imageUrl?: string | null
}

export interface BlogPostRef {
  id: string
  slug: string
}

/**
 * Creates the interview as a DRAFT blog post.
 *
 * Draft on purpose. Cam authorises anything going live on the public site, so
 * this only ever stages it; publishBlogPost is the separate, deliberate step.
 *
 * Webflow rejects a duplicate slug with a 400 rather than adjusting it, and its
 * own slug filter is not reliable enough to check beforehand, so a collision is
 * handled by retrying with a suffix. Second and third attempts are enough: the
 * slug carries an author's name, and a fourth clash means something is wrong
 * that a bigger number would only hide.
 */
export async function createBlogPost(input: BlogPostInput): Promise<BlogPostRef> {
  const fieldData: Record<string, unknown> = {
    name:                input.title,
    slug:                input.slug,
    'full-blog-post':    input.bodyHtml,
    'short-description': input.description,
    'blog-author':       BLOG_AUTHOR_CAMERON,
    category:            BLOG_CATEGORY_AUTHOR_COMMUNITY,
  }
  // Webflow re-hosts a plain URL on its own CDN, which is the only way to set
  // an image without the Designer app running.
  if (input.imageUrl) fieldData['main-image'] = { url: input.imageUrl }

  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? input.slug : `${input.slug}-${attempt + 1}`
    try {
      const data = await wfFetch(`/collections/${BLOG_COLLECTION_ID}/items`, {
        method: 'POST',
        body: JSON.stringify({ isDraft: true, fieldData: { ...fieldData, slug } }),
      })
      return { id: data.id, slug: data.fieldData?.slug ?? slug }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const taken = /already (exists|in database)|Unique value/i.test(msg)
      // An archived item keeps its slug while being invisible to a listing,
      // so "taken" can be true for a post nobody can see.
      if (!taken || attempt === 2) throw err
      console.warn(`[webflow] slug "${slug}" taken, retrying`)
    }
  }
  throw new Error('Could not find a free slug for the blog post')
}

/** Live on the site. Separate from creation, and only ever Cam's call. */
export async function publishBlogPost(itemId: string): Promise<void> {
  await wfFetch(`/collections/${BLOG_COLLECTION_ID}/items/publish`, {
    method: 'POST',
    body: JSON.stringify({ itemIds: [itemId] }),
  })
}

/**
 * Finds an already-staged post by trying the slugs createBlogPost would have
 * used, in the order it would have used them.
 *
 * This exists so nothing has to be stored in Airtable. The alternative was a
 * "Blog Item ID" column, which meant a hand-made field standing between the
 * feature and working at all - and the post is already addressable by a slug
 * derived from the author's own name.
 *
 * Listing and matching locally rather than using Webflow's slug filter: that
 * filter has returned zero matches for a slug Webflow then rejected as a
 * duplicate, so it cannot be trusted for exactly this question.
 */
export async function findBlogPostBySlugs(slugs: string[]): Promise<{ id: string; slug: string; name: string; isDraft: boolean } | null> {
  const items = await listAllItems(BLOG_COLLECTION_ID)
  for (const slug of slugs) {
    const hit = items.find((i: any) => i.fieldData?.slug === slug)
    if (hit) {
      return {
        id:      hit.id,
        slug:    hit.fieldData?.slug ?? slug,
        name:    hit.fieldData?.name ?? '',
        isDraft: Boolean(hit.isDraft),
      }
    }
  }
  return null
}

/** The post as it stands, for reading back the slug Webflow actually kept. */
export async function getBlogPost(itemId: string): Promise<{ id: string; slug: string; name: string; isDraft: boolean }> {
  const data = await wfFetch(`/collections/${BLOG_COLLECTION_ID}/items/${itemId}`)
  return {
    id:      data.id,
    slug:    data.fieldData?.slug ?? '',
    name:    data.fieldData?.name ?? '',
    isDraft: Boolean(data.isDraft),
  }
}

/** Publishes the author's own item, so the summary and link go live with it. */
export async function publishAuthorItem(authorItemId: string): Promise<void> {
  await wfFetch(`/collections/${AUTHORS_COLLECTION_ID}/items/publish`, {
    method: 'POST',
    body: JSON.stringify({ itemIds: [authorItemId] }),
  })
}

/** The author's headshot, reused as the blog post's main image. */
export async function getAuthorHeadshotUrl(authorItemId: string): Promise<string | null> {
  try {
    const data = await wfFetch(`/collections/${AUTHORS_COLLECTION_ID}/items/${authorItemId}`)
    return data.fieldData?.['author-headshot']?.url ?? null
  } catch (err) {
    console.error('[webflow] headshot lookup failed:', err)
    return null
  }
}

// ── What the end of a published interview needs ──────────────────────────────

export interface PostFooterData {
  authorName?: string
  authorLinkedin?: string
  authorWebsite?: string
  bookTitle?: string
  bookCoverUrl?: string
  bookCoverAlt?: string
  /** Where to buy, best first. Booktopia before Amazon: it is the Australian
   *  shop, and these are overwhelmingly Australian authors and readers. */
  buyLinks: Array<{ label: string; url: string }>
  /** Cover on a background, which reads better as a post image than a bare
   *  cover floating on white. */
  bookHeroUrl?: string
}

export async function getPostFooterData(
  authorItemId?: string,
  bookItemId?: string
): Promise<PostFooterData> {
  const [author, book] = await Promise.all([
    authorItemId
      ? wfFetch(`/collections/${AUTHORS_COLLECTION_ID}/items/${authorItemId}`).catch(err => {
          console.error('[webflow] author footer fetch failed:', err)
          return null
        })
      : null,
    bookItemId
      ? wfFetch(`/collections/${BOOKS_COLLECTION_ID}/items/${bookItemId}`).catch(err => {
          console.error('[webflow] book footer fetch failed:', err)
          return null
        })
      : null,
  ])

  const a = author?.fieldData ?? {}
  const b = book?.fieldData ?? {}

  const buyLinks: Array<{ label: string; url: string }> = []
  const push = (label: string, value: unknown) => {
    const url = linkUrl(value)
    if (url) buyLinks.push({ label, url })
  }
  // Shops only, and only these two.
  //
  // `view-on-website` was in here labelled "the publisher" and it is not the
  // publisher - on Penelope's book it points at her own site, so the post
  // offered "available from the publisher" and sent the reader to the author
  // page they had just come from. A field whose contents vary by record cannot
  // carry a fixed label.
  push('Booktopia', b['view-on-booktopia'])
  push('Amazon',    b['view-on-amazon'])

  return {
    authorName:     a.name,
    authorLinkedin: linkUrl(a.linkedin),
    authorWebsite:  linkUrl(a['author-website']),
    bookTitle:      b.name,
    bookCoverUrl:   b['book-thumbnail']?.url,
    bookCoverAlt:   b['alt-text-for-image'] || b.name,
    bookHeroUrl:    b.image?.url,
    buyLinks,
  }
}

// ── The "best business books" round-up ───────────────────────────────────────

export interface BlogPostSummary {
  id: string
  name: string
  slug: string
  isDraft: boolean
}

/** Every blog post, titles and slugs only, for locating the round-up. */
export async function listBlogPosts(): Promise<Array<BlogPostSummary & { bodyHtml: string }>> {
  const items = await listAllItems(BLOG_COLLECTION_ID)
  return items.map((i: any) => ({
    id:       i.id,
    name:     i.fieldData?.name ?? '',
    slug:     i.fieldData?.slug ?? '',
    isDraft:  Boolean(i.isDraft),
    bodyHtml: i.fieldData?.['full-blog-post'] ?? '',
  }))
}

/**
 * Rewrites one post's body.
 *
 * Only ever called with HTML that came from that same post a moment earlier
 * and had exactly one link inserted. Nothing here composes a body from
 * scratch, because the round-up is a live article that ranks and this tool has
 * no business rewriting anyone's prose.
 */
export async function writeBlogBody(itemId: string, bodyHtml: string): Promise<void> {
  await wfFetch(`/collections/${BLOG_COLLECTION_ID}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fieldData: { 'full-blog-post': bodyHtml } }),
  })
}

/**
 * Rewrites an interview post that has already been staged.
 *
 * Needed because staging is not a one-shot: Cam re-reads the draft, changes
 * the headline, picks a different photograph, and expects the post to catch
 * up. Refusing the second attempt - which is what happened before this - left
 * him deleting items in Webflow by hand to get another go.
 *
 * The slug is deliberately NOT updated. It is how this tool finds the post
 * again, and changing it would orphan the staged item and break any link
 * already pointing at it, including the one on the author's page.
 */
export async function updateBlogPost(itemId: string, input: Omit<BlogPostInput, 'slug'>): Promise<void> {
  const fieldData: Record<string, unknown> = {
    name:                input.title,
    'full-blog-post':    input.bodyHtml,
    'short-description': input.description,
  }
  if (input.imageUrl) fieldData['main-image'] = { url: input.imageUrl }

  await wfFetch(`/collections/${BLOG_COLLECTION_ID}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fieldData }),
  })
}
