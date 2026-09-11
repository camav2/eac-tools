/*
 * EAC Tend — scheduler
 *
 * Vercel cron hits this hourly. It finds the agents that are due, runs them
 * one after another, and stops. Anything it does not reach is picked up on the
 * next tick, so a busy hour delays a job rather than dropping it.
 *
 * Schedules are stored as intent (hourly / daily at hour / weekly on day) not
 * as cron strings. Cam picks them from a dropdown; nobody should have to read
 * "0 21 * * 1" to know when their teammate wakes up.
 *
 * A scheduled run that proposes a gated write stops at awaiting_approval and
 * waits on the dashboard. Unattended does not mean unsupervised.
 *
 * Protection: requires Authorization: Bearer CRON_SECRET (Vercel injects it
 * for cron invocations when the env var is set).
 *
 * Who a scheduled run "is": the admin with a connected Gmail (from
 * gmail_tokens), so sends go out from their mailbox. TEND_ADMIN_EMAIL
 * overrides that when set, for an install with several connected admins.
 * Neither is required to run — a teammate with only read tools never needs
 * a mailbox, and send_email fails with a plain message if there is none.
 *
 * Env vars required:
 *   CRON_SECRET, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   plus whatever the granted tools need (Circle, Airtable, Webflow, Brevo, Gmail)
 * Optional: TEND_ADMIN_EMAIL
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { drive, kickoffMessages } from './_lib/tend-runner'
import { listConnectedAdmins } from './_lib/gmail'
import {
  listAgents, createRun, updateAgent, hasLiveRun, getWorkspace,
  type TendAgent,
} from './_lib/tend-db'

export const maxDuration = 300

/**
 * Agents started per tick. Each can take minutes, and the function is capped
 * at 300 seconds — better to run three properly than to be killed mid-way
 * through the fourth and leave a half-written transcript.
 */
const MAX_PER_TICK = 3

const HOUR_MS = 60 * 60 * 1000

/**
 * Who an unattended run acts as. An explicit override wins; otherwise the
 * most recently connected admin. Never throws: a run with only read tools
 * needs no mailbox, so a missing one is a note in the log, not a refusal.
 */
export function resolveAdminEmail(
  override: string | undefined,
  connected: string[],
): { adminEmail: string; note?: string } {
  if (override) return { adminEmail: override }
  const adminEmail = connected[0] ?? ''
  if (!adminEmail) {
    return { adminEmail, note: 'no connected mailbox — send_email will fail if a teammate tries it' }
  }
  if (connected.length > 1) {
    return {
      adminEmail,
      note: `${connected.length} admins have Gmail connected; acting as ${adminEmail}. Set TEND_ADMIN_EMAIL to choose.`,
    }
  }
  return { adminEmail }
}

export function isDue(agent: TendAgent, now: Date): boolean {
  if (!agent.enabled) return false
  if (agent.schedule === 'manual') return false

  const last = agent.last_run_at ? new Date(agent.last_run_at) : null
  const sinceLast = last ? now.getTime() - last.getTime() : Infinity

  if (agent.schedule === 'hourly') {
    // 55 minutes, not 60: an hourly cron never fires at exactly the same
    // offset twice, and a strict hour means every other tick is skipped.
    return sinceLast >= 55 * 60 * 1000
  }

  if (now.getUTCHours() !== agent.hour_utc) return false

  if (agent.schedule === 'daily')  return sinceLast >= 23 * HOUR_MS
  if (agent.schedule === 'weekly') return now.getUTCDay() === agent.dow && sinceLast >= 6 * 24 * HOUR_MS

  return false
}

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
    // Resolve, don't require. See the header comment.
    const { adminEmail, note } = resolveAdminEmail(
      process.env.TEND_ADMIN_EMAIL,
      await listConnectedAdmins(),
    )
    if (note) console.warn(`[tend-cron] ${note}`)

    const now = new Date()
    const due = (await listAgents()).filter(a => isDue(a, now))

    if (!due.length) {
      console.log('[tend-cron] nothing due')
      return res.json({ ok: true, started: 0, ts: now.toISOString() })
    }

    const results: { agent: string; status: string }[] = []
    const workspace = await getWorkspace()

    for (const agent of due.slice(0, MAX_PER_TICK)) {
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
        status:     'running',
        trigger:    'schedule',
        provider:   agent.provider,
        model:      agent.model,
        messages:   kickoffMessages(agent.provider, now),
      })

      // Stamped before the run, not after. A crash mid-run must not leave the
      // agent looking un-run, or the next tick starts it again immediately.
      await updateAgent(agent.id, { last_run_at: now.toISOString() })

      const done = await drive(run, agent, { adminEmail, workspace })
      console.log(`[tend-cron] ${agent.name} → ${done.status}`)
      results.push({ agent: agent.name, status: done.status })
    }

    return res.json({
      ok: true,
      started: results.length,
      deferred: Math.max(0, due.length - MAX_PER_TICK),
      results,
      ts: now.toISOString(),
    })
  } catch (err: any) {
    console.error('[tend-cron]', err)
    return res.status(500).json({ error: String(err?.message ?? err).slice(0, 300) })
  }
}
