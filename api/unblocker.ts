/*
 * Airtable handler — Writing Blocker (Unblocker) submissions
 *
 * TABLE: create "Unblocker Submissions" in the same Airtable base, with fields:
 *   Email           (Email)
 *   First Name      (Single line text)
 *   Writing Blocker (Single select: Time / Structure / Noise / Isolation / Momentum)
 *   Submitted At    (Date, include time)
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_UNBLOCKER_TABLE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email, firstName, writingBlocker } = req.body

  if (!email) return res.status(400).json({ error: 'Email required' })

  if (!process.env.AIRTABLE_UNBLOCKER_TABLE_ID) {
    console.warn('AIRTABLE_UNBLOCKER_TABLE_ID not set — skipping Airtable write')
    return res.status(200).json({ ok: true, skipped: true })
  }

  const fields = {
    'Email':           email,
    'First Name':      firstName     || '',
    'Writing Blocker': writingBlocker || '',
    'Submitted At':    new Date().toISOString(),
  }

  try {
    const tableId  = encodeURIComponent(process.env.AIRTABLE_UNBLOCKER_TABLE_ID)
    const response = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${tableId}`,
      {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type':   'application/json',
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
    console.error('Unblocker handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
