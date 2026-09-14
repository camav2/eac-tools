/*
 * EAC Tend — scheduling rules
 *
 * Pure functions shared by the Vercel cron and the worker. No I/O here, so
 * every branch is testable with a Date and an object.
 */

import type { TendAgent } from './tend-db'

const HOUR_MS = 60 * 60 * 1000

/**
 * A run still "running" with no progress for this long was killed, not slow.
 * Keyed on updated_at (touched every persist), so a genuinely long run that
 * keeps saving is never swept. Comfortably above Vercel's 300 s cap.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000

export function staleCutoff(now: Date): string {
  return new Date(now.getTime() - STALE_AFTER_MS).toISOString()
}

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
