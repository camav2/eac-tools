import type { VercelRequest, VercelResponse } from '@vercel/node'

const COWRITING_TABLE = 'tblMTfHsSf1WrAvbs'
const CIRCLE_COMMUNITY = process.env.CIRCLE_COMMUNITY_ID!

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getAuthedEmail(req: VercelRequest): Promise<string | null> {
  const cookieHeader = req.headers.cookie ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)eac_session=([^;]+)/)
  if (!match) return null
  try {
    const { jwtVerify } = await import('jose')
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    const { payload } = await jwtVerify(decodeURIComponent(match[1]), secret)
    return (payload.sub as string) ?? null
  } catch {
    return null
  }
}

function isAdmin(email: string): boolean {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim()).filter(Boolean)
    .includes(email)
}

// ── Circle API ────────────────────────────────────────────────────────────────

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

// Space ID for /c/co-writing-events/ — set CIRCLE_COWRITING_SPACE_ID in Vercel env,
// or leave blank to sync all community events (safe for a one-time backfill).
async function fetchCowritingEvents(): Promise<any[]> {
  const spaceId = process.env.CIRCLE_COWRITING_SPACE_ID ?? ''
  const all: any[] = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      community_id: CIRCLE_COMMUNITY,
      per_page:     '50',
      page:         String(page),
    })
    if (spaceId) params.set('space_id', spaceId)

    const data = await circleGet(`events?${params}`)
    if (!data) break

    const records: any[] = data.records ?? (Array.isArray(data) ? data : [])
    if (records.length === 0) break
    all.push(...records)

    if (records.length < 50) break
    page++
  }

  return all
}

async function fetchCircleMember(memberId: string | number) {
  return circleGet(`community_members/${memberId}?community_id=${CIRCLE_COMMUNITY}`)
}

// ── Airtable ──────────────────────────────────────────────────────────────────

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
    return { id: record.id as string, created: false }
  }
  const created = await at(COWRITING_TABLE, '', {
    method: 'POST',
    body: JSON.stringify({ fields: { 'Circle Event ID': circleEventId, ...fields } }),
  })
  return { id: created.id as string, created: true }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const email = await getAuthedEmail(req)
  if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Forbidden' })

  try {
    // DEBUG: inspect raw Circle response shape
    const debugParams = new URLSearchParams({ community_id: CIRCLE_COMMUNITY, per_page: '5', page: '1' })
    const debugRaw = await circleGet(`events?${debugParams}`)
    console.log('[sync-cowriting] raw Circle response keys:', debugRaw ? Object.keys(debugRaw) : 'null')
    console.log('[sync-cowriting] raw sample:', JSON.stringify(debugRaw).slice(0, 500))

    const events = await fetchCowritingEvents()
    console.log(`[sync-cowriting] fetched ${events.length} events`)

    const results = { created: 0, updated: 0, skipped: 0 }

    for (const event of events) {
      const circleEventId = String(event.id ?? '')
      if (!circleEventId) { results.skipped++; continue }

      const startsAt = event.event_setting_attributes?.starts_at ?? event.starts_at ?? null
      const endsAt   = event.event_setting_attributes?.ends_at   ?? event.ends_at   ?? null

      const now = new Date()
      const isUpcoming  = startsAt  && new Date(startsAt)  > now
      const isCompleted = endsAt    && new Date(endsAt)    < now

      const fields: Record<string, unknown> = {
        'Event Title': event.name ?? 'Co-writing Session',
        'Status':      isCompleted ? 'Completed' : 'Upcoming',
      }
      if (startsAt)       fields['Event Date']  = startsAt
      if (event.url)      fields['Event URL']   = event.url
      if (startsAt && endsAt) {
        const dur = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000
        if (dur > 0) fields['Duration (hours)'] = Math.round(dur * 10) / 10
      }

      const { id: eventRecordId, created } = await upsertEvent(circleEventId, fields)
      if (created) results.created++; else results.updated++

      // Capture host from event.user_id if present and event is new
      if (created && event.community_member_id) {
        try {
          const member = await fetchCircleMember(event.community_member_id)
          const email  = member?.email ?? ''
          const name   = member?.name ?? member?.full_name ?? ''
          if (email) {
            const { upsertPerson } = await import('./_lib/airtable')
            const personId = await upsertPerson({ email, name, isMember: true })
            await at(COWRITING_TABLE, `/${eventRecordId}`, {
              method: 'PATCH',
              body: JSON.stringify({ fields: { Host: [personId] } }),
            })
          }
        } catch (err) {
          console.warn('[sync-cowriting] host lookup failed for event', circleEventId, err)
        }
      }
    }

    console.log('[sync-cowriting] done:', results)
    return res.status(200).json({ ok: true, results, total: events.length, debug: { rawKeys: debugRaw ? Object.keys(debugRaw) : null, sample: JSON.stringify(debugRaw).slice(0, 300) } })
  } catch (err) {
    console.error('[sync-cowriting] error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
