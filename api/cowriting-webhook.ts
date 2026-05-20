import type { VercelRequest, VercelResponse } from '@vercel/node'
import { upsertPerson } from './_lib/airtable'

const COWRITING_TABLE = 'tblMTfHsSf1WrAvbs'

// ── Airtable helpers ──────────────────────────────────────────────────────────

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
    await at(COWRITING_TABLE, `/${record.id}`, { method: 'PATCH', body: JSON.stringify({ fields }) })
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

// ── Circle API helpers ────────────────────────────────────────────────────────

const CIRCLE_COMMUNITY  = process.env.CIRCLE_COMMUNITY_ID!

async function circleGet(path: string) {
  const res = await fetch(`https://app.circle.so/api/v2/${path}`, {
    headers: { Authorization: `Token ${process.env.CIRCLE_API_TOKEN}` },
  })
  if (!res.ok) {
    console.error('[circle] GET failed:', path, res.status)
    return null
  }
  return res.json()
}

async function fetchCircleEvent(eventId: string | number) {
  return circleGet(`/events/${eventId}?community_id=${CIRCLE_COMMUNITY}`)
}

async function fetchCircleMember(memberId: string | number) {
  return circleGet(`/community_members/${memberId}?community_id=${CIRCLE_COMMUNITY}`)
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-webhook-secret'] ?? req.headers['x-circle-webhook-secret']
  if (process.env.COWRITING_WEBHOOK_SECRET && secret !== process.env.COWRITING_WEBHOOK_SECRET) {
    console.warn('[cowriting-webhook] bad secret')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  console.log('[cowriting-webhook] raw:', JSON.stringify(req.body))

  const raw     = req.body ?? {}
  // Circle wraps its payload: { body: { type, data } }
  const payload = (raw.body && raw.body.type) ? raw.body : raw
  const type    = (payload.type ?? '') as string
  const data    = payload.data ?? {}

  const circleEventId  = String(data.event_id  ?? '')
  const circleMemberId = String(data.community_member_id ?? '')

  if (!circleEventId) {
    console.error('[cowriting-webhook] no event_id')
    return res.status(200).json({ ok: true })
  }

  try {
    // ── "event_published" — track host ───────────────────────────────────────
    if (type === 'event_published') {
      const event = await fetchCircleEvent(circleEventId)
      if (!event) return res.status(200).json({ ok: true })

      const startsAt = event.event_setting_attributes?.starts_at ?? event.starts_at ?? null
      const endsAt   = event.event_setting_attributes?.ends_at   ?? event.ends_at   ?? null
      const fields: Record<string, unknown> = {
        'Event Title': event.name ?? 'Co-writing Session',
        'Status':      'Upcoming',
      }
      if (startsAt)       fields['Event Date']  = startsAt
      if (event.url)      fields['Event URL']   = event.url
      if (startsAt && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
        if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
      }

      const eventRecordId = await upsertEvent(circleEventId, fields)

      if (circleMemberId) {
        const member   = await fetchCircleMember(circleMemberId)
        const email    = member?.email ?? ''
        const name     = member?.name  ?? member?.full_name ?? ''
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await at(COWRITING_TABLE, `/${eventRecordId}`, {
            method: 'PATCH',
            body: JSON.stringify({ fields: { Host: [personId] } }),
          })
          console.log('[cowriting-webhook] host set:', email, circleEventId)
        }
      }
      return res.status(200).json({ ok: true })
    }

    // ── "event_attendee.attended" / live event attended ───────────────────────
    if (type === 'event_attendee.attended' || type.includes('attend')) {
      const event  = await fetchCircleEvent(circleEventId)
      const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
      const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
      const fields: Record<string, unknown> = { 'Status': 'Completed' }
      if (event?.name)   fields['Event Title'] = event.name
      if (startsAt)      fields['Event Date']  = startsAt
      if (event?.url)    fields['Event URL']   = event.url
      if (startsAt && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
        if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
      }
      await upsertEvent(circleEventId, fields)

      if (circleMemberId) {
        const member = await fetchCircleMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name  ?? member?.full_name ?? ''
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await addAttendee(circleEventId, personId)
          console.log('[cowriting-webhook] attendee added:', email, circleEventId)
        }
      }
      return res.status(200).json({ ok: true })
    }

    // ── "event_ended" / event ended for member ───────────────────────────────
    // Fires once per member who attended — use it to record both completion and attendee
    if (type === 'event_ended' || type.includes('ended')) {
      await upsertEvent(circleEventId, { 'Status': 'Completed' })

      if (circleMemberId) {
        const member = await fetchCircleMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name  ?? member?.full_name ?? ''
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await addAttendee(circleEventId, personId)
          console.log('[cowriting-webhook] attendee (event_ended):', email, circleEventId)
        }
      } else {
        console.log('[cowriting-webhook] event completed (no member):', circleEventId)
      }
      return res.status(200).json({ ok: true })
    }

    console.log('[cowriting-webhook] unhandled type:', type)
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[cowriting-webhook] error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
