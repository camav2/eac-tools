/*
 * The diff between an author's words and the edit.
 *
 * The failure that matters here is silent. A diff that under-reports makes a
 * heavy edit look light, and Cam approves it believing he has seen the
 * changes — which is worse than showing no diff at all, because it looks like
 * reassurance. So most of these pin that real changes are actually marked.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sourceText, wordDiff } from '../api/_lib/qna-diff'

test('identical text shows nothing changed', () => {
  const d = wordDiff('Living it was all fog.', 'Living it was all fog.')
  assert.equal(d.removed, 0)
  assert.equal(d.added, 0)
  assert.doesNotMatch(d.originalHtml, /<mark/)
  assert.doesNotMatch(d.editedHtml, /<mark/)
})

test('marks words the edit dropped', () => {
  const d = wordDiff('Um, so living it was all fog, you know.', 'Living it was all fog.')
  assert.ok(d.removed > 0, 'dropped words must be counted')
  assert.match(d.originalHtml, /<mark class="diff-cut">Um,<\/mark>/)
  assert.match(d.originalHtml, /know/)
})

test('marks words the edit added', () => {
  const d = wordDiff('it was fog', 'it was all fog')
  assert.ok(d.added > 0)
  assert.match(d.editedHtml, /<mark class="diff-new">all<\/mark>/)
})

test('an edit that rewrites everything is not reported as light', () => {
  // The case worth guarding: if this came back with removed 0, a wholesale
  // rewrite would look like no change at all.
  const d = wordDiff(
    'I reckon the thing is you just sort of keep going',
    'Persistence is the whole discipline.'
  )
  assert.ok(d.removed >= 8, `expected most words marked, got ${d.removed}`)
  assert.ok(d.added >= 4, `expected the new wording marked, got ${d.added}`)
})

test('keeps the paragraph breaks the author put in', () => {
  // A break is where they stopped to think. Splitting on whitespace alone
  // would throw those away and the original would read as one block.
  const d = wordDiff('First thought.\n\nSecond thought.', 'First thought.\n\nSecond thought.')
  assert.match(d.originalHtml, /\n\n/)
})

test('whitespace alone is never marked as a change', () => {
  // Re-wrapping a line is not an edit to anyone's words.
  const d = wordDiff('living it   was fog', 'living it was fog')
  assert.equal(d.removed, 0)
  assert.equal(d.added, 0)
})

test('escapes markup on both sides', () => {
  const d = wordDiff('<script>a</script>', '<script>b</script>')
  assert.doesNotMatch(d.originalHtml, /<script>/)
  assert.doesNotMatch(d.editedHtml, /<script>/)
  assert.match(d.originalHtml, /&lt;script&gt;/)
})

test('an empty original marks the whole edit as new', () => {
  const d = wordDiff('', 'Something the author never said.')
  assert.ok(d.added > 0)
  assert.equal(d.removed, 0)
})

test('an empty edit marks everything as cut', () => {
  const d = wordDiff('Everything they said.', '')
  assert.ok(d.removed > 0)
  assert.equal(d.added, 0)
})

test('says so rather than pretending, when two answers are too long', () => {
  const long = 'word '.repeat(2500)
  const d = wordDiff(long, long + 'extra')
  assert.equal(d.tooLong, true)
  // Reporting 0 changes with tooLong false would be the lie; unmarked plain
  // text plus the flag is honest.
  assert.doesNotMatch(d.originalHtml, /<mark/)
})

test('source text prefers a typed answer and keeps a spoken one too', () => {
  assert.equal(sourceText({ text: 'typed' }), 'typed')
  assert.equal(sourceText({ transcript: 'spoken' }), 'spoken')
  // Both means they typed and also recorded; the editor saw both, so the
  // comparison has to as well.
  assert.equal(sourceText({ text: 'typed', transcript: 'spoken' }), 'typed\n\nspoken')
  assert.equal(sourceText({}), '')
})
