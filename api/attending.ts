/*
 * Attending API — LinkedIn "I'm attending" badge for EAC events
 *
 * POST — save a generated badge, optionally publish it to the member's own
 *        LinkedIn feed as a native image post
 * GET  — retrieve share(s) for the logged-in EAC member
 *   ?id=<recordId>  →  single record
 *   (no params)     →  list of all shares for the session user
 *
 * Identity here comes from the LinkedIn cookie (eac_li), not eac_session —
 * the whole point of the tool is the LinkedIn profile photo. The EAC session
 * is read opportunistically to flag members and link the People record.
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_ATTENDING_TABLE_ID
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, JWT_SECRET
 * Optional:
 *   LINKEDIN_ENABLE_POSTING, BREVO_ATTENDING_LIST_ID, BREVO_ATTENDING_TEMPLATE_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth, getSession, ALL_TOOLS } from './_lib/auth'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'
import { addContactToList, sendResultsEmail } from './_lib/brevo'
import {
  LI_COOKIE, parseCookie, publishImagePost, verifyLinkedInToken,
} from './_lib/linkedin'

const ACTIVITY_LOG_TABLE   = 'tblgK9bOiRsjfzvdM'
const ACTION_TYPE_FIELD_ID = 'fld7imPa3v3yvyLJY'
const ACTION_TYPE          = 'Open House Share Created'

const ALLOWED_ORIGINS = ['https://hub.expertauthor.community']

const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_COMMENTARY  = 2800   // LinkedIn's own limit is 3000

const EXISTING_ACTION_CHOICES = [
  { id: 'selopOD3Eq1wvZMr1', name: 'Login',                       color: 'grayLight1'   },
  { id: 'selJWSQ9tIHqmN3hc', name: 'Idea Test Completed',         color: 'blueBright'   },
  { id: 'selzketAS0dU9bBJF', name: 'Co-writing Session Created',  color: 'tealBright'   },
  { id: 'selsALzV7eEoh4iMI', name: 'Co-writing Session Attended', color: 'cyanBright'   },
  { id: 'sel7Ag7iM8PesZFHy', name: 'Writing Unblock Completed',   color: 'purpleBright' },
  { id: 'selYellowBC1',      name: 'Book Canvas Completed',       color: 'yellowBright' },
  { id: 'selOrangeIW1',      name: 'ISBN Wizard Completed',       color: 'orangeBright' },
]

let actionTypePatched = false

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function getTable(): string {
  const id = process.env.AIRTABLE_ATTENDING_TABLE_ID
  if (!id) throw new Error('AIRTABLE_ATTENDING_TABLE_ID env var not set')
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

/**
 * Try to add our Action Type choice to the shared Activity Log.
 *
 * This needs `schema.bases:write` on AIRTABLE_API_KEY, which the current token
 * does not have — it returns 403 and logActivity then fails with
 * INVALID_MULTIPLE_CHOICE_OPTIONS. Add the choice by hand in Airtable (or widen
 * the token) and this becomes a no-op.
 *
 * The earlier version of this function never checked the response and logged
 * success either way, which is how the missing choice went unnoticed.
 */
