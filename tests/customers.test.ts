/*
 * Name matching for the member email lookup.
 *
 * The failure this guards against is not a missing address, which Cam simply
 * types in. It is a WRONG address: two different people folded onto the same
 * key, and an author's unpublished interview sent to a stranger. So the tests
 * that matter most here are the ones asserting that distinct names stay
 * distinct.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normaliseName } from '../api/_lib/customers'

test('ignores case', () => {
  assert.equal(normaliseName('Kerryn Harvey'), normaliseName('KERRYN HARVEY'))
})

test('ignores surrounding and doubled whitespace', () => {
  assert.equal(normaliseName('  Benita   Bensch '), normaliseName('Benita Bensch'))
})

test('ignores punctuation that differs between systems', () => {
  assert.equal(normaliseName("Kylie O'Brien"), normaliseName('Kylie OBrien'))
  assert.equal(normaliseName('Anne-Marie Smith'), normaliseName('Anne Marie Smith'))
  assert.equal(normaliseName('Dr. Janine Stratford'), normaliseName('Dr Janine Stratford'))
})

test('folds accents', () => {
  assert.equal(normaliseName('Renée Dubois'), normaliseName('Renee Dubois'))
})

test('keeps different people apart', () => {
  // The whole point. Each pair below must never collapse onto one key.
  const distinct = [
    ['Kerryn Harvey', 'Karen Harvey'],
    ['Benita Bensch', 'Benita Bench'],
    ['Jane Smith', 'Jane Smyth'],
    ['Kylie Paatsch', 'Kylie Patsch'],
    ['Penelope Barr', 'Penelope Barr-Jones'],
  ]
  for (const [a, b] of distinct) {
    assert.notEqual(normaliseName(a), normaliseName(b), `${a} must not match ${b}`)
  }
})

test('a first name alone never matches a full name', () => {
  // Guards against any future "close enough" softening of the rule.
  assert.notEqual(normaliseName('Kerryn'), normaliseName('Kerryn Harvey'))
})

test('empty and junk input normalise to nothing', () => {
  // findCustomerByName treats an empty key as "no lookup", so this is what
  // stops a blank author name matching a blank customer row.
  assert.equal(normaliseName(''), '')
  assert.equal(normaliseName('   '), '')
  assert.equal(normaliseName('---'), '')
  assert.equal(normaliseName(undefined as unknown as string), '')
})
