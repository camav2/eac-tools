/*
 * Audio storage for the Author Editorial Q&A intake — Supabase Storage.
 *
 * The bucket is PRIVATE. Author recordings are unpublished, often candid
 * reflections; a public bucket would make every recording readable by anyone
 * who guessed the path. Playback in the admin UI goes through short-lived
 * signed URLs minted server-side.
 *
 * The bucket self-provisions on first upload so there's no hand-created
 * dependency — same reasoning as the rest of this tool.
 *
 * Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const BUCKET = 'qna-audio'

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
 * Supabase signals "already exists" as HTTP 400 with {"statusCode":"409",
 * "code":"BucketAlreadyExists"} in the *body* — the HTTP status does not
 * reflect it. Checking res.status alone therefore treats the normal
 * steady-state case as a fatal error, which is exactly what happened: the
 * first upload succeeded and every one after it failed.
 */
async function ensureBucket(): Promise<void> {
  const res = await fetch(storageUrl('/bucket'), {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: false,
      file_size_limit: 26214400, // 25 MB — well above our client-side cap
      allowed_mime_types: ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'],
    }),
  })
  if (res.ok) return

  const body = await res.text().catch(() => '')
  if (res.status === 409 || /BucketAlreadyExists|already exists|"statusCode":"409"/i.test(body)) {
    return // already provisioned — the desired end state
  }
  throw new Error(`Supabase bucket create failed: ${res.status} ${body.slice(0, 200)}`)
}

export function extensionFor(contentType: string): string {
  if (contentType.includes('webm')) return 'webm'
  if (contentType.includes('mp4'))  return 'm4a'
  if (contentType.includes('mpeg')) return 'mp3'
  if (contentType.includes('ogg'))  return 'ogg'
  if (contentType.includes('wav'))  return 'wav'
  return 'bin'
}

function putObject(path: string, data: Buffer, contentType: string) {
  return fetch(storageUrl(`/object/${BUCKET}/${path}`), {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType, 'x-upsert': 'true' }),
    body: new Uint8Array(data),
  })
}

/**
 * Returns the storage path (not a URL) — URLs are minted on demand.
 *
 * Uploads first and only provisions the bucket if the upload reports it
 * missing, rather than calling ensureBucket() every time. The steady state
 * (bucket exists) is then a single request, and the provisioning path runs
 * once in the tool's lifetime instead of on every recording.
 */
export async function uploadAudio(
  path: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  let res = await putObject(path, data, contentType)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 404 || /Bucket not found|NoSuchBucket/i.test(body)) {
      await ensureBucket()
      res = await putObject(path, data, contentType)
    } else {
      throw new Error(`Supabase upload failed: ${res.status} ${body.slice(0, 200)}`)
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase upload failed after bucket create: ${res.status} ${body.slice(0, 200)}`)
  }
  return path
}

/** Short-lived signed URL for playback or server-side fetch. */
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
  // signedURL comes back relative, e.g. "/object/sign/qna-audio/…?token=…"
  return `${process.env.SUPABASE_URL}/storage/v1${data.signedURL}`
}

/** Fetches the raw bytes back — used by the transcription step. */
export async function downloadAudio(path: string): Promise<{ buffer: Buffer; contentType: string }> {
  const url = await signedUrlFor(path, 300)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Supabase download failed: ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  }
}
