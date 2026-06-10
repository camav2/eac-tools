/**
 * Shared Brevo helpers — contact list management + transactional email
 *
 * List IDs (Tools folder):
 *   book-canvas : 66
 *   idea-test   : 65
 *   unblocker   : 64
 *
 * Template IDs:
 *   book-canvas : 546
 *   idea-test   : 547
 *   unblocker   : 548
 */

export const BREVO_LISTS = {
  'book-canvas': 66,
  'idea-test':   65,
  'unblocker':   64,
  'isbn-wizard': 68,
} as const

export const BREVO_TEMPLATES = {
  'book-canvas': 546,
  'idea-test':   547,
  'unblocker':   548,
  'isbn-wizard': 550,
} as const

/**
 * Upsert a contact in Brevo and add them to the tool-specific list.
 * Best-effort — errors are logged but not re-thrown.
 */
export async function addContactToList(params: {
  email:      string
  firstName?: string
  tool:       keyof typeof BREVO_LISTS
  attributes?: Record<string, unknown>
}): Promise<void> {
  const { email, firstName, tool, attributes } = params
  const listId = BREVO_LISTS[tool]

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      process.env.BREVO_API_KEY!,
      },
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: firstName || '',
          ...attributes,
        },
        listIds:       [listId],
        updateEnabled: true,
      }),
    })

    // 201 = created, 204 = updated, 200 = ok — all success
    if (res.ok) {
      console.log(`[brevo] contact added to list ${listId} (${tool}) — status ${res.status}`)
    } else {
      const err = await res.json().catch(() => ({ status: res.status }))
      console.error(`[brevo] addContactToList (${tool}) error ${res.status}:`, JSON.stringify(err))
    }
  } catch (err) {
    console.error(`[brevo] addContactToList (${tool}) failed:`, err)
  }
}

// ── Mail-merge helpers ───────────────────────────────────────────────────────

const BREVO_BASE = 'https://api.brevo.com/v3'

async function brevoFetch(path: string, params?: URLSearchParams) {
  const url = `${BREVO_BASE}/${path}${params ? '?' + params : ''}`
  const res = await fetch(url, {
    headers: { 'api-key': process.env.BREVO_API_KEY!, 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error('Brevo API error:', res.status, path, body.slice(0, 200))
    return null
  }
  return res.json()
}

export interface BrevoSource { id: number; name: string; count: number }

export async function listBrevoLists(): Promise<BrevoSource[]> {
  const all: BrevoSource[] = []
  let offset = 0
  while (true) {
    const data = await brevoFetch('contacts/lists', new URLSearchParams({ limit: '50', offset: String(offset) }))
    if (!data) break
    const lists: any[] = data.lists ?? []
    for (const l of lists) all.push({ id: l.id, name: l.name, count: l.uniqueSubscribers ?? 0 })
    if (lists.length < 50) break
    offset += 50
  }
  return all
}

export interface BrevoMember { email: string; name: string; first_name: string; last_name: string }

function parseBrevoContact(c: any): BrevoMember | null {
  if (!c.email) return null
  const a  = c.attributes ?? {}
  const fn = (a.FIRSTNAME ?? a.firstname ?? '') as string
  const ln = (a.LASTNAME  ?? a.lastname  ?? '') as string
  return { email: c.email, name: `${fn} ${ln}`.trim() || c.email, first_name: fn, last_name: ln }
}

export async function getMembersFromBrevoList(listId: number): Promise<BrevoMember[]> {
  const members: BrevoMember[] = []
  let offset = 0
  while (true) {
    const data = await brevoFetch(`contacts/lists/${listId}/contacts`, new URLSearchParams({ limit: '500', offset: String(offset) }))
    if (!data) break
    const contacts: any[] = data.contacts ?? []
    for (const c of contacts) { const m = parseBrevoContact(c); if (m) members.push(m) }
    if (contacts.length < 500) break
    offset += 500
  }
  return members
}

export async function listBrevoSegments(): Promise<BrevoSource[]> {
  const all: BrevoSource[] = []
  let offset = 0
  while (true) {
    const data = await brevoFetch('contacts/segments', new URLSearchParams({ limit: '50', offset: String(offset) }))
    if (!data) break
    const segments: any[] = data.segments ?? []
    for (const s of segments) all.push({ id: s.id, name: s.segmentName, count: 0 })
    if (segments.length < 50) break
    offset += 50
  }
  return all
}

export async function getMembersFromBrevoSegment(segmentId: number): Promise<BrevoMember[]> {
  const members: BrevoMember[] = []
  let offset = 0
  while (true) {
    const data = await brevoFetch('contacts', new URLSearchParams({ segmentId: String(segmentId), limit: '500', offset: String(offset) }))
    if (!data) break
    const contacts: any[] = data.contacts ?? []
    for (const c of contacts) { const m = parseBrevoContact(c); if (m) members.push(m) }
    if (contacts.length < 500) break
    offset += 500
  }
  return members
}

/**
 * Send a transactional email via a Brevo template.
 * Best-effort — errors are logged but not re-thrown.
 */
export async function sendResultsEmail(params: {
  to:         { email: string; name?: string }
  tool:       keyof typeof BREVO_TEMPLATES
  templateParams: Record<string, unknown>
}): Promise<void> {
  const { to, tool, templateParams } = params
  const templateId = BREVO_TEMPLATES[tool]

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      process.env.BREVO_API_KEY!,
      },
      body: JSON.stringify({
        to:         [{ email: to.email, name: to.name || to.email }],
        templateId,
        params:     templateParams,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      console.error(`[brevo] sendResultsEmail (${tool}) error:`, err)
    } else {
      console.log(`[brevo] results email sent (template ${templateId}) to ${to.email}`)
    }
  } catch (err) {
    console.error(`[brevo] sendResultsEmail (${tool}) failed:`, err)
  }
}
