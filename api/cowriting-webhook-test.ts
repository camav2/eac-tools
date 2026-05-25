/**
 * Diagnostic endpoint for the cowriting webhook — admin only.
 * Runs the full event_published pipeline (upsert event + fetch member + set host).
 *
 * POST /api/cowriting-webhook-test
 * Body: { event_id?, event_name?, community_member_id?, type? }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
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
  const text = await res.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`) }
  if (!res.ok) throw json
  return json
}

async function findEvent(circleEventId: string) {
  const filter = encodeURIComponent(`{Circle Event ID}="${circleEventId}"`)
  const data = await at(COWRITING_TABLE, `?filterByFormula=${filter}&maxRecords=1`) as any
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
  }) as any
  return created.id as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  // 1. Check env vars
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

  // Helper: fetch Circle member by community_member_id
  async function fetchMember(memberId: string) {
    const url = `${process.env.CIRCLE_ADMIN_V2_URL}/community_members/${memberId}?community_id=${process.env.CIRCLE_COMMUNITY_ID}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.CIRCLE_ADMIN_V2_TOKEN}` },
      cache: 'no-store',
    })
    if (!res.ok) return null
    return res.json() as Promise<any>
  }

  // Helper: fetch Circle event by event_id
  async function fetchCircleEvent(eventId: string) {
    const url = `${process.env.CIRCLE_ADMIN_V2_URL}/events/${eventId}?community_id=${process.env.CIRCLE_COMMUNITY_ID}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.CIRCLE_ADMIN_V2_TOKEN}` },
      cache: 'no-store',
    })
    if (!res.ok) { results.circleEvent = { ok: false, status: res.status }; return null }
    const event = await res.json() as any
    const startsAt = event?.event_setting_attributes?.starts_at ?? event?.starts_at ?? null
    const endsAt   = event?.event_setting_attributes?.ends_at   ?? event?.ends_at   ?? null
    results.circleEvent = { ok: true, startsAt, url: event?.url }
    return { event, startsAt, endsAt }
  }

  try {
    // ── event_published — upsert event + set host ─────────────────────────────
    if (type.includes('publish') || type.includes('creat')) {
      const fields: Record<string, unknown> = { 'Event Title': event_name, 'Status': 'Upcoming' }

      const circleEventData = await fetchCircleEvent(circleEventId)
      if (circleEventData) {
        const { event, startsAt, endsAt } = circleEventData
        if (startsAt)        fields['Event Date'] = startsAt
        if (event?.url)      fields['Event URL']  = event.url
        if (startsAt && endsAt) {
          const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
          if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
        }
      }

      const eventRecordId = await upsertEvent(circleEventId, fields)
      results.airtableEvent = { ok: true, recordId: eventRecordId }

      if (circleMemberId && circleMemberId !== '0') {
        const member = await fetchMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name ?? member?.full_name ?? ''
        results.circleMember = member ? { ok: true, email, name } : { ok: false }
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          await at(COWRITING_TABLE, `/${eventRecordId}`, {
            method: 'PATCH',
            body: JSON.stringify({ fields: { Host: [personId] } }),
          })
          results.host = { ok: true, personId, email }
        }
      }
    }

    // ── event_ended — mark completed + add attendee ───────────────────────────
    else if (type.includes('ended')) {
      const fields: Record<string, unknown> = { 'Status': 'Completed' }

      const circleEventData = await fetchCircleEvent(circleEventId)
      if (circleEventData) {
        const { event, startsAt, endsAt } = circleEventData
        if (event?.name)  fields['Event Title'] = event.name
        if (startsAt)     fields['Event Date']  = startsAt
        if (event?.url)   fields['Event URL']   = event.url
        if (startsAt && endsAt) {
          const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
          if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
        }
      }

      const eventRecordId = await upsertEvent(circleEventId, fields)
      results.airtableEvent = { ok: true, recordId: eventRecordId }

      if (circleMemberId && circleMemberId !== '0') {
        const member = await fetchMember(circleMemberId)
        const email  = member?.email ?? ''
        const name   = member?.name ?? member?.full_name ?? ''
        results.circleMember = member ? { ok: true, email, name } : { ok: false }
        if (email) {
          const personId = await upsertPerson({ email, name, isMember: true })
          // Check existing attendees — don't duplicate
          const record = await findEvent(circleEventId)
          const hosts    = (record?.fields['Host']      as string[]) || []
          const existing = (record?.fields['Attendees'] as string[]) || []
          if (hosts.includes(personId)) {
            results.attendee = { ok: true, skipped: 'is host', email }
          } else if (existing.includes(personId)) {
            results.attendee = { ok: true, skipped: 'already attendee', email }
          } else {
            await at(COWRITING_TABLE, `/${eventRecordId}`, {
              method: 'PATCH',
              body: JSON.stringify({ fields: { Attendees: [...existing, personId] } }),
            })
            results.attendee = { ok: true, personId, email }
          }
        }
      }
    }

    else {
      results.error = `Unhandled type: ${type}`
    }

  } catch (err) {
    results.error = String(err)
    console.error('[webhook-test] error:', err)
  }

  return res.status(200).json(results)
}
