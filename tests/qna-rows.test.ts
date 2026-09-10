/*
 * Tests for the Author Editorial Q&A row helpers.
 *
 * These exist because the subtle part of author-added questions is not any one
 * handler — it is which entries survive a save, a reload and a submit, and
 * that answer now has three callers (qna-intake, qna-audio, and the admin
 * review). A change that looks harmless in one of them shows up here.
 *
 * Run with `npm test`. No network, no keys — pure functions over a fake row.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  authorEntries,
  buildResponses,
  dropEmptyAuthorQuestions,
  fullQuestions,
  orphanedAnswers,
  sanitiseAuthorQuestions,
  MAX_AUTHOR_QUESTIONS,
} from '../api/_lib/qna-rows'

const BASE = ['q1', 'q2']

/** A pipeline row, only the fields these helpers read. */
function row(questions: string[], responses: unknown[]) {
  return {
    fields: {
      'Question Set': JSON.stringify(questions),
      'Responses': JSON.stringify(responses),
    },
  }
}

test('authorEntries keeps an answer written before its question', () => {
  // An author can type the answer first, or reload between the two halves.
  // Losing the answer because the box above is still empty is not acceptable.
  const entries = authorEntries(
    row(BASE, [{}, {}, { authorAdded: true, question: '', text: 'my answer' }])
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0].text, 'my answer')
})

test('authorEntries keeps a recording made before its question', () => {
  const entries = authorEntries(
    row(BASE, [{}, {}, { authorAdded: true, question: '', text: '', audioPath: 'p/2.webm' }])
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0].audioPath, 'p/2.webm')
})

test('authorEntries drops a blank slot and compacts the rest', () => {
  // The compaction is what stops the slot after a discarded one from losing
  // its answer to an index shift.
  const entries = authorEntries(
    row(BASE, [
      {}, {},
      { authorAdded: true, question: '', text: '' },
      { authorAdded: true, question: 'kept', text: 'a', audioPath: 'p/3.webm' },
    ])
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0].question, 'kept')
  assert.equal(entries[0].audioPath, 'p/3.webm')
})

test('authorEntries ignores unflagged entries past the question set', () => {
  assert.deepEqual(
    authorEntries(row(BASE, [{}, {}, { question: 'stray', text: 'x' }])),
    []
  )
})

test('authorEntries never returns more than the cap', () => {
  const entries = authorEntries(
    row(BASE, [
      {}, {},
      { authorAdded: true, question: 'a', text: '1' },
      { authorAdded: true, question: 'b', text: '2' },
      { authorAdded: true, question: 'c', text: '3' },
    ])
  )
  assert.equal(entries.length, MAX_AUTHOR_QUESTIONS)
})

test('fullQuestions is the set followed by the author’s own', () => {
  assert.deepEqual(
    fullQuestions(row(BASE, [{}, {}, { authorAdded: true, question: 'mine', text: 'a' }])),
    ['q1', 'q2', 'mine']
  )
})

test('buildResponses keeps the recording under a text save', () => {
  // The bug this guards: an autosave rebuilding the array and dropping the
  // audio path an upload just wrote.
  const existing = [
    { text: 'old', audioPath: 'p/0.webm', audioType: 'audio/webm', transcript: 't' },
    {},
  ]
  const out = buildResponses(BASE, 2, existing, ['new', ''])
  assert.equal(out[0].text, 'new')
  assert.equal(out[0].audioPath, 'p/0.webm')
  assert.equal(out[0].transcript, 't')
})

test('buildResponses flags everything past the base count', () => {
  const out = buildResponses([...BASE, 'mine'], 2, [{}, {}, {}], ['', '', 'a'])
  assert.deepEqual(out.map(r => Boolean(r.authorAdded)), [false, false, true])
})

test('orphanedAnswers finds an answer with no question above it', () => {
  assert.deepEqual(
    orphanedAnswers(
      [
        { question: 'q1', text: 'a' },
        { question: 'q2', text: 'b' },
        { question: '', text: 'orphan' },
      ],
      2
    ),
    [2]
  )
})

test('orphanedAnswers counts a recording as an answer', () => {
  assert.deepEqual(
    orphanedAnswers(
      [{ question: 'q1', text: '' }, { question: '', text: '', audioPath: 'p.webm' }],
      1
    ),
    [1]
  )
})

test('orphanedAnswers never flags one of Cam’s own questions', () => {
  assert.deepEqual(orphanedAnswers([{ question: '', text: 'a' }], 1), [])
})

test('dropEmptyAuthorQuestions keeps only slots with both halves', () => {
  const out = dropEmptyAuthorQuestions(
    [
      { question: 'q1', text: 'a' },
      { question: 'asked, never answered', text: '' },
      { question: '', text: '' },
      { question: 'real', text: 'answered' },
    ],
    1
  )
  assert.deepEqual(out.map(r => r.question), ['q1', 'real'])
})

test('dropEmptyAuthorQuestions never touches Cam’s questions', () => {
  // An unanswered question of his is a validation failure, not something to
  // quietly delete.
  const out = dropEmptyAuthorQuestions(
    [{ question: 'q1', text: '' }, { question: 'q2', text: '' }],
    2
  )
  assert.equal(out.length, 2)
})

test('sanitiseAuthorQuestions trims, caps length, and holds slot positions', () => {
  const out = sanitiseAuthorQuestions(['  spaced  ', '', 'x'.repeat(500), 'fourth'])
  assert.equal(out.length, MAX_AUTHOR_QUESTIONS)
  assert.equal(out[0], 'spaced')
  // An empty slot is kept in place rather than dropped, so a half-typed
  // question can't shuffle the answer below it mid-autosave.
  assert.equal(out[1], '')
})

test('sanitiseAuthorQuestions ignores anything that is not an array', () => {
  assert.deepEqual(sanitiseAuthorQuestions(undefined), [])
  assert.deepEqual(sanitiseAuthorQuestions('not an array'), [])
})
