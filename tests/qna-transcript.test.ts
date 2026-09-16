/*
 * Spoken answers: the arithmetic that catches a rewrite.
 *
 * The dangerous failure here is not an ugly answer, it is a beautiful one.
 * A model handed a rambling transcript and asked to clean it will sometimes
 * write a better answer than the author gave, in words the author never used,
 * and publish it under the author's name. That is invisible to the eye and
 * obvious in the numbers, so nearly every test below pins a number.
 *
 * The fixtures are Kerryn Harvey's real transcripts, because a synthetic
 * transcript is always tidier than a real one and would let a weak guard pass.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isSpoken,
  words,
  wordCount,
  novelWords,
  residualFillers,
  checkClean,
  cleanSummary,
} from '../api/_lib/qna-transcript'

/* ── Fixtures, verbatim from the recording ───────────────────────────────── */

const KERRYN_Q1 =
  'Uh, interesting question. So many differences between telling my story on stage ' +
  'or on radio as it is to, uh, telling it in a book, writing it down. Um, on stage ' +
  "and on those, um, pre-recorded, uh, radio interviews, um, it's all... It really " +
  'just glosses over the surface of everything that, um, everything that\'s been part ' +
  'of my journey. So you never really go into great detail, and you never really get ' +
  'emotionally deep into what you\'re saying. It\'s just really giving the basics. In ' +
  'writing, I found I was able to actually get right back into those spaces where I ' +
  'was back 13 years ago when, when it was my reality.'

// What a correct clean-up of the above looks like.
const KERRYN_Q1_CLEAN =
  'So many differences between telling my story on stage or on radio, and telling it ' +
  'in a book, writing it down.\n\n' +
  'On stage, and in those pre-recorded radio interviews, it really just glosses over ' +
  "the surface of everything that's been part of my journey. You never really go into " +
  "great detail, and you never really get emotionally deep into what you're saying. " +
  "It's just really giving the basics.\n\n" +
  'In writing, I found I was able to actually get right back into those spaces where ' +
  'I was back 13 years ago, when it was my reality.'

/* ── Which answers get cleaned at all ────────────────────────────────────── */

test('an answer is spoken only when there is a transcript and no typing', () => {
  assert.equal(isSpoken({ transcript: 'um, so' }), true)
  assert.equal(isSpoken({ text: 'I wrote this.' }), false)
  // Both present: the author typed, so the typing wins and nothing is cleaned.
  assert.equal(isSpoken({ text: 'I wrote this.', transcript: 'um, so' }), false)
  assert.equal(isSpoken({}), false)
  assert.equal(isSpoken(null), false)
})

/* ── Tokenising ──────────────────────────────────────────────────────────── */

test("contractions and hyphenated words count as one word each", () => {
  // Splitting these would report "didn't" as two novel words and make the
  // novelty guard fire on every answer containing an apostrophe.
  assert.deepEqual(words("didn't flesh-eating"), ["didn't", 'flesh-eating'])
})

test('punctuation and case do not make a word novel', () => {
  assert.deepEqual(novelWords('It was overwhelming.', 'overwhelming, IT was!'), [])
})

/* ── The real clean-up passes ────────────────────────────────────────────── */

test("a correct clean-up of Kerryn's answer is accepted", () => {
  const check = checkClean(KERRYN_Q1, KERRYN_Q1_CLEAN)
  assert.equal(check.accepted, true, check.reason)
  assert.ok(check.cleanedWords < check.originalWords)
  assert.deepEqual(check.fillers, [])
})

test('the clean-up introduces almost no new vocabulary', () => {
  // "and" and "when" already appear in the transcript; the only genuine
  // insertion is punctuation, which is not a word.
  const novel = novelWords(KERRYN_Q1, KERRYN_Q1_CLEAN)
  assert.ok(novel.length <= 2, `introduced ${novel.length}: ${novel.join(', ')}`)
})

/* ── The rewrite it has to catch ─────────────────────────────────────────── */

test("a fluent rewrite in the model's own words is rejected", () => {
  // Deliberately sized to pass both length guards - shorter than the
  // transcript, more than half of it - so that the only thing standing
  // between this and publication is the vocabulary check.
  const rewrite =
    'Writing demanded a depth that performance never required. On stage the narrative ' +
    'remains necessarily superficial, constrained by time and by the expectations of a ' +
    'listening audience. The page, by contrast, permitted genuine excavation of ' +
    'experience and a reckoning with events thirteen years past. Solitude allowed ' +
    'reflection that no auditorium could accommodate, and the resulting prose carries ' +
    'an intimacy which oral delivery invariably sacrifices in pursuit of immediate impact.'

  const check = checkClean(KERRYN_Q1, rewrite)
  assert.ok(check.cleanedWords < check.originalWords, 'fixture must pass the growth guard')
  assert.ok(check.cleanedWords > check.originalWords * 0.4, 'fixture must pass the drop guard')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /did not say/)
})

test('a clean-up longer than the recording is rejected', () => {
  const check = checkClean('um so I wrote it', 'So I wrote it, and it took me a very long time indeed')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /longer than what was said/)
})

test('a clean-up that silently drops half the answer is rejected', () => {
  // Cutting filler loses roughly a quarter. Losing half means content went.
  const check = checkClean(KERRYN_Q1, 'So many differences between telling my story on stage or on radio.')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /dropped more than half/)
})

test('an empty clean-up is rejected rather than published as a blank answer', () => {
  const check = checkClean(KERRYN_Q1, '   ')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /came back empty/)
})

/* ── Filler that survived ────────────────────────────────────────────────── */

test('filler left in the clean-up is reported', () => {
  assert.deepEqual(residualFillers('So, um, I wrote it').sort(), ['um'])
})

test('a word that merely contains a filler is not filler', () => {
  // "um" inside "umbrella", "ah" inside "ahead".
  assert.deepEqual(residualFillers('She went ahead with the umbrella'), [])
})

test('surviving filler is a flag, not a rejection', () => {
  // Worth telling Cam about; not worth throwing away an otherwise good pass.
  const cleaned = KERRYN_Q1_CLEAN.replace('On stage,', 'On stage, um,')
  const check = checkClean(KERRYN_Q1, cleaned)
  assert.equal(check.accepted, true)
  assert.deepEqual(check.fillers, ['um'])
})

/* ── What Cam reads ──────────────────────────────────────────────────────── */

test('the summary says how much came out', () => {
  const s = cleanSummary(checkClean(KERRYN_Q1, KERRYN_Q1_CLEAN))
  assert.match(s, /^Spoken\. Cleaned: \d+ words of filler and false starts removed/)
})

test('a rejected clean-up announces itself and names the reason', () => {
  // Silence here would look exactly like "nothing needed doing".
  const s = cleanSummary(checkClean(KERRYN_Q1, '   '))
  assert.match(s, /rejected, showing the raw transcript/)
  assert.match(s, /came back empty/)
})

test('an empty answer does not divide by zero', () => {
  const check = checkClean('', '')
  assert.equal(check.accepted, false)
  assert.equal(check.originalWords, 0)
})

test('wordCount ignores punctuation', () => {
  assert.equal(wordCount('Well, well... well!'), 3)
})
