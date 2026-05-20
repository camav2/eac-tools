import type { VercelRequest, VercelResponse } from '@vercel/node'

const COWRITING_TABLE = 'tblMTfHsSf1WrAvbs'
const PEOPLE_TABLE    = 'tblbJgznPsbETLl8q'

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
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

type AirtableRecord = { id: string; fields: Record<string, unknown> }

async function fetchAllSessions(): Promise<AirtableRecord[]> {
  const data = await at(COWRITING_TABLE,
    `?fields[]=Event%20Title&fields[]=Event%20Date&fields[]=Duration%20(hours)` +
    `&fields[]=Event%20URL&fields[]=Status&fields[]=Host&fields[]=Attendees`
  )
  return data.records || []
}

async function enrichWithPeople(records: AirtableRecord[]) {
  const allIds = new Set<string>()
  for (const r of records) {
    for (const a of (r.fields['Attendees'] as Array<{ id: string }> || [])) allIds.add(a.id)
    for (const h of (r.fields['Host']      as Array<{ id: string }> || [])) allIds.add(h.id)
  }
  const peopleMap = new Map<string, { name: string; linkedinUrl: string | null }>()
  if (allIds.size > 0) {
    const orParts = [...allIds].map(id => `RECORD_ID()="${id}"`).join(',')
    const pData = await at(PEOPLE_TABLE,
      `?filterByFormula=${encodeURIComponent(`OR(${orParts})`)}&fields[]=Full%20Name&fields[]=LinkedIn%20URL`
    )
    for (const p of (pData.records || [])) {
      peopleMap.set(p.id, {
        name:        p.fields['Full Name']    || '',
        linkedinUrl: p.fields['LinkedIn URL'] || null,
      })
    }
  }
  return peopleMap
}

function mapRecord(r: AirtableRecord, peopleMap: Map<string, { name: string; linkedinUrl: string | null }>) {
  const hostLinks     = (r.fields['Host']      as Array<{ id: string }>) || []
  const attendeeLinks = (r.fields['Attendees'] as Array<{ id: string }>) || []
  const hostIds       = new Set(hostLinks.map(h => h.id))

  const attendees = attendeeLinks.map(a => ({
    ...(peopleMap.get(a.id) ?? { name: '', linkedinUrl: null }),
    isHost: hostIds.has(a.id),
  }))

  return {
    id:            r.id as string,
    title:         (r.fields['Event Title']      as string) || 'Co-writing Session',
    eventDate:     (r.fields['Event Date']       as string) || null,
    durationHours: (r.fields['Duration (hours)'] as number) || 1,
    eventUrl:      (r.fields['Event URL']        as string) || null,
    status:        (r.fields['Status']           as string) || 'Upcoming',
    attendees,
  }
}

function byDateDesc(a: { eventDate: string | null }, b: { eventDate: string | null }) {
  return (b.eventDate || '').localeCompare(a.eventDate || '')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const email = await getSessionEmail(req)
  if (!email) return res.status(401).json({ error: 'Unauthorised' })

  try {
    // Find person record ID
    const personFilter = encodeURIComponent(`{Email}="${email}"`)
    const personData = await at(PEOPLE_TABLE, `?filterByFormula=${personFilter}&maxRecords=1&fields[]=Full%20Name`)
    if (!personData.records?.length) return res.status(200).json({ hosted: [], attended: [] })

    const personId = personData.records[0].id

    const allRecords = await fetchAllSessions()
    const hostedRecords   = allRecords.filter((r: AirtableRecord) =>
      ((r.fields['Host']      as Array<{ id: string }>) || []).some(h => h.id === personId)
    )
    const attendedRecords = allRecords.filter((r: AirtableRecord) =>
      ((r.fields['Attendees'] as Array<{ id: string }>) || []).some(a => a.id === personId)
    )

    // Deduplicate: sessions already in hosted shouldn't appear in attended
    const hostedIds = new Set(hostedRecords.map((r: AirtableRecord) => r.id as string))
    const attendedOnly = attendedRecords.filter((r: AirtableRecord) => !hostedIds.has(r.id as string))

    // Batch-fetch all people across both lists
    const allRecords = [...hostedRecords, ...attendedOnly]
    const peopleMap = await enrichWithPeople(allRecords)

    const hosted   = hostedRecords.map((r: AirtableRecord) => mapRecord(r, peopleMap)).sort(byDateDesc)
    const attended = attendedOnly .map((r: AirtableRecord) => mapRecord(r, peopleMap)).sort(byDateDesc)

    return res.status(200).json({ hosted, attended })
  } catch (err) {
    console.error('[cowriting-sessions] error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
