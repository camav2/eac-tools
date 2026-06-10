import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
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
  const text = await res.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`) }
  if (!res.ok) { console.error('[airtable] error:', JSON.stringify(json)); throw json }
  return json as any
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
    console.log('[cowriting-webhook] event updated:', record.id)
    return record.id as string
  }
  const created = await at(COWRITING_TABLE, '', {
    method: 'POST',
    body: JSON.stringify({ fields: { 'Circle Event ID': circleEventId, ...fields } }),
  })
  console.log('[cowriting-webhook] event created:', created.id)
  return created.id as string
}

async function addAttendee(circleEventId: string, personId: string) {
  const record = await findEvent(circleEventId)
  if (!record) return
  const hosts    = (record.fields['Host']      as string[]) || []
  if (hosts.includes(personId)) return
  const existing = (record.fields['Attendees'] as string[]) || []
  if (existing.includes(personId)) return
  await at(COWRITING_TABLE, `/${record.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { Attendees: [...existing, personId] } }),
  })
}

// ── Circle API helpers ────────────────────────────────────────────────────────

const CIRCLE_BASE_URL  = process.env.CIRCLE_ADMIN_V2_URL ?? 'https://app.circle.so/api/admin/v2'
const CIRCLE_API_TOKEN = process.env.CIRCLE_ADMIN_V2_TOKEN!
const CIRCLE_COMMUNITY = process.env.CIRCLE_COMMUNITY_ID!

