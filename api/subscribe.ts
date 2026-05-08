import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email, name, writingBlocker } = req.body

  if (!email) {
    return res.status(400).json({ error: 'Email required' })
  }

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY!,
      },
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: name || '',
          WRITING_BLOCKER: writingBlocker || '',
        },
        listIds: [Number(process.env.BREVO_LIST_ID)],
        updateEnabled: true,
      }),
    })

    // 201 = created, 204 = already existed + updated — both are success
    if (brevoRes.status === 201 || brevoRes.status === 204) {
      return res.status(200).json({ ok: true })
    }

    const error = await brevoRes.json()
    console.error('Brevo error:', error)
    return res.status(500).json({ error: 'Brevo API error' })

  } catch (err) {
    console.error('Subscribe handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
