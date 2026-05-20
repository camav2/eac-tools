/*
 * Airtable API handler — Idea Test submissions
 *
 * POST — save a completed idea test (existing behaviour)
 * GET  — retrieve idea test result(s) for the logged-in member
 *   ?id=<recordId>  ->  single result (full answers)
 *   (no params)     ->  list of all results for the user (summary only)
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID, JWT_SECRET
 *   CIRCLE_API_TOKEN, CIRCLE_COMMUNITY_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'
import { addContactToList, sendResultsEmail } from './_lib/brevo'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

async function getSessionEmail(req: VercelRequest): Promise<string | null> {
  const token = parseCookie(req.headers.cookie ?? '', 'eac_session')
  if (!token) return null
  try {
    const { jwtVerify } = await import('jose')
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    const { payload } = await jwtVerify(token, secret)
    return (payload.sub as string) ?? null
  } catch {
    return null
  }
}

async function atGet(path: string) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

// ── Route ─────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // ── GET: retrieve result(s) for the logged-in member ──────────────────────
  if (req.method === 'GET') {
    const email = await getSessionEmail(req)
    if (!email) return res.status(401).json({ error: 'Unauthorised' })

    const { id } = req.query

    // Single result by record ID
    if (id && typeof id === 'string') {
      try {
        const record = await atGet(`/${id}`)
        const recordEmail = (record.fields['Email'] as string) ?? ''
        if (recordEmail.toLowerCase() !== email.toLowerCase()) {
          return res.status(403).json({ error: 'Forbidden' })
        }
        const f = record.fields as Record<string, unknown>
        return res.status(200).json({
          id:           record.id,
          submittedAt:  f['Submitted At'] || null,
          tier:         f['Tier']         || '',
          score:        f['Score']        || 0,
          ideaText:     f['Idea Text']    || '',
          answers: {
            1: f['Q1 – Persistence'] || 'not-yet',
            2: f['Q2 – Argument']    || 'not-yet',
            3: f['Q3 – Reader']      || 'not-yet',
            4: f['Q4 – Depth']       || 'not-yet',
            5: f['Q5 – Alignment']   || 'not-yet',
          },
        })
      } catch (err) {
        console.error('[airtable] GET single error:', err)
        return res.status(500).json({ error: 'Failed to load result' })
      }
    }

    // List all results for this user
    try {
      const filter = encodeURIComponent(`{Email}="${email}"`)
      const data = await atGet(
        `?filterByFormula=${filter}&sort[0][field]=Submitted%20At&sort[0][direction]=desc` +
        `&fields[]=Submitted%20At&fields[]=Tier&fields[]=Score&fields[]=Idea%20Text`
      )
      const results = ((data.records || []) as Array<{ id: string; fields: Record<string, unknown> }>)
        .map(r => ({
          id:          r.id,
          submittedAt: (r.fields['Submitted At'] as string) || null,
          tier:        (r.fields['Tier']         as string) || '',
          score:       (r.fields['Score']        as number) || 0,
          ideaText:    (r.fields['Idea Text']    as string) || '',
        }))
      return res.status(200).json({ results })
    } catch (err) {
      console.error('[airtable] GET list error:', err)
      return res.status(500).json({ error: 'Failed to load results' })
    }
  }

  // ── POST: save a completed idea test ──────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    email, firstName, ideaText,
    weightedScore, tier,
    q1, q2, q3, q4, q5,
    isMember, circleUserId,
  } = req.body

  if (!email) return res.status(400).json({ error: 'Email required' })

  // ── Email helpers ──────────────────────────────────────────────────────────
  function answerLabel(val: string): string {
    if (val === 'yes')            return 'Yes, clearly'
    if (val === 'getting-there')  return 'Getting there'
    return 'Not yet'
  }

  function tierDesc(t: string): string {
    if (t === 'Strong')     return 'Your idea has the depth, tension, and staying power to go the distance.'
    if (t === 'Developing') return 'Your idea has real potential — it needs sharper framing or more development before it\'s ready.'
    return 'Some ideas need to find their form first — an essay, a talk, or a shorter piece before a full book.'
  }

  const personId = await resolvePersonWithCircle({
    email,
    name:         firstName    || '',
    isMember:     !!isMember,
    circleUserId: circleUserId ? String(circleUserId) : undefined,
  })

  try {
    const fields: Record<string, unknown> = {
      'Email':            email,
      'First Name':       firstName   || '',
      'Idea Text':        ideaText    || '',
      'Score':            weightedScore,
      'Tier':             tier,
      'Q1 – Persistence': q1,
      'Q2 – Argument':    q2,
      'Q3 – Reader':      q3,
      'Q4 – Depth':       q4,
      'Q5 – Alignment':   q5,
      'Source Tool':      'idea-test',
      'Submitted At':     new Date().toISOString(),
    }
    if (personId && typeof personId === 'string') {
      fields['Person'] = [personId]
      console.log('[results] linking person:', personId)
    }

    const resultRes = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      }
    )

    if (!resultRes.ok) {
      const err = await resultRes.json()
      console.error('[results] Airtable error:', JSON.stringify(err))
      return res.status(500).json({ error: 'Airtable write failed' })
    }

    const { id: resultId } = await resultRes.json()
    console.log('[results] written:', resultId)

    await Promise.all([
      addContactToList({ email, firstName: firstName || '', tool: 'idea-test' }),
      sendResultsEmail({
        to:   { email, name: firstName || email },
        tool: 'idea-test',
        templateParams: {
          FIRSTNAME:  firstName || '',
          SCORE:      Number(weightedScore).toFixed(1),
          SCORE_MAX:  '5.5',
          TIER:       tier || '',
          TIER_DESC:  tierDesc(tier || ''),
          IDEA_TEXT:  ideaText || '',
          Q1_LABEL:   answerLabel(q1 || ''),
          Q2_LABEL:   answerLabel(q2 || ''),
          Q3_LABEL:   answerLabel(q3 || ''),
          Q4_LABEL:   answerLabel(q4 || ''),
          Q5_LABEL:   answerLabel(q5 || ''),
        },
      }),
    ])

    if (personId) {
      try {
        await logActivity({
          personId,
          actionType:  'Idea Test Completed',
          sourceTool:  'idea-test',
          summary:     `Completed Idea Test — ${tier} (${Number(weightedScore).toFixed(1)})`,
          referenceId: resultId,
        })
        console.log('[activity] logged')
      } catch (err) {
        console.error('[activity] failed:', err)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[results] handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}