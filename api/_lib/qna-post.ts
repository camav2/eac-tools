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

  for (const item of draft?.items ?? []) {
    const q = String(item?.question ?? '').trim()
    const a = paragraphs(item?.answer ?? '')
    if (!q && !a.length) continue
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
