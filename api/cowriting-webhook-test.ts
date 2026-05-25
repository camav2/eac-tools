/**
 * Test endpoint for the cowriting webhook — admin only, never touches Circle.
 *
 * POST /api/cowriting-webhook-test
 * Body: { event_id, event_name, community_member_id, type }
 *
 * Replays the exact payload shape Circle sends, forwarding it internally
 * to the webhook handler so you can verify Airtable updates without
 * creating a real Circle event.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  const {
    event_id         = 99999999,
    event_name       = 'Test Co-writing Session',
    community_member_id = 0,
    type             = 'event_published',
  } = req.body ?? {}

  // Mirror the exact payload shape Circle sends
  const circlePayload = {
    body: {
      type,
      data: {
        event_id,
        event_name,
        community_member_id,
        space_id:     1633748,
        community_id: 9832,
      },
    },
  }

  const webhookUrl = `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://tools.expertauthor.community'}/api/cowriting-webhook`

  console.log('[webhook-test] forwarding to', webhookUrl, JSON.stringify(circlePayload))

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.COWRITING_WEBHOOK_SECRET
        ? { 'x-webhook-secret': process.env.COWRITING_WEBHOOK_SECRET }
        : {}),
    },
    body: JSON.stringify(circlePayload),
  })

  const result = await response.json()
  console.log('[webhook-test] result:', response.status, JSON.stringify(result))

  return res.status(200).json({
    forwarded: circlePayload,
    webhookStatus: response.status,
    webhookResult: result,
  })
}
