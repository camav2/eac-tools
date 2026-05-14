/*
 * Airtable API handler — Idea Test submissions
 *
 * TABLE: "Idea Test Submissions"
 *
 * Create this table manually in Airtable before deploying:
 *
 * Fields:
 *   Email            (Email)
 *   First Name       (Single line text)
 *   Idea Text        (Long text)
 *   Score            (Number, 1 decimal)
 *   Tier             (Single select: Strong / Developing / Not Yet)
 *   Q1 – Persistence (Single select: yes / getting-there / not-yet)
 *   Q2 – Argument    (Single select: yes / getting-there / not-yet)
 *   Q3 – Reader      (Single select: yes / getting-there / not-yet)
 *   Q4 – Depth       (Single select: yes / getting-there / not-yet)
 *   Q5 – Alignment   (Single select: yes / getting-there / not-yet)
 *   Source Tool      (Single line text)
 *   Submitted At     (Date, include time)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    email, firstName, ideaText,
    weightedScore, tier,
    q1, q2, q3, q4, q5
  } = req.body

  if (!email) return res.status(400).json({ error: 'Email required' })

  const fields = {
    'Email':             email,
    'First Name':        firstName  || '',
    'Idea Text':         ideaText   || '',
    'Score':             weightedScore,
    'Tier':              tier,           // 'Strong' | 'Developing' | 'Not Yet'
    'Q1 – Persistence':  q1,
    'Q2 – Argument':     q2,
    'Q3 – Reader':       q3,
    'Q4 – Depth':        q4,
    'Q5 – Alignment':    q5,
    'Source Tool':       'idea-test',
    'Submitted At':      new Date().toISOString(),
  }

  try {
    const response = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      }
    )

    if (!response.ok) {
      const error = await response.json()
      console.error('Airtable error:', error)
      return res.status(500).json({ error: 'Airtable API error' })
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('Handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
