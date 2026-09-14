/*
 * Turning an approved draft into a blog post.
 *
 * This output goes on a public page under an author's name, so the failures
 * worth pinning are the ones nobody would catch by glancing at a preview: an
 * apostrophe double-escaped into gibberish, an answer's paragraph breaks
 * collapsing into one wall, and the editor's private notes being published.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  authorSummaryHtml,
  candidateSlugs,
  choosePostImage,
  defaultTitle,
  footerHtml,
  metaDescription,
  postBodyHtml,
  slugify,
  type Draft,
} from '../api/_lib/qna-post'

const DRAFT: Draft = {
  standfirst: 'Benita Bensch spent four drafts turning fog into an argument.',
  items: [
    { question: 'What did writing it clarify?', answer: 'Living it was all fog.\n\nWriting it forced an order.' },
    { question: 'What surprised you?', answer: 'How slow the good part is.' },
  ],
  editorNotes: 'Q2 answer actually responds to a different question - check with Cam.',
}

test('title drops the subtitle', () => {
  // "Benita Bensch on Seen Again: Light on Matrescence" has two colons doing
  // different jobs and reads like a cataloguing error.
  assert.equal(
    defaultTitle('Benita Bensch', 'Seen Again: Light on Matrescence'),
    'Benita Bensch on Seen Again'
  )
})

test('title copes with a missing half', () => {
  assert.equal(defaultTitle('', 'Seen Again'), 'Seen Again')
  assert.equal(defaultTitle('Benita Bensch', ''), 'Benita Bensch')
})

test('slug is url-safe and keeps words apart', () => {
  assert.equal(slugify('Benita Bensch on Seen Again'), 'benita-bensch-on-seen-again')
  assert.equal(slugify('Kerryn Harvey on Mostly Ups'), 'kerryn-harvey-on-mostly-ups')
})

test('slug folds accents and joins on an apostrophe', () => {
  // O'Brien must not become o-brien: the apostrophe joins a name, it does not
  // separate one.
  assert.equal(slugify("Seán O'Brien on Wintering"), 'sean-obrien-on-wintering')
})

test('slug never comes back empty or trailing a hyphen', () => {
  assert.equal(slugify(''), 'interview')
  assert.equal(slugify('!!!'), 'interview')
  assert.doesNotMatch(slugify('A very ordinary title -- '), /-$/)
})

test('body keeps the author paragraph breaks', () => {
  const html = postBodyHtml(DRAFT)
  assert.match(html, /<p>Living it was all fog\.<\/p>/)
  assert.match(html, /<p>Writing it forced an order\.<\/p>/)
})

test('questions are h3, not h2', () => {
  // Site H2 is 28px and set for section headings; every question would shout
  // over the answer beneath it.
  const html = postBodyHtml(DRAFT)
  assert.match(html, /<h3>What did writing it clarify\?<\/h3>/)
  assert.doesNotMatch(html, /<h2>/)
})

test('editor notes are never published', () => {
  // They are working-out addressed to Cam. On a live page under the author's
  // name they would read as our doubts about their answers.
  const html = postBodyHtml(DRAFT)
  assert.doesNotMatch(html, /check with Cam/)
  assert.doesNotMatch(html, /editorNotes/)
})

test('body escapes markup in an answer', () => {
  const html = postBodyHtml({
    standfirst: '', items: [{ question: 'Q', answer: '<script>alert(1)</script>' }],
  })
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('body skips an item with nothing in it', () => {
  const html = postBodyHtml({ standfirst: '', items: [
    { question: '', answer: '' },
    { question: 'Real one', answer: 'Real answer.' },
  ] })
  assert.equal((html.match(/<h3>/g) || []).length, 1)
})

test('meta description cuts on a word, not mid-word', () => {
  const long = { standfirst: 'word '.repeat(60).trim(), items: [] }
  const d = metaDescription(long, 60)
  assert.ok(d.length <= 62, 'stays near the limit')
  assert.match(d, /…$/)
  assert.doesNotMatch(d, /wor…$/)
})

test('meta description leaves a short standfirst alone', () => {
  assert.equal(metaDescription(DRAFT), DRAFT.standfirst)
  assert.doesNotMatch(metaDescription(DRAFT), /…/)
})

test('author summary always carries a link', () => {
  // A summary with no way through is a dead end, and sending people to the
  // interview is the only reason the author page carries this.
  const html = authorSummaryHtml(DRAFT, 'benita-bensch-on-seen-again')
  assert.match(html, /href="https:\/\/www\.expertauthor\.community\/blog\/benita-bensch-on-seen-again"/)
  assert.match(html, /Read the full interview/)
})

test('author summary still links when there is no standfirst', () => {
  const html = authorSummaryHtml({ standfirst: '', items: [] }, 'a-slug')
  assert.match(html, /Read the full interview/)
})

test('candidate slugs mirror the collision retry, in order', () => {
  // These are how a staged post is found again. If they drift from what
  // createBlogPost actually tries, a post exists that nothing can locate, and
  // the next stage makes a second one.
  assert.deepEqual(
    candidateSlugs('Benita Bensch', 'Seen Again: Light on Matrescence'),
    ['benita-bensch-on-seen-again', 'benita-bensch-on-seen-again-2', 'benita-bensch-on-seen-again-3']
  )
})

test('candidate slugs ignore an edited headline', () => {
  // The base slug comes from the row, never from the headline Cam types, so a
  // staged post stays findable from the pipeline alone.
  const a = candidateSlugs('Benita Bensch', 'Seen Again: Light on Matrescence')[0]
  assert.equal(a, slugify(defaultTitle('Benita Bensch', 'Seen Again: Light on Matrescence')))
})

/* ── The end of the post ──
 * Buy their book, connect with them. No EAC pitch: the series is built on not
 * being a testimonial, and an ending that sold EAC would undo the reason the
 * editor cuts praise from the answers.
 */

