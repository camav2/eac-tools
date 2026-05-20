import type { VercelRequest, VercelResponse } from '@vercel/node'
import { upsertPerson } from './_lib/airtable'

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
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

async function findEvent(circleEventId: string) {
  const filter = encodeURIComponent(`{Circle Event ID}="${circleEventId}"`)
  const data = await at(COWRITING_TABLE, `?filterByFormula=${filter}&maxRecords=1`)
  return data.records?.[0] ?? null
}

async function upsertEvent(circleEventId: string, fields: Record<string, unknown>) {
  const record = await findEvent(circleEventId)
  if (record) {
    await at(COWRITING_TABLE, `/${record.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    })
    return record.id as string
  }
  const created = await at(COWRITING_TABLE, '', {
    method: 'POST',
    body: JSON.stringify({ fields: { 'Circle Event ID': circleEventId, ...fields } }),
  })
  return created.id as string
}

async function addAttendee(circleEventId: string, personId: string) {
  const record = await findEvent(circleEventId)
  if (!record) return
  const existing = ((record.fields['Attendees'] ?? []) as Array<{ id: string }>).map(a => a.id)
  if (existing.includes(personId)) return
  await at(COWRITING_TABLE, `/${record.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { Attendees: [...existing, personId] } }),
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Verify Circle webhook secret
  const secret = req.headers['x-webhook-secret'] ?? req.headers['x-circle-webhook-secret']
  if (process.env.COWRITING_WEBHOOK_SECRET && secret !== process.env.COWRITING_WEBHOOK_SECRET) {
    console.warn('[cowriting-webhook] bad secret:', secret)
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Log full payload so we can inspect the first real Circle webhook
  console.log('[cowriting-webhook] raw payload:', JSON.stringify(req.body))

  const body = req.body ?? {}

  // Circle webhook envelope — best-guess field names; update after first real hit
  // Expected shape: { type, community_id, data: { event: {...}, member: {...} } }
  const type       = (body.type ?? body.event_type ?? '') as string
  const eventData  = body.data?.event   ?? body.event   ?? {}
  const memberData = body.data?.member  ?? body.member  ?? {}

  const circleEventId = String(eventData.id ?? '')
  const eventName     = (eventData.name    ?? 'Co-writing Session') as string
  const eventDate     = (eventData.starts_at ?? eventData.start_time ?? null) as string | null
  const eventUrl      = (eventData.url     ?? null) as string | null
  const endsAt        = (eventData.ends_at ?? null) as string | null

  const memberEmail = (memberData.email ?? memberData.member_email ?? '') as string
  const memberName  = (memberData.name  ?? memberData.full_name    ?? '') as string

  if (!circleEventId) {
    console.error('[cowriting-webhook] no event id in payload')
    return res.status(200).json({ ok: true }) // ack to avoid Circle retries
  }

  try {
    // ── "Published an event" ───────────────────────────────────────────────
    if (type.includes('publish') || type.includes('created')) {
      const baseFields: Record<string, unknown> = {
        'Event Title': eventName,
        'Status':      'Upcoming',
      }
      if (eventDate) baseFields['Event Date'] = eventDate
      if (eventUrl)  baseFields['Event URL']  = eventUrl
      if (eventDate && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(eventDate).getTime()) / 3600000
        if (dur > 0) baseFields['Duration (hours)'] = Math.round(dur * 10) / 10
      }

      const eventRecordId = await upsertEvent(circleEventId, baseFields)

      if (memberEmail) {
        const personId = await upsertPerson({ email: memberEmail, name: memberName, isMember: true })
        // Link as host
        await at(COWRITING_TABLE, `/${eventRecordId}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { Host: [personId] } }),
        })
        console.log('[cowriting-webhook] host set:', memberEmail, circleEventId)
      }
      return res.status(200).json({ ok: true })
    }

    // ── "Attended live event" ──────────────────────────────────────────────
    if (type.includes('attend') || type.includes('live')) {
      const baseFields: Record<string, unknown> = {
        'Event Title': eventName,
        'Status':      'Completed',
      }
      if (eventDate) baseFields['Event Date'] = eventDate
      if (eventUrl)  baseFields['Event URL']  = eventUrl

      // Derive duration from starts_at / ends_at if available
      if (eventDate && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(eventDate).getTime()) / 3600000
        if (dur > 0) baseFields['Duration (hours)'] = Math.round(dur * 10) / 10
      }

      await upsertEvent(circleEventId, baseFields)

      if (memberEmail) {
        const personId = await upsertPerson({ email: memberEmail, name: memberName, isMember: true })
        await addAttendee(circleEventId, personId)
        console.log('[cowriting-webhook] attendee added:', memberEmail, circleEventId)
      }
      return res.status(200).json({ ok: true })
    }

    // ── "Event ended for member" ───────────────────────────────────────────
    if (type.includes('ended') || type.includes('end')) {
      await upsertEvent(circleEventId, { 'Status': 'Completed' })
      console.log('[cowriting-webhook] event marked completed:', circleEventId)
      return res.status(200).json({ ok: true })
    }

    console.log('[cowriting-webhook] unhandled type:', type)
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[cowriting-webhook] error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
