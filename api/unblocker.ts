/*
 * Airtable handler — Unblocker diagnostic submissions
 *
 * TABLE: "Unblocker Responses" in the same Airtable base
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_UNBLOCKER_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    email,
    name,
    primaryBlocker,
    secondaryBlocker,
    intensityTier,
    scores,
    context,
    isMember,
    combinationPattern,
    source,
  } = req.body

  if (!email || !primaryBlocker || !scores) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' })
  }

  if (!process.env.AIRTABLE_UNBLOCKER_TABLE_ID) {
    console.warn('AIRTABLE_UNBLOCKER_TABLE_ID not set — skipping Airtable write')
    return res.status(200).json({ ok: true, skipped: true })
  }

  const fields: Record<string, unknown> = {
    'Name':               name || '',
    'Email':              email,
    'Primary Blocker':    primaryBlocker,
    'Secondary Blocker':  secondaryBlocker || '',
    'Intensity Tier':     intensityTier || '',
    'Score: Time':        scores.Time        ?? 0,
    'Score: Structure':   scores.Structure   ?? 0,
    'Score: Noise':       scores.Noise       ?? 0,
    'Score: Isolation':   scores.Isolation   ?? 0,
    'Score: Momentum':    scores.Momentum    ?? 0,
    'Context':            context || '',
    'Is Member':          !!isMember,
    'Combination Pattern': combinationPattern || '',
    'Source':             source || 'unblocker',
  }

  try {
    const tableId = encodeURIComponent(process.env.AIRTABLE_UNBLOCKER_TABLE_ID)
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${tableId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ fields }),
      }
    )

    if (!airtableRes.ok) {
      const error = await airtableRes.json()
      console.error('Airtable error:', error)
      return res.status(200).json({ ok: false, error: 'Airtable API error' })
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('Unblocker handler error:', err)
    return res.status(200).json({ ok: false, error: 'Internal error' })
  }
}
