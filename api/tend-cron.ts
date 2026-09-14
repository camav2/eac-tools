/*
 * EAC Tend — scheduler
 *
 * Vercel cron hits this hourly. It finds the agents that are due and starts
 * them. Anything it does not reach is picked up on the next tick, so a busy
 * hour delays a job rather than dropping it.
 *
 * WHERE A RUN EXECUTES. If a worker (the Mac mini) has heartbeated in the
 * last minute, due runs are created `queued` and the worker takes them —
 * that is the path that allows hour-long jobs and, later, a browser. If no
 * worker is alive, this function runs them inline as before, within its
 * 300 s cap. Same rule for runs already sitting in the queue: a dead worker
 * must not strand them, so the cron drains the queue itself when it can.
 *
 * Schedules are stored as intent (hourly / daily at hour / weekly on day),
 * not cron strings. Cam picks them from a dropdown; nobody should have to
 * read "0 21 * * 1" to know when their teammate wakes up.
 *
 * Who a scheduled run "is": the admin with a connected Gmail (from
 * gmail_tokens). TEND_ADMIN_EMAIL overrides that for an install with several
 * connected admins. Neither is required — see _lib/tend-schedule.ts.
 *
 * Protection: requires Authorization: Bearer CRON_SECRET (Vercel injects it
 * for cron invocations when the env var is set).
 *
 * Env vars required:
 *   CRON_SECRET, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   plus whatever the granted tools need (Circle, Airtable, Webflow, Brevo, Gmail)
 * Optional: TEND_ADMIN_EMAIL
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { drive, resolveApproval, kickoffMessages } from './_lib/tend-runner'
import { listConnectedAdmins } from './_lib/gmail'
import { isDue, resolveAdminEmail, staleCutoff } from './_lib/tend-schedule'
import {
  listAgents, getAgent, createRun, updateAgent, hasLiveRun, getWorkspace,
  expireStaleRuns, getWorkerStatus, claimNextRun,
} from './_lib/tend-db'

// Kept as re-exports so existing imports and tests keep working.
export { isDue, resolveAdminEmail, staleCutoff, STALE_AFTER_MS } from './_lib/tend-schedule'

export const maxDuration = 300

/**
 * Runs this function will execute itself per tick, when no worker is alive.
 * Each can take minutes and the function is capped at 300 seconds — better
 * to run three properly than to be killed mid-way through the fourth.
 * Queueing for the worker has no such limit.
 */
const MAX_INLINE_PER_TICK = 3

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  if (!process.env.CRON_SECRET) {
    console.error('[tend-cron] CRON_SECRET not configured — refusing to run')
    return res.status(500).json({ error: 'CRON_SECRET not configured' })
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const now = new Date()

    // Housekeeping first, so a teammate blocked by a dead run can be
    // scheduled again on this same tick.
    const expired = await expireStaleRuns(staleCutoff(now))
    if (expired) console.warn(`[tend-cron] marked ${expired} stale run(s) as failed`)

    const { alive: workerAlive, worker } = await getWorkerStatus(now)
    console.log(`[tend-cron] worker ${workerAlive ? `alive (${worker?.id})` : 'not alive — running inline'}`)

    const { adminEmail, note } = resolveAdminEmail(
      process.env.TEND_ADMIN_EMAIL,
      await listConnectedAdmins(),
    )
    if (note) console.warn(`[tend-cron] ${note}`)
    const workspace = await getWorkspace()
    const ctx = { adminEmail, workspace }

    const results: { agent: string; status: string }[] = []
    let inlineBudget = MAX_INLINE_PER_TICK

    // ── Start what is due ────────────────────────────────────────────────
    const due = (await listAgents()).filter(a => isDue(a, now))
    for (const agent of due) {
      if (!workerAlive && inlineBudget <= 0) break

      if (await hasLiveRun(agent.id)) {
        // Usually an earlier run still sitting at an approval gate. Skipping is
        // right: starting a second one would queue a second thing to approve.
        console.log(`[tend-cron] ${agent.name} skipped — run already live`)
        results.push({ agent: agent.name, status: 'skipped' })
        continue
      }

      const run = await createRun({
        agent_id:   agent.id,
        agent_name: agent.name,
        status:     workerAlive ? 'queued' : 'running',
        trigger:    'schedule',
        provider:   agent.provider,
        model:      agent.model,
        prompt:     null,
        messages:   kickoffMessages(agent.provider, { now, adminName: workspace.admin_name }),
      })

      // Stamped before the run, not after. A crash mid-run must not leave the
      // agent looking un-run, or the next tick starts it again immediately.
      await updateAgent(agent.id, { last_run_at: now.toISOString() })

      if (workerAlive) {
        console.log(`[tend-cron] ${agent.name} queued for worker`)
        results.push({ agent: agent.name, status: 'queued' })
        continue
      }

      const done = await drive(run, agent, ctx)
      inlineBudget--
      console.log(`[tend-cron] ${agent.name} → ${done.status}`)
      results.push({ agent: agent.name, status: done.status })
    }

    // ── Drain the queue if the worker is gone ────────────────────────────
    // Runs queued while the worker was alive (or decisions handed to it)
    // must not sit forever because the Mac mini lost power.
    let drained = 0
    if (!workerAlive) {
      while (inlineBudget > 0) {
        const claimed = await claimNextRun('vercel-cron')
        if (!claimed) break
        const { run, decision } = claimed
        const agent = await getAgent(run.agent_id)
        if (!agent) {
          console.warn(`[tend-cron] queued run ${run.id} has no agent — leaving it to the stale sweep`)
          continue
        }
        const done = decision
          ? await resolveApproval(run, agent, decision === 'approve', ctx)
          : await drive(run, agent, ctx)
        inlineBudget--
        drained++
        console.log(`[tend-cron] drained ${agent.name} (${decision ?? 'run'}) → ${done.status}`)
        results.push({ agent: agent.name, status: `drained:${done.status}` })
      }
    }

    return res.json({
      ok: true,
      workerAlive,
      due: due.length,
      started: results.filter(r => r.status !== 'skipped').length,
      drained,
      results,
      ts: now.toISOString(),
    })
  } catch (err: any) {
    console.error('[tend-cron]', err)
    return res.status(500).json({ error: String(err?.message ?? err).slice(0, 300) })
  }
}
