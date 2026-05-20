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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-webhook-secret']
  if (!process.env.COWRITING_WEBHOOK_SECRET || secret !== process.env.COWRITING_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const {
    action, circleEventId, eventTitle, eventDate,
    durationHours, eventUrl, hostEmail, hostName,
    attendees,
  } = req.body

  if (!circleEventId || !action) return res.status(400).json({ error: 'Missing required fields' })

  try {
    if (action === 'session_created') {
      let hostPersonId: string | undefined
      if (hostEmail) {
        hostPersonId = await upsertPerson({ email: hostEmail, name: hostName || '', isMember: true })
      }
      const fields: Record<string, unknown> = {
        'Event Title':     eventTitle || 'Co-writing Session',
        'Event Date':      eventDate,
        'Duration (hours)': durationHours ?? 1,
        'Circle Event ID': circleEventId,
        'Event URL':       eventUrl || '',
        'Status':          'Upcoming',
        'Created At':      new Date().toISOString(),
      }
      if (hostPersonId) fields['Host'] = [hostPersonId]
      await at(COWRITING_TABLE, '', { method: 'POST', body: JSON.stringify({ fields }) })
      console.log('[cowriting-webhook] session_created:', circleEventId)
      return res.status(200).json({ ok: true })
    }

    if (action === 'session_completed') {
      const attendeeList: Array<{ email: string; name?: string }> = attendees || []
      const attendeeIds: string[] = []
      for (const att of attendeeList) {
        if (att.email) {
          const id = await upsertPerson({ email: att.email, name: att.name || '', isMember: true })
          attendeeIds.push(id)
        }
      }
      const record = await findEvent(circleEventId)
      if (record) {
        const existing = (record.fields['Attendees'] || []).map((a: { id: string }) => a.id) as string[]
        const merged = [...new Set([...existing, ...attendeeIds])]
        await at(COWRITING_TABLE, `/${record.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Status': 'Completed', 'Attendees': merged } }),
        })
      }
      console.log('[cowriting-webhook] session_completed:', circleEventId, attendeeIds.length, 'attendees')
      return res.status(200).json({ ok: true })
    }

    if (action === 'attendee_added') {
      const { attendeeEmail, attendeeName } = req.body
      if (!attendeeEmail) return res.status(400).json({ error: 'attendeeEmail required' })
      const personId = await upsertPerson({ email: attendeeEmail, name: attendeeName || '', isMember: true })
      const record = await findEvent(circleEventId)
      if (record) {
        const existing = (record.fields['Attendees'] || []).map((a: { id: string }) => a.id) as string[]
        if (!existing.includes(personId)) {
          await at(COWRITING_TABLE, `/${record.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ fields: { 'Attendees': [...existing, personId] } }),
          })
        }
      }
      console.log('[cowriting-webhook] attendee_added:', attendeeEmail)
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('[cowriting-webhook] error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
