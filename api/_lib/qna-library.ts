/*
 * The author's media library, mirrored into Airtable so there is a repository
 * somebody can actually look through.
 *
 * WHY THIS EXISTS
 * The uploads live in a private Supabase bucket, reachable only through signed
 * URLs minted per request. That is right for storage and useless as a library:
 * nobody can browse it, and choosing three photographs out of eleven means
 * looking at eleven photographs.
 *
 * Airtable is where the rest of this pipeline already is, so the library goes
 * there as attachments on the author's row, beside their answers.
 *
 * WHAT THIS IS NOT
 * It is not the host for a published image. Airtable attachment URLs expire
 * within hours, as do Supabase signed URLs, and a post pointing at either
 * would look fine on the day and be eleven broken pictures by the weekend.
 * Every image in a live EAC post body is served from Webflow's CDN. The
 * publish step re-hosts a chosen image there; this only ever feeds it.
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID
 */

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!

/** The attachment field this module owns. */
export const LIBRARY_FIELD = 'Author Media Library'

function atUrl(path: string): string {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}${path}`
}

function headers(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, ...extra }
}

/**
 * Creates the attachment field if it is not there.
 *
 * Same reasoning as ensureEditorialQnaField and the storage buckets: a feature
 * that needs somebody to hand-create a field first is a feature that sits
 * broken until they do, and the error it produces in the meantime explains
 * nothing.
 *
 * Idempotent on the body rather than the status, because that is the trap this
 * repo keeps meeting - Airtable answers a duplicate field name with a 422
 * naming the field, and reading the status alone would make every call after
 * the first look like a failure.
 */
export async function ensureLibraryField(): Promise<void> {
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${process.env.AIRTABLE_BASE_ID}/tables/${QNA_TABLE}/fields`,
    {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: LIBRARY_FIELD,
        type: 'multipleAttachments',
        description:
          'Everything the author uploaded with their Q&A, mirrored from the private ' +
          'qna-media bucket so it can be browsed. Attachment URLs here expire within ' +
          'hours: this is the library to choose from, never the source a published ' +
          'post points at. Publishing re-hosts the chosen image onto Webflow.',
      }),
    }
  )
  if (res.ok) {
    console.log(`[qna-library] created the ${LIBRARY_FIELD} field`)
    return
  }

  const body = await res.text().catch(() => '')
  if (/already exists|duplicate|same name/i.test(body)) return
  throw new Error(`Airtable field create failed: ${res.status} ${body.slice(0, 200)}`)
}

export interface LibraryFile {
  /** Storage path, which is the handle a draft image spec refers to. */
  path: string
  name: string
  /** A signed URL Airtable can fetch from right now. */
  url: string
}

/**
 * Replaces the library with exactly these files.
 *
 * Airtable fetches each url itself and keeps its own copy, so the signed URL
 * only has to survive the seconds between this call and Airtable's download.
 * Sent as a replacement rather than an append because the bucket is the truth:
 * a file the author removed should leave the library too.
 *
 * The filename is sent explicitly. Without it Airtable names every attachment
 * after the storage path, which is a timestamp and a uuid.
 */
export async function mirrorLibrary(recordId: string, files: LibraryFile[]): Promise<number> {
  const write = () =>
    fetch(atUrl(`/${recordId}`), {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        fields: {
          [LIBRARY_FIELD]: files.map(f => ({ url: f.url, filename: f.name })),
        },
      }),
    })

  let res = await write()
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // A missing field is fixed rather than reported, then tried once more.
    if (/UNKNOWN_FIELD_NAME|Unknown field name/i.test(body)) {
      await ensureLibraryField()
      res = await write()
    } else {
      throw new Error(`Airtable library write failed: ${res.status} ${body.slice(0, 200)}`)
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Airtable library write failed after field create: ${res.status} ${body.slice(0, 200)}`)
  }

  console.log(`[qna-library] mirrored ${files.length} file(s) to ${recordId}`)
  return files.length
}
