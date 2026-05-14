/**
 * Circle REST API helpers
 *
 * Env vars required:
 *   CIRCLE_API_TOKEN    — API token from Circle settings
 *   CIRCLE_COMMUNITY_ID — numeric community ID
 */

interface AccessGroup {
  id:   number
  name: string
}

/**
 * Returns the first access group for a Circle community member.
 * Returns null if the member has no access groups or the call fails.
 */
export async function getCircleAccessGroup(circleUserId: string | number): Promise<AccessGroup | null> {
  try {
    const params = new URLSearchParams({
      community_member_id: String(circleUserId),
      community_id:        process.env.CIRCLE_COMMUNITY_ID!,
      per_page:            '1',
    })

    const res = await fetch(
      `https://app.circle.so/api/v1/community_member_access_groups?${params}`,
      {
        headers: {
          Authorization: `Token ${process.env.CIRCLE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!res.ok) {
      console.error('Circle API error:', res.status, await res.text())
      return null
    }

    const data = await res.json()
    // Response is an array of access group objects
    const groups: AccessGroup[] = Array.isArray(data) ? data : data.records ?? []
    return groups[0] ?? null
  } catch (err) {
    console.error('Circle API fetch failed:', err)
    return null
  }
}
