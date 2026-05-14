/*
 * Airtable API handler — Idea Test submissions
 *
 * Three-step write on every submission:
 *   1. Upsert People record (find by email or create; set Member/Non-member)
 *   2. Create Idea Test Results record linked to that person
 *   3. Append Activity Log entry linked to that person
 *
 * Env vars required:
 *   AIRTABLE_API_KEY      — personal access token
 *   AIRTABLE_BASE_ID      — appvucz2Xo0PLqN2k
 *   AIRTABLE_TABLE_ID     — Idea Test Results table ID (tblPU7kA0YMw58Uyg)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { upsertPerson, logActivity } from './_lib/airtable'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    email, firstName, ideaText,
    weightedScore, tier,
    q1, q2, q3, q4, q5,
    isMember,
  } = req.body

  if (!email) return res.status(400).json({ error: 'Email required' })

  try {
    // 1. Upsert People record
    const personId = await upsertPerson({
      email,
      name:     firstName || '',
      isMember: !!isMember,
    })

    // 2. Create Idea Test Results record linked to person
    const resultRes = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
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
            'Person':           [{ id: personId }],
          },
        }),
      }
    )

    if (!resultRes.ok) {
      const err = await resultRes.json()
      console.error('Airtable error (results):', err)
      return res.status(500).json({ error: 'Airtable API error' })
    }

    const { id: resultId } = await resultRes.json()

    // 3. Log activity
    await logActivity({
      personId,
      actionType:  'tool-completion',
      sourceTool:  'idea-test',
      summary:     `Completed Idea Test — ${tier} (${Number(weightedScore).toFixed(1)})`,
      referenceId: resultId,
    })

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('Handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
