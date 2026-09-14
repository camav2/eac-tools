/*
 * Author media uploads — reading Supabase's real error shapes.
 *
 * Every test here pins a body Supabase actually returned, because the bug this
 * file exists to prevent was entirely about trusting res.status. A missing
 * bucket arrives as HTTP 400 carrying "statusCode":"404", and the message
 * never contains the word "bucket". The original check looked for a 404 status
 * or the words "Bucket not found", matched neither, and so never provisioned
 * the bucket — which meant no author could upload anything, ever.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isMissingBucket,
  isBucketAlreadyExists,
  isOverGlobalLimit,
  safeFileName,
  parseMedia,
  ALLOWED_TYPES,
  MAX_FILES,
} from '../api/_lib/qna-media'

/* ── The body that broke it ──────────────────────────────────────────────── */

// Verbatim from a failed upload of AGM-Questions-Run-Card.pdf, 2026-09-14.
const MISSING_BUCKET_BODY =
  '{"statusCode":"404","error":"InvalidRequest","message":"The related resource does not exist","code":"InvalidRequest"}'

test('a missing bucket is recognised even though the status says 400', () => {
  assert.equal(isMissingBucket(400, MISSING_BUCKET_BODY), true)
})

test('the old checks would both have missed it', () => {
  // Kept as a standing explanation of why this predicate exists at all.
  const status: number = 400
  assert.equal(status === 404, false)
  assert.equal(/Bucket not found|NoSuchBucket/i.test(MISSING_BUCKET_BODY), false)
})

test('a plain 404 still counts as a missing bucket', () => {
  assert.equal(isMissingBucket(404, ''), true)
})

test('older Supabase wording still counts', () => {
  assert.equal(isMissingBucket(400, '{"message":"Bucket not found"}'), true)
  assert.equal(isMissingBucket(400, 'NoSuchBucket'), true)
})

test('an unrelated failure is not mistaken for a missing bucket', () => {
  // Treating this as "missing" would send us into a pointless create/retry
  // loop and swallow the real reason.
  assert.equal(isMissingBucket(401, '{"statusCode":"401","message":"Invalid JWT"}'), false)
  assert.equal(isMissingBucket(500, 'Internal Server Error'), false)
})

/* ── Already exists, the same trap in reverse ────────────────────────────── */

test('already-exists is recognised from a 409 buried in a 400', () => {
  assert.equal(
    isBucketAlreadyExists(400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}'),
    true
  )
  assert.equal(isBucketAlreadyExists(409, ''), true)
  assert.equal(isBucketAlreadyExists(400, 'BucketAlreadyExists'), true)
})

test('already-exists and missing-bucket do not both claim the same body', () => {
  assert.equal(isBucketAlreadyExists(400, MISSING_BUCKET_BODY), false)
})

/* ── The global upload cap ───────────────────────────────────────────────── */

test('a bucket larger than the project allows is detected so we can retry smaller', () => {
  assert.equal(
    isOverGlobalLimit('{"message":"The requested file_size_limit (104857600) is greater than the global limit"}'),
    true
  )
  assert.equal(isOverGlobalLimit(MISSING_BUCKET_BODY), false)
})

/* ── Filenames ───────────────────────────────────────────────────────────── */

test('a real author filename survives as a usable key', () => {
  assert.equal(safeFileName('AGM-Questions-Run-Card.pdf'), 'AGM-Questions-Run-Card.pdf')
  assert.equal(safeFileName('logo.png'), 'logo.png')
})

test('spaces, accents and punctuation are flattened, not dropped', () => {
  const out = safeFileName('Benita & Kel — launch night (1).JPG')
  assert.match(out, /^[A-Za-z0-9._-]+$/)
  assert.match(out, /JPG$/)
})

test('a name that cleans away to nothing still yields a key', () => {
  assert.equal(safeFileName('———'), 'file')
  assert.equal(safeFileName(''), 'file')
})

/* ── Stored media ────────────────────────────────────────────────────────── */

test('media round-trips and junk is ignored rather than thrown', () => {
  const raw = JSON.stringify([
    { path: 'rec1/1-a.pdf', name: 'a.pdf', type: 'application/pdf', size: 10, uploadedAt: 'x' },
    { name: 'no path' },
  ])
  const parsed = parseMedia(raw)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].name, 'a.pdf')

  assert.deepEqual(parseMedia('not json'), [])
  assert.deepEqual(parseMedia(''), [])
  assert.deepEqual(parseMedia(null), [])
})

test('stored media cannot exceed the file cap', () => {
  const many = JSON.stringify(
    Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ path: `rec1/${i}`, name: `${i}` }))
  )
  assert.equal(parseMedia(many).length, MAX_FILES)
})

test('the types an author actually sends are allowed', () => {
  // PDFs and PNGs are both in the failing reports that prompted this file.
  for (const t of ['application/pdf', 'image/png', 'image/jpeg', 'image/heic']) {
    assert.ok(ALLOWED_TYPES.includes(t), `${t} should be allowed`)
  }
})
