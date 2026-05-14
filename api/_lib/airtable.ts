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
  email:            string
  name?:            string
  isMember:         boolean
  circleMemberId?:  string
  accessGroup?:     string
  accessGroupId?:   string
}): Promise<string> {
  const { email, name, isMember, circleMemberId, accessGroup, accessGroupId } = params
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
          ...(name            ? { 'Full Name':        name                   } : {}),
          ...(circleMemberId  ? { 'Circle Member ID': circleMemberId         } : {}),
          ...(accessGroup     ? { 'Access Group':     [accessGroup]          } : {}),
          ...(accessGroupId   ? { 'Access Group ID':  String(accessGroupId)  } : {}),
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
        ...(circleMemberId  ? { 'Circle Member ID': circleMemberId         } : {}),
        ...(accessGroup     ? { 'Access Group':     [accessGroup]          } : {}),
        ...(accessGroupId   ? { 'Access Group ID':  String(accessGroupId)  } : {}),
      },
    }),
  })
  return created.id
}

/**
 * Resolve a person record: Circle access group lookup (members only) + People upsert.
 * Best-effort — returns undefined if anything fails.
 * Use this at the top of every tool handler before writing to a results table.
 */
export async function resolvePersonWithCircle(params: {
  email:          string
  name?:          string
  isMember?:      boolean
  circleUserId?:  string
}): Promise<string | undefined> {
  const { email, name, isMember, circleUserId } = params

  let accessGroup:   string | undefined
  let accessGroupId: string | undefined

  if (isMember && email) {
    try {
      const { getCircleAccessGroup } = await import('./circle')
      const group = await getCircleAccessGroup(email)
      if (group) {
        accessGroup   = group.name
        accessGroupId = String(group.id)
        console.log('[circle] access group:', group.name, group.id)
      } else {
        console.log('[circle] no access group found for', email)
      }
    } catch (err) {
      console.error('[circle] failed:', err)
    }
  }

  try {
    const personId = await upsertPerson({
      email,
      name:           name || '',
      isMember:       !!isMember,
      circleMemberId: circleUserId ? String(circleUserId) : undefined,
      accessGroup,
      accessGroupId,
    })
    console.log('[people] upserted:', personId)
    return personId
  } catch (err) {
    console.error('[people] upsert failed:', err)
    return undefined
  }
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
        'Person':      [personId],
        'Action Type': actionType,
        'Timestamp':   new Date().toISOString(),
        'Source Tool': sourceTool,
        ...(referenceId ? { 'Reference ID': referenceId } : {}),
      },
    }),
  })
}
