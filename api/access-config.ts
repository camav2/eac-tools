import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'

/*
 * Access Config — single source of truth for EAC tool access control.
 *
 * This is read by the /settings admin page and serves as the canonical
 * reference for which space groups unlock which tools.
 *
 * To add a new access group:
 *  1. Create the Space Group in Circle
 *  2. POST to this endpoint with { slug, name, circleSpaceGroupId, tools[] }
 *  3. Add the new slug to GATED_SPACE_GROUPS in eac-auth/src/lib/circle.ts
 *  4. Update ALL_TOOLS / COWRITING constants in api/_lib/auth.ts as needed
 *  5. Redeploy both eac-auth and eac-tools
 *
 * Storage: persisted as JSON in the ACCESS_CONFIG_JSON env var.
 * Seed value (set in Vercel env vars):
 *   ACCESS_CONFIG_JSON = see defaultConfig below
 */

const defaultConfig = {
  groups: [
    {
      slug:               'connect',
      name:               'Connect',
      circleSpaceGroupId: 22744,
      description:        'Full membership — access to all tools including co-writing sessions',
    },
    {
      slug:               'write-now',
      name:               'Write Now',
      circleSpaceGroupId: 1056434,
      description:        'Programme access — all tools except co-writing sessions',
    },
  ],
  tools: [
    { slug: 'idea-test',   name: 'Idea Test',           path: '/idea-test',   requiredGroups: ['connect', 'write-now'] },
    { slug: 'unblocker',   name: 'Writing Unblock',     path: '/unblocker',   requiredGroups: ['connect', 'write-now'] },
    { slug: 'book-canvas', name: 'Book Canvas',         path: '/book-canvas', requiredGroups: ['connect', 'write-now'] },
    { slug: 'cowriting',   name: 'Co-writing Sessions', path: '/cowriting',   requiredGroups: ['connect'] },
  ],
}

function loadConfig() {
  try {
    const raw = process.env.ACCESS_CONFIG_JSON
    if (!raw) return defaultConfig
    const parsed = JSON.parse(raw)
    // Merge: keep default tools/groups but allow overrides + additions
    return {
      groups: parsed.groups ?? defaultConfig.groups,
      tools:  parsed.tools  ?? defaultConfig.tools,
    }
  } catch {
    return defaultConfig
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  if (req.method === 'GET') {
    return res.status(200).json(loadConfig())
  }

  // POST — add or update a group
  if (req.method === 'POST') {
    const { slug, name, circleSpaceGroupId, description, tools } = req.body
    if (!slug || !name || !circleSpaceGroupId) {
      return res.status(400).json({ error: 'slug, name, and circleSpaceGroupId are required' })
    }

    const config = loadConfig()

    // Upsert group
    const existingIdx = config.groups.findIndex(g => g.slug === slug)
    const newGroup = { slug, name, circleSpaceGroupId: Number(circleSpaceGroupId), description: description || '' }
    if (existingIdx >= 0) {
      config.groups[existingIdx] = newGroup
    } else {
      config.groups.push(newGroup)
    }

    // Update tool access if provided
    if (Array.isArray(tools)) {
      for (const toolSlug of tools) {
        const tool = config.tools.find(t => t.slug === toolSlug)
        if (tool && !tool.requiredGroups.includes(slug)) {
          tool.requiredGroups.push(slug)
        }
      }
    }

    // Note: in production you'd persist this to Airtable or KV store.
    // For now, return the updated config with a reminder to set the env var.
    return res.status(200).json({
      ok: true,
      config,
      reminder: 'Set ACCESS_CONFIG_JSON in Vercel env vars to: ' + JSON.stringify(config) +
                '\nAlso add slug to GATED_SPACE_GROUPS in eac-auth/src/lib/circle.ts and redeploy.',
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