test('the ending offers the book and the author, and never EAC', () => {
  const html = footerHtml({
    authorName: 'Penelope Barr',
    authorLinkedin: 'https://linkedin.com/in/penelopebarr',
    bookTitle: 'Win the Night to Win the Day',
    buyLinks: [{ label: 'Booktopia', url: 'https://booktopia.test/win' }],
  })
  assert.match(html, /Win the Night to Win the Day/)
  assert.match(html, /booktopia\.test/)
  assert.match(html, /linkedin\.com\/in\/penelopebarr/)
  assert.doesNotMatch(html, /Expert Author Community|join|membership/i)
})

test('connects by first name', () => {
  const html = footerHtml({
    authorName: 'Penelope Barr',
    authorLinkedin: 'https://linkedin.test/p',
  })
  assert.match(html, /connect with Penelope/)
  assert.doesNotMatch(html, /connect with Penelope Barr/)
})

test('reads as a sentence with two or three shops', () => {
  const two = footerHtml({
    bookTitle: 'A Book',
    buyLinks: [
      { label: 'Booktopia', url: 'https://b.test' },
      { label: 'Amazon', url: 'https://a.test' },
    ],
  })
  assert.match(two, /Booktopia<\/a> or <a[^>]*>Amazon/)

  const three = footerHtml({
    bookTitle: 'A Book',
    buyLinks: [
      { label: 'Booktopia', url: 'https://b.test' },
      { label: 'Amazon', url: 'https://a.test' },
      { label: 'the publisher', url: 'https://p.test' },
    ],
  })
  assert.match(three, /Booktopia<\/a>, <a[^>]*>Amazon<\/a> or <a[^>]*>the publisher/)
})

test('no LinkedIn means no LinkedIn line, not an empty one', () => {
  const html = footerHtml({
    authorName: 'Penelope Barr',
    bookTitle: 'A Book',
    buyLinks: [{ label: 'Booktopia', url: 'https://b.test' }],
  })
  assert.doesNotMatch(html, /connect with/i)
  assert.match(html, /A Book/)
})

test('a book with nowhere to buy it still gets named', () => {
  const html = footerHtml({ bookTitle: 'A Book', buyLinks: [] })
  assert.match(html, /A Book/)
  assert.doesNotMatch(html, /available from/)
})

test('nothing to say means no trailing rule', () => {
  // An <hr> with nothing under it is a page that looks broken.
  assert.equal(footerHtml({}), '')
  assert.equal(footerHtml({ authorName: 'Penelope Barr' }), '')
})

test('the ending escapes markup', () => {
  const html = footerHtml({
    authorName: '<script>x</script> Barr',
    authorLinkedin: 'https://l.test',
    bookTitle: '<img onerror=1>',
    buyLinks: [],
  })
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /<img onerror/)
})

/* ── Which picture the post uses ── */

test("the author's own photo beats everything", () => {
  // It is theirs, it is specific, and it is why the upload box exists.
  assert.equal(choosePostImage({
    uploadedImageUrl: 'https://up.test/launch.jpg',
    bookHeroUrl: 'https://wf.test/hero.jpg',
    bookCoverUrl: 'https://wf.test/cover.jpg',
    headshotUrl: 'https://wf.test/face.jpg',
  }), 'https://up.test/launch.jpg')
})

test('falls back in order, headshot last', () => {
  // Every headshot looks like every other headshot and says nothing about the
  // book, so it is the last resort rather than the default it used to be.
  assert.equal(choosePostImage({ bookHeroUrl: 'h', bookCoverUrl: 'c', headshotUrl: 'f' }), 'h')
  assert.equal(choosePostImage({ bookCoverUrl: 'c', headshotUrl: 'f' }), 'c')
  assert.equal(choosePostImage({ headshotUrl: 'f' }), 'f')
  assert.equal(choosePostImage({}), null)
})

test('space separates each answer from the next question', () => {
  // A rule was too heavy - six down a page turned it into a form. Without any
  // gap a long answer runs straight into the heading below it.
  const html = postBodyHtml(DRAFT)
  const parts = html.split('<h3>')
  assert.equal(parts.length - 1, 2, 'two questions')
  assert.match(html, /<\/p>\n<p>&nbsp;<\/p>\n<h3>What surprised you\?<\/h3>/)
  // The rule is gone. Six of them down a page turned the interview into a form.
  assert.doesNotMatch(html.split('<hr>').slice(1).join('<hr>'), /<hr>/)
})

