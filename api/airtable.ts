/*
 * Airtable API handler — Idea Test submissions
 *
 * Write order (each step fails independently):
 *   1. Circle: fetch access group for members
 *   2. People: upsert record (find by email or create)
 *   3. Idea Test Results: always written, linked to person if step 2 succeeded
 *   4. Activity Log: written only if step 2 succeeded
 *
 * Env vars required:
 *   AIRTABLE_API_KEY      — personal access token (needs access to all 3 tables)
 *   AIRTABLE_BASE_ID      — appvucz2Xo0PLqN2k
 *   AIRTABLE_TABLE_ID     — Idea Test Results table ID (tblPU7kA0YMw58Uyg)
 *   CIRCLE_API_TOKEN      — Circle v2 API token
 *   CIRCLE_COMMUNITY_ID   — 9832
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { upsertPerson, logActivity } from './_lib/airtable'
import { getCircleAccessGroup }      from './_lib/circle'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    email, firstName, ideaText,
    weightedScore, tier,
    q1, q2, q3, q4, q5,
    isMember, circleUserId,
  } = req.body

  if (!email) return res.status(400).json({ error: 'Email required' })

  // ── Step 1: Circle access group (members only, best-effort) ──────────────
  let accessGroup:   string | undefined
  let accessGroupId: string | undefined
  if (isMember && email) {
    try {
      const group = await getCircleAccessGroup(email)
      if (group) {
        accessGroup   = group.name
        accessGroupId = String(group.id)
        console.log('[circle] access group:', group.name, group.id)
      } else {
        console.log('[circle] no access group found for', email)
      }
    } catch (err) {
      console.error('[circle] failed:', err)
    }
  }

  // ── Step 2: Upsert People (best-effort) ──────────────────────────────────
  let personId: string | undefined
  try {
    personId = await upsertPerson({
      email,
      name:           firstName    || '',
      isMember:       !!isMember,
      circleMemberId: circleUserId ? String(circleUserId) : undefined,
      accessGroup,
      accessGroupId,
    })
    console.log('[people] upserted:', personId)
  } catch (err) {
    console.error('[people] upsert failed:', err)
  }

  // ── Step 3: Write Idea Test Results (always) ─────────────────────────────
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

    // ── Step 4: Activity Log (only if we have a person) ───────────────────
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
