/*
 * ISBN Wizard API
 *
 * POST — save a completed wizard result (members + non-members)
 * GET  — retrieve result(s) for the logged-in member
 *   ?id=<recordId>  →  single result (full fields)
 *   (no params)     →  list of all results for the session user
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_ISBN_WIZARD_TABLE_ID
 *   JWT_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth, ALL_TOOLS } from './_lib/auth'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'
import { addContactToList, sendResultsEmail } from './_lib/brevo'

const ACTIVITY_LOG_TABLE   = 'tblgK9bOiRsjfzvdM'
const ACTION_TYPE_FIELD_ID = 'fld7imPa3v3yvyLJY'

const ALLOWED_ORIGINS = ['https://hub.expertauthor.community']

const EXISTING_ACTION_CHOICES = [
  { id: 'selopOD3Eq1wvZMr1', name: 'Login',                       color: 'grayLight1'   },
  { id: 'selJWSQ9tIHqmN3hc', name: 'Idea Test Completed',         color: 'blueBright'   },
  { id: 'selzketAS0dU9bBJF', name: 'Co-writing Session Created',  color: 'tealBright'   },
  { id: 'selsALzV7eEoh4iMI', name: 'Co-writing Session Attended', color: 'cyanBright'   },
  { id: 'sel7Ag7iM8PesZFHy', name: 'Writing Unblock Completed',   color: 'purpleBright' },
  { id: 'selYellowBC1',      name: 'Book Canvas Completed',       color: 'yellowBright' },
]

let actionTypePatched = false

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function getTable(): string {
  const id = process.env.AIRTABLE_ISBN_WIZARD_TABLE_ID
  if (!id) throw new Error('AIRTABLE_ISBN_WIZARD_TABLE_ID env var not set')
  return id
}

async function atGet(path: string) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${getTable()}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

async function atPost(fields: Record<string, unknown>) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${getTable()}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

async function ensureIsbnWizardActionType() {
  if (actionTypePatched) return
  try {
    await fetch(
      `https://api.airtable.com/v0/meta/bases/${process.env.AIRTABLE_BASE_ID}/tables/${ACTIVITY_LOG_TABLE}/fields/${ACTION_TYPE_FIELD_ID}`,
      {
        method: 'PATCH',
        headers: {
          Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          options: {
            choices: [
              ...EXISTING_ACTION_CHOICES,
              { name: 'ISBN Wizard Completed', color: 'orangeBright' },
            ],
          },
        }),
      }
    )
    actionTypePatched = true
    console.log('[isbn-wizard] Action Type choice ensured')
  } catch (err) {
    console.error('[isbn-wizard] ensureActionType failed:', err)
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const session = await requireAuth(req, res, ALL_TOOLS)
    if (!session) return
    const { email } = session
    const { id } = req.query

    if (id && typeof id === 'string') {
      try {
        const record = await atGet(`/${id}`)
        const recordEmail = (record.fields['Email'] as string) ?? ''
        if (recordEmail.toLowerCase() !== email.toLowerCase()) {
          return res.status(403).json({ error: 'Forbidden' })
        }
        return res.status(200).json({
          id:              record.id,
          submittedAt:     record.fields['Submitted At']      || null,
          country:         record.fields['Country']           || '',
          formats:         record.fields['Formats']           || '',
          platform:        record.fields['Platform']          || '',
          publisher:       record.fields['Publisher']         || '',
          quantity:        record.fields['Quantity']          || '',
          isbnCount:       record.fields['ISBN Count']        || 0,
          recommendedPack: record.fields['Recommended Pack']  || '',
        })
      } catch (err) {
        console.error('[isbn-wizard] GET single error:', err)
        return res.status(500).json({ error: 'Failed to load result' })
      }
    }

    try {
      const filter = encodeURIComponent(`{Email}="${email}"`)
      const data = await atGet(
        `?filterByFormula=${filter}&sort[0][field]=Submitted%20At&sort[0][direction]=desc` +
        `&fields[]=Submitted%20At&fields[]=Country&fields[]=ISBN%20Count`
      )
      const results = ((data.records || []) as Array<{ id: string; fields: Record<string, unknown> }>)
        .map(r => ({
          id:          r.id,
          submittedAt: (r.fields['Submitted At'] as string) || null,
          country:     (r.fields['Country']      as string) || '',
          isbnCount:   (r.fields['ISBN Count']   as number) || 0,
        }))
      return res.status(200).json({ results })
    } catch (err) {
      console.error('[isbn-wizard] GET list error:', err)
      return res.status(500).json({ error: 'Failed to load results' })
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const origin = (req.headers['origin'] ?? req.headers['referer'] ?? '') as string
  if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const {
    email, firstName,
    isMember, circleUserId,
    country, formats, platform, publisher, quantity,
    isbnCount, recommendedPack,
  } = req.body

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email required' })
  }

  const personId = await resolvePersonWithCircle({
    email,
    name:         firstName    || '',
    isMember:     !!isMember,
    circleUserId: circleUserId ? String(circleUserId) : undefined,
  })

  try {
    const fields: Record<string, unknown> = {
      'Email':            email,
      'First Name':       firstName        || '',
      'Is Member':        !!isMember,
      'Submitted At':     new Date().toISOString(),
      'Source Tool':      'isbn-wizard',
      'Country':          country          || '',
      'Formats':          formats          || '',
      'Platform':         platform         || '',
      'Publisher':        publisher        || '',
      'Quantity':         quantity         || '',
      'ISBN Count':       isbnCount        || 0,
      'Recommended Pack': recommendedPack  || '',
    }

    if (personId) fields['Person'] = [personId]

    const { id: resultId } = await atPost(fields)
    console.log('[isbn-wizard] written:', resultId)

    const countryNames: Record<string, string> = {
      us: 'United States', ca: 'Canada', uk: 'United Kingdom', au: 'Australia', nz: 'New Zealand',
    }

    await Promise.all([
      addContactToList({ email, firstName: firstName || '', tool: 'isbn-wizard' }),
      sendResultsEmail({
        to:   { email, name: firstName || email },
        tool: 'isbn-wizard',
        templateParams: {
          FIRSTNAME:        firstName              || '',
          COUNTRY_NAME:     countryNames[country]  || country || '',
          FORMATS:          formats                || '',
          PLATFORM:         platform               || '',
          ISBN_COUNT:       isbnCount              || 0,
          RECOMMENDED_PACK: recommendedPack        || '',
        },
      }),
    ])

    if (personId) {
      await ensureIsbnWizardActionType()
      try {
        await logActivity({
          personId,
          actionType:  'ISBN Wizard Completed',
          sourceTool:  'isbn-wizard',
          summary:     `Completed ISBN Wizard — ${isbnCount || 0} ISBN(s) needed, country: ${country || ''}`,
          referenceId: resultId,
        })
        console.log('[isbn-wizard] activity logged')
      } catch (err) {
        console.error('[isbn-wizard] logActivity failed:', err)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[isbn-wizard] handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
