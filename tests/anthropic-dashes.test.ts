/*
 * The no-dash rule for generated questions.
 *
 * The prompt asks for it and a retry enforces it, but both hang off one
 * detector. If that stops matching, the rule silently stops existing — the
 * questions still generate, they just quietly carry dashes again. Hence tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { questionsWithDashes } from '../api/_lib/anthropic'

test('flags an em dash', () => {
  assert.deepEqual(
    questionsWithDashes(['What did writing it teach you — really?']),
    ['What did writing it teach you — really?']
  )
})

test('flags an en dash', () => {
  assert.equal(questionsWithDashes(['Over 2019–2024, what changed?']).length, 1)
})

test('leaves a hyphenated compound alone', () => {
  // The whole reason a plain hyphen is not in the pattern.
  assert.deepEqual(
    questionsWithDashes([
      'What did self-publishing teach you?',
      'How has your thirty-year career shaped the book?',
      'What would you tell a first-time author?',
    ]),
    []
  )
})

test('returns only the offenders, not the whole set', () => {
  const questions = [
    'Clean question one.',
    'Dirty question — with an aside.',
    'Clean question three.',
  ]
  assert.deepEqual(questionsWithDashes(questions), ['Dirty question — with an aside.'])
})

test('an empty set has no offenders', () => {
  assert.deepEqual(questionsWithDashes([]), [])
})
