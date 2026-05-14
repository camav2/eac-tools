import type { VercelRequest, VercelResponse } from '@vercel/node'
import { jwtVerify } from 'jose'
import { isCircleAdmin } from './_lib/circle'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)
const OWNER      = process.env.GITHUB_OWNER ?? 'camav2'
const REPO       = process.env.GITHUB_REPO  ?? 'eac-tools'
const FILE_PATH  = 'public/index.html'

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\s*)${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

async function requireAdmin(req: VercelRequest): Promise<string | null> {
  const token = parseCookie(req.headers.cookie ?? '', 'eac_session')
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)
    const email = payload.sub as string
    return (await isCircleAdmin(email)) ? email : null
  } catch {
    return null
  }
}

async function githubRequest(path: string, options: RequestInit = {}) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      ...options,
      headers: {
        Authorization:          `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...((options.headers as Record<string, string>) ?? {}),
      },
    }
  )
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.message ?? 'GitHub API error')
  }
  return res.json()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const email = await requireAdmin(req)
  if (!email) return res.status(403).json({ error: 'Admin access required' })

  if (req.method === 'GET') {
    try {
      const file    = await githubRequest(FILE_PATH)
      const content = Buffer.from(file.content, 'base64').toString('utf-8')
      return res.status(200).json({ content, sha: file.sha })
    } catch (err) {
      console.error('content GET error:', err)
      return res.status(500).json({ error: 'Failed to read file' })
    }
  }

  if (req.method === 'POST') {
    const { content, sha } = req.body ?? {}
    if (!content || !sha) return res.status(400).json({ error: 'content and sha required' })

    try {
      const result = await githubRequest(FILE_PATH, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Update index.html [${email}]`,
          content: Buffer.from(content).toString('base64'),
          sha,
        }),
      })
      return res.status(200).json({ ok: true, sha: result.content.sha })
    } catch (err) {
      console.error('content POST error:', err)
      return res.status(500).json({ error: 'Failed to update file' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
