/*
 * Book Canvas API
 *
 * POST — save a completed canvas (members + non-members)
 * GET  — retrieve canvas(es) for the logged-in member
 *   ?id=<recordId>  ->  single canvas (full answers)
 *   (no params)     ->  list of all canvases for the user (summary only)
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, JWT_SECRET
 *   CIRCLE_API_TOKEN, CIRCLE_COMMUNITY_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth, ALL_TOOLS } from './_lib/auth'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'
import { addContactToList, sendResultsEmail } from './_lib/brevo'

const BOOK_CANVAS_TABLE    = 'tblqezI9SqgelqJA5'
const ACTIVITY_LOG_TABLE   = 'tblgK9bOiRsjfzvdM'
const ACTION_TYPE_FIELD_ID = 'fld7imPa3v3yvyLJY'

const ALLOWED_ORIGINS = ['https://hub.expertauthor.community']

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

const EXISTING_ACTION_CHOICES = [
  { id: 'selopOD3Eq1wvZMr1', name: 'Login',                       color: 'grayLight1'   },
  { id: 'selJWSQ9tIHqmN3hc', name: 'Idea Test Completed',         color: 'blueBright'   },
  { id: 'selzketAS0dU9bBJF', name: 'Co-writing Session Created',  color: 'tealBright'   },
  { id: 'selsALzV7eEoh4iMI', name: 'Co-writing Session Attended', color: 'cyanBright'   },
  { id: 'sel7Ag7iM8PesZFHy', name: 'Writing Unblock Completed',   color: 'purpleBright' },
]

let actionTypePatched = false

async function atGet(path: string) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${BOOK_CANVAS_TABLE}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  const json = await res.json()
  if (!res.ok) throw json
  return json
}

async function atPost(fields: Record<string, unknown>) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${BOOK_CANVAS_TABLE}`
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

function recordToAnswers(fields: Record<string, unknown>) {
  return {
    purpose:     (fields['Purpose']        as string) || '',
    positioning: (fields['Positioning']    as string) || '',
    audience:    (fields['Audience']       as string) || '',
    problem:     (fields['Problem / Need'] as string) || '',
    marketfit:   (fields['Market Fit']     as string) || '',
    uniquevalue: (fields['Unique Value']   as string) || '',
    platform:    (fields['Platform']       as string) || '',
    objective:   (fields['Objective']      as string) || '',
    strategy:    (fields['Strategy']       as string) || '',
  }
}

async function ensureBookCanvasActionType() {
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
              { name: 'Book Canvas Completed', color: 'yellowBright' },
            ],
          },
        }),
      }
    )
    actionTypePatched = true
    console.log('[book-canvas] Action Type choice ensured')
  } catch (err) {
    console.error('[book-canvas] ensureActionType failed:', err)
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // ── GET: retrieve canvas(es) for the logged-in member ─────────────────────
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
          id:               record.id,
          submittedAt:      record.fields['Submitted At'] || null,
          pillarsCompleted: record.fields['Pillars Completed'] || 0,
          answers:          recordToAnswers(record.fields),
        })
      } catch (err) {
        console.error('[book-canvas] GET single error:', err)
        return res.status(500).json({ error: 'Failed to load canvas' })
      }
    }

    try {
      const filter = encodeURIComponent(`{Email}="${email}"`)
      const data = await atGet(
        `?filterByFormula=${filter}&sort[0][field]=Submitted%20At&sort[0][direction]=desc` +
        `&fields[]=Submitted%20At&fields[]=Pillars%20Completed&fields[]=Purpose`
      )
      const canvases = ((data.records || []) as Array<{ id: string; fields: Record<string, unknown> }>)
        .map(r => ({
          id:               r.id,
          submittedAt:      (r.fields['Submitted At'] as string) || null,
          pillarsCompleted: (r.fields['Pillars Completed'] as number) || 0,
          purpose:          (r.fields['Purpose'] as string) || '',
        }))
      return res.status(200).json({ canvases })
    } catch (err) {
      console.error('[book-canvas] GET list error:', err)
      return res.status(500).json({ error: 'Failed to load canvases' })
    }
  }

  // ── POST: save a completed canvas ─────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // 1. Origin check — block direct API hits from outside the site
  const origin = (req.headers['origin'] ?? req.headers['referer'] ?? '') as string
  if (!ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const {
    email, firstName,
    isMember, circleUserId,
    answers, platformChecked, objectiveSelected,
  } = req.body

  // 2. Email validation
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' })

  const personId = await resolvePersonWithCircle({
    email,
    name:         firstName    || '',
    isMember:     !!isMember,
    circleUserId: circleUserId ? String(circleUserId) : undefined,
  })

  try {
    const a = answers || {}

    const platformLabels: Record<string, string> = {
      email:         'Email list',
      podcast_own:   'Podcast (own)',
      podcast_guest: 'Podcast (guest)',
      speaking:      'Speaking',
      corporate:     'Corporate clients',
      association:   'Professional association',
      community:     'Online community',
      other:         'Other',
    }
    const platformCheckedMap: Record<string, boolean> = platformChecked || {}
    const platformStr = Object.entries(platformCheckedMap)
      .filter(([, checked]) => checked)
      .map(([id]) => platformLabels[id] || id)
      .join(', ')

    const pillarsCompleted = [
      'purpose', 'positioning', 'audience', 'problem',
      'marketfit', 'uniquevalue', 'platform', 'objective', 'strategy',
    ].filter(k => {
      if (k === 'platform') return Object.values(platformCheckedMap).some(Boolean)
      if (k === 'objective') return Array.isArray(objectiveSelected) && objectiveSelected.length > 0
      return a[k] && a[k] !== '?'
    }).length

    const fields: Record<string, unknown> = {
      'Email':             email,
      'First Name':        firstName         || '',
      'Is Member':         !!isMember,
      'Submitted At':      new Date().toISOString(),
      'Source Tool':       'book-canvas',
      'Pillars Completed': pillarsCompleted,
      'Purpose':           a.purpose         || '',
      'Positioning':       a.positioning     || '',
      'Audience':          a.audience        || '',
      'Problem / Need':    a.problem         || '',
      'Market Fit':        a.marketfit       || '',
      'Unique Value':      a.uniquevalue     || '',
      'Platform':          platformStr,
      'Objective':         Array.isArray(objectiveSelected) ? objectiveSelected.join(', ') : '',
      'Strategy':          a.strategy        || '',
    }

    if (personId) fields['Person'] = [personId]

    const { id: resultId } = await atPost(fields)
    console.log('[book-canvas] written:', resultId)

    const objectiveStr = Array.isArray(objectiveSelected) ? objectiveSelected.join(', ') : ''
    const unansweredPillars = [
      { key: 'purpose',     name: 'Purpose',        answered: !!a.purpose        },
      { key: 'positioning', name: 'Positioning',    answered: !!a.positioning    },
      { key: 'audience',    name: 'Audience',       answered: !!a.audience       },
      { key: 'problem',     name: 'Problem / Need', answered: !!a.problem        },
      { key: 'marketfit',   name: 'Market Fit',     answered: !!a.marketfit      },
      { key: 'uniquevalue', name: 'Unique Value',   answered: !!a.uniquevalue    },
      { key: 'platform',    name: 'Platform',       answered: !!platformStr      },
      { key: 'objective',   name: 'Objective',      answered: !!objectiveStr     },
      { key: 'strategy',    name: 'Strategy',       answered: !!a.strategy       },
    ].filter(p => !p.answered).map(p => p.name)

    await Promise.all([
      addContactToList({ email, firstName: firstName || '', tool: 'book-canvas' }),
      sendResultsEmail({
        to:   { email, name: firstName || email },
        tool: 'book-canvas',
        templateParams: {
          FIRSTNAME:          firstName    || '',
          PILLARS_COMPLETED:  pillarsCompleted,
          PILLARS_REMAINING:  9 - pillarsCompleted,
          UNANSWERED_PILLARS: unansweredPillars.join(' · '),
          PURPOSE:            a.purpose     || '',
          POSITIONING:        a.positioning || '',
          AUDIENCE:           a.audience    || '',
          PROBLEM:            a.problem     || '',
          MARKETFIT:          a.marketfit   || '',
          UNIQUEVALUE:        a.uniquevalue || '',
          PLATFORM:           platformStr   || '',
          OBJECTIVE:          objectiveStr  || '',
          STRATEGY:           a.strategy    || '',
        },
      }),
    ])

    if (personId) {
      await ensureBookCanvasActionType()
      try {
        await logActivity({
          personId,
          actionType:  'Book Canvas Completed',
          sourceTool:  'book-canvas',
          summary:     `Completed Book Screening Canvas — ${pillarsCompleted}/9 pillars filled`,
          referenceId: resultId,
        })
        console.log('[activity] logged')
      } catch (err) {
        console.error('[activity] failed:', err)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[book-canvas] handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
