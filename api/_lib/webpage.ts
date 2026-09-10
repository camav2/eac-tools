/*
 * Plain-text extraction from a public web page — Author Editorial Q&A.
 *
 * The Webflow author record carries an `author-website` link. That site is
 * usually where an author says what they actually do, in their own words —
 * far richer than the one-paragraph CMS summary. Reading it makes the
 * generated questions specific rather than generic.
 *
 * Deliberately dependency-free: no Cheerio, no Readability. A regex strip is
 * crude, but the consumer is a language model, not a renderer — leftover
 * navigation noise costs a few tokens and nothing else. Adding a parser to
 * the bundle for that would be the wrong trade.
 *
 * Everything here is BEST-EFFORT. An author's site being down, slow, or
 * bot-walled must never block question generation; callers get '' and carry
 * on with the CMS summaries alone.
 *
 * No env vars required.
 */

/** Per-request ceiling. Two pages worst case, so the caller stays well inside
 *  its function timeout even when a site is slow. */
const FETCH_TIMEOUT_MS = 8000

/**
 * Stop reading the body past this — a backstop against a pathological page,
 * not a tuning knob.
 *
 * Set generously on purpose. Site builders put a megabyte of bootstrap JSON
 * ahead of the visible copy, so a tight cap truncates before any prose is
 * reached: a real Wix author site is 1.5 MB and its body text starts past
 * 600 KB. The strip that follows is what actually controls the size.
 */
const MAX_BYTES = 4_000_000

/** What the model actually receives. Roughly 3-4k tokens per page — enough
 *  for substance, small enough that the site never crowds out the prompt. */
const MAX_CHARS_PER_PAGE = 8000
const MAX_CHARS_TOTAL = 14_000

/** Presented to the site as a real client. Some hosts 403 an empty UA. */
const USER_AGENT =
  'Mozilla/5.0 (compatible; EAC-EditorialQnA/1.0; +https://expertauthor.community)'

/**
 * Rejects anything that isn't a public http(s) URL.
 *
 * The URL comes from our own CMS, so this is not the main line of defence —
 * but a fetch driven by a stored field is exactly the shape of an SSRF, and
 * the check is three lines.
 */
function isPublicHttpUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false

  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (/^169\.254\./.test(host)) return false
  return true
}

/** The handful of entities a stripped page actually produces. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
}

/**
 * Truncating at MAX_BYTES can sever an open <script>/<style> from its closing
 * tag. The paired rule below then finds no match and dumps the whole
 * stylesheet into the "text" — observed on Wix sites, which are large enough
 * to hit the cap mid-stylesheet.
 *
 * Cutting from the first genuinely unclosed opener is correct, because
 * everything after it is inside that element. The check for a matching close
 * is what makes it safe: a blanket "opener to end of document" rule also
 * matches a self-closing <svg/> in the nav and deletes the entire page.
 */
function dropUnclosedRawBlock(html: string): string {
  // One lowercased copy plus indexOf, rather than a fresh regex test against
  // html.slice(m.index) per opener — that copies the tail of a multi-megabyte
  // document once for every script tag on the page.
  const lower = html.toLowerCase()
  const openers = /<(script|style)\b[^>]*(?<!\/)>/gi
  let m: RegExpExecArray | null
  while ((m = openers.exec(html)) !== null) {
    if (lower.indexOf(`</${m[1].toLowerCase()}`, m.index) === -1) {
      return html.slice(0, m.index)
    }
  }
  return html
}

/**
 * HTML → readable text.
 *
 * Script and style contents are dropped entirely — pure noise, and often the
 * bulk of the bytes. nav/header/footer/form go too: on a personal site those
 * are the same menu on every page, which would otherwise be the only thing
 * two fetched pages have in common. SVG needs no special case — its content
 * is all attributes, so the generic tag strip leaves nothing behind.
 */
export function htmlToText(html: string): string {
  const text = dropUnclosedRawBlock(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|form|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    // Keep block boundaries as line breaks so headings don't glue to body copy.
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  return decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The page's <title>, used to label each block for the model. */
function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

interface FetchedPage {
  url: string
  title: string
  text: string
  html: string
}

/**
 * One page, or null on any failure.
 *
 * Reads the body as a stream so an unexpectedly huge page is abandoned at
 * MAX_BYTES rather than buffered whole.
 */
async function fetchPage(url: string): Promise<FetchedPage | null> {
  if (!isPublicHttpUrl(url)) return null

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!res.ok) {
      console.warn(`[webpage] ${url} returned ${res.status}`)
      return null
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      console.warn(`[webpage] ${url} is ${contentType || 'untyped'} — skipping`)
      return null
    }

    const raw = await res.text()
    const html = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw
    const text = htmlToText(html)
    if (text.length < 200) return null // a shell page; nothing to learn from it

    return {
      url: res.url || url,
      title: titleOf(html),
      text: text.slice(0, MAX_CHARS_PER_PAGE),
      html,
    }
  } catch (err) {
    console.warn(`[webpage] ${url} fetch failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Finds the site's About page from the homepage markup.
 *
 * On an author's site the About page is where the bio, the story and the
 * positioning live — usually the single most useful page for question
 * generation, and rarely the homepage.
 */
function findAboutUrl(page: FetchedPage): string | null {
  const anchors = page.html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)
  for (const m of anchors) {
    const href = m[1]
    const label = htmlToText(m[2]).toLowerCase()
    if (!/about|my-story|meet|bio/i.test(`${href} ${label}`)) continue
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue
    try {
      const abs = new URL(href, page.url)
      if (abs.href.replace(/\/$/, '') === page.url.replace(/\/$/, '')) continue
      if (abs.hostname !== new URL(page.url).hostname) continue // stay on their site
      return abs.href
    } catch {
      continue
    }
  }
  return null
}

/**
 * Homepage + About page, as one labelled text block for the prompt.
 *
 * Two pages is the deliberate ceiling: it captures what an author says about
 * themselves without turning question generation into a crawl.
 *
 * Returns '' when nothing readable came back — never throws.
 */
export async function fetchAuthorWebsiteText(url?: string | null): Promise<string> {
  if (!url) return ''

  const home = await fetchPage(url)
  if (!home) return ''

  const pages: FetchedPage[] = [home]

  const aboutUrl = findAboutUrl(home)
  if (aboutUrl) {
    const about = await fetchPage(aboutUrl)
    if (about) pages.push(about)
  }

  const combined = pages
    .map(p => `--- ${p.title || p.url} (${p.url}) ---\n${p.text}`)
    .join('\n\n')

  console.log(
    `[webpage] ${url}: ${pages.length} page(s), ${combined.length} chars` +
    (aboutUrl ? ` (about: ${aboutUrl})` : '')
  )

  return combined.slice(0, MAX_CHARS_TOTAL)
}
