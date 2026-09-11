/*
 * The agent loop, turn by turn.
 *
 * Everything that can go wrong in Tend goes wrong here: a write that slips
 * past the gate, a held turn that resumes half-answered, a step budget that
 * resets on resume, a model reply that is silently lost. None of it needs a
 * network to reproduce, so the model is a scripted adapter, the database is
 * an array of patches, and the tools are stubs that record whether they ran.
 *
 * The gate tests are the ones that matter. "Approval required" is the only
 * thing between a research assistant and something that emails members at
 * 3am, and it has to hold for the whole turn, not just the write.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  drive,
  resolveApproval,
  systemPrompt,
  kickoffMessages,
  MAX_STEPS,
  type RunnerDeps,
} from '../api/_lib/tend-runner'
import type { TendAgent, TendRun, TendWorkspace } from '../api/_lib/tend-db'
import type { ModelTurn, CallOptions, ProviderAdapter } from '../api/_lib/tend-providers'
import type { TendTool } from '../api/_lib/tend-tools'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WS: TendWorkspace = {
  id: 'default',
  community_name: 'the Quilters Guild',
  operator_name:  'Ada',
  admin_name:     'Grace',
  about:          'A paid community for quilters.',
  style_notes:    'Never use exclamation marks.',
  updated_at:     '',
}

function agent(over: Partial<TendAgent> = {}): TendAgent {
  return {
    id: 'a1', name: 'Scout', role: 'Finds things', instructions: 'Look around.',
    tools: ['read_thing', 'write_thing'], approval_required: true, effort: 'low',
    provider: 'anthropic', model: 'claude-opus-5',
    schedule: 'manual', hour_utc: 21, dow: 1, enabled: true,
    last_run_at: null, created_at: '',
    ...over,
  }
}

function run(over: Partial<TendRun> = {}): TendRun {
  return {
    id: 'r1', agent_id: 'a1', agent_name: 'Scout', status: 'running', trigger: 'manual',
    provider: 'anthropic', model: 'claude-opus-5',
    summary: null, error: null,
    messages: [{ role: 'user', content: 'go' }], log: [], pending: null,
    input_tokens: 0, output_tokens: 0, started_at: '', finished_at: null,
    ...over,
  }
}

/** A model turn. Tool calls are given as [id, name, input]. */
function turn(calls: [string, string, any][] = [], text = ''): ModelTurn {
  return {
    assistantMessages: [{ role: 'assistant', content: `turn:${text}:${calls.map(c => c[1]).join(',')}` }],
    text,
    toolCalls: calls.map(([id, name, input]) => ({ id, name, input })),
    usage: { input: 10, output: 5 },
  }
}

const finish = (summary: string, details = '') => turn([['f', 'finish', { summary, details }]])

/** Scripted model plus stubs that record what happened. */
function harness(turns: ModelTurn[], opts: { failTool?: string } = {}) {
  const calls: CallOptions[] = []
  const patches: Partial<TendRun>[] = []
  const ran: string[] = []

  const adapter: ProviderAdapter = {
    async call(o) {
      calls.push(o)
      const t = turns.shift()
      if (!t) throw new Error('scripted model has no more turns')
      return t
    },
    toolResultMessages(results) {
      return [{ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) }]
    },
    initialMessages(text) { return [{ role: 'user', content: text }] },
  }

  const tools: Record<string, TendTool> = {
    read_thing:  { name: 'read_thing',  label: '', write: false, description: '', input_schema: {}, async run(i) { ran.push('read_thing');  return { got: i } } },
    write_thing: { name: 'write_thing', label: '', write: true,  description: '', input_schema: {}, async run(i) { ran.push('write_thing'); if (opts.failTool === 'write_thing') throw new Error('smtp down'); return { wrote: i } } },
  }

  const deps: RunnerDeps = {
    adapter,
    persist: async (_id, patch) => { patches.push(patch) },
    tool: name => tools[name],
    toolDefs: names => names.filter(n => tools[n]).map(n => ({ name: n, description: '', input_schema: {} })),
  }

  const last = () => patches[patches.length - 1]
  return { deps, calls, patches, ran, last }
}

const ctx = { adminEmail: 'grace@example.com', workspace: WS }

// ── Prompt and kickoff ────────────────────────────────────────────────────────

test('system prompt is built from the workspace, not from literals', () => {
  const p = systemPrompt(agent(), WS)
  for (const fact of ['Scout', 'the Quilters Guild', 'Ada', 'Grace', 'A paid community for quilters.', 'Never use exclamation marks.', 'Look around.']) {
    assert.ok(p.includes(fact), `prompt should mention ${fact}`)
  }
  // The proof that EAC is data: a different community leaves no trace of it.
  assert.ok(!/EAC|Expert Author|Kelly|Cameron/.test(p), 'no EAC literal in a non-EAC prompt')
  assert.ok(p.includes(String(MAX_STEPS)), 'step budget is stated to the model')
})

