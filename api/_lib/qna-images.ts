/*
 * Author photographs in the post body: where they sit, and how they are written.
 *
 * WHY POSITION IS A FIELD AND NOT A MARKER IN THE TEXT
 * The obvious design is a token in the answer - [IMAGE: beach.jpg] - that the
 * publish step swaps out. It is wrong here for two reasons, and the second is
 * the one that settles it:
 *
 *   1. It edits the author's words, which nothing in this tool has ever done.
 *   2. It breaks the spoken-answer guards. checkClean counts vocabulary the
 *      author did not say, and a token inside an answer is exactly that. It
 *      would eat the 5% budget and push real clean-ups into rejection.
 *
 * So an image is a property of a Q&A item, the draft stays the deterministic
 * JSON the publish step can render without parsing prose, and the author's
 * answer is untouched either way.
 *
 * WHY WEBFLOW'S OWN CLASS NAMES
 * The blog template already styles w-richtext-align-*. Writing the figure in
 * the shape Webflow writes it means a photograph lands correctly with no new
 * CSS and no Designer visit - the same reasoning as the headshot figure in
 * qna-post. Penelope's published post uses align-normal and align-center for
 * exactly this.
 *
 * No env vars.
 */

/** Webflow's five, and nothing else. An unknown value is not styled at all. */
export const ALIGNMENTS = ['normal', 'center', 'fullwidth', 'floatleft', 'floatright'] as const
export type Alignment = (typeof ALIGNMENTS)[number]

export const DEFAULT_ALIGNMENT: Alignment = 'fullwidth'

/**
 * A float that fills the column is not a float, it is a full-width image with
 * the text jammed against it. Webflow's editor writes a width when a person
 * drags one; this is that width, chosen once.
 */
const FLOAT_WIDTH = 320

export interface ImageSpec {
  /** Storage path, which is also the handle the admin page and Airtable share. */
  file: string
  align: Alignment
  caption: string
  alt: string
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function isAlignment(v: unknown): v is Alignment {
  return typeof v === 'string' && (ALIGNMENTS as readonly string[]).includes(v)
}

/**
 * Whatever the draft screen sent, reduced to something publishable or nothing.
 *
 * Returns null rather than a half-filled spec: an image with no file is not an
 * image, and rendering a figure around an empty src puts a broken picture in a
 * published post.
 */
export function sanitiseImageSpec(input: unknown): ImageSpec | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>

  const file = String(raw.file ?? '').trim()
  if (!file) return null

  return {
    file,
    align:   isAlignment(raw.align) ? raw.align : DEFAULT_ALIGNMENT,
    caption: String(raw.caption ?? '').trim(),
    // Capped because alt text is read aloud, and a paragraph of it is worse
    // for a screen reader than a short sentence.
    alt:     String(raw.alt ?? '').trim().slice(0, 300),
  }
}

/**
 * One figure, in the shape Webflow writes them.
 *
 * The url is whatever host the image will be served from at publish time -
 * never a Supabase signed URL and never an Airtable attachment URL, both of
 * which expire within hours. See qna-library.
 */
export function figureHtml(url: string, spec: ImageSpec): string {
  if (!url?.trim()) return ''

  // Alt text is required for accessibility and for the image to mean anything
  // in search. Falling back to the caption is better than an empty alt, and an
  // empty alt is better than repeating the filename.
  const alt = spec.alt || spec.caption || ''
  const floats = spec.align === 'floatleft' || spec.align === 'floatright'
  const width = floats ? ` width="${FLOAT_WIDTH}"` : ''

  const caption = spec.caption
    ? `<figcaption>${esc(spec.caption)}</figcaption>`
    : ''

  return (
    `<figure class="w-richtext-align-${spec.align} w-richtext-figure-type-image">` +
    `<div><img src="${esc(url)}" alt="${esc(alt)}"${width}></div>` +
    caption +
    `</figure>`
  )
}

/**
 * Every image a draft refers to, in the order they will appear.
 *
 * The publish step needs this before it renders anything, because each one has
 * to be re-hosted onto a permanent URL first and that is worth doing in one
 * pass rather than one request at a time in the middle of building HTML.
 */
export function imagesInDraft(draft: {
  lead?: unknown
  items?: Array<{ image?: unknown }>
}): ImageSpec[] {
  const out: ImageSpec[] = []
  const lead = sanitiseImageSpec(draft?.lead)
  if (lead) out.push(lead)
  for (const item of draft?.items ?? []) {
    const spec = sanitiseImageSpec(item?.image)
    if (spec) out.push(spec)
  }
  return out
}
