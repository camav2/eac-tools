/*
 * Spoken answers edited into written form: the arithmetic that catches a rewrite.
 *
 * The dangerous failure here is not an ugly answer, it is a beautiful one. A
 * model handed a rambling transcript will sometimes write a better answer than
 * the author gave, in words the author never used, under the author's name.
 * That is invisible to the eye and obvious in the numbers.
 *
 * There is a second failure, found the hard way. The first guard counted every
 * new word, so a properly written edit - which needs grammar words the speaker
 * never said - tipped over the budget, got rejected, and fell back to the raw
 * transcript. The guard meant to protect the author published her ums.
 *
 * Fixtures are Kerryn Harvey's real transcripts. A synthetic transcript is
 * always tidier than a real one and would let a weak guard pass.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isSpoken,
  words,
  wordCount,
  contentWords,
  novelWords,
  novelContentWords,
  residualFillers,
  residualTics,
  checkClean,
  cleanSummary,
  NOVEL_CONTENT_LIMIT,
  MIN_NOVEL_ALLOWANCE,
  MIN_KEPT_SHARE,
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

// What she rejected: speech with the ums removed and the register kept.
const KERRYN_Q1_SPOKEN_CLEAN =
  'So many differences between telling my story on stage or on radio, and telling it ' +
  'in a book, writing it down.\n\n' +
  'On stage, and in those pre-recorded radio interviews, it really just glosses over ' +
  "the surface of everything that's been part of my journey. You never really go into " +
  "great detail, and you never really get emotionally deep into what you're saying. " +
  "It's just really giving the basics.\n\n" +
  'In writing, I found I was able to actually get right back into those spaces where ' +
  'I was back 13 years ago, when it was my reality.'

// What the edit should now produce: written, and still hers.
const KERRYN_Q1_WRITTEN =
  'Telling my story on stage or on radio is very different from writing it down. ' +
  'On stage, and in pre-recorded radio interviews, it only ever glosses over the ' +
  'surface of my journey. You never go into great detail, and you never get ' +
  "emotionally deep. It's just the basics.\n\n" +
  'In writing, I was able to get right back into the spaces I was in 13 years ago, ' +
  'when it was my reality.'

/* ── Which answers get edited at all ─────────────────────────────────────── */

test('an answer is spoken only when there is a transcript and no typing', () => {
  assert.equal(isSpoken({ transcript: 'um, so' }), true)
  assert.equal(isSpoken({ text: 'I wrote this.' }), false)
  // Both present: the author typed, so the typing wins and nothing is edited.
  assert.equal(isSpoken({ text: 'I wrote this.', transcript: 'um, so' }), false)
  assert.equal(isSpoken({}), false)
  assert.equal(isSpoken(null), false)
})

/* ── Tokenising ──────────────────────────────────────────────────────────── */

test('contractions and hyphenated words count as one word each', () => {
  assert.deepEqual(words("didn't flesh-eating"), ["didn't", 'flesh-eating'])
})

test('a curly apostrophe and a straight one are the same word', () => {
  // A phone types one, the transcriber writes the other. Treating them as
  // different words would report "don't" as invented in every answer.
  assert.deepEqual(novelWords("I don't know", 'I don’t know'), [])
})

test('punctuation and case do not make a word novel', () => {
  assert.deepEqual(novelWords('It was overwhelming.', 'overwhelming, IT was!'), [])
})

/* ── Content words: the thing the guard actually measures ────────────────── */

test('grammar words are not content words', () => {
  assert.deepEqual(contentWords("There weren't any real surprises from it"), ['real', 'surprises'])
})

test('a year is a fact, not a word choice', () => {
  assert.deepEqual(contentWords('Back in 2013 it was hard'), ['hard'])
})

test('repairing speech into prose does not count as invention', () => {
  // "there was any" to "there weren't any" is repair. Under the old all-words
  // guard this spent the budget; under content words it costs nothing.
  const spoken = "I don't think there was any real surprises about what I remembered"
  const written = "There weren't any real surprises about what I remembered"
  assert.deepEqual(novelContentWords(spoken, written), [])
  assert.ok(novelWords(spoken, written).includes("weren't"), 'the old measure would have counted it')
})

test('a grammar fix that needs a new content word is small and named', () => {
  // "so much more deep" to "so much deeper" genuinely introduces a word.
  assert.deepEqual(novelContentWords('It was just so much more deep', 'It was so much deeper'), ['deeper'])
})

/* ── The written edit she asked for passes ───────────────────────────────── */

test("the written version of Kerryn's answer is accepted", () => {
  const check = checkClean(KERRYN_Q1, KERRYN_Q1_WRITTEN)
  assert.equal(check.accepted, true, check.reason)
  assert.deepEqual(check.fillers, [])
  assert.deepEqual(check.tics, [])
})

test('the written version introduces almost no new meaning', () => {
  const novel = novelContentWords(KERRYN_Q1, KERRYN_Q1_WRITTEN)
  const content = contentWords(KERRYN_Q1_WRITTEN).length
  assert.ok(
    novel.length <= content * NOVEL_CONTENT_LIMIT,
    `introduced ${novel.length} of ${content}: ${novel.join(', ')}`
  )
  assert.ok(novel.length <= 3, `expected a repair or two, got: ${novel.join(', ')}`)
})

