/*
 * What the browser is allowed to write.
 *
 * sanitiseAgent and sanitiseWorkspace are the only path from a request body
 * to the database. The cases here are the ones an attacker or a buggy page
 * would exercise: fields that must never be settable, values out of range,
 * tool and provider names that do not exist, and a model id that would 404
 * on a schedule nobody is watching.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sanitiseAgent, sanitiseWorkspace, clampInt } from '../api/_lib/tend-validate'

test('clampInt keeps in-range integers and falls back on everything else', () => {
  assert.equal(clampInt(5, 0, 23, 21), 5)
  assert.equal(clampInt('7', 0, 23, 21), 7)
  assert.equal(clampInt(7.9, 0, 23, 21), 7, 'truncates, does not round')
  assert.equal(clampInt(24, 0, 23, 21), 21)
  assert.equal(clampInt(-1, 0, 6, 1), 1)
  assert.equal(clampInt('lunch', 0, 23, 21), 21)
  assert.equal(clampInt(null, 0, 23, 21), 21)
})

test('agent: only whitelisted fields survive', () => {
  const patch = sanitiseAgent({
    id: 'evil', last_run_at: '2020-01-01', created_at: 'x', anything: 1,
    name: '  Scout  ', role: 'Finds things', enabled: false,
  })
  assert.deepEqual(patch, { name: 'Scout', role: 'Finds things', enabled: false })
})

test('agent: text is trimmed and capped', () => {
  const patch = sanitiseAgent({ name: 'x'.repeat(500), role: 'r'.repeat(500), instructions: 'i'.repeat(30000) })
  assert.equal(patch.name?.length, 80)
  assert.equal(patch.role?.length, 200)
  assert.equal(patch.instructions?.length, 20000)
})

test('agent: unknown tools are dropped and duplicates collapse', () => {
  const patch = sanitiseAgent({ tools: ['send_email', 'ghost_tool', 'send_email', 42, null, 'fetch_webpage'] })
  assert.deepEqual(patch.tools, ['send_email', 'fetch_webpage'])
})

test('agent: bad schedule and effort are ignored, hour and day are clamped', () => {
  const patch = sanitiseAgent({ schedule: 'fortnightly', effort: 'maximum', hour_utc: 99, dow: 9 })
  assert.equal(patch.schedule, undefined)
  assert.equal(patch.effort, undefined)
  assert.equal(patch.hour_utc, 21)
  assert.equal(patch.dow, 1)

  const ok = sanitiseAgent({ schedule: 'weekly', effort: 'high', hour_utc: 3, dow: 5 })
  assert.deepEqual(ok, { schedule: 'weekly', effort: 'high', hour_utc: 3, dow: 5 })
})

test('agent: provider must exist; a Claude model off the list falls back to the default', () => {
  assert.deepEqual(sanitiseAgent({ provider: 'cursor', model: 'x' }), { model: 'x' }, 'unknown provider dropped, model kept as text')
  assert.deepEqual(
    sanitiseAgent({ provider: 'anthropic', model: 'claude-9000' }),
    { provider: 'anthropic', model: 'claude-opus-5' },
  )
  assert.deepEqual(
    sanitiseAgent({ provider: 'anthropic', model: 'claude-sonnet-5' }),
    { provider: 'anthropic', model: 'claude-sonnet-5' },
  )
})

test('agent: a free-text provider keeps whatever model id was typed', () => {
  assert.deepEqual(
    sanitiseAgent({ provider: 'openrouter', model: '  meta/llama-9  ' }),
    { provider: 'openrouter', model: 'meta/llama-9' },
  )
  assert.deepEqual(sanitiseAgent({ provider: 'openrouter', model: '   ' }), { provider: 'openrouter' }, 'blank model is not saved')
})

test('agent: non-object bodies produce an empty patch', () => {
  assert.deepEqual(sanitiseAgent(null), {})
  assert.deepEqual(sanitiseAgent('name=x'), {})
  assert.deepEqual(sanitiseAgent(undefined), {})
})

test('workspace: five text fields, trimmed, capped, nothing else', () => {
  const patch = sanitiseWorkspace({
    id: 'evil', updated_at: 'x',
    community_name: '  Guild ', operator_name: 'Ada', admin_name: 'Grace',
    about: 'a'.repeat(5000), style_notes: 's'.repeat(3000), extra: true,
  })
  assert.deepEqual(Object.keys(patch).sort(), ['about', 'admin_name', 'community_name', 'operator_name', 'style_notes'])
  assert.equal(patch.community_name, 'Guild')
  assert.equal(patch.about?.length, 4000)
  assert.equal(patch.style_notes?.length, 2000)
})

test('workspace: non-string values are ignored', () => {
  assert.deepEqual(sanitiseWorkspace({ community_name: 42, about: null }), {})
  assert.deepEqual(sanitiseWorkspace(null), {})
})
