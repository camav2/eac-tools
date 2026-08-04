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

/** Idempotent — a 409 means the bucket already exists, which is success. */
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
  if (res.ok || res.status === 409) return
  const body = await res.text().catch(() => '')
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

/** Returns the storage path (not a URL) — URLs are minted on demand. */
export async function uploadAudio(
  path: string,
  data: Buffer,
  contentType: string
): Promise<string> {
  await ensureBucket()

  const res = await fetch(storageUrl(`/object/${BUCKET}/${path}`), {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType, 'x-upsert': 'true' }),
    body: new Uint8Array(data),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase upload failed: ${res.status} ${body.slice(0, 200)}`)
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
