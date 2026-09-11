/*
 * The worker tick.
 *
 * The worker is the new critical path: if it claims a run and then drops it,
 * that run sits "running" with nobody on it until the stale sweep, and the
 * teammate is blocked for fifteen minutes. So every exit from processOne is
 * pinned — idle, a fresh run, a handed-over decision, a deleted teammate, a
 * thrown error — and each one is checked to leave the run in a state the
 * dashboard can explain.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { processOne, type LoopDeps } from '../worker/loop'
import type { TendAgent, TendRun, TendWorkspace } from '../api/_lib/tend-db'

const WS: TendWorkspace = {
  id: 'default', community_name: 'Guild', operator_name: 'Ada', admin_name: 'Grace',
  about: '', style_notes: '', updated_at: '',
}

function agent(over: Partial<TendAgent> = {}): TendAgent {
  return {
    id: 'a1', name: 'Scout', role: '', instructions: '', tools: [], approval_required: true,
    effort: 'low', provider: 'anthropic', model: 'claude-opus-5',
    schedule: 'manual', hour_utc: 21, dow: 1, enabled: true, last_run_at: null, created_at: '',
    ...over,
  }
}

function run(over: Partial<TendRun> = {}): TendRun {
  return {
    id: 'r1', agent_id: 'a1', agent_name: 'Scout', status: 'running', trigger: 'manual',
    provider: 'anthropic', model: 'claude-opus-5', prompt: null, summary: null, error: null,
    messages: [], log: [], pending: null, input_tokens: 0, output_tokens: 0,
    claimed_by: 'mac-mini', pending_decision: null,
    started_at: '', updated_at: '', finished_at: null,
    ...over,
  }
}

/** Fakes that record what the tick did. */
function harness(opts: {
  claim?: { run: TendRun; decision: 'approve' | 'reject' | null } | null
  agent?: TendAgent | null
  driveResult?: Partial<TendRun>
  driveThrows?: string
} = {}) {
  const calls: string[] = []
  const patches: { id: string; patch: Partial<TendRun> }[] = []
  const logs: string[] = []
  const deps: LoopDeps = {
    claimNextRun: async id => { calls.push(`claim:${id}`); return opts.claim ?? null },
    getAgent:     async id => { calls.push(`agent:${id}`); return opts.agent === undefined ? agent() : opts.agent },
    getWorkspace: async () => WS,
    adminEmail:   async () => 'grace@example.com',
    drive: async (r, _a, ctx) => {
      calls.push(`drive:${r.id}:${ctx.adminEmail}`)
      if (opts.driveThrows) throw new Error(opts.driveThrows)
      return { ...r, status: 'completed', summary: 'ok', ...opts.driveResult } as TendRun
    },
    resolveApproval: async (r, _a, approved) => {
      calls.push(`resolve:${r.id}:${approved}`)
      return { ...r, status: 'completed', summary: 'resumed' } as TendRun
    },
    updateRun: async (id, patch) => { patches.push({ id, patch }) },
    log: m => logs.push(m),
  }
  return { deps, calls, patches, logs }
}

test('an empty queue is idle and touches nothing', async () => {
  const h = harness()
  assert.equal(await processOne('mac-mini', h.deps), 'idle')
  assert.deepEqual(h.calls, ['claim:mac-mini'])
  assert.equal(h.patches.length, 0)
})

test('a fresh run is driven as the connected admin with the workspace loaded', async () => {
  const h = harness({ claim: { run: run(), decision: null } })
  assert.equal(await processOne('mac-mini', h.deps), 'done')
  assert.deepEqual(h.calls, ['claim:mac-mini', 'agent:a1', 'drive:r1:grace@example.com'])
  assert.ok(h.logs.some(l => l.includes('starting')))
  assert.ok(h.logs.some(l => l.includes('→ completed')))
})

test('a handed-over decision resumes the run instead of restarting it', async () => {
  const h = harness({ claim: { run: run({ pending: { blocks: [] } as any }), decision: 'reject' } })
  assert.equal(await processOne('mac-mini', h.deps), 'done')
  assert.ok(h.calls.includes('resolve:r1:false'), 'reject → approved=false')
  assert.ok(!h.calls.some(c => c.startsWith('drive:')), 'drive is not called directly')
  assert.ok(h.logs.some(l => l.includes('resuming (reject)')))
})

test('a run whose teammate was deleted is failed with a plain reason, not left running', async () => {
  const h = harness({ claim: { run: run(), decision: null }, agent: null })
  assert.equal(await processOne('mac-mini', h.deps), 'failed')
  assert.equal(h.patches.length, 1)
  assert.equal(h.patches[0].patch.status, 'failed')
  assert.match(h.patches[0].patch.error ?? '', /no longer exists/)
  assert.ok(h.patches[0].patch.finished_at)
})

test('a run the runner reports as failed counts as failed, without a second write', async () => {
  const h = harness({ claim: { run: run(), decision: null }, driveResult: { status: 'failed', error: 'model down' } })
  assert.equal(await processOne('mac-mini', h.deps), 'failed')
  // drive() persisted its own failure; the loop must not overwrite it.
  assert.equal(h.patches.length, 0)
})

test('an exception outside the runner still fails the run so it cannot be orphaned', async () => {
  const h = harness({ claim: { run: run(), decision: null }, driveThrows: 'supabase exploded' })
  assert.equal(await processOne('mac-mini', h.deps), 'failed')
  assert.equal(h.patches[0].patch.status, 'failed')
  assert.match(h.patches[0].patch.error ?? '', /supabase exploded/)
  assert.ok(h.logs.some(l => l.includes('failed: supabase exploded')))
})