test('system prompt survives an empty workspace with sane fallbacks', () => {
  const p = systemPrompt(agent({ role: '', instructions: '' }), { ...WS, community_name: '', operator_name: '', admin_name: '', about: '', style_notes: '' })
  assert.ok(p.includes('this community'))
  assert.ok(p.includes('the operator'))
  assert.ok(!p.includes('ABOUT THIS COMMUNITY'), 'empty about is omitted, not printed blank')
})

test('kickoff message names the date and demands finish', () => {
  const h = harness([])
  const msgs = kickoffMessages('anthropic', new Date('2026-09-14T03:00:00Z'), h.deps.adapter)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'user')
  assert.ok(msgs[0].content.includes('2026-09-14'))
  assert.ok(msgs[0].content.includes('call finish'))
})

// ── Ending a run ──────────────────────────────────────────────────────────────

test('finish completes the run with summary and details logged', async () => {
  const h = harness([finish('All quiet.', '# Report\nNothing.')])
  const out = await drive(run(), agent(), ctx, h.deps)

  assert.equal(out.status, 'completed')
  assert.equal(out.summary, 'All quiet.')
  assert.equal(h.last().status, 'completed')
  assert.ok(h.last().finished_at, 'finished_at stamped')
  const fin = out.log.find(e => e.tool === 'finish')
  assert.equal(fin?.result, '# Report\nNothing.')
  assert.deepEqual(h.ran, [], 'finish runs no tool')
})

test('a prose reply with no tool call is kept as the summary, not lost', async () => {
  const h = harness([turn([], 'Nothing new this week.')])
  const out = await drive(run(), agent(), ctx, h.deps)
  assert.equal(out.status, 'completed')
  assert.equal(out.summary, 'Nothing new this week.')
})

test('the model call carries the system prompt, the agent effort and the finish tool', async () => {
  const h = harness([finish('ok')])
  await drive(run(), agent({ effort: 'high' }), ctx, h.deps)
  const call = h.calls[0]
  assert.equal(call.effort, 'high')
  assert.equal(call.model, 'claude-opus-5')
  assert.ok(call.system.includes('the Quilters Guild'))
  assert.ok(call.tools.some(t => t.name === 'finish'))
  assert.ok(call.tools.some(t => t.name === 'read_thing'))
})

// ── Tools ─────────────────────────────────────────────────────────────────────

test('a read tool runs unattended and its result is fed back verbatim', async () => {
  const h = harness([turn([['c1', 'read_thing', { q: 1 }]]), finish('done')])
  const out = await drive(run(), agent(), ctx, h.deps)

  assert.equal(out.status, 'completed')
  assert.deepEqual(h.ran, ['read_thing'])
  // The second call saw the tool result in the transcript.
  const second = h.calls[1].messages
  const resultMsg = second[second.length - 1]
  assert.equal(resultMsg.role, 'user')
  assert.equal(resultMsg.content[0].tool_use_id, 'c1')
  assert.equal(resultMsg.content[0].content, '{"got":{"q":1}}')
  assert.equal(out.log[0].tool, 'read_thing')
})

test('assistant turns are appended exactly as the adapter returned them', async () => {
  const t = turn([['c1', 'read_thing', {}]])
  t.assistantMessages = [{ role: 'assistant', content: [{ type: 'thinking', signature: 'sig-XYZ' }, { type: 'tool_use', id: 'c1', name: 'read_thing', input: {} }] }]
  const h = harness([t, finish('ok')])
  await drive(run(), agent(), ctx, h.deps)
  const replayed = h.calls[1].messages[1]
  assert.deepEqual(replayed, t.assistantMessages[0], 'signed block replayed untouched')
})

test('an unknown tool and a tool that throws both become error results, not crashes', async () => {
  const h = harness([
    turn([['c1', 'no_such_tool', {}]]),
    turn([['c2', 'write_thing', {}]]),
    finish('gave up'),
  ], { failTool: 'write_thing' })
  const out = await drive(run(), agent({ approval_required: false }), ctx, h.deps)

  assert.equal(out.status, 'completed')
  assert.match(out.log[0].error ?? '', /No such tool/)
  assert.match(out.log[1].error ?? '', /smtp down/)
  const fedBack = h.calls[1].messages.at(-1).content[0]
  assert.equal(fedBack.is_error, true)
  assert.match(fedBack.content, /^Error:/)
})

test('a call with a JSON parse error is refused back to the model and never executed', async () => {
  const t = turn([['c1', 'read_thing', {}]])
  t.toolCalls[0].parseError = 'Unexpected token'
  const h = harness([t, finish('retry worked')])
  await drive(run(), agent(), ctx, h.deps)
  assert.deepEqual(h.ran, [], 'tool must not run on broken arguments')
  assert.match(h.calls[1].messages.at(-1).content[0].content, /not valid JSON/)
})

// ── The approval gate ─────────────────────────────────────────────────────────

