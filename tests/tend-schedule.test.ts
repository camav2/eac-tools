/*
 * When a teammate wakes up.
 *
 * The scheduler is the one part of Tend nobody watches. A wrong comparison
 * here does not throw, it just means an agent silently never runs, or runs
 * every single tick and bills for it. Both are invisible until someone reads
 * the log, so the boundaries are pinned here instead.
 *
 * The 55-minute hourly window is the case most likely to be "tidied" into a
 * clean 60 by someone who has not noticed that an hourly cron never fires at
 * the same offset twice — at exactly 60, every second tick is skipped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isDue, resolveAdminEmail } from '../api/tend-cron'
import type { TendAgent } from '../api/_lib/tend-db'

function agent(over: Partial<TendAgent> = {}): TendAgent {
  return {
    id: 'a1',
    name: 'Test',
    role: '',
    instructions: '',
    tools: [],
    approval_required: true,
    effort: 'medium',
    provider: 'anthropic',
    model: 'claude-opus-5',
    schedule: 'daily',
    hour_utc: 21,
    dow: 1,
    enabled: true,
    last_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const minutesAgo = (now: Date, mins: number) =>
  new Date(now.getTime() - mins * 60_000).toISOString()

test('paused and manual agents never run on a schedule', () => {
  const now = new Date('2026-09-14T21:00:00Z')
  assert.equal(isDue(agent({ enabled: false }), now), false)
  assert.equal(isDue(agent({ schedule: 'manual' }), now), false)
  // Manual beats enabled: pressing go is the only trigger.
  assert.equal(isDue(agent({ schedule: 'manual', enabled: true }), now), false)
})

test('hourly tolerates cron drift but not a double fire', () => {
  const now = new Date('2026-09-14T13:07:00Z')
  const hourly = (last: string | null) => isDue(agent({ schedule: 'hourly', last_run_at: last }), now)

  assert.equal(hourly(null), true, 'never run yet')
  assert.equal(hourly(minutesAgo(now, 5)), false, 'just ran')
  assert.equal(hourly(minutesAgo(now, 54)), false, 'inside the window')
  assert.equal(hourly(minutesAgo(now, 56)), true, 'drifted tick still counts')
})

test('daily fires once, in its hour', () => {
  const daily = (now: Date, last: string | null) =>
    isDue(agent({ schedule: 'daily', hour_utc: 21, last_run_at: last }), now)

  const inHour  = new Date('2026-09-14T21:30:00Z')
  const offHour = new Date('2026-09-14T20:30:00Z')

  assert.equal(daily(inHour, null), true)
  assert.equal(daily(offHour, null), false, 'wrong hour')
  // Already ran this morning: an hour is 60 ticks, and only one may win.
  assert.equal(daily(inHour, minutesAgo(inHour, 20)), false)
  assert.equal(daily(inHour, minutesAgo(inHour, 24 * 60)), true, 'a day later')
})

test('scheduled runs act as the connected admin, and never refuse to start', () => {
  assert.deepEqual(resolveAdminEmail(undefined, ['cam@x.com']), { adminEmail: 'cam@x.com' })

  // The env var wins when set, even over a connected admin.
  assert.deepEqual(resolveAdminEmail('kelly@x.com', ['cam@x.com']), { adminEmail: 'kelly@x.com' })

  // Several connected: first (most recent) is used, and it says so.
  const many = resolveAdminEmail(undefined, ['cam@x.com', 'kelly@x.com'])
  assert.equal(many.adminEmail, 'cam@x.com')
  assert.match(many.note ?? '', /2 admins/)

  // None connected: still runs, with a note. A read-only teammate needs no mailbox.
  const none = resolveAdminEmail(undefined, [])
  assert.equal(none.adminEmail, '')
  assert.match(none.note ?? '', /no connected mailbox/)

  // An empty override is the same as no override.
  assert.deepEqual(resolveAdminEmail('', ['cam@x.com']), { adminEmail: 'cam@x.com' })
})

test('weekly needs the right day and the right hour', () => {
  // 2026-09-14 is a Monday.
  const monday   = new Date('2026-09-14T21:30:00Z')
  const tuesday  = new Date('2026-09-15T21:30:00Z')
  const weekly = (now: Date, last: string | null) =>
    isDue(agent({ schedule: 'weekly', dow: 1, hour_utc: 21, last_run_at: last }), now)

  assert.equal(weekly(monday, null), true)
  assert.equal(weekly(tuesday, null), false, 'wrong day')
  assert.equal(weekly(new Date('2026-09-14T09:30:00Z'), null), false, 'wrong hour')
  assert.equal(weekly(monday, minutesAgo(monday, 2 * 24 * 60)), false, 'ran two days ago')
  assert.equal(weekly(monday, minutesAgo(monday, 7 * 24 * 60)), true, 'a week later')
})
