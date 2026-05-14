/*
 * Airtable handler — Unblocker diagnostic submissions
 *
 * Write order (each step fails independently):
 *   1+2. resolvePersonWithCircle: Circle lookup + People upsert (shared helper)
 *   3. Unblocker Submissions: always written, linked to person if steps 1+2 succeeded
 *   4. Activity Log: written only if steps 1+2 succeeded
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_UNBLOCKER_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'

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
    circleUserId,
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

  // ── Steps 1+2: Circle access group + People upsert (best-effort) ──────────
  const personId = await resolvePersonWithCircle({
    email,
    name:         name || '',
    isMember:     !!isMember,
    circleUserId: circleUserId ? String(circleUserId) : undefined,
  })

  // ── Step 3: Write Unblocker Submission (always) ───────────────────────────
  try {
    const fields: Record<string, unknown> = {
      'Email':               email,
      'First Name':          name || '',
      'Primary Blocker':     primaryBlocker,
      ...(secondaryBlocker ? { 'Secondary Blocker': secondaryBlocker } : {}),
      'Intensity Tier':      intensityTier || 'scattered',
      'Score: Time':         scores.Time        ?? 0,
      'Score: Structure':    scores.Structure   ?? 0,
      'Score: Noise':        scores.Noise       ?? 0,
      'Score: Isolation':    scores.Isolation   ?? 0,
      'Score: Momentum':     scores.Momentum    ?? 0,
      'Context':             context || '',
      'Is Member':           !!isMember,
      'Combination Pattern': combinationPattern || '',
      'Source':              source || 'unblocker',
    }
    if (personId) {
      fields['Person'] = [personId]
      console.log('[unblocker] linking person:', personId)
    }

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
      console.error('[unblocker] Airtable error:', JSON.stringify(error))
      return res.status(200).json({ ok: false, error: 'Airtable API error' })
    }

    const { id: resultId } = await airtableRes.json()
    console.log('[unblocker] written:', resultId)

    // ── Step 4: Activity Log (only if we have a person) ───────────────────
    if (personId) {
      try {
        await logActivity({
          personId,
          actionType:  'Unblocker Completed',
          sourceTool:  'unblocker',
          summary:     `Completed Unblocker Diagnostic — ${primaryBlocker} (${intensityTier || 'scattered'})`,
          referenceId: resultId,
        })
        console.log('[activity] logged')
      } catch (err) {
        console.error('[activity] failed:', err)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[unblocker] handler error:', err)
    return res.status(200).json({ ok: false, error: 'Internal error' })
  }
}
