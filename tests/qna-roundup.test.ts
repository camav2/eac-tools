/*
 * Linking the "28 best business books" round-up to a new interview.
 *
 * This edits a live post that already ranks, so nearly every test here pins
 * something it must NOT do. The dangerous failures are silent: a nested
 * anchor that a browser drops, a name matched inside an href and turned into
 * broken markup, or a second link added every time someone presses the button.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findRoundup, linkNameInHtml } from '../api/_lib/qna-roundup'

const URL = 'https://www.expertauthor.community/blog-posts/penelope-barr-on-win-the-night'

test('links the name', () => {
  const r = linkNameInHtml('<p>Win the Night by Penelope Barr is superb.</p>', 'Penelope Barr', URL)
  assert.equal(r.outcome, 'linked')
  assert.match(r.html, /<a href="[^"]*penelope-barr[^"]*">Penelope Barr<\/a>/)
})

test('links only the first mention', () => {
  // Linking every occurrence turns an article into a link farm.
  const html = '<p>Penelope Barr wrote it.</p><p>Penelope Barr again.</p><p>And Penelope Barr.</p>'
  const r = linkNameInHtml(html, 'Penelope Barr', URL)
  assert.equal((r.html.match(/<a href/g) || []).length, 1)
})

test('never nests inside an existing link', () => {
  // A browser resolves nested anchors by silently dropping one, so the visible
  // result of getting this wrong is a link that mysteriously stops working.
  const html = '<p><a href="https://her.site">Penelope Barr</a> wrote it.</p>'
  const r = linkNameInHtml(html, 'Penelope Barr', URL)
  assert.equal(r.outcome, 'not-found')
  assert.equal(r.html, html)
})

test('links a later plain mention when the first is inside a link', () => {
  const html = '<p><a href="https://her.site">Penelope Barr</a> wrote it.</p><p>Penelope Barr again.</p>'
  const r = linkNameInHtml(html, 'Penelope Barr', URL)
  assert.equal(r.outcome, 'linked')
  assert.match(r.html, /her\.site">Penelope Barr<\/a>/)
  assert.equal((r.html.match(/<a href/g) || []).length, 2)
})

test('never matches inside a tag', () => {
  // A name in an alt attribute or a URL is not prose, and rewriting it would
  // produce broken markup on a live page.
  const html = '<p><img alt="Penelope Barr" src="/penelope-barr.jpg"></p>'
  const r = linkNameInHtml(html, 'Penelope Barr', URL)
  assert.equal(r.outcome, 'not-found')
  assert.equal(r.html, html)
})

test('is idempotent', () => {
  // Pressing the button twice must not add a second link.
  const once = linkNameInHtml('<p>By Penelope Barr.</p>', 'Penelope Barr', URL)
  const twice = linkNameInHtml(once.html, 'Penelope Barr', URL)
  assert.equal(twice.outcome, 'already')
  assert.equal(twice.html, once.html)
})

test('says so when the author is not in the post', () => {
  const html = '<p>Some other author entirely.</p>'
  const r = linkNameInHtml(html, 'Penelope Barr', URL)
  assert.equal(r.outcome, 'not-found')
  assert.equal(r.html, html)
})

test('tolerates odd spacing and case in the name', () => {
  const r = linkNameInHtml('<p>by penelope   barr, who wrote it</p>', 'Penelope Barr', URL)
  assert.equal(r.outcome, 'linked')
  // The post's own capitalisation is kept - this is not the place to correct
  // somebody else's published prose.
  assert.match(r.html, />penelope   barr<\/a>/)
})

test('escapes a quote in the url rather than breaking out of the attribute', () => {
  const r = linkNameInHtml('<p>Penelope Barr</p>', 'Penelope Barr', 'https://x.test/a"onmouseover="evil')
  assert.doesNotMatch(r.html, /"onmouseover="/)
  assert.match(r.html, /&quot;/)
})

test('returns the sentence the link landed in', () => {
  const r = linkNameInHtml(
    '<p>Our pick this year is Win the Night by Penelope Barr, a book about sleep.</p>',
    'Penelope Barr', URL
  )
  assert.match(r.context ?? '', /Win the Night by Penelope Barr/)
  assert.doesNotMatch(r.context ?? '', /</, 'context is for reading, so no markup')
})

test('handles empty input without throwing', () => {
  assert.equal(linkNameInHtml('', 'Penelope Barr', URL).outcome, 'not-found')
  assert.equal(linkNameInHtml('<p>x</p>', '', URL).outcome, 'not-found')
  assert.equal(linkNameInHtml('<p>Penelope Barr</p>', 'Penelope Barr', '').outcome, 'not-found')
})

/* ── Finding the round-up ── */

test('finds the round-up by title, whatever the number is', () => {
  // It was 25 once and will be 30. A pinned slug would not survive that.
  const posts = [
    { id: '1', name: 'Something else', slug: 'something-else' },
    { id: '2', name: 'The 28 best business books of 2026', slug: '28-best-business-books' },
  ]
  assert.equal(findRoundup(posts)?.id, '2')
  assert.equal(findRoundup([{ id: '3', name: 'The 30 Best Business Books', slug: 'x' }])?.id, '3')
})

test('finds it by slug when the title is worded differently', () => {
  const posts = [{ id: '9', name: 'Our yearly reading list', slug: 'best-business-books-2026' }]
  assert.equal(findRoundup(posts)?.id, '9')
})

test('returns nothing rather than guessing', () => {
  assert.equal(findRoundup([{ id: '1', name: 'A post', slug: 'a-post' }]), null)
  assert.equal(findRoundup([]), null)
})
