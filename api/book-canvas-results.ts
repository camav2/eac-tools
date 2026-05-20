/*
 * Book Canvas Results API
 *
 * Write order (each step fails independently):
 *   1. Circle: fetch access group for members
 *   2. People: upsert record
 *   3. Book Canvas Results: always written, linked to person if step 2 succeeded
 *   4. Activity Log: written only if step 2 succeeded
 *
 * Env vars required:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID
 *   CIRCLE_API_TOKEN, CIRCLE_COMMUNITY_ID
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolvePersonWithCircle, logActivity } from './_lib/airtable'
import { addContactToList, sendResultsEmail } from './_lib/brevo'

const BOOK_CANVAS_TABLE    = 'tblqezI9SqgelqJA5'
const ACTIVITY_LOG_TABLE   = 'tblgK9bOiRsjfzvdM'
const ACTION_TYPE_FIELD_ID = 'fld7imPa3v3yvyLJY'

const EXISTING_ACTION_CHOICES = [
  { id: 'selopOD3Eq1wvZMr1', name: 'Login',                       color: 'grayLight1'   },
  { id: 'selJWSQ9tIHqmN3hc', name: 'Idea Test Completed',         color: 'blueBright'   },
  { id: 'selzketAS0dU9bBJF', name: 'Co-writing Session Created',  color: 'tealBright'   },
  { id: 'selsALzV7eEoh4iMI', name: 'Co-writing Session Attended', color: 'cyanBright'   },
  { id: 'sel7Ag7iM8PesZFHy', name: 'Writing Unblock Completed',   color: 'purpleBright' },
]

let actionTypePatched = false

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
    console.log('[book-canvas-results] Action Type choice ensured')
  } catch (err) {
    console.error('[book-canvas-results] ensureActionType failed:', err)
  }
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    email, firstName,
    isMember, circleUserId,
    answers, platformChecked, objectiveSelected,
  } = req.body

  if (!email) return res.status(400).json({ error: 'Email required' })

  // ── Steps 1+2: Circle access group + People upsert (best-effort) ──────────
  const personId = await resolvePersonWithCircle({
    email,
    name:         firstName    || '',
    isMember:     !!isMember,
    circleUserId: circleUserId ? String(circleUserId) : undefined,
  })

  // ── Step 3: Write Book Canvas Results (always) ───────────────────────────
  try {
    const a = answers || {}

    // Summarise platform checkboxes as a readable string
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

    // Count non-empty pillar answers
    const pillarsCompleted = [
      'purpose', 'positioning', 'audience', 'problem',
      'marketfit', 'uniquevalue', 'platform', 'objective', 'strategy',
    ].filter(k => {
      if (k === 'platform') return Object.values(platformCheckedMap).some(Boolean)
      if (k === 'objective') return Array.isArray(objectiveSelected) && objectiveSelected.length > 0
      return a[k] && a[k] !== '?'
    }).length

    const fields: Record<string, unknown> = {
      'Email':            email,
      'First Name':       firstName         || '',
      'Is Member':        !!isMember,
      'Submitted At':     new Date().toISOString(),
      'Source Tool':      'book-canvas',
      'Pillars Completed': pillarsCompleted,
      'Purpose':          a.purpose         || '',
      'Positioning':      a.positioning     || '',
      'Audience':         a.audience        || '',
      'Problem / Need':   a.problem         || '',
      'Market Fit':       a.marketfit       || '',
      'Unique Value':     a.uniquevalue     || '',
      'Platform':         platformStr,
      'Objective':        Array.isArray(objectiveSelected) ? objectiveSelected.join(', ') : '',
      'Strategy':         a.strategy        || '',
    }

    if (personId) fields['Person'] = [personId]

    const { id: resultId } = await atPost(fields)
    console.log('[book-canvas-results] written:', resultId)

    // ── Step 4: Brevo — add to list + send results email (best-effort) ───
    await Promise.all([
      addContactToList({ email, firstName: firstName || '', tool: 'book-canvas' }),
      sendResultsEmail({
        to:   { email, name: firstName || email },
        tool: 'book-canvas',
        templateParams: {
          FIRSTNAME:        firstName || '',
          PILLARS_COMPLETED: pillarsCompleted,
          PURPOSE:          a.purpose      || '—',
          POSITIONING:      a.positioning  || '—',
          AUDIENCE:         a.audience     || '—',
          PROBLEM:          a.problem      || '—',
          MARKETFIT:        a.marketfit    || '—',
          UNIQUEVALUE:      a.uniquevalue  || '—',
          PLATFORM:         platformStr    || '—',
          OBJECTIVE:        Array.isArray(objectiveSelected) ? objectiveSelected.join(', ') : '—',
          STRATEGY:         a.strategy     || '—',
        },
      }),
    ])

    // ── Step 5: Activity Log ─────────────────────────────────────────────
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
    console.error('[book-canvas-results] handler error:', err)
    return res.status(500).json({ error: 'Internal error' })
  }
}
