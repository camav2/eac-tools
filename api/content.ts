import type { VercelRequest, VercelResponse } from '@vercel/node'

const CONTENT_TABLE = 'tblUyaPEteDmd21IM'

function parseCookie(header: string, name: string): string | null {
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

async function getAuthedEmail(req: VercelRequest): Promise<string | null> {
  const token = parseCookie(req.headers.cookie ?? '', 'eac_session')
  if (!token) return null
  try {
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET!))
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

async function at(path = '', options: RequestInit = {}) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${CONTENT_TABLE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    },
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // GET — public, returns { key: html } for a page
  if (req.method === 'GET') {
    const page = req.query.page as string
    if (!page) return res.status(400).json({ error: 'page required' })

    const filter = encodeURIComponent(`{Page}="${page}"`)
    const data   = await at(`?filterByFormula=${filter}&maxRecords=100`)
    const map: Record<string, string> = {}
    for (const record of data.records ?? []) {
      if (record.fields.Key) map[record.fields.Key] = record.fields.HTML ?? ''
    }
    return res.status(200).json(map)
  }

  // POST — admin only, upserts a content record
  if (req.method === 'POST') {
    const email = await getAuthedEmail(req)
    if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Forbidden' })

    const { key, html, page, label } = req.body
    if (!key || !page) return res.status(400).json({ error: 'key and page required' })

    const filter = encodeURIComponent(`{Key}="${key}"`)
    const found  = await at(`?filterByFormula=${filter}&maxRecords=1`)

    if (found.records?.length) {
      const { id } = found.records[0]
      await at(`/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { HTML: html, 'Updated At': new Date().toISOString() } }),
      })
    } else {
      await at('', {
        method: 'POST',
        body: JSON.stringify({
          fields: { Key: key, Page: page, HTML: html, Label: label ?? key, 'Updated At': new Date().toISOString() },
        }),
      })
    }

    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
