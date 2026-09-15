/*
 * Linking the "28 best business books" round-up to a published interview.
 *
 * This edits a live post that already ranks, so the rules are stricter than
 * anywhere else in this tool:
 *
 *  - It links ONE mention, the first, and leaves the rest alone. Linking every
 *    occurrence of a name turns an article into a link farm.
 *  - It never touches text already inside an <a>. Nesting anchors is invalid
 *    HTML and browsers resolve it by silently dropping one of them.
 *  - It never matches inside a tag, so a name appearing in an alt attribute or
 *    a URL cannot be mangled into broken markup.
 *  - It is idempotent: if the interview is already linked from the post, it
 *    reports "already linked" rather than adding a second one.
 *
 * The matching is deliberately literal. A near miss here rewrites somebody
 * else's published article, and a name that does not match is a link Cam adds
 * by hand in thirty seconds.
 *
 * No env vars.
 */

/** Splits HTML into tags and the text between them, in order. */
function tokenise(html: string): Array<{ tag: boolean; text: string }> {
  const out: Array<{ tag: boolean; text: string }> = []
  const re = /<[^>]*>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) out.push({ tag: false, text: html.slice(last, m.index) })
    out.push({ tag: true, text: m[0] })
    last = m.index + m[0].length
  }
  if (last < html.length) out.push({ tag: false, text: html.slice(last) })
  return out
}

function escAttr(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** A name as a regex, tolerant of extra spacing between the parts. */
function namePattern(name: string): RegExp | null {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const escaped = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('\\s+'), 'i')
}

export interface LinkResult {
  html: string
  /** 'linked' | 'already' | 'not-found' */
  outcome: 'linked' | 'already' | 'not-found'
  /** The sentence the link landed in, for showing Cam what changed. */
  context?: string
}

export function linkNameInHtml(html: string, name: string, url: string): LinkResult {
  const source = String(html ?? '')
  const pattern = namePattern(name)
  if (!pattern || !url) return { html: source, outcome: 'not-found' }

  // Already pointing at the interview: adding a second link would be the same
  // mistake twice.
  if (source.includes(url)) return { html: source, outcome: 'already' }

  const tokens = tokenise(source)
  let depth = 0
  let done = false

  const rebuilt = tokens.map(t => {
    if (t.tag) {
      if (/^<a[\s>]/i.test(t.text)) depth++
      else if (/^<\/a\s*>/i.test(t.text)) depth = Math.max(0, depth - 1)
      return t.text
    }
    if (done || depth > 0) return t.text

    const m = pattern.exec(t.text)
    if (!m) return t.text

    done = true
    const before = t.text.slice(0, m.index)
    const after = t.text.slice(m.index + m[0].length)
    return `${before}<a href="${escAttr(url)}">${m[0]}</a>${after}`
  }).join('')

  if (!done) return { html: source, outcome: 'not-found' }

  // A window around the match, so the preview shows where it landed rather
  // than asking Cam to trust it.
  const at = rebuilt.indexOf(`<a href="${escAttr(url)}">`)
  const context = rebuilt
    .slice(Math.max(0, at - 120), at + 200)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return { html: rebuilt, outcome: 'linked', context }
}

/**
 * Identifies the round-up among the blog posts.
 *
 * Matched on the title rather than a hard-coded id, because the number in it
 * changes: "28 best business books" was 25 once and will be 30. A pinned id
 * would survive that; a pinned slug would not, and neither would a person
 * remembering to come back and update a constant.
 */
export function findRoundup<T extends { id: string; name: string; slug: string }>(
  posts: T[]
): T | null {
  // "best business books" was a guess and it was wrong. The post is actually
  // "28 new business books you should read in 2026", so matching on "best"
  // would never have found it - and the button would have quietly reported
  // that no round-up existed, forever.
  //
  // Matching on "business books" alone is what survives the wording changing
  // again, which it does every year along with the number.
  const re = /business[\s-]+books/i
  const matches = posts.filter(
    p => re.test(String(p?.name ?? '')) || re.test(String(p?.slug ?? ''))
  )
  if (!matches.length) return null

  // A round-up counts its books, so a title starting with a number is the
  // round-up rather than an essay that happens to mention business books.
  return matches.find(p => /^\d/.test(String(p?.name ?? '').trim())) ?? matches[0]
}
