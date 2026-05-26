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
import { requireAuth, ALL_TOOLS } from './_lib/auth'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'
import { addContactToList, sendResultsEmail } from './_lib/brevo'

const ALLOWED_ORIGINS = ['https://hub.expertauthor.community']

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}


async function atGet(path: string) {
  const tableId = encodeURIComponent(process.env.AIRTABLE_UNBLOCKER_TABLE_ID!)
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${tableId}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

// -- Route --------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // GET: retrieve result(s) for the logged-in member
  if (req.method === 'GET') {
    const session = await requireAuth(req, res, ALL_TOOLS)
    if (!session) return
    const { email } = session

    const { id } = req.query

    if (id && typeof id === 'string') {
      try {
        const record = await atGet('/' + id)
        const recordEmail = (record.fields['Email'] as string) ?? ''
        if (recordEmail.toLowerCase() !== email.toLowerCase()) {
          return res.status(403).json({ error: 'Forbidden' })
        }
        return res.status(200).json({
          id:               record.id,
          submittedAt:      record.fields['Submitted At'] || record.createdTime || null,
          primaryBlocker:   record.fields['Primary Blocker']   || '',
          secondaryBlocker: record.fields['Secondary Blocker'] || '',
          intensityTier:    record.fields['Intensity Tier']    || 'scattered',
          scores: {
            Time:      record.fields['Score: Time']      || 0,
            Structure: record.fields['Score: Structure'] || 0,
            Noise:     record.fields['Score: Noise']     || 0,
            Isolation: record.fields['Score: Isolation'] || 0,
            Momentum:  record.fields['Score: Momentum']  || 0,
          },
        })
      } catch (err) {
        console.error('[unblocker] GET single error:', err)
        return res.status(500).json({ error: 'Failed to load result' })
      }
    }

    try {
      const filter = encodeURIComponent('{Email}="' + email + '"')
      const data = await atGet(
        '?filterByFormula=' + filter +
        '&fields[]=Submitted%20At&fields[]=Primary%20Blocker&fields[]=Secondary%20Blocker&fields[]=Intensity%20Tier'
      )
      const results = ((data.records || []) as Array<{ id: string; fields: Record<string, unknown>; createdTime: string }>)
        .map(r => ({
          id:               r.id,
          submittedAt:      (r.fields['Submitted At'] as string) || r.createdTime || null,
          primaryBlocker:   (r.fields['Primary Blocker']   as string) || '',
          secondaryBlocker: (r.fields['Secondary Blocker'] as string) || '',
          intensityTier:    (r.fields['Intensity Tier']    as string) || 'scattered',
        }))
        .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''))
      return res.status(200).json({ results })
    } catch (err) {
      console.error('[unblocker] GET list error:', err)
      return res.status(500).json({ error: 'Failed to load results' })
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // 1. Origin check — block direct API hits from outside the site
  const origin = (req.headers['origin'] ?? req.headers['referer'] ?? '') as string
  if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return res.status(403).json({ error: 'Forbidden' })
  }

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

  // 2. Email validation
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email required' })
  }

  if (!primaryBlocker || !scores) {
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
      'Submitted At':        new Date().toISOString(),
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

    // ── Step 4: Brevo — add to list + send results email (best-effort) ───
    await Promise.all([
      addContactToList({ email, firstName: name || '', tool: 'unblocker' }),
      sendResultsEmail({
        to:   { email, name: name || email },
        tool: 'unblocker',
        templateParams: {
          FIRSTNAME:        name             || '',
          PRIMARY_BLOCKER:  primaryBlocker   || '',
          SECONDARY_BLOCKER: secondaryBlocker || '—',
          INTENSITY_TIER:   intensityTier    || '',
          SCORE_TIME:       scores.Time      ?? 0,
          SCORE_STRUCTURE:  scores.Structure ?? 0,
          SCORE_NOISE:      scores.Noise     ?? 0,
          SCORE_ISOLATION:  scores.Isolation ?? 0,
          SCORE_MOMENTUM:   scores.Momentum  ?? 0,
        },
      }),
    ])

    // ── Step 5: Activity Log (only if we have a person) ───────────────────
    if (personId) {
      try {
        await logActivity({
          personId,
          actionType:  'Writing Unblock Completed',
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