async function circleGet(path: string) {
  const res = await fetch(`${CIRCLE_BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    console.error('[circle] GET failed:', path, res.status)
    return null
  }
  return res.json()
}

async function fetchCircleEvent(eventId: string | number) {
  return circleGet(`events/${eventId}?community_id=${CIRCLE_COMMUNITY}`)
}

async function fetchCircleMember(memberId: string | number) {
  return circleGet(`community_members/${memberId}?community_id=${CIRCLE_COMMUNITY}`)
}

// ── Diagnostic handler (POST ?diagnostic=1, admin only) ───────────────────────

async function handleDiagnostic(req: VercelRequest, res: VercelResponse) {
  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  const envCheck = {
    AIRTABLE_BASE_ID:      !!process.env.AIRTABLE_BASE_ID,
    AIRTABLE_API_KEY:      !!process.env.AIRTABLE_API_KEY,
    CIRCLE_ADMIN_V2_TOKEN: !!process.env.CIRCLE_ADMIN_V2_TOKEN,
    CIRCLE_ADMIN_V2_URL:   !!process.env.CIRCLE_ADMIN_V2_URL,
    CIRCLE_COMMUNITY_ID:   !!process.env.CIRCLE_COMMUNITY_ID,
  }
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

  const circleEventId  = String(event_id)
  const circleMemberId = String(community_member_id)
  const results: Record<string, unknown> = { envCheck, inputs: { event_id, event_name, community_member_id, type } }

  try {
    if (type.includes('publish') || type.includes('creat')) {
      const fields: Record<string, unknown> = { 'Event Title': event_name, 'Status': 'Upcoming' }
      const event    = await fetchCircleEvent(circleEventId)
      const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
      const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
      results.circleEvent = event ? { ok: true, startsAt, url: event?.url } : { ok: false }
      if (startsAt)        fields['Event Date'] = startsAt
      if (event?.url)      fields['Event URL']  = event.url
      if (startsAt && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
        if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
      }
      const eventRecordId = await upsertEvent(circleEventId, fields)
      results.airtableEvent = { ok: true, recordId: eventRecordId }
      if (circleMemberId && circleMemberId !== '0') {
        const member = await fetchCircleMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name ?? member?.full_name ?? ''
        results.circleMember = member ? { ok: true, email, name } : { ok: false }
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await at(COWRITING_TABLE, `/${eventRecordId}`, { method: 'PATCH', body: JSON.stringify({ fields: { Host: [personId] } }) })
          results.host = { ok: true, personId, email }
        }
      }
    } else if (type.includes('ended')) {
      const fields: Record<string, unknown> = { 'Status': 'Completed' }
      const event    = await fetchCircleEvent(circleEventId)
      const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
      const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
      if (event?.name)  fields['Event Title'] = event.name
      if (startsAt)     fields['Event Date']  = startsAt
      if (event?.url)   fields['Event URL']   = event.url
      if (startsAt && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
        if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
      }
      const eventRecordId = await upsertEvent(circleEventId, fields)
      results.airtableEvent = { ok: true, recordId: eventRecordId }
      if (circleMemberId && circleMemberId !== '0') {
        const member = await fetchCircleMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name ?? member?.full_name ?? ''
        results.circleMember = member ? { ok: true, email, name } : { ok: false }
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          const record   = await findEvent(circleEventId)
          const hosts    = (record?.fields['Host']      as string[]) || []
          const existing = (record?.fields['Attendees'] as string[]) || []
          if (hosts.includes(personId)) {
            results.attendee = { ok: true, skipped: 'is host', email }
          } else if (existing.includes(personId)) {
            results.attendee = { ok: true, skipped: 'already attendee', email }
          } else {
            await at(COWRITING_TABLE, `/${eventRecordId}`, { method: 'PATCH', body: JSON.stringify({ fields: { Attendees: [...existing, personId] } }) })
            results.attendee = { ok: true, personId, email }
          }
        }
      }
    } else {
      results.error = `Unhandled type: ${type}`
    }
  } catch (err) {
    results.error = String(err)
    console.error('[webhook-diagnostic] error:', err)
  }

  return res.status(200).json(results)
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Diagnostic mode: POST /api/cowriting-webhook?diagnostic=1 (admin only)
  if (req.query.diagnostic === '1') return handleDiagnostic(req, res)

  const secret = req.headers['x-webhook-secret'] ?? req.headers['x-circle-webhook-secret']
  if (process.env.COWRITING_WEBHOOK_SECRET && secret !== process.env.COWRITING_WEBHOOK_SECRET) {
    console.warn('[cowriting-webhook] bad secret')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  console.log('[cowriting-webhook] raw body:', JSON.stringify(req.body).slice(0, 600))

  const raw     = req.body ?? {}
  const payload = (raw.body && raw.body.type) ? raw.body : raw
  const type    = (payload.type ?? '') as string
  const data    = payload.data ?? {}

  console.log('[cowriting-webhook] type:', type, '| data:', JSON.stringify(data))

  const circleEventId  = String(data.event_id  ?? '')
  const circleMemberId = String(data.community_member_id ?? '')

  if (!circleEventId) {
    console.warn('[cowriting-webhook] no event_id in payload — returning ok')
    return res.status(200).json({ ok: true })
  }

  if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_API_KEY) {
    console.error('[cowriting-webhook] missing AIRTABLE_BASE_ID or AIRTABLE_API_KEY')
    return res.status(500).json({ error: 'Server misconfiguration' })
  }
  if (!CIRCLE_API_TOKEN) {
    console.warn('[cowriting-webhook] CIRCLE_ADMIN_V2_TOKEN not set — member lookup will be skipped')
  }

  try {
    if (type.includes('publish') || type.includes('creat')) {
      const fields: Record<string, unknown> = {
        'Event Title': data.event_name ?? 'Co-writing Session',
        'Status':      'Upcoming',
      }
      try {
        const event    = await fetchCircleEvent(circleEventId)
        const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
        const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
        if (startsAt)            fields['Event Date'] = startsAt
        if (event?.url)          fields['Event URL']  = event.url
        if (startsAt && endsAt) {
          const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
          if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
        }
        console.log('[cowriting-webhook] event enriched from Circle API')
      } catch (e) {
        console.warn('[cowriting-webhook] circle event fetch failed, continuing without dates:', e)
      }
      const eventRecordId = await upsertEvent(circleEventId, fields)
      if (circleMemberId) {
        const member = await fetchCircleMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name  ?? member?.full_name ?? ''
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await at(COWRITING_TABLE, `/${eventRecordId}`, { method: 'PATCH', body: JSON.stringify({ fields: { Host: [personId] } }) })
          console.log('[cowriting-webhook] host set:', email, circleEventId)
        } else {
          console.warn('[cowriting-webhook] member lookup returned no email for memberId:', circleMemberId)
        }
      }
      return res.status(200).json({ ok: true })
    }

    if (type === 'event_attendee.attended' || type.includes('attend')) {
      const event    = await fetchCircleEvent(circleEventId)
      const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
      const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
      const fields: Record<string, unknown> = { 'Status': 'Completed' }
      if (event?.name)  fields['Event Title'] = event.name
      if (startsAt)     fields['Event Date']  = startsAt
      if (event?.url)   fields['Event URL']   = event.url
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
        } else {
          console.warn('[cowriting-webhook] member lookup returned no email for memberId:', circleMemberId)
        }
      }
      return res.status(200).json({ ok: true })
    }

    if (type === 'event_ended' || type.includes('ended')) {
      const fields: Record<string, unknown> = { 'Status': 'Completed' }
      try {
        const event    = await fetchCircleEvent(circleEventId)
        const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
        const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
        if (event?.name)  fields['Event Title'] = event.name
        if (startsAt)     fields['Event Date']  = startsAt
        if (event?.url)   fields['Event URL']   = event.url
        if (startsAt && endsAt) {
          const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
          if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
        }
      } catch (e) {
        console.warn('[cowriting-webhook] circle event fetch failed for event_ended:', e)
      }
      await upsertEvent(circleEventId, fields)
      if (circleMemberId) {
        const member = await fetchCircleMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name  ?? member?.full_name ?? ''
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await addAttendee(circleEventId, personId)
          console.log('[cowriting-webhook] attendee (event_ended):', email, circleEventId)
        } else {
          console.warn('[cowriting-webhook] member lookup returned no email for memberId:', circleMemberId)
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
    return res.status(500).json({ error: 'Internal error', detail: String(err) })
  }
}
