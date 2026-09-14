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

/*
 * ── Supabase buries the real status in the body ──────────────────────────────
 *
 * None of these three conditions can be read off res.status, and getting that
 * wrong is what broke this feature: a missing bucket arrives as HTTP 400 with
 * {"statusCode":"404","error":"InvalidRequest","message":"The related resource
 * does not exist"}. The status says 400 and the message never says "bucket",
 * so the old check — res.status === 404 || /Bucket not found|NoSuchBucket/ —
 * never fired. ensureBucket() was therefore never reached, the bucket was
 * never provisioned, and every upload an author ever attempted failed.
 *
 * The audio module documents the same trap in the opposite direction, where a
 * 409 hides inside a 400. Both live here as named predicates so the next
 * variant has one obvious place to go.
 */

/** Missing bucket: HTTP 404, or a 404 buried in the body of a 400. */
export function isMissingBucket(status: number, body: string): boolean {
  return (
    status === 404 ||
    /"statusCode"\s*:\s*"?404"?/.test(body) ||
    /Bucket not found|NoSuchBucket|The related resource does not exist/i.test(body)
  )
}

/** Already provisioned — the desired end state, not a failure. */
export function isBucketAlreadyExists(status: number, body: string): boolean {
  return (
    status === 409 ||
    /"statusCode"\s*:\s*"?409"?/.test(body) ||
    /BucketAlreadyExists|already exists/i.test(body)
  )
}

/**
 * The project-wide upload cap can sit below the bucket we ask for, which
 * rejects the create outright. Free projects default to 50 MB; MAX_BYTES is
 * 100 MB.
 */
export function isOverGlobalLimit(body: string): boolean {
  return /global limit|exceeded the maximum allowed size|file_size_limit/i.test(body)
}

function createBucket(fileSizeLimit: number | null) {
  return fetch(storageUrl('/bucket'), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: false,
      ...(fileSizeLimit === null ? {} : { file_size_limit: fileSizeLimit }),
      allowed_mime_types: ALLOWED_TYPES,
    }),
  })
}

/** Idempotent bucket creation. */
async function ensureBucket(): Promise<void> {
  let res = await createBucket(MAX_BYTES)
  if (res.ok) return
  let body = await res.text().catch(() => '')
  if (isBucketAlreadyExists(res.status, body)) return

  // Inheriting the project's global limit is a better outcome than no bucket.
  if (isOverGlobalLimit(body)) {
    res = await createBucket(null)
    if (res.ok) return
    body = await res.text().catch(() => '')
    if (isBucketAlreadyExists(res.status, body)) return
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
    if (isMissingBucket(res.status, body)) {
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
