/**
 * Circle REST API v2 helpers
 *
 * Env vars required:
 *   CIRCLE_API_TOKEN    — API token from Circle settings
 *   CIRCLE_COMMUNITY_ID — numeric community ID (9832)
 *   CIRCLE_ADMIN_GROUP  — name of the admin access group (default: "Administrator")
 *
 * NOTE: Circle has two distinct IDs per person:
 *   user_id             — global account ID (what the JWT stores as circleUserId)
 *   community_member_id — community-specific ID (what the API needs for access groups)
 * We resolve community_member_id by looking up the member by email first.
 */

interface AccessGroup {
  id:   number
  name: string
}

async function circleFetch(path: string, admin = false) {
  const base = admin ? 'https://app.circle.so/api/admin/v2' : 'https://app.circle.so/api/v2'
  const res = await fetch(`${base}/${path}`, {
    headers: {
      Authorization:  `Token ${process.env.CIRCLE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    console.error('Circle API error:', res.status, path)
    return null
  }
  return res.json()
}

/**
 * Look up a member's community_member_id by email.
 * Returns null if not found or on error.
 */
async function getCommunityMemberId(email: string): Promise<number | null> {
  const params = new URLSearchParams({
    email,
    community_id: process.env.CIRCLE_COMMUNITY_ID!,
    per_page:     '1',
  })
  const data = await circleFetch(`community_members?${params}`)
  if (!data) return null
  const records = data.records ?? (Array.isArray(data) ? data : [data])
  return records[0]?.id ?? null
}

/**
 * Returns the most relevant access group for a member, looked up by email.
 * Returns null if the member has no access groups or any call fails.
 * Fails silently so it never blocks a form submission.
 */
export async function getCircleAccessGroup(email: string): Promise<AccessGroup | null> {
  try {
    const communityMemberId = await getCommunityMemberId(email)
    if (!communityMemberId) return null

    const params = new URLSearchParams({
      community_member_id: String(communityMemberId),
      community_id:        process.env.CIRCLE_COMMUNITY_ID!,
      per_page:            '10',
    })
    const data = await circleFetch(`community_member_access_groups?${params}`)
    if (!data) return null

    const groups: AccessGroup[] = data.records ?? []
    // Prefer active groups; return the first one
    return groups.find(g => (g as any).status === 'active') ?? groups[0] ?? null
  } catch (err) {
    console.error('Circle access group lookup failed:', err)
    return null
  }
}

export interface CircleMember {
  email:      string
  name:       string
  first_name: string
  last_name:  string
}

/**
 * List all access groups for the community.
 */
export async function listAccessGroups(): Promise<{ id: number; name: string }[]> {
  try {
    const all: { id: number; name: string }[] = []
    let page = 1
    while (true) {
      const params = new URLSearchParams({
        community_id: process.env.CIRCLE_COMMUNITY_ID!,
        per_page:     '100',
        page:         String(page),
      })
      const data = await circleFetch(`access_groups?${params}`, true)
      if (!data) break
      const records: any[] = data.records ?? (Array.isArray(data) ? data : [])
      for (const g of records) all.push({ id: g.id as number, name: g.name as string })
      if (!data.has_next_page) break
      page++
    }
    return all
  } catch (err) {
    console.error('[circle] listAccessGroups failed:', err)
    return []
  }
}

/**
 * Fetch all community members that belong to a given access group.
 *
 * Step 1: page through access_group_community_members (admin API) to collect
 *         community_member_id values — the join table has no email/name.
 * Step 2: fetch each member record by ID in parallel batches of 20.
 */
export async function getMembersInAccessGroup(accessGroupId: number): Promise<CircleMember[]> {
  // Step 1 — collect community_member_ids
  const memberIds: number[] = []
  let page = 1
  while (true) {
    const params = new URLSearchParams({
      access_group_id: String(accessGroupId),
      per_page:        '100',
      page:            String(page),
    })
    const data = await circleFetch(`access_group_community_members?${params}`, true)
    if (!data) break
    const records: any[] = data.records ?? []
    for (const r of records) if (r.community_member_id) memberIds.push(Number(r.community_member_id))
    if (!data.has_next_page) break
    page++
  }

  if (memberIds.length === 0) return []

  // Step 2 — fetch member details in parallel chunks
  const members: CircleMember[] = []
  const CHUNK = 20
  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const chunk = memberIds.slice(i, i + CHUNK)
    const results = await Promise.all(
      chunk.map(id =>
        circleFetch(`community_members/${id}`, true).catch(() => null)
      )
    )
    for (const m of results) {
      if (!m || !m.email) continue
      const firstName = (m.first_name ?? '') as string
      const lastName  = (m.last_name  ?? '') as string
      members.push({
        email:      m.email      as string,
        name:       (m.name as string) || `${firstName} ${lastName}`.trim() || m.email,
        first_name: firstName,
        last_name:  lastName,
      })
    }
  }

  return members
}

/**
 * Returns true if the given email belongs to the admin access group.
 * Group name is configured via CIRCLE_ADMIN_GROUP (default: "Administrator").
 */
export async function isCircleAdmin(email: string): Promise<boolean> {
  try {
    const communityMemberId = await getCommunityMemberId(email)
    if (!communityMemberId) return false

    const params = new URLSearchParams({
      community_member_id: String(communityMemberId),
      community_id:        process.env.CIRCLE_COMMUNITY_ID!,
      per_page:            '25',
    })
    const data = await circleFetch(`community_member_access_groups?${params}`)
    if (!data) return false

    const adminGroup = (process.env.CIRCLE_ADMIN_GROUP ?? 'Administrator').toLowerCase()
    const groups: AccessGroup[] = data.records ?? []
    return groups.some(g => g.name.toLowerCase() === adminGroup)
  } catch (err) {
    console.error('isCircleAdmin check failed:', err)
    return false
  }
}
