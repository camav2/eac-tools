/**
 * Shared Airtable helpers — People upsert + Activity Log
 *
 * Table IDs are fixed for the EAC base (appvucz2Xo0PLqN2k).
 * These are shared infrastructure tables used by every tool.
 */

const PEOPLE_TABLE       = 'tblbJgznPsbETLl8q'
const ACTIVITY_LOG_TABLE = 'tblgK9bOiRsjfzvdM'

async function at(table: string, path = '', options: RequestInit = {}) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${table}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    },
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

/**
 * Find an existing Person by email and update them, or create a new record.
 * Returns the Airtable record ID.
 */
export async function upsertPerson(params: {
  email:           string
  name?:           string
  isMember:        boolean
  circleMemberId?: string
}): Promise<string> {
  const { email, name, isMember, circleMemberId } = params
  const category = isMember ? 'Member' : 'Non-member'
  const now = new Date().toISOString()

  const filter = encodeURIComponent(`{Email}="${email}"`)
  const found  = await at(PEOPLE_TABLE, `?filterByFormula=${filter}&maxRecords=1`)

  if (found.records?.length) {
    const { id } = found.records[0]
    await at(PEOPLE_TABLE, `/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          'Category':    category,
          'Last Active': now,
          ...(name           ? { 'Full Name':        name           } : {}),
          ...(circleMemberId ? { 'Circle Member ID': circleMemberId } : {}),
        },
      }),
    })
    return id
  }

  const created = await at(PEOPLE_TABLE, '', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        'Email':       email,
        'Full Name':   name ?? '',
        'Category':    category,
        'First Seen':  now,
        'Last Active': now,
        ...(circleMemberId ? { 'Circle Member ID': circleMemberId } : {}),
      },
    }),
  })
  return created.id
}

/**
 * Append a row to the Activity Log table linked to a Person.
 */
export async function logActivity(params: {
  personId:    string
  actionType:  string
  sourceTool:  string
  summary:     string
  referenceId?: string
}): Promise<void> {
  const { personId, actionType, sourceTool, summary, referenceId } = params
  await at(ACTIVITY_LOG_TABLE, '', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        'Summary':     summary,
        'Person':      [{ id: personId }],
        'Action Type': actionType,
        'Timestamp':   new Date().toISOString(),
        'Source Tool': sourceTool,
        ...(referenceId ? { 'Reference ID': referenceId } : {}),
      },
    }),
  })
}