test('a written edit may cut hard, because speech repeats itself', () => {
  // Kerryn's written answers come in 40-45% under her transcripts.
  const check = checkClean(KERRYN_Q1, KERRYN_Q1_WRITTEN)
  assert.ok(check.cleanedWords < check.originalWords * 0.7, 'expected a substantial cut')
  assert.ok(check.cleanedWords >= check.originalWords * MIN_KEPT_SHARE)
})

test('the spoken-register version she rejected is still a valid edit, just a lighter one', () => {
  // The guard judges invention, not register. Register is the prompt's job.
  assert.equal(checkClean(KERRYN_Q1, KERRYN_Q1_SPOKEN_CLEAN).accepted, true)
})

/* ── The rewrite it has to catch ─────────────────────────────────────────── */

test("a fluent rewrite in the model's own words is rejected", () => {
  // Sized to pass both length guards, so the only thing standing between this
  // and publication is the content-word check.
  const rewrite =
    'Writing demanded a depth that performance never required. On stage the narrative ' +
    'remains necessarily superficial, constrained by time and by the expectations of a ' +
    'listening audience. The page, by contrast, permitted genuine excavation of ' +
    'experience and a reckoning with events thirteen years past. Solitude allowed ' +
    'reflection that no auditorium could accommodate, and the resulting prose carries ' +
    'an intimacy which oral delivery invariably sacrifices in pursuit of immediate impact.'

  const check = checkClean(KERRYN_Q1, rewrite)
  assert.ok(check.cleanedWords < check.originalWords, 'fixture must pass the growth guard')
  assert.ok(check.cleanedWords >= check.originalWords * MIN_KEPT_SHARE, 'fixture must pass the cut guard')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /did not say/)
})

test('an edit longer than the recording is rejected', () => {
  const check = checkClean('um so I wrote it', 'So I wrote it, and it took me a very long time indeed')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /longer than what was said/)
})

test('an edit that keeps almost nothing is rejected', () => {
  const check = checkClean(KERRYN_Q1, 'So many differences between telling my story on stage or on radio.')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /less than a third/)
})

test('an empty edit is rejected rather than published as a blank answer', () => {
  const check = checkClean(KERRYN_Q1, '   ')
  assert.equal(check.accepted, false)
  assert.match(check.reason, /came back empty/)
})

/* ── Invented slang: too small for a percentage, so it is named ──────────── */

test('a single invented word is named even though it is under budget', () => {
  // The first version of this put "yakka" into Kerryn's answer - a word she
  // never said. One word is always under any sane percentage, so the defence
  // is that it appears by name in the note Cam reads.
  const spoken = 'it was a lot of hard work getting the book written'
  const edited = 'It was hard yakka getting the book written'
  const check = checkClean(spoken, edited)
  assert.equal(check.accepted, true)
  assert.ok(check.novel.includes('yakka'))
  assert.match(cleanSummary(check), /words not in the recording: .*yakka/)
})

test('a short answer can still carry an honest repair', () => {
  // Four content words: one repair is 25%, which a bare percentage would reject.
  const check = checkClean('It was so much more deep for me', 'It was so much deeper for me')
  assert.equal(check.accepted, true, check.reason)
  assert.ok(check.novel.length <= MIN_NOVEL_ALLOWANCE)
})

test('a short answer rewritten wholesale is still rejected', () => {
  const check = checkClean(
    'um it was so much more deep for me',
    'Profound introspection yielded remarkable emotional clarity'
  )
  assert.equal(check.accepted, false)
  assert.match(check.reason, /did not say/)
})

/* ── What "too bogan" was made of ────────────────────────────────────────── */

test('spoken tics are detected', () => {
  assert.deepEqual(
    residualTics('So yeah, I reckon it was kind of hard, you know').sort(),
    ['i reckon', 'kind of', 'so yeah', 'you know']
  )
})

test('a tic is flagged, never a reason to reject', () => {
  // "a different kind of book" is a good sentence, and a phrase list cannot
  // tell it from a habit. It goes in front of Cam instead.
  const check = checkClean(KERRYN_Q1, KERRYN_Q1_WRITTEN.replace('very different', 'kind of different'))
  assert.equal(check.accepted, true)
  assert.deepEqual(check.tics, ['kind of'])
  assert.match(cleanSummary(check), /still reads as speech: kind of/)
})

test('a word that merely contains a filler is not filler', () => {
  assert.deepEqual(residualFillers('She went ahead with the umbrella'), [])
  assert.deepEqual(residualFillers('So, um, I wrote it'), ['um'])
})

/* ── What Cam reads ──────────────────────────────────────────────────────── */

test('the summary says the answer was written up, and by how much', () => {
  const s = cleanSummary(checkClean(KERRYN_Q1, KERRYN_Q1_WRITTEN))
  assert.match(s, /^Spoken\. Edited into written form, \d+ words shorter/)
})

test('a rejected edit announces itself and names the reason', () => {
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
