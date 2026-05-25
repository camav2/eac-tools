/**
 * Diagnostic endpoint for the cowriting webhook — admin only.
 *
 * POST /api/cowriting-webhook-test
 * Body: { event_id?, event_name?, community_member_id?, type? }
 *
 * Checks env vars, hits Airtable directly, and attempts the full
 * upsert so you can verify the pipeline without creating a real Circle event.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'

const COWRITING_TABLE = 'tblMTfHsSf1WrAvbs'

async function at(table: string, path = '', options: RequestInit = {}) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${table}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) ?? {}),
    },
  })
  const text = await res.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`) }
  if (!res.ok) throw json
  return json
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  // 1. Check env vars — return immediately so the response is always readable JSON
  const envCheck = {
    AIRTABLE_BASE_ID:      !!process.env.AIRTABLE_BASE_ID,
    AIRTABLE_API_KEY:      !!process.env.AIRTABLE_API_KEY,
    CIRCLE_ADMIN_V2_TOKEN: !!process.env.CIRCLE_ADMIN_V2_TOKEN,
    CIRCLE_ADMIN_V2_URL:   !!process.env.CIRCLE_ADMIN_V2_URL,
    CIRCLE_COMMUNITY_ID:   !!process.env.CIRCLE_COMMUNITY_ID,
  }
  console.log('[webhook-test] env check:', envCheck)

  const missingEnv = Object.entries(envCheck).filter(([, v]) => !v).map(([k]) => k)
  if (missingEnv.length) {
    return res.status(200).json({ envCheck, error: `Missing env vars: ${missingEnv.join(', ')}` })
  }

  const {
    event_id            = 99999999,
    event_name          = 'TEST - Webhook Diagnostic (safe to delete)',
    community_member_id = 0,
    type                = 'event_published',
  } = req.body ?? {}

  const circleEventId = String(event_id)
  const results: Record<string, unknown> = { envCheck }

  // 2. Try Airtable — find existing record
  try {
    const filter = encodeURIComponent(`{Circle Event ID}="${circleEventId}"`)
    const found  = await at(COWRITING_TABLE, `?filterByFormula=${filter}&maxRecords=1`)
    results.airtableFind = { ok: true, existing: found.records?.length > 0 }
  } catch (err) {
    results.airtableFind = { ok: false, error: err }
    console.error('[webhook-test] airtable find failed:', err)
    return res.status(200).json(results)
  }

  // 3. Try Airtable — create/update record
  try {
    const existing = (results.airtableFind as { existing: boolean }).existing
    let recordId: string

    if (existing) {
      const filter = encodeURIComponent(`{Circle Event ID}="${circleEventId}"`)
      const found  = await at(COWRITING_TABLE, `?filterByFormula=${filter}&maxRecords=1`)
      recordId = found.records[0].id
      await at(COWRITING_TABLE, `/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { 'Event Title': event_name, 'Status': 'Upcoming' } }),
      })
      results.airtableUpsert = { ok: true, action: 'updated', recordId }
    } else {
      const created = await at(COWRITING_TABLE, '', {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            'Circle Event ID': circleEventId,
            'Event Title':     event_name,
            'Status':          'Upcoming',
          },
        }),
      })
      recordId = created.id
      results.airtableUpsert = { ok: true, action: 'created', recordId }
    }
    console.log('[webhook-test] airtable upsert ok:', results.airtableUpsert)
  } catch (err) {
    results.airtableUpsert = { ok: false, error: err }
    console.error('[webhook-test] airtable upsert failed:', err)
    return res.status(200).json(results)
  }

  // 4. Try Circle API — fetch member (if provided)
  if (community_member_id) {
    try {
      const circleUrl = `${process.env.CIRCLE_ADMIN_V2_URL}/community_members/${community_member_id}?community_id=${process.env.CIRCLE_COMMUNITY_ID}`
      const circleRes = await fetch(circleUrl, {
        headers: { Authorization: `Bearer ${process.env.CIRCLE_ADMIN_V2_TOKEN}` },
        cache: 'no-store',
      })
      results.circleMember = { ok: circleRes.ok, status: circleRes.status }
      console.log('[webhook-test] circle member fetch:', circleRes.status)
    } catch (err) {
      results.circleMember = { ok: false, error: String(err) }
    }
  }

  return res.status(200).json(results)
}
