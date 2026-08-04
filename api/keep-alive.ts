/*
 * Keep-alive ping for Supabase free tier.
 *
 * Supabase pauses a free project after 7 days without activity; any query
 * resets that clock. Vercel cron hits this daily.
 *
 * Daily rather than every-few-days on purpose: the margin is what matters,
 * not the frequency. The previous "0 0 * /5 * *" schedule looked like every
 * five days but cron's day-of-month stepping fires on the 1st, 6th, 11th,
 * 16th, 21st, 26th and then wraps — a 6-day gap against a 7-day deadline,
 * so a single failed run meant a paused database. Daily leaves six days of
 * slack for free.
 *
 * NOTE: this cannot wake a project that is already paused — restoring that
 * is a manual step in the Supabase dashboard. This only prevents pausing.
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
