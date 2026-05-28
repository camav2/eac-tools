/*
 * Content API — reads/writes page content baked into HTML files via GitHub
 *
 * Content is stored as a JSON block in each page's <head>:
 *   <script type="application/json" id="page-content">{...}</script>
 *
 * GET  ?page=<page>  — returns the current content map for that page
 * POST              — admin only; updates a key and commits the HTML file to GitHub
 *
 * Env vars required:
 *   JWT_SECRET, ADMIN_EMAILS
 *   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSession } from './_lib/auth'

const PAGE_FILES: Record<string, string> = {
  'index':        'public/index.html',
  'idea-test':    'public/idea-test.html',
  'unblocker':    'public/unblocker.html',
  'book-canvas':  'public/book-canvas.html',
  'isbn-wizard':  'public/isbn-wizard.html',
}

const CONTENT_BLOCK_RE = /<script type="application\/json" id="page-content">([\s\S]*?)<\/script>/


async function ghGet(filePath: string) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${filePath}`
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept:        'application/vnd.github.v3+json',
    },
  })
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`)
  return res.json() as Promise<{ content: string; sha: string }>
}

async function ghPut(filePath: string, content: string, sha: string, message: string) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${filePath}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization:  `token ${process.env.GITHUB_TOKEN}`,
      Accept:         'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString('base64'),
      sha,
    }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(`GitHub PUT failed: ${JSON.stringify(err)}`)
  }
}

function extractContentMap(html: string): Record<string, string> {
  const match = html.match(CONTENT_BLOCK_RE)
  if (!match) return {}
  try { return JSON.parse(match[1] || '{}') } catch { return {} }
}

function injectContentMap(html: string, map: Record<string, string>): string {
  const block = `<script type="application/json" id="page-content">${JSON.stringify(map, null, 2)}</script>`
  if (CONTENT_BLOCK_RE.test(html)) return html.replace(CONTENT_BLOCK_RE, block)
  return html.replace('<head>', `<head>\n${block}`)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // GET — returns the current content map for a page (reads from GitHub)
  if (req.method === 'GET') {
    const page = req.query.page as string
    if (!page) return res.status(400).json({ error: 'page required' })
    const filePath = PAGE_FILES[page]
    if (!filePath) return res.status(400).json({ error: 'Unknown page' })

    try {
      const { content } = await ghGet(filePath)
      const html = Buffer.from(content, 'base64').toString('utf8')
      return res.status(200).json(extractContentMap(html))
    } catch (err) {
      console.error('content GET failed:', err)
      return res.status(500).json({ error: 'Failed to read content' })
    }
  }

  // POST — admin only; updates a key and commits the HTML file to GitHub
  if (req.method === 'POST') {
    const session = await getSession(req)
    if (!session) return res.status(401).json({ error: 'Unauthorised' })
    if (!session.isAdmin) return res.status(403).json({ error: 'Forbidden — not admin' })

    const { key, html: value, page } = req.body
    if (!key || !page) return res.status(400).json({ error: 'key and page required' })
    const filePath = PAGE_FILES[page]
    if (!filePath) return res.status(400).json({ error: 'Unknown page' })

    try {
      const { content, sha } = await ghGet(filePath)
      const fileHtml    = Buffer.from(content, 'base64').toString('utf8')
      const currentMap  = extractContentMap(fileHtml)
      const updatedMap  = { ...currentMap, [key]: value ?? '' }
      const updatedHtml = injectContentMap(fileHtml, updatedMap)

      await ghPut(filePath, updatedHtml, sha, `content: update ${key}`)
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[content] POST failed:', err)
      return res.status(500).json({ error: 'Failed to save content' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
