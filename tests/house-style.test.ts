/*
 * No em dashes. Cam's rule.
 *
 * The drafter kept breaking it - it turned "given up coffee which may be"
 * into "given up coffee — which may be", putting a mark into an author's mouth
 * that the author never typed. The prompt asks and this enforces, so most of
 * these pin the enforcement rather than the asking.
 *
 * The other half is what must NOT be touched: a hyphen inside a word is a
 * word, not a punctuation choice.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyHouseStyle, houseDashes } from '../api/_lib/house-style'

test('a spaced em dash becomes a spaced hyphen', () => {
  assert.equal(
    houseDashes('given up coffee — which may be the proof'),
    'given up coffee - which may be the proof'
  )
})

test('an unspaced em dash gets the spacing EAC uses', () => {
  assert.equal(houseDashes('coffee—which may be'), 'coffee - which may be')
})

test('en dashes go too', () => {
  // Same mistake in a narrower font. Nobody types one deliberately in prose.
  assert.equal(houseDashes('the years 2020–2024'), 'the years 2020 - 2024')
  assert.equal(houseDashes('sleep – and work'), 'sleep - and work')
})

test('a hyphen inside a word is left alone', () => {
  // "Flesh-eating" is a word. Rewriting it would be a different bug.
  assert.equal(houseDashes('a flesh-eating bacteria'), 'a flesh-eating bacteria')
  assert.equal(houseDashes('self-published, well-being'), 'self-published, well-being')
})

test('text with no dashes is returned untouched', () => {
  const s = 'Living it was all fog. Writing it forced an order.'
  assert.equal(houseDashes(s), s)
})

test('a dash opening a line stays a bullet', () => {
  // "- Start by getting curious" is a list item, not a sentence break, and
  // indenting it would quietly reformat the author's list.
  assert.equal(houseDashes('— Start by getting curious'), '- Start by getting curious')
  assert.equal(houseDashes('a\n— b'), 'a\n- b')
})

test('handles empty and missing input', () => {
  assert.equal(houseDashes(''), '')
  assert.equal(houseDashes(undefined as unknown as string), '')
})

test('applies across a whole draft', () => {
  const out = applyHouseStyle({
    standfirst: 'Penelope Barr ran 150 experiments — on her own sleep.',
    items: [
      { question: 'Why sleep — of all things?', answer: 'It is foundational — not a wellness issue.' },
    ],
    editorNotes: 'Q4 trimmed — restore if you prefer the two-part framing.',
  })

  assert.doesNotMatch(out.standfirst, /[—–]/)
  assert.doesNotMatch(out.items[0].question, /[—–]/)
  assert.doesNotMatch(out.items[0].answer, /[—–]/)
})

test('editor notes keep their own punctuation', () => {
  // They are addressed to Cam and never published. Tidying a note about
  // punctuation helps nobody.
  const notes = 'Q4 trimmed — restore if you prefer the two-part framing.'
  const out = applyHouseStyle({ standfirst: '', items: [], editorNotes: notes })
  assert.equal(out.editorNotes, notes)
})

test('carries through fields it does not own', () => {
  const out = applyHouseStyle({
    standfirst: 'a', items: [], editorNotes: '', extra: 'kept',
  } as any)
  assert.equal((out as any).extra, 'kept')
})
