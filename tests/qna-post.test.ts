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
  defaultTitle,
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
