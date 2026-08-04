/*
 * Author Editorial Q&A — Kelly's voice for the intake page (admin)
 *
 * GET                                 → lists the account's ElevenLabs voices,
 *                                        so the right voice ID can be found
 *                                        without leaving the admin screen
 * POST { authorItemId }               → renders the intro + every question in
 *                                        Kelly's voice and caches the clips
 *
 * Clips are pre-generated and stored, never synthesised on page load: TTS per
 * visit would make the author wait, and would bill a fresh generation every
 * time someone refreshed. Regenerate after changing the question set.
 *
 * Env vars required:
 *   JWT_SECRET, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_QNA_TABLE_ID,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'
import { textToSpeech, listVoices } from './_lib/elevenlabs'
import { uploadAudio } from './_lib/qna-storage'

// Seven clips through a high-quality TTS model is not a 15-second job.
export const maxDuration = 300

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

function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function firstName(full: string): string {
  return String(full || '').trim().split(/\s+/)[0] || 'there'
}

/**
 * What Kelly says at the top. Written to be *spoken* — short sentences, plain
 * words, no bullet-point cadence — and to carry the same "this isn't a
 * testimonial" framing as the written intro, in her voice rather than ours.
 */
function introScript(authorName: string, bookTitle: string): string {
  return [
    `Hi ${firstName(authorName)}, it's Kelly.`,
    `Thank you for doing this.`,
    `We're building a more editorial home for the Expert Author Community, and I wanted to ask you about ${bookTitle}.`,
    `This isn't a testimonial. I'm not after kind words about us.`,
    `What I'm actually interested in is what the writing and the publishing taught you. The things you'd tell another expert who was about to start.`,
    `There are six questions. Take them at your own pace. Type your answers or record them, whichever feels easier.`,
    `Thanks again. I'm looking forward to reading what you say.`,
  ].join(' ')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await getSession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })
  if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

  try {
    if (req.method === 'GET') {
      const voices = await listVoices()
      return res.status(200).json({
        voices,
        configured: process.env.ELEVENLABS_VOICE_ID ?? null,
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    if (!process.env.ELEVENLABS_VOICE_ID) {
      return res.status(400).json({
        error: 'No voice configured. Set ELEVENLABS_VOICE_ID in Vercel to Kelly\'s voice ID.',
      })
    }

    const { authorItemId } = req.body ?? {}
    if (!authorItemId || typeof authorItemId !== 'string') {
      return res.status(400).json({ error: 'authorItemId is required' })
    }

    const data = await atGet('?pageSize=100')
    const row = (data.records ?? []).find(
      (r: any) => r.fields['Webflow Author Item ID'] === authorItemId
    )
    if (!row) return res.status(404).json({ error: 'No pipeline row for this author' })

    const questions = parseJson(row.fields['Question Set'])
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Save a question set first' })
    }

    const authorName = row.fields['Author Name'] ?? ''
    const bookTitle  = row.fields['Book Title'] ?? ''

    const clips: Array<{ key: string; text: string }> = [
      { key: 'intro', text: introScript(authorName, bookTitle) },
      ...questions.map((q: string, i: number) => ({ key: `q${i}`, text: q })),
    ]

    // Timestamped folder so a regeneration never serves a half-replaced set —
    // the old clips stay valid until the new map is written.
    const stamp = Date.now()
    const voiceMap: Record<string, string> = {}
    const failed: string[] = []

    // Best-effort per clip: one failed question shouldn't cost the whole set.
    for (const clip of clips) {
      try {
        const audio = await textToSpeech(clip.text)
        const path = `voice/${row.id}/${stamp}-${clip.key}.mp3`
        await uploadAudio(path, audio, 'audio/mpeg')
        voiceMap[clip.key] = path
      } catch (err) {
        console.error(`[qna-voice] ${clip.key} failed:`, err)
        failed.push(clip.key)
      }
    }

    if (Object.keys(voiceMap).length === 0) {
      return res.status(500).json({ error: 'Every clip failed to generate. Check the voice ID and API key.' })
    }

    await atPatch(row.id, { 'Voice Audio': JSON.stringify(voiceMap) })

    console.log(
      `[qna-voice] ${authorName}: ${Object.keys(voiceMap).length}/${clips.length} clips generated`
    )
    return res.status(200).json({
      generated: Object.keys(voiceMap).length,
      total:     clips.length,
      failed,
    })
  } catch (err) {
    console.error('[qna-voice] request failed:', err)
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }
}
