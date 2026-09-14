/*
 * Turning an approved draft into a blog post and an author-page summary.
 *
 * Pure functions, deliberately. Everything here is string shaping that is
 * cheap to get subtly wrong - a slug that collides, an answer whose blank
 * lines collapse into one wall of text, an apostrophe that arrives as &amp;
 * on a live page - and none of it needs Webflow or Airtable to be tested.
 * The endpoint that calls this does the talking to other systems.
 *
 * No env vars.
 */

import { mainTitle } from '../qna-voice'

export interface DraftItem { question: string; answer: string }
export interface Draft { standfirst: string; items: DraftItem[]; editorNotes?: string }

export const BLOG_BASE_URL = 'https://www.expertauthor.community/blog'

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The default headline, which Cam edits before anything is created.
 *
 * Deterministic rather than another trip to the model: a title is the one
 * thing an editor always wants to change anyway, so generating it would spend
 * a call and a wait on a suggestion that gets overwritten.
 *
 * The subtitle is dropped for the same reason Kelly's voice drops it - "Benita
 * Bensch on Seen Again: Light on Matrescence" has two colons doing different
 * jobs and reads like a cataloguing error.
 */
export function defaultTitle(authorName: string, bookTitle: string): string {
  const who = String(authorName ?? '').trim()
  const book = mainTitle(bookTitle)
  if (!who) return book
  if (!book) return who
  return `${who} on ${book}`
}

/**
 * A URL-safe slug.
 *
 * Webflow rejects a duplicate slug outright, and its own slug filter is not
 * trustworthy for checking first, so the caller handles the collision. This
 * only has to produce something valid and readable.
 */
export function slugify(title: string): string {
  const s = String(title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’]/g, '')   // apostrophes join, they don't separate
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return s || 'interview'
}

/** Paragraphs from an answer, keeping the author's own breaks. */
function paragraphs(text: string): string[] {
  return String(text ?? '')
    .split(/\n\s*\n|\n/)
    .map(t => t.trim())
    .filter(Boolean)
}

/**
 * The post body.
 *
 * Questions are h3 rather than h2: site H2 is 28px and set for section
 * headings, which makes every question shout over the answer beneath it.
 *
 * editorNotes never appears. They are notes to Cam about the edit - a flagged
 * mismatch, a guess at what an answer meant - and publishing them would put
 * our working-out on the author's page.
 */
export function postBodyHtml(draft: Draft): string {
  const parts: string[] = []

  const stand = String(draft?.standfirst ?? '').trim()
  if (stand) {
    parts.push(`<p><em>${esc(stand)}</em></p>`)
    parts.push('<hr>')
  }

  // Space between each pair, so an answer cannot run into the next question.
  // A rule was too heavy: six of them down a page turned the interview into a
  // form. An empty paragraph is the only spacing that survives a Webflow rich
  // text field, which strips inline styles and has no margin set on h3.
  //
  // If the h3 margin is ever set in site custom code, drop this and the
  // spacing gets better for free.
  let first = true
  for (const item of draft?.items ?? []) {
    const q = String(item?.question ?? '').trim()
    const a = paragraphs(item?.answer ?? '')
    if (!q && !a.length) continue
    // Never before the first pair: the standfirst already put a rule there.
    if (!first) parts.push('<p>&nbsp;</p>')
    first = false
    if (q) parts.push(`<h3>${esc(q)}</h3>`)
    for (const p of a) parts.push(`<p>${esc(p)}</p>`)
  }

  return parts.join('\n')
}

/**
 * The meta description.
 *
 * Cut at a word boundary, because Google truncating mid-word looks careless
 * in a way that a slightly shorter line does not.
 */
export function metaDescription(draft: Draft, limit = 155): string {
  const stand = String(draft?.standfirst ?? '').replace(/\s+/g, ' ').trim()
  if (stand.length <= limit) return stand
  const cut = stand.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '') + '…'
}

/**
 * What goes on the author's own page: the standfirst, then a way through to
 * the full piece.
 *
 * A summary with no link is a dead end, and the whole point of the author page
 * carrying this is to send people to the interview.
 */
export function authorSummaryHtml(draft: Draft, slug: string): string {
  const stand = String(draft?.standfirst ?? '').trim()
  const url = `${BLOG_BASE_URL}/${encodeURIComponent(slug)}`
  const parts: string[] = []
  if (stand) parts.push(`<p>${esc(stand)}</p>`)
  parts.push(`<p><a href="${esc(url)}">Read the full interview</a></p>`)
  return parts.join('\n')
}

