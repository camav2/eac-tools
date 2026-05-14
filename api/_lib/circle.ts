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

async function circleFetch(path: string) {
  const res = await fetch(`https://app.circle.so/api/v2/${path}`, {
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
