/*
 * Keep-alive ping for Supabase free tier.
 * Vercel cron hits this every 5 days — any query counts as activity
 * and prevents the project being auto-paused.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
  const r = await fetch(`${base}/rest/v1/gmail_tokens?limit=1&select=admin_email`, {
    headers: {
      apikey:        process.env.SUPABASE_SERVICE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  })
  const ok = r.ok
  console.log(`[keep-alive] Supabase ping ${ok ? 'ok' : 'failed'} (${r.status})`)
  return res.status(ok ? 200 : 502).json({ ok, status: r.status, ts: new Date().toISOString() })
}
