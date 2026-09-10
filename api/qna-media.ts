/*
 * Author Editorial Q&A — media uploads (author-facing, token-gated)
 *
 * POST { token, action: 'sign',    name, type, size }  → { uploadUrl, path }
 * POST { token, action: 'confirm', path, name, type, size } → { media }
 * POST { token, action: 'remove',  path }              → { media }
 *
 * Three steps rather than one because Vercel caps a request body at 4.5 MB
 * and a photo off a phone is routinely past it. The browser uploads straight
 * to Supabase with a signed URL; this endpoint only decides whether it may,
 * and records the result. See _lib/qna-media.ts.
 *
 * Token-only auth, same shape and same reasoning as qna-intake: an unknown
 * token and a wrong one both return 404, so this cannot be used to discover
 * which tokens exist.
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { tokensMatch } from './_lib/qna-tokens'
import {
  ALLOWED_TYPES,
  MAX_BYTES,
  MAX_FILES,
  deleteMedia,
  parseMedia,
  signUpload,
  signedUrlFor,
  type MediaFile,
} from './_lib/qna-media'

const QNA_TABLE = process.env.AIRTABLE_QNA_TABLE_ID!

async function atGet(path: string) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status}`)
  return res.json()
}

async function atPatch(recordId: string, fields: Record<string, unknown>) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${QNA_TABLE}/${recordId}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Airtable PATCH failed: ${res.status} ${body.slice(0, 300)}`)
  }
  return res.json()
}

/**
 * What the page needs to show one file: everything except the storage path,
 * which the author has no use for and which shouldn't leave the server.
 */
async function publicMedia(files: MediaFile[]) {
  return Promise.all(
    files.map(async f => ({
      id:   f.path,          // opaque handle for a later remove
      name: f.name,
      type: f.type,
      size: f.size,
      url:  await signedUrlFor(f.path).catch(err => {
        console.error('[qna-media] sign failed:', err)
        return null
      }),
    }))
  )
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { token, action } = req.body ?? {}
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const data = await atGet('?pageSize=100')
    const row = (data.records ?? []).find((r: any) =>
      tokensMatch(r.fields['Intake Token'], token)
    )
    if (!row) return res.status(404).json({ error: 'This link is not valid.' })
    if (row.fields['Author Submitted At']) {
      return res.status(409).json({ error: 'This response has already been submitted.' })
    }

    const existing = parseMedia(row.fields['Author Media'])

    if (action === 'sign') {
      const { name, type, size } = req.body ?? {}

      if (existing.length >= MAX_FILES) {
        return res.status(400).json({ error: `You can add up to ${MAX_FILES} files.` })
      }
      if (!ALLOWED_TYPES.includes(String(type))) {
        return res.status(415).json({
          error: `We can't take ${String(type) || 'that kind of file'}. Images, PDFs and video only.`,
        })
      }
      // Checked here as well as by the bucket, so an author learns before
      // spending five minutes uploading rather than after.
      if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
        return res.status(413).json({
          error: `That file is over ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
        })
      }

      const signed = await signUpload(row.id, String(name ?? 'file'))
      return res.status(200).json(signed)
    }

    if (action === 'confirm') {
      const { path, name, type, size } = req.body ?? {}

      // The path has to be one this endpoint issued for this author. Without
      // this check a token holder could attach any object in the bucket,
      // including another author's photographs, to their own row.
      if (typeof path !== 'string' || !path.startsWith(`${row.id}/`)) {
        return res.status(400).json({ error: 'That upload does not belong to this page.' })
      }
      if (existing.some(f => f.path === path)) {
        return res.status(200).json({ media: await publicMedia(existing) })
      }
      if (existing.length >= MAX_FILES) {
        return res.status(400).json({ error: `You can add up to ${MAX_FILES} files.` })
      }

      const next: MediaFile[] = [
        ...existing,
        {
          path,
          name: String(name ?? 'file').slice(0, 200),
          type: String(type ?? ''),
          size: Number(size) || 0,
          uploadedAt: new Date().toISOString(),
        },
      ]
      await atPatch(row.id, { 'Author Media': JSON.stringify(next) })
      console.log(`[qna-media] ${row.fields['Author Name']} added ${name}`)
      return res.status(200).json({ media: await publicMedia(next) })
    }

    if (action === 'remove') {
      const { path } = req.body ?? {}
      const next = existing.filter(f => f.path !== path)

      // Row first, storage second. If the delete fails the author still sees
      // the file gone, which is what they asked for; an orphan in the bucket
      // costs storage and nothing else.
      await atPatch(row.id, { 'Author Media': JSON.stringify(next) })
      await deleteMedia(String(path)).catch(err =>
        console.error('[qna-media] storage delete failed:', err)
      )
      return res.status(200).json({ media: await publicMedia(next) })
    }

    return res.status(400).json({ error: 'action must be sign, confirm or remove' })
  } catch (err) {
    console.error('[qna-media] request failed:', err)
    const detail = err instanceof Error ? err.message : ''
    return res.status(500).json({ error: detail || 'Upload failed. Please try again.' })
  }
}