async function ensureAttendingActionType() {
  if (actionTypePatched) return
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/meta/bases/${process.env.AIRTABLE_BASE_ID}/tables/${ACTIVITY_LOG_TABLE}/fields/${ACTION_TYPE_FIELD_ID}`,
      {
        method: 'PATCH',
        headers: {
          Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          options: {
            choices: [...EXISTING_ACTION_CHOICES, { name: ACTION_TYPE, color: 'pinkBright' }],
          },
        }),
      }
    )
    if (res.ok) {
      actionTypePatched = true
      console.log('[attending] Action Type choice ensured')
      return
    }
    const body = (await res.text()).slice(0, 200)
    console.error(
      `[attending] could not add the "${ACTION_TYPE}" Action Type choice (${res.status}). ` +
      `Add it manually in Airtable, or grant schema.bases:write to AIRTABLE_API_KEY. ${body}`
    )
  } catch (err) {
    console.error('[attending] ensureActionType failed:', err)
  }
}

/** Strip the data: prefix and decode. Returns null if it is not a JPEG/PNG. */
function decodeImage(dataUrl: string): Buffer | null {
  const match = /^data:image\/(jpeg|jpg|png);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  const buf = Buffer.from(match[2], 'base64')
  if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) return null
  return buf
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
          id:          record.id,
          submittedAt: record.fields['Submitted At'] || null,
          eventName:   record.fields['Event Name']   || '',
          role:        record.fields['Role Line']    || '',
          posted:      !!record.fields['Posted'],
          postUrl:     record.fields['Post URL']     || '',
        })
      } catch (err) {
        console.error('[attending] GET single error:', err)
        return res.status(500).json({ error: 'Failed to load result' })
      }
    }

    try {
      const filter = encodeURIComponent(`{Email}="${email}"`)
      const data = await atGet(
        `?filterByFormula=${filter}&sort[0][field]=Submitted%20At&sort[0][direction]=desc` +
        `&fields[]=Submitted%20At&fields[]=Event%20Name&fields[]=Posted&fields[]=Post%20URL`
      )
      const results = ((data.records || []) as Array<{ id: string; fields: Record<string, unknown> }>)
        .map(r => ({
          id:          r.id,
          submittedAt: (r.fields['Submitted At'] as string)  || null,
          eventName:   (r.fields['Event Name']   as string)  || '',
          posted:      !!r.fields['Posted'],
          postUrl:     (r.fields['Post URL']     as string)  || '',
        }))
      return res.status(200).json({ results })
    } catch (err) {
      console.error('[attending] GET list error:', err)
      return res.status(500).json({ error: 'Failed to load results' })
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const origin = (req.headers['origin'] ?? req.headers['referer'] ?? '') as string
  if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  // Identity is the LinkedIn connection — no cookie, no badge.
  const li = await verifyLinkedInToken(parseCookie(req.headers.cookie ?? '', LI_COOKIE))
  if (!li) {
    return res.status(401).json({ error: 'Your LinkedIn connection expired. Please connect again.' })
  }

  const { imageBase64, commentary, roleLine, eventName, post } = req.body as {
    imageBase64?: string
    commentary?:  string
    roleLine?:    string
    eventName?:   string
    post?:        boolean
  }

  const email = li.email
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'LinkedIn did not return a usable email address' })
  }

  const firstName = (li.name || '').trim().split(/\s+/)[0] || ''

  // An EAC session is a bonus, not a requirement — non-members can share too.
  const eac      = await getSession(req)
  const isMember = !!eac

  const personId = await resolvePersonWithCircle({
    email,
    name:         li.name || '',
    isMember,
    circleUserId: eac?.circleUserId ? String(eac.circleUserId) : undefined,
  })

  // ── Publish to LinkedIn (optional, best-effort but surfaced to the user) ──
  let posted   = false
  let postUrl  = ''
  let postError = ''

  if (post) {
    if (!li.canPost) {
      postError = 'Posting is not enabled on this LinkedIn connection'
    } else {
      const bytes = imageBase64 ? decodeImage(imageBase64) : null
      if (!bytes) {
        postError = 'The badge image was missing or too large'
      } else {
        try {
          const text = (commentary || '').slice(0, MAX_COMMENTARY)
          const urn  = await publishImagePost({
            accessToken: li.accessToken,
            sub:         li.sub,
            imageBytes:  bytes,
            commentary:  text,
            altText:     `${li.name} is attending ${eventName || 'the EAC open house'}`,
          })
          posted  = true
          postUrl = urn ? `https://www.linkedin.com/feed/update/${urn}/` : ''
        } catch (err) {
          postError = err instanceof Error ? err.message : 'LinkedIn rejected the post'
          console.error('[attending] publish failed:', err)
        }
      }
    }
  }

  // ── Record it ─────────────────────────────────────────────────────────────
  try {
    const fields: Record<string, unknown> = {
      'Email':          email,
      'First Name':     firstName,
      'Full Name':      li.name       || '',
      'Is Member':      isMember,
      'Submitted At':   new Date().toISOString(),
      'Source Tool':    'attending',
      'Event Name':     eventName     || '',
      'Role Line':      roleLine      || '',
      'LinkedIn ID':    li.sub,
      'Posted':         posted,
      'Post URL':       postUrl,
    }
    if (personId) fields['Person'] = [personId]

    const { id: resultId } = await atPost(fields)
    console.log('[attending] written:', resultId, 'posted:', posted)

    await Promise.all([
      addContactToList({ email, firstName, tool: 'attending' }),
      sendResultsEmail({
        to:   { email, name: firstName || email },
        tool: 'attending',
        templateParams: {
          FIRSTNAME:  firstName,
          EVENT_NAME: eventName || '',
          POST_URL:   postUrl,
          POSTED:     posted,
        },
      }),
    ])

    if (personId) {
      await ensureAttendingActionType()
      try {
        await logActivity({
          personId,
          actionType:  ACTION_TYPE,
          sourceTool:  'attending',
          summary:     posted
            ? `Posted an "I'm attending" badge to LinkedIn — ${eventName || 'open house'}`
            : `Created an "I'm attending" badge — ${eventName || 'open house'}`,
          referenceId: resultId,
        })
      } catch (err) {
        console.error('[attending] logActivity failed:', err)
      }
    }

    return res.status(200).json({ ok: true, id: resultId, posted, postUrl, postError })
  } catch (err) {
    console.error('[attending] handler error:', err)
    // The post may already be live — tell the truth rather than implying failure.
    if (posted) {
      return res.status(200).json({ ok: true, posted, postUrl, postError: '', saveFailed: true })
    }
    return res.status(500).json({ error: 'Internal error' })
  }
}
