/*
 * Trimming a subtitle off a book title, for the spoken intro only.
 *
 * The risk is not the obvious colon case. It is over-trimming: a hyphen inside
 * a word, or a title that legitimately opens with punctuation, silently
 * shortening a real title in Kelly's voice where nobody would notice until an
 * author heard it. So most of these pin what must NOT be cut.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mainTitle } from '../api/qna-voice'

test('drops a subtitle after a colon', () => {
  assert.equal(mainTitle('Seen Again: Light on Matrescence'), 'Seen Again')
  assert.equal(
    mainTitle('The Connect Effect: How to Build Loyalty, Ownership and Engagement with Your Leaders'),
    'The Connect Effect'
  )
  assert.equal(
    mainTitle('Win the Night to Win the Day: Sleep Well. Work Better. Live Best.'),
    'Win the Night to Win the Day'
  )
})

test('drops a subtitle after a spaced dash', () => {
  assert.equal(mainTitle('Deep Listening - Impact Beyond Words'), 'Deep Listening')
  assert.equal(mainTitle('Deep Listening – Impact Beyond Words'), 'Deep Listening')
  assert.equal(mainTitle('Deep Listening — Impact Beyond Words'), 'Deep Listening')
})

test('keeps a hyphen that is inside a word', () => {
  // The real one from the pipeline. An unspaced hyphen joins a word; cutting
  // there would leave "Mostly Ups: How I Survived a Flesh".
  assert.equal(
    mainTitle('Mostly Ups: How I Survived a Flesh-eating Bacteria'),
    'Mostly Ups'
  )
  assert.equal(mainTitle('Twenty-One Lessons'), 'Twenty-One Lessons')
  assert.equal(mainTitle('Well-Being'), 'Well-Being')
})

test('leaves a title with no subtitle alone', () => {
  assert.equal(mainTitle('Anthologia'), 'Anthologia')
  assert.equal(mainTitle('The Art of Trying'), 'The Art of Trying')
})

test('a separator with nothing before it leaves the title alone', () => {
  // Returning '' here would have Kelly say "I wanted to ask you about ."
  assert.equal(mainTitle(': Light on Matrescence'), ': Light on Matrescence')
  assert.equal(mainTitle('- Something'), '- Something')
})

test('handles empty and missing input', () => {
  assert.equal(mainTitle(''), '')
  assert.equal(mainTitle('   '), '')
  assert.equal(mainTitle(undefined as unknown as string), '')
})

test('trims surrounding whitespace', () => {
  assert.equal(mainTitle('  Seen Again : Light on Matrescence '), 'Seen Again')
})
