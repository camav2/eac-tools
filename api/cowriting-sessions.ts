import type { VercelRequest, VercelResponse } from '@vercel/node'

const COWRITING_TABLE = 'tblMTfHsSf1WrAvbs'
const PEOPLE_TABLE    = 'tblbJgznPsbETLl8q'

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\s*)${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

async function getSessionEmail(req: VercelRequest): Promise<string | null> {
  const token = parseCookie(req.headers.cookie ?? '', 'eac_session')
  if (!token) return null
  try {
    const { jwtVerify } = await import('jose')
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    const { payload } = await jwtVerify(token, secret)
    return (payload.sub as string) ?? null
  } catch {
    return null
  }
}

async function at(table: string, path = '') {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${table}${path}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const email = await getSessionEmail(req)
  if (!email) return res.status(401).json({ error: 'Unauthorised' })

  try {
    // Find person record
    const personFilter = encodeURIComponent(`{Email}="${email}"`)
    const personData = await at(PEOPLE_TABLE,
      `?filterByFormula=${personFilter}&maxRecords=1` +
      `&fields[]=Full%20Name&fields[]=Co-writing%20Events`
    )
    if (!personData.records?.length) return res.status(200).json({ sessions: [] })

    const person = personData.records[0]
    const eventLinks: Array<{ id: string }> = person.fields['Co-writing Events'] || []
    if (!eventLinks.length) return res.status(200).json({ sessions: [] })

    // Fetch the linked Co-writing Event records
    const orParts = eventLinks.map(e => `RECORD_ID()="${e.id}"`).join(',')
    const eventsFilter = encodeURIComponent(`OR(${orParts})`)
    const eventsData = await at(COWRITING_TABLE,
      `?filterByFormula=${eventsFilter}` +
      `&fields[]=Event%20Title&fields[]=Event%20Date&fields[]=Duration%20(hours)` +
      `&fields[]=Event%20URL&fields[]=Status&fields[]=Host&fields[]=Attendees`
    )

    const completedRecords = (eventsData.records || [])
      .filter((r: Record<string, unknown>) => (r.fields as Record<string, unknown>)['Status'] === 'Completed')

    if (!completedRecords.length) return res.status(200).json({ sessions: [] })

    // Collect all People IDs across all sessions for a single batch lookup
    const allPeopleIds = new Set<string>()
    for (const r of completedRecords) {
      const fields = r.fields as Record<string, Array<{ id: string }>>
      for (const a of (fields['Attendees'] || [])) allPeopleIds.add(a.id)
      for (const h of (fields['Host']      || [])) allPeopleIds.add(h.id)
    }

    const peopleMap = new Map<string, { name: string; linkedinUrl: string | null }>()
    if (allPeopleIds.size > 0) {
      const pOr = [...allPeopleIds].map(id => `RECORD_ID()="${id}"`).join(',')
      const pFilter = encodeURIComponent(`OR(${pOr})`)
      const pData = await at(PEOPLE_TABLE,
        `?filterByFormula=${pFilter}&fields[]=Full%20Name&fields[]=LinkedIn%20URL`
      )
      for (const p of (pData.records || [])) {
        peopleMap.set(p.id, {
          name:        p.fields['Full Name']    || '',
          linkedinUrl: p.fields['LinkedIn URL'] || null,
        })
      }
    }

    const sessions = completedRecords.map((r: Record<string, unknown>) => {
      const fields = r.fields as Record<string, unknown>
      const attendeeLinks = (fields['Attendees'] as Array<{ id: string }>) || []
      const hostLinks     = (fields['Host']      as Array<{ id: string }>) || []
      const hostIds = new Set(hostLinks.map(h => h.id))

      const attendees = attendeeLinks.map(a => ({
        ...(peopleMap.get(a.id) ?? { name: '', linkedinUrl: null }),
        isHost: hostIds.has(a.id),
      }))

      return {
        id:            r.id,
        title:         (fields['Event Title']      as string) || 'Co-writing Session',
        eventDate:     (fields['Event Date']       as string) || null,
        durationHours: (fields['Duration (hours)'] as number) || 1,
        eventUrl:      (fields['Event URL']        as string) || null,
        attendees,
      }
    })

    sessions.sort((a: { eventDate: string | null }, b: { eventDate: string | null }) =>
      (b.eventDate || '').localeCompare(a.eventDate || ''))

    return res.status(200).json({ sessions })
  } catch (err) {
    console.error('[cowriting-sessions] error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
