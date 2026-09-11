/*
 * EAC Tend — run an agent, or resolve an approval
 *
 * POST /api/tend-run  { agentId }                      → start a run now
 * POST /api/tend-run  { runId, decision: 'approve' }    → run the held action
 * POST /api/tend-run  { runId, decision: 'reject' }     → decline it and carry on
 *
 * Returns the run's end state: completed, awaiting_approval, or failed.
 *
 * Admin-only, and long-running — the model loop and its tool calls happen
 * inside this request.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
import { drive, resolveApproval, kickoffMessages } from './_lib/tend-runner'
import {
  getAgent, getRun, createRun, updateAgent, hasLiveRun, getWorkspace,
} from './_lib/tend-db'

export const maxDuration = 300

/** The run's end state, trimmed for the browser. `messages` never goes out. */
function publicRun(run: any) {
  return {
    id:            run.id,
    agentId:       run.agent_id,
    agentName:     run.agent_name,
    status:        run.status,
    provider:      run.provider,
    model:         run.model,
    summary:       run.summary ?? null,
    error:         run.error ?? null,
    pending:       run.pending ?? null,
    log:           run.log ?? [],
    inputTokens:   run.input_tokens ?? 0,
    outputTokens:  run.output_tokens ?? 0,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  const ctx = { adminEmail: session.email, workspace: await getWorkspace() }

  try {
    const { agentId, runId, decision } = req.body ?? {}

    // ── Resolve a held approval ──────────────────────────────────────────
    if (runId) {
      if (decision !== 'approve' && decision !== 'reject') {
        return res.status(400).json({ error: "decision must be 'approve' or 'reject'" })
      }
      const run = await getRun(runId)
      if (!run) return res.status(404).json({ error: 'Run not found' })
      if (run.status !== 'awaiting_approval') {
        return res.status(409).json({ error: `Run is ${run.status}, not awaiting approval` })
      }
      const agent = await getAgent(run.agent_id)
      if (!agent) return res.status(404).json({ error: 'Agent no longer exists' })

      console.log(`[tend] ${session.email} ${decision}d run ${runId}`)
      const done = await resolveApproval(run, agent, decision === 'approve', ctx)
      return res.json({ run: publicRun(done) })
    }

    // ── Start a run ──────────────────────────────────────────────────────
    if (!agentId) return res.status(400).json({ error: 'agentId or runId required' })

    const agent = await getAgent(agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    // One live run per agent. Two in flight would fork the transcript, and an
    // approval would then attach to whichever row happened to finish last.
    if (await hasLiveRun(agentId)) {
      return res.status(409).json({ error: `${agent.name} already has a run in progress` })
    }

    const run = await createRun({
      agent_id:   agent.id,
      agent_name: agent.name,
      status:     'running',
      trigger:    'manual',
      provider:   agent.provider,
      model:      agent.model,
      messages:   kickoffMessages(agent.provider, new Date()),
    })

    await updateAgent(agent.id, { last_run_at: new Date().toISOString() })
    console.log(`[tend] ${session.email} started ${agent.name} (run ${run.id})`)

    const done = await drive(run, agent, ctx)
    return res.json({ run: publicRun(done) })
  } catch (err: any) {
    console.error('[tend-run]', err)
    return res.status(500).json({ error: String(err?.message ?? err).slice(0, 300) })
  }
}