test('no spacer directly under the standfirst rule', () => {
  // The standfirst already puts one there; a second reads as a mistake.
  assert.doesNotMatch(postBodyHtml(DRAFT), /<hr>\n<hr>/)
})

test('no spacer at all when there is only one question', () => {
  const html = postBodyHtml({ standfirst: '', items: [{ question: 'Q', answer: 'A' }] })
  assert.doesNotMatch(html, /<hr>/)
})

test('a buy link pointing at our own site is dropped', () => {
  // This shipped: a Books field holding the author's own website was offered
  // as "the publisher", so the post said "available from the publisher" and
  // sent the reader back to the author page they had arrived from.
  const html = footerHtml({
    bookTitle: 'Win the Night',
    buyLinks: [
      { label: 'Booktopia', url: 'https://booktopia.com.au/win' },
      { label: 'the publisher', url: 'https://www.expertauthor.community/authors/penelope-barr' },
    ],
  })
  assert.match(html, /booktopia/)
  assert.doesNotMatch(html, /expertauthor\.community/)
  assert.doesNotMatch(html, /the publisher/)
})

test('our own site is dropped however the url is written', () => {
  const forms = [
    'https://expertauthor.community/x',
    'https://www.expertauthor.community/x',
    'http://the.expertauthor.community/x',
  ]
  for (const url of forms) {
    const html = footerHtml({ bookTitle: 'A Book', buyLinks: [{ label: 'somewhere', url }] })
    assert.doesNotMatch(html, /expertauthor\.community/, url)
  }
})

test('a shop with a similar name is not dropped by accident', () => {
  // The guard matches our domain, not the words in it.
  const html = footerHtml({
    bookTitle: 'A Book',
    buyLinks: [{ label: 'Booktopia', url: 'https://booktopia.com.au/expertauthor-community-title' }],
  })
  assert.match(html, /booktopia\.com\.au/)
})

test('nothing left to buy from means no buy sentence', () => {
  const html = footerHtml({
    bookTitle: 'A Book',
    buyLinks: [{ label: 'the publisher', url: 'https://www.expertauthor.community/x' }],
  })
  assert.match(html, /A Book/)
  assert.doesNotMatch(html, /available from/)
})

test('the cover is sized down, not left to fill the column', () => {
  // A rich text image defaults to full width, which put a full-width book
  // jacket mid-page and dwarfed the interview it sat under.
  const html = footerHtml({ bookTitle: 'Win the Night', bookCoverUrl: 'https://wf.test/cover.jpg' })
  assert.match(html, /width="150"/)
  assert.match(html, /max-width:150px/)
  // Both the attribute and the style: which one a Webflow rich text field
  // keeps is not worth gambling a live page on.
  assert.match(html, /height:auto/)
})

test("the author's own site is a buy link, named after them", () => {
  // It was briefly called "the publisher", which read as somewhere else
  // entirely. It is where they sell the book themselves.
  const html = footerHtml({
    bookTitle: 'Win the Night',
    buyLinks: [
      { label: 'Booktopia', url: 'https://booktopia.com.au/win' },
      { label: "Penelope's website", url: 'https://penelopebarr.com/book' },
    ],
  })
  assert.match(html, /Penelope&#x27;s website|Penelope's website/)
  assert.match(html, /penelopebarr\.com/)
  assert.doesNotMatch(html, /the publisher/)
})

test('the headshot floats beside the standfirst, inside it', () => {
  // Inside the paragraph, not above it: that is what makes the text wrap
  // around the picture instead of sitting under a lonely one.
  const html = postBodyHtml(DRAFT, {
    headshotUrl: 'https://wf.test/penelope.jpg',
    authorName: 'Penelope Barr',
  })
  assert.match(html, /<p><img src="https:\/\/wf\.test\/penelope\.jpg"[^>]*><em>/)
  assert.match(html, /float:left/)
  assert.match(html, /width="96"/)
})

test('the headshot is named, for a reader who cannot see it', () => {
  const html = postBodyHtml(DRAFT, {
    headshotUrl: 'https://wf.test/p.jpg',
    authorName: 'Penelope Barr',
  })
  assert.match(html, /alt="Penelope Barr"/)
})

test('no headshot leaves the standfirst exactly as it was', () => {
  // The common case for an author with no photo on file, and it must not
  // leave an empty image or a stray float behind.
  const html = postBodyHtml(DRAFT)
  assert.match(html, /<p><em>Benita Bensch spent four drafts/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /float/)
})

test('the headshot never appears without a standfirst to sit beside', () => {
  const html = postBodyHtml(
    { standfirst: '', items: [{ question: 'Q', answer: 'A' }] },
    { headshotUrl: 'https://wf.test/p.jpg', authorName: 'Penelope Barr' }
  )
  assert.doesNotMatch(html, /<img/)
})