test('a gated write holds the WHOLE turn: the read beside it does not run either', async () => {
  const h = harness([turn([['c1', 'read_thing', {}], ['c2', 'write_thing', { to: 'x' }]])])
  const out = await drive(run(), agent(), ctx, h.deps)

  assert.equal(out.status, 'awaiting_approval')
  assert.deepEqual(h.ran, [], 'nothing executes while held')
  const blocks = (out.pending as any).blocks
  assert.deepEqual(blocks.map((b: any) => [b.name, b.write]), [['read_thing', false], ['write_thing', true]])
  assert.equal(h.last().status, 'awaiting_approval')
  assert.equal(h.calls.length, 1, 'model not called again while held')
})

test('approve runs every held call, then the loop continues to finish', async () => {
  const held = harness([turn([['c1', 'read_thing', {}], ['c2', 'write_thing', { to: 'x' }]])])
  const paused = await drive(run(), agent(), ctx, held.deps)

  const h = harness([finish('sent')])
  const out = await resolveApproval(paused, agent(), true, ctx, h.deps)

  assert.equal(out.status, 'completed')
  assert.deepEqual(h.ran, ['read_thing', 'write_thing'])
  const decisions = out.log.map(e => [e.tool, e.decision])
  assert.deepEqual(decisions, [['read_thing', undefined], ['write_thing', 'approved'], ['finish', undefined]])
  // Both results went back in ONE message, ids intact.
  const results = h.calls[0].messages.at(-1).content
  assert.deepEqual(results.map((r: any) => r.tool_use_id), ['c1', 'c2'])
  assert.equal(h.patches[0].pending, null, 'gate cleared on resume')
})

test('decline runs the reads, refuses the writes by name, and lets the agent finish honestly', async () => {
  const held = harness([turn([['c1', 'read_thing', {}], ['c2', 'write_thing', { to: 'x' }]])])
  const paused = await drive(run(), agent(), ctx, held.deps)

  const h = harness([finish('could not send')])
  const out = await resolveApproval(paused, agent(), false, ctx, h.deps)

  assert.equal(out.status, 'completed')
  assert.deepEqual(h.ran, ['read_thing'], 'the write never runs')
  const refused = h.calls[0].messages.at(-1).content[1]
  assert.equal(refused.tool_use_id, 'c2')
  assert.match(refused.content, /Grace reviewed this write_thing call and declined it/)
  assert.match(refused.content, /Do not propose it again/)
  const rejected = out.log.find(e => e.decision === 'rejected')
  assert.equal(rejected?.tool, 'write_thing')
  assert.match(rejected?.result ?? '', /Declined by Grace/)
})

test('with approval off, a write runs straight through', async () => {
  const h = harness([turn([['c2', 'write_thing', { to: 'x' }]]), finish('sent')])
  const out = await drive(run(), agent({ approval_required: false }), ctx, h.deps)
  assert.equal(out.status, 'completed')
  assert.deepEqual(h.ran, ['write_thing'])
  assert.ok(!h.patches.some(p => p.status === 'awaiting_approval'))
})

test('resolveApproval refuses a run that has nothing pending', async () => {
  const h = harness([])
  await assert.rejects(() => resolveApproval(run(), agent(), true, ctx, h.deps), /no pending action/)
})

// ── Budgets and failure ───────────────────────────────────────────────────────

test('the step limit ends the run as failed instead of looping forever', async () => {
  const turns = Array.from({ length: MAX_STEPS + 2 }, (_, i) => turn([[`c${i}`, 'read_thing', {}]]))
  const h = harness(turns)
  const out = await drive(run(), agent(), ctx, h.deps)

  assert.equal(out.status, 'failed')
  assert.match(out.error ?? '', new RegExp(`Stopped after ${MAX_STEPS}`))
  assert.equal(h.ran.length, MAX_STEPS)
  assert.ok(h.last().finished_at)
})

test('a resumed run does not get a fresh step budget', async () => {
  // Log already shows MAX_STEPS - 1 spent; one more read is allowed, then stop.
  const spent = Array.from({ length: MAX_STEPS - 1 }, () => ({ at: '', tool: 'read_thing', input: {} }))
  const h = harness([turn([['c1', 'read_thing', {}]]), turn([['c2', 'read_thing', {}]])])
  const out = await drive(run({ log: spent }), agent(), ctx, h.deps)
  assert.equal(out.status, 'failed')
  assert.equal(h.ran.length, 1)
})

test('a provider error fails the run and persists the error and the transcript so far', async () => {
  const h = harness([turn([['c1', 'read_thing', {}]])]) // second call throws: no more turns
  const out = await drive(run(), agent(), ctx, h.deps)

  assert.equal(out.status, 'failed')
  assert.match(out.error ?? '', /no more turns/)
  assert.equal(h.last().status, 'failed')
  assert.ok((h.last().messages ?? []).length >= 3, 'transcript up to the failure is kept')
  assert.equal(h.last().input_tokens, 10, 'tokens spent before the failure are recorded')
})

test('token usage accumulates across turns', async () => {
  const h = harness([turn([['c1', 'read_thing', {}]]), finish('ok')])
  await drive(run(), agent(), ctx, h.deps)
  assert.equal(h.last().input_tokens, 20)
  assert.equal(h.last().output_tokens, 10)
})
