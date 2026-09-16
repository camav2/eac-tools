/*
 * Photographs in the post body: the figure, and where it lands.
 *
 * The published page is the only place these mistakes show up, so the tests
 * pin the exact markup Webflow expects rather than "contains an img". A
 * figure with the wrong class is not a styling nit here - it is an image
 * sitting alone above the text with the float silently dropped, which is
 * precisely the bug the headshot figure was written to fix.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALIGNMENTS,
  DEFAULT_ALIGNMENT,
  isAlignment,
  sanitiseImageSpec,
  figureHtml,
  imagesInDraft,
} from '../api/_lib/qna-images'
import { postBodyHtml } from '../api/_lib/qna-post'

const FILE = 'recrTrVsS1yskvxHp/1789379906210-thumbnail_IMG_4158.jpg'
const URL = 'https://cdn.prod.website-files.com/685f75e1/abc_photo.jpg'

/* ── The vocabulary ──────────────────────────────────────────────────────── */

test("the alignments are Webflow's own and nothing else", () => {
  // These are the class suffixes Webflow writes. Inventing one means the
  // template has no rule for it and the image renders unstyled.
  assert.deepEqual([...ALIGNMENTS], ['normal', 'center', 'fullwidth', 'floatleft', 'floatright'])
  assert.equal(isAlignment('center'), true)
  assert.equal(isAlignment('middle'), false)
  assert.equal(isAlignment(''), false)
})

/* ── Sanitising what the draft screen sends ──────────────────────────────── */

test('an image with no file is not an image', () => {
  // Rendering a figure round an empty src puts a broken picture on a live page.
  assert.equal(sanitiseImageSpec({ align: 'center', caption: 'A photo' }), null)
  assert.equal(sanitiseImageSpec(null), null)
  assert.equal(sanitiseImageSpec('a string'), null)
})

test('an unknown alignment falls back rather than reaching the page', () => {
  const spec = sanitiseImageSpec({ file: FILE, align: 'diagonal' })
  assert.equal(spec?.align, DEFAULT_ALIGNMENT)
})

test('alt text is capped, because it gets read aloud', () => {
  const spec = sanitiseImageSpec({ file: FILE, alt: 'x'.repeat(500) })
  assert.equal(spec?.alt.length, 300)
})

/* ── The figure ──────────────────────────────────────────────────────────── */

test("the figure is the shape Webflow writes", () => {
  const spec = sanitiseImageSpec({ file: FILE, align: 'fullwidth', alt: 'Kerryn in hospital' })!
  const html = figureHtml(URL, spec)
  assert.equal(
    html,
    '<figure class="w-richtext-align-fullwidth w-richtext-figure-type-image">' +
    `<div><img src="${URL}" alt="Kerryn in hospital"></div></figure>`
  )
})

test('a floated image carries a width, because a float that fills the column is not a float', () => {
  const spec = sanitiseImageSpec({ file: FILE, align: 'floatleft', alt: 'A' })!
  assert.match(figureHtml(URL, spec), /w-richtext-align-floatleft[\s\S]*width="320"/)
})

test('a full-width image carries no width attribute', () => {
  const spec = sanitiseImageSpec({ file: FILE, align: 'fullwidth', alt: 'A' })!
  assert.doesNotMatch(figureHtml(URL, spec), /width=/)
})

test('a caption becomes a figcaption, and no caption becomes nothing', () => {
  const withCap = sanitiseImageSpec({ file: FILE, caption: 'Rehab, 2013', alt: 'A' })!
  assert.match(figureHtml(URL, withCap), /<figcaption>Rehab, 2013<\/figcaption>/)
  const without = sanitiseImageSpec({ file: FILE, alt: 'A' })!
  assert.doesNotMatch(figureHtml(URL, without), /figcaption/)
})

test('alt falls back to the caption rather than being left empty', () => {
  const spec = sanitiseImageSpec({ file: FILE, caption: 'Rehab, 2013' })!
  assert.match(figureHtml(URL, spec), /alt="Rehab, 2013"/)
})

test('a caption cannot inject markup into the page', () => {
  const spec = sanitiseImageSpec({ file: FILE, caption: '<script>x</script>', alt: '"quoted"' })!
  const html = figureHtml(URL, spec)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /alt="&quot;quoted&quot;"/)
})

test('no url means no figure at all', () => {
  const spec = sanitiseImageSpec({ file: FILE, alt: 'A' })!
  assert.equal(figureHtml('', spec), '')
})

/* ── Where it lands in the body ──────────────────────────────────────────── */

const DRAFT = {
  standfirst: 'Kerryn Harvey on surviving a flesh-eating bacteria.',
  items: [
    { question: 'What did the page demand?', answer: 'It was like going back there all over again.',
      image: { file: FILE, align: 'fullwidth', caption: 'Rehab, 2013', alt: 'Kerryn in rehab' } },
    { question: 'And the second?', answer: 'Overwhelming.' },
  ],
}

test('the image follows the answer it belongs to, not the question', () => {
  const html = postBodyHtml(DRAFT as any, { imageUrls: { [FILE]: URL } })
  const answerAt = html.indexOf('going back there')
  const figureAt = html.indexOf('<figure')
  const nextQAt  = html.indexOf('And the second')
  assert.ok(answerAt > -1 && figureAt > -1 && nextQAt > -1)
  assert.ok(figureAt > answerAt, 'figure should come after its answer')
  assert.ok(figureAt < nextQAt, 'figure should come before the next question')
})

test('an answer with no image renders exactly as it always did', () => {
  const html = postBodyHtml(DRAFT as any, { imageUrls: { [FILE]: URL } })
  assert.equal((html.match(/<figure/g) || []).length, 1)
})

test('an unresolved path renders nothing rather than a broken image', () => {
  // The path is in the draft but was never re-hosted. Silence is the only
  // safe outcome: the alternative is a published page of broken pictures.
  const html = postBodyHtml(DRAFT as any, { imageUrls: {} })
  assert.doesNotMatch(html, /<figure/)
  assert.match(html, /going back there/)
})

test('the lead image sits under the rule, above the first question', () => {
  const withLead = { ...DRAFT, lead: { file: FILE, align: 'fullwidth', alt: 'Kerryn' } }
  const html = postBodyHtml(withLead as any, { imageUrls: { [FILE]: URL } })
  const hrAt = html.indexOf('<hr>')
  const leadAt = html.indexOf('<figure')
  const firstQAt = html.indexOf('What did the page demand')
  assert.ok(hrAt < leadAt && leadAt < firstQAt)
})

test('the headshot figure is still the floated one beside the standfirst', () => {
  // Regression guard: the lead image must not displace the headshot.
  const html = postBodyHtml(DRAFT as any, {
    headshotUrl: 'https://cdn.prod.website-files.com/face.jpg',
    authorName: 'Kerryn Harvey',
    imageUrls: { [FILE]: URL },
  })
  assert.match(html, /w-richtext-align-floatleft[\s\S]*face\.jpg[\s\S]*width="96"/)
})

/* ── Collecting them for the publish step ────────────────────────────────── */

test('every image in a draft is listed in the order it appears', () => {
  const withLead = { ...DRAFT, lead: { file: 'lead/photo.jpg' } }
  assert.deepEqual(imagesInDraft(withLead as any).map(i => i.file), ['lead/photo.jpg', FILE])
})

test('a draft with no images lists none', () => {
  assert.deepEqual(imagesInDraft({ items: [{ question: 'q', answer: 'a' }] } as any), [])
  assert.deepEqual(imagesInDraft({} as any), [])
})
