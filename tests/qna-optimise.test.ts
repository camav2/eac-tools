/*
 * Getting a camera photograph down to something a page should carry.
 *
 * The numbers here are the whole point. Kerryn's largest file is 14.09 MB;
 * Webflow refuses anything over 4 MB, and rich text images get no srcset, so
 * whatever survives this is downloaded in full by every visitor on every
 * device. A guard that is slightly wrong in the generous direction does not
 * fail loudly - it publishes a slow page.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_WIDTH,
  START_QUALITY,
  MIN_QUALITY,
  TARGET_BYTES,
  WEBFLOW_MAX_BYTES,
  scaleToWidth,
  needsResize,
  nextQuality,
  outputName,
} from '../api/_lib/qna-optimise'

/* ── Scaling ─────────────────────────────────────────────────────────────── */

test('a camera photograph comes down to the maximum width, keeping its shape', () => {
  // A 4032x3024 phone photo, which is what most of her files are.
  const out = scaleToWidth({ width: 4032, height: 3024 })
  assert.equal(out.width, MAX_WIDTH)
  assert.equal(out.height, 1200) // 3024 / 4032 * 1600
})

test('a portrait photograph keeps its aspect ratio too', () => {
  const out = scaleToWidth({ width: 3024, height: 4032 })
  assert.equal(out.width, MAX_WIDTH)
  assert.equal(out.height, 2133)
})

test('a small image is never enlarged', () => {
  // Upscaling invents detail and makes the file bigger for a worse result.
  const out = scaleToWidth({ width: 600, height: 400 })
  assert.deepEqual(out, { width: 600, height: 400 })
  assert.equal(needsResize({ width: 600, height: 400 }), false)
})

test('an image exactly at the limit is left alone', () => {
  assert.equal(needsResize({ width: MAX_WIDTH, height: 900 }), false)
  assert.equal(needsResize({ width: MAX_WIDTH + 1, height: 900 }), true)
})

test('a missing or zero dimension does not produce NaN in the markup', () => {
  assert.deepEqual(scaleToWidth({ width: 0, height: 0 }), { width: 0, height: 0 })
  assert.deepEqual(scaleToWidth({} as any), { width: 0, height: 0 })
})

test('height never rounds to zero on an extreme panorama', () => {
  const out = scaleToWidth({ width: 20000, height: 5 })
  assert.ok(out.height >= 1, 'a zero-height image renders as nothing')
})

/* ── Quality stepping ────────────────────────────────────────────────────── */

test('quality steps down and then stops, rather than smearing the photograph', () => {
  const steps: number[] = []
  let q: number | null = START_QUALITY
  while (q !== null) { steps.push(q); q = nextQuality(q) }

  assert.equal(steps[0], START_QUALITY)
  assert.ok(steps.at(-1)! >= MIN_QUALITY, 'never goes below the floor')
  // Bounded: an extra encode costs more than the kilobytes a perfect search
  // would save.
  assert.ok(steps.length <= 5, `took ${steps.length} attempts: ${steps.join(', ')}`)
})

test('the floor is respected exactly', () => {
  assert.equal(nextQuality(MIN_QUALITY), null)
  assert.equal(nextQuality(MIN_QUALITY + 1), null)
})

/* ── The ceilings ────────────────────────────────────────────────────────── */

test("the refusal threshold matches Webflow's own cap", () => {
  // If this drifts above what Webflow accepts, the upload fails with an error
  // that names neither the file nor the size.
  assert.equal(WEBFLOW_MAX_BYTES, 4 * 1024 * 1024)
})

test('the target is well under the ceiling, not just under it', () => {
  // The target is what a page should carry; the ceiling is what Webflow will
  // take. They are not the same number and should not drift together.
  assert.ok(TARGET_BYTES < WEBFLOW_MAX_BYTES / 4)
})

/* ── Naming ──────────────────────────────────────────────────────────────── */

test('the asset takes the format it was actually encoded in', () => {
  // Her real filenames.
  assert.equal(outputName('Kerry Harvey-246_PE.jpg'), 'Kerry-Harvey-246_PE.webp')
  assert.equal(outputName('thumbnail_IMG_4158.jpg'), 'thumbnail_IMG_4158.webp')
})

test('a camera-roll uuid survives as a usable name', () => {
  assert.equal(
    outputName('badd79b6-09e2-4652-9caa-7ae529ed1714.jpeg'),
    'badd79b6-09e2-4652-9caa-7ae529ed1714.webp'
  )
})

test('a name that cleans away to nothing still yields a filename', () => {
  assert.equal(outputName('   '), 'image.webp')
  assert.equal(outputName('.jpg'), 'image.webp')
})

test('a very long name is trimmed rather than rejected', () => {
  const out = outputName('x'.repeat(300) + '.jpg')
  assert.ok(out.length <= 85, `name was ${out.length} characters`)
  assert.match(out, /\.webp$/)
})
