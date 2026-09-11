/*
 * EAC Tend — run an agent, or resolve an approval
 *
 * POST /api/tend-run  { agentId }                      → run the standing job now
 * POST /api/tend-run  { agentId, text }                → chat: run with a message
 * POST /api/tend-run  { runId, decision: 'approve' }    → run the held action
 * POST /api/tend-run  { runId, decision: 'reject' }     → decline it and carry on
 *
 * WHERE THE WORK HAPPENS. If a worker (the Mac mini) has heartbeated in the
 * last minute, the run is written as `queued` and this returns at once; the
 * worker claims it, runs it for as long as it takes, and the page sees the
 * result by polling. If no worker is alive, the run executes inside this
 * request as before, within the 300 s cap. The page cannot tell the
 * difference and does not need to.
 *
 * Either way the run is persisted before the model is called, and every
 * transition is saved, so the operator can close the tab and the reply is
 * there when they come back. A killed run is swept to `failed` by the cron.
 *
 * Admin-only.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
import { drive, resolveApproval, kickoffMessages, type Exchange } from './_lib/tend-runner'
import { sanitiseMessage } from './_lib/tend-validate'
import {
  getAgent, getRun, createRun, updateAgent, hasLiveRun, getWorkspace, listRunsForAgent,
  getWorkerStatus, queueDecision,
} from './_lib/tend-db'

export const maxDuration = 300

/** The run's state, trimmed for the browser. `messages` never goes out. */
function publicRun(run: any) {
  return {
    id:            run.id,
    agentId:       run.agent_id,
    agentName:     run.agent_name,
    status:        run.status,
    provider:      run.provider,
    model:         run.model,
    prompt:        run.prompt ?? null,
    summary:       run.summary ?? null,
    error:         run.error ?? null,
    pending:       run.pending ?? null,
    log:           run.log ?? [],
    inputTokens:   run.input_tokens ?? 0,
    outputTokens:  run.output_tokens ?? 0,
  }
}

/** Prompt + reply pairs from finished runs, oldest first. Tool output stays out. */
function historyFrom(runs: { prompt: string | null; summary: string | null; status: string }[]): Exchange[] {
  return runs
    .filter(r => r.status === 'completed' && r.summary)
    .map(r => ({ prompt: r.prompt, summary: r.summary as string }))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  const workspace = await getWorkspace()
  const ctx = { adminEmail: session.email, workspace }

  try {
    const { agentId, runId, decision } = req.body ?? {}
    const { alive: workerAlive } = await getWorkerStatus()

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

      console.log(`[tend] ${session.email} ${decision}d run ${runId}${workerAlive ? ' (handed to worker)' : ''}`)

      if (workerAlive) {
        await queueDecision(runId, decision)
        return res.json({ run: publicRun({ ...run, status: 'queued', pending: null }) })
      }
      const done = await resolveApproval(run, agent, decision === 'approve', ctx)
      return res.json({ run: publicRun(done) })
    }

    // ── Start a run (standing job, or a chat message) ────────────────────
    if (!agentId) return res.status(400).json({ error: 'agentId or runId required' })

    const agent = await getAgent(agentId)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    // One live run per agent. Two in flight would fork the transcript, and an
    // approval would then attach to whichever row happened to finish last.
    if (await hasLiveRun(agentId)) {
      return res.status(409).json({ error: `${agent.name} is still working. Wait for it to finish.` })
    }

    const text    = sanitiseMessage(req.body?.text)
    const history = text ? historyFrom(await listRunsForAgent(agentId)) : []

    const run = await createRun({
      agent_id:   agent.id,
      agent_name: agent.name,
      status:     workerAlive ? 'queued' : 'running',
      trigger:    'manual',
      provider:   agent.provider,
      model:      agent.model,
      prompt:     text || null,
      messages:   kickoffMessages(agent.provider, {
        now:       new Date(),
        prompt:    text || undefined,
        history,
        adminName: workspace.admin_name,
      }),
    })

    await updateAgent(agent.id, { last_run_at: new Date().toISOString() })
    console.log(
      `[tend] ${session.email} started ${agent.name} (run ${run.id})` +
      `${text ? ' from chat' : ''}${workerAlive ? ' → queued for worker' : ''}`
    )

    if (workerAlive) return res.json({ run: publicRun(run) })

    const done = await drive(run, agent, ctx)
    return res.json({ run: publicRun(done) })
  } catch (err: any) {
    console.error('[tend-run]', err)
    return res.status(500).json({ error: String(err?.message ?? err).slice(0, 300) })
  }
}
