/*
 * Getting an author's photograph down to something a web page should carry.
 *
 * WHY THIS IS NOT OPTIONAL
 * Kerryn sent 21.9 MB across eleven files, 14.09 MB of it in one photograph
 * straight off a camera. Two separate things go wrong if that reaches the post
 * unchanged:
 *
 *   1. Webflow refuses it. Assets are capped at 4 MB, so the upload fails and
 *      the publish stage fails with it.
 *   2. Even under the cap it would be a disaster on the page. Rich text images
 *      get no srcset - verified on Penelope's published post, neither of hers
 *      has one - so whatever is uploaded is what every visitor downloads, in
 *      full, on every device. On the post that carries two thirds of the
 *      site's organic traffic that is not a detail.
 *
 * So everything is resized and re-encoded on the way through, and the upload
 * refuses anything still over the ceiling afterwards rather than letting
 * Webflow be the one to say no.
 *
 * WEBP RATHER THAN JPEG
 * Webflow serves webp for everything it converts itself, the format is
 * universally supported now, and it is roughly a third smaller than JPEG at
 * the same visual quality. The one thing it is not good for is a photograph
 * somebody will download and reuse, which is not what these are.
 *
 * The maths here is pure and tested. The encoding is sharp's and is not.
 */

/** Wide enough for a full-bleed image on a 1280px container at 2x on the
 *  parts that matter, small enough that nobody waits for it. */
export const MAX_WIDTH = 1600

/** Quality where webp stops being distinguishable from the original on a
 *  photograph, found by the usual method of looking at it. */
export const START_QUALITY = 82

/** Never go below this chasing a byte target - a smeared photograph of
 *  somebody's worst year is not a win. */
export const MIN_QUALITY = 60

/** What we aim for. A full-width photograph at this size loads instantly on
 *  a phone connection. */
export const TARGET_BYTES = 400 * 1024

/**
 * Webflow's own ceiling for an asset. Anything still above this after
 * re-encoding is refused here, with a message that says what happened, rather
 * than being sent for Webflow to reject with one that does not.
 */
export const WEBFLOW_MAX_BYTES = 4 * 1024 * 1024

export interface Dimensions { width: number; height: number }

/**
 * The size an image becomes, preserving its shape.
 *
 * Never enlarges. An author who sends a 600px photograph gets a 600px
 * photograph: upscaling invents detail and makes the file bigger for a result
 * that looks worse.
 */
export function scaleToWidth(source: Dimensions, maxWidth = MAX_WIDTH): Dimensions {
  const w = Math.max(0, Math.round(source?.width ?? 0))
  const h = Math.max(0, Math.round(source?.height ?? 0))
  if (!w || !h) return { width: 0, height: 0 }
  if (w <= maxWidth) return { width: w, height: h }
  return { width: maxWidth, height: Math.max(1, Math.round((h / w) * maxWidth)) }
}

/** Whether an image is wide enough to be worth resampling at all. */
export function needsResize(source: Dimensions, maxWidth = MAX_WIDTH): boolean {
  return (source?.width ?? 0) > maxWidth
}

/**
 * The quality to try next when the last attempt came out too heavy.
 *
 * Steps rather than a search: an extra encode costs more than the handful of
 * kilobytes a perfectly tuned quality would save, and three attempts covers
 * the range between a screenshot and a camera raw.
 */
export function nextQuality(current: number): number | null {
  const step = current > 70 ? 10 : 7
  const next = current - step
  return next >= MIN_QUALITY ? next : null
}

/** The name the asset gets in Webflow, with the extension the bytes deserve. */
export function outputName(sourceName: string, ext = 'webp'): string {
  const base = String(sourceName ?? '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return `${base || 'image'}.${ext}`
}

export interface Optimised {
  buffer: Buffer
  bytes: number
  width: number
  height: number
  quality: number
  contentType: string
}

/**
 * A photograph, resized and re-encoded until it is small enough to publish.
 *
 * rotate() first and without arguments: that applies the EXIF orientation and
 * discards the tag. Skipping it is how a portrait taken on a phone arrives on
 * the page lying on its side, because the pixels were always landscape and
 * only the tag said otherwise - and resizing drops the tag.
 *
 * sharp is imported here rather than at module scope so that nothing else in
 * this file needs it to be installed, which keeps the maths testable.
 */
export async function optimiseImage(input: Buffer): Promise<Optimised> {
  const { default: sharp } = await import('sharp')

  const meta = await sharp(input).metadata()
  const target = scaleToWidth({ width: meta.width ?? 0, height: meta.height ?? 0 })

  let quality: number = START_QUALITY
  let best: Optimised | null = null

  for (;;) {
    const pipeline = sharp(input).rotate()
    if (target.width && needsResize({ width: meta.width ?? 0, height: meta.height ?? 0 })) {
      pipeline.resize({ width: target.width, withoutEnlargement: true })
    }
    const buffer = await pipeline.webp({ quality }).toBuffer()
    const out: Optimised = {
      buffer,
      bytes: buffer.length,
      width: target.width || (meta.width ?? 0),
      height: target.height || (meta.height ?? 0),
      quality,
      contentType: 'image/webp',
    }

    // Keep the smallest attempt, not the last: a lower quality that somehow
    // encoded larger is not an improvement worth publishing.
    if (!best || out.bytes < best.bytes) best = out

    if (out.bytes <= TARGET_BYTES) break
    const lower = nextQuality(quality)
    if (lower === null) break
    quality = lower
  }

  if (!best) throw new Error('Image could not be encoded')

  if (best.bytes > WEBFLOW_MAX_BYTES) {
    throw new Error(
      `Still ${(best.bytes / 1024 / 1024).toFixed(1)} MB after resizing to ` +
      `${best.width}px at quality ${best.quality}. Webflow will not take it.`
    )
  }

  return best
}
