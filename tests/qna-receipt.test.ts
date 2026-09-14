/*
 * The receipt email an author gets the moment they submit.
 *
 * The body is built the same way as the invitation - a <div> per line - and
 * the thing worth pinning is that it stays that way. A <p> creeping back in
 * would arrive with no spacing at all, because the Gmail helper strips
 * paragraph margins, and the email would read as one unbroken block again.
 *
 * The link matters more than the prose: it is the only proof the author has
 * that anything was received, so it must carry their token, intact.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { receiptEmail } from '../api/_lib/qna-receipt'

const LINK = 'https://hub.expertauthor.community/qna-intake?token=u6XLdFA0f0H32iSJJmYoNL8DmlAc5d2m'

test('greets by first name only', () => {
  const { body } = receiptEmail('Benita Bensch', 'Seen Again', LINK)
  assert.match(body, /Hi Benita,/)
  assert.doesNotMatch(body, /Hi Benita Bensch/)
})

test('falls back to "there" when the name is missing', () => {
  const { body } = receiptEmail('', 'Seen Again', LINK)
  assert.match(body, /Hi there,/)
})

test('names the book in the subject', () => {
  const { subject } = receiptEmail('Benita Bensch', 'Seen Again', LINK)
  assert.match(subject, /Seen Again/)
})

test('carries the link, with the token intact', () => {
  const { body } = receiptEmail('Benita Bensch', 'Seen Again', LINK)
  assert.ok(body.includes(`href="${LINK}"`), 'link must be the href')
  assert.ok(body.includes(`>${LINK}<`), 'and shown as the visible text')
})

test('is built from divs, never paragraphs', () => {
  // A <p> here arrives with no gap between lines: the Gmail helper rewrites
  // <p> to <div> to escape Gmail's own margins, and strips the spacing with it.
  const { body } = receiptEmail('Benita Bensch', 'Seen Again', LINK)
  assert.doesNotMatch(body, /<p[\s>]/)
  assert.match(body, /<div><br><\/div>/)
})

test('escapes a name or title that contains markup', () => {
  const { body, subject } = receiptEmail(
    '<script>x</script> Bensch',
    'Seen Again & "Light"',
    LINK
  )
  assert.doesNotMatch(body, /<script>/)
  // The subject is not HTML, so it is the body that must be safe.
  assert.match(subject, /Seen Again & "Light"/)
})

test('promises approval before publishing', () => {
  // The invitation makes this promise. Breaking it here would be the first
  // place an author notices the two do not agree.
  const { body } = receiptEmail('Benita Bensch', 'Seen Again', LINK)
  assert.match(body, /approval/i)
})