/**
 * Every slug createBlogPost might have settled on, in order.
 *
 * The base slug comes from the author's name and book, never from the headline
 * Cam edits, so it stays derivable from the pipeline row alone. The suffixed
 * ones mirror the collision retry: first choice, then -2, then -3.
 */
export function candidateSlugs(authorName: string, bookTitle: string): string[] {
  const base = slugify(defaultTitle(authorName, bookTitle))
  return [base, `${base}-2`, `${base}-3`]
}

export function blogUrl(slug: string): string {
  return `${BLOG_BASE_URL}/${encodeURIComponent(slug)}`
}

/* ── The end of the post ─────────────────────────────────────────────────────
 *
 * Buy their book, then connect with them. Cam's call, and it is the only
 * ending consistent with the rest of the series: this is not a testimonial,
 * so it does not end by selling EAC. It ends by being useful to the author,
 * which is also what makes them want to share it - and their network is where
 * the next members come from anyway.
 */

export interface PostFooter {
  authorName?: string
  authorLinkedin?: string
  bookTitle?: string
  bookCoverUrl?: string
  bookCoverAlt?: string
  buyLinks?: Array<{ label: string; url: string }>
}

function firstNameOf(full?: string): string {
  return String(full ?? '').trim().split(/\s+/)[0] || ''
}

/** "Booktopia", "Booktopia or Amazon", "Booktopia, Amazon or the publisher". */
function joinLinks(links: Array<{ label: string; url: string }>): string {
  const parts = links.map(l => `<a href="${esc(l.url)}">${esc(l.label)}</a>`)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
}

/**
 * A "buy the book" link that points at our own site is not a buy link.
 *
 * This happened: a Books field holding the author's own website was offered as
 * "the publisher", so the post said "available from the publisher" and sent
 * the reader back to the author page they had arrived from. Dropping the field
 * fixed that one; this stops the next one, whichever field it comes from.
 */
function isOffSite(url: string): boolean {
  return !/(^|\/\/|\.)expertauthor\.community/i.test(String(url ?? ''))
}

export function footerHtml(f: PostFooter): string {
  const parts: string[] = []
  const book = String(f?.bookTitle ?? '').trim()
  const links = (f?.buyLinks ?? []).filter(l => l?.url && isOffSite(l.url))
  const first = firstNameOf(f?.authorName)

  if (!book && !links.length && !f?.authorLinkedin) return ''

  parts.push('<hr>')

  if (book) {
    // The cover sits with the buy line rather than alone: a cover with no way
    // to act on it is decoration, and this is the one place the post asks for
    // something.
    // Sized down hard. A cover in a rich text field fills the column by
    // default, which put a full-width book jacket in the middle of the page
    // and dwarfed the interview it was meant to sit under.
    //
    // Both the attribute and the inline style, because which of them a
    // Webflow rich text field preserves is not something to gamble a live
    // page on - whichever survives does the job, and both surviving is
    // harmless.
    if (f.bookCoverUrl) {
      parts.push(
        `<p><img src="${esc(f.bookCoverUrl)}" alt="${esc(f.bookCoverAlt || book)}" ` +
        `width="150" style="width:150px;max-width:150px;height:auto;"></p>`
      )
    }
    parts.push(
      links.length
        ? `<p><strong>${esc(book)}</strong> is available from ${joinLinks(links)}.</p>`
        : `<p><strong>${esc(book)}</strong></p>`
    )
  } else if (links.length) {
    parts.push(`<p>The book is available from ${joinLinks(links)}.</p>`)
  }

  if (f?.authorLinkedin && first) {
    parts.push(
      `<p>You can connect with ${esc(first)} ` +
      `<a href="${esc(f.authorLinkedin)}">on LinkedIn</a>.</p>`
    )
  }

  return parts.join('\n')
}

/**
 * The post image, best available first.
 *
 * A photograph the author sent beats everything: it is theirs, it is specific,
 * and it is why the upload box exists. A headshot is the last resort because
 * every headshot looks like every other headshot and says nothing about the
 * book.
 */
export function choosePostImage(opts: {
  uploadedImageUrl?: string | null
  bookHeroUrl?: string | null
  bookCoverUrl?: string | null
  headshotUrl?: string | null
}): string | null {
  return opts.uploadedImageUrl
    || opts.bookHeroUrl
    || opts.bookCoverUrl
    || opts.headshotUrl
    || null
}
