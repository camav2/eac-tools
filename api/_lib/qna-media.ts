/*
 * Author-supplied media for the Editorial Q&A — Supabase Storage.
 *
 * WHY THIS DOES NOT GO THROUGH THE API THE WAY AUDIO DOES
 * Vercel caps a request body at 4.5 MB. A photo straight off a phone is
 * routinely 3-8 MB and a video is far past it, so routing these through a
 * function would reject exactly the files an author is most likely to send.
 * Instead the server mints a short-lived signed upload URL and the browser
 * PUTs the file to Supabase directly, which the cap never touches.
 *
 * The trade is an orphan risk: a browser closed between the upload and the
 * confirm leaves a file nothing points at. That costs storage and nothing
 * else, which is a better failure than refusing an author's photo.
 *
 * The bucket is PRIVATE, same reasoning as the recordings: these are
 * unpublished, sometimes personal, and a public bucket makes every one of
 * them readable by anyone who guesses a path.
 *
 * Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const BUCKET = 'qna-media'

/** Generous, because the point of asking is to get the good photograph rather
 *  than the one that happened to be small. Enforced by the bucket itself, so
 *  a signed URL cannot be used to push something larger. */
export const MAX_BYTES = 100 * 1024 * 1024

/** Twelve is more than any Q&A will use and still bounded. */
export const MAX_FILES = 12

/**
 * What an author might reasonably have: photographs, a scan, a short clip.
 * HEIC is here because it is what an iPhone produces by default and leaving
 * it out would reject half the uploads from Apple users without explanation.
 */
export const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm',
  'application/pdf',
]

export interface MediaFile {
  path: string
  name: string
  type: string
  size: number
  uploadedAt: string
}

function storageUrl(path: string): string {
  return `${process.env.SUPABASE_URL}/storage/v1${path}`
}

function headers(extra: Record<string, string> = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY!
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra }
}

/**
 * Idempotent bucket creation.
 *
 * Supabase reports "already exists" as HTTP 400 with a 409 buried in the body,
 * so the status alone cannot be trusted — the same trap that made every
 * recording after the first one fail when this was written for audio.
 */
async function ensureBucket(): Promise<void> {
  const res = await fetch(storageUrl('/bucket'), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: false,
      file_size_limit: MAX_BYTES,
      allowed_mime_types: ALLOWED_TYPES,
    }),
  })
  if (res.ok) return

  const body = await res.text().catch(() => '')
  if (res.status === 409 || /BucketAlreadyExists|already exists|"statusCode":"409"/i.test(body)) {
    return
  }
  throw new Error(`Supabase bucket create failed: ${res.status} ${body.slice(0, 200)}`)
}

/**
 * A filename that is safe as a storage path and still recognisable.
 *
 * Supabase keys tolerate little beyond word characters, and an author's file
 * is as likely to be called "Benita & Kel — launch night (1).JPG" as anything
 * else. The original name is kept in Airtable for display; this is only the
 * key.
 */
export function safeFileName(name: string): string {
  const cleaned = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(-80)
  return cleaned || 'file'
}

/**
 * A URL the browser can PUT one file to, and the path it will land on.
 *
 * Timestamped so two files of the same name from the same author cannot
 * collide, and so a re-upload never silently overwrites an earlier one.
 */
export async function signUpload(
  recordId: string,
  fileName: string
): Promise<{ uploadUrl: string; path: string }> {
  const path = `${recordId}/${Date.now()}-${safeFileName(fileName)}`

  const sign = () =>
    fetch(storageUrl(`/object/upload/sign/${BUCKET}/${path}`), {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: 3600 }),
    })

  let res = await sign()
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // First upload of the tool's life: provision, then try once more.
    if (res.status === 404 || /Bucket not found|NoSuchBucket/i.test(body)) {
      await ensureBucket()
      res = await sign()
    } else {
      throw new Error(`Supabase sign upload failed: ${res.status} ${body.slice(0, 200)}`)
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase sign upload failed after bucket create: ${res.status} ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  // Supabase returns a relative signed path, e.g.
  // "/object/upload/sign/qna-media/…?token=…"
  return { uploadUrl: `${process.env.SUPABASE_URL}/storage/v1${data.url}`, path }
}

/** Short-lived signed URL for viewing one file. */
export async function signedUrlFor(path: string, expiresInSeconds = 3600): Promise<string> {
  const res = await fetch(storageUrl(`/object/sign/${BUCKET}/${path}`), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase sign failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return `${process.env.SUPABASE_URL}/storage/v1${data.signedURL}`
}

/** Removes one file. Used when an author takes an upload back. */
export async function deleteMedia(path: string): Promise<void> {
  const res = await fetch(storageUrl(`/object/${BUCKET}/${path}`), {
    method: 'DELETE',
    headers: headers(),
  })
  // A file that is already gone is the desired end state, not a failure.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase delete failed: ${res.status} ${body.slice(0, 200)}`)
  }
}

export function parseMedia(raw: unknown): MediaFile[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((m: any) => m?.path && typeof m.path === 'string')
      .map((m: any) => ({
        path:       String(m.path),
        name:       String(m.name ?? 'file'),
        type:       String(m.type ?? ''),
        size:       Number(m.size) || 0,
        uploadedAt: String(m.uploadedAt ?? ''),
      }))
      .slice(0, MAX_FILES)
  } catch {
    return []
  }
}
