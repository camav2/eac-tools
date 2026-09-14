/*
 * Tend worker — the loop, with its edges injected
 *
 * One tick: claim the oldest queued run, execute it (a fresh run, or an
 * approval decision handed over from the UI), persist the outcome. The
 * database, the runner and the admin lookup are all passed in, so this file
 * is tested with fakes and never touches the network.
 *
 * Why the worker exists: a Vercel function stops at 300 seconds. A teammate
 * that browses for an hour cannot live there. This loop runs on the Mac mini
 * for as long as a job takes, and the runner saves after every step, so a
 * crash loses at most one step.
 */

import type { TendAgent, TendRun, TendWorkspace } from '../api/_lib/tend-db'
import type { DriveContext } from '../api/_lib/tend-runner'

export interface LoopDeps {
  claimNextRun(workerId: string): Promise<{ run: TendRun; decision: 'approve' | 'reject' | null } | null>
  getAgent(id: string): Promise<TendAgent | null>
  getWorkspace(): Promise<TendWorkspace>
  adminEmail(): Promise<string>
  drive(run: TendRun, agent: TendAgent, ctx: DriveContext): Promise<TendRun>
  resolveApproval(run: TendRun, agent: TendAgent, approved: boolean, ctx: DriveContext): Promise<TendRun>
  updateRun(id: string, patch: Partial<TendRun>): Promise<void>
  log(message: string): void
}

export type TickResult = 'idle' | 'done' | 'failed'

/** Process at most one queued run. Returns what happened so the caller can pace itself. */
export async function processOne(workerId: string, deps: LoopDeps): Promise<TickResult> {
  const claimed = await deps.claimNextRun(workerId)
  if (!claimed) return 'idle'

  const { run, decision } = claimed
  const label = `run ${run.id} (${run.agent_name})`

  try {
    const agent = await deps.getAgent(run.agent_id)
    if (!agent) {
      await deps.updateRun(run.id, {
        status: 'failed',
        error: 'Teammate no longer exists.',
        finished_at: new Date().toISOString(),
      })
      deps.log(`${label} failed: teammate deleted`)
      return 'failed'
    }

    const ctx: DriveContext = {
      adminEmail: await deps.adminEmail(),
      workspace:  await deps.getWorkspace(),
    }

    deps.log(`${label} ${decision ? `resuming (${decision})` : 'starting'}`)
    const out = decision
      ? await deps.resolveApproval(run, agent, decision === 'approve', ctx)
      : await deps.drive(run, agent, ctx)

    deps.log(`${label} → ${out.status}`)
    return out.status === 'failed' ? 'failed' : 'done'
  } catch (err: any) {
    // drive() and resolveApproval() persist their own failures. This catches
    // what they cannot: a thrown lookup, a bad decision on a run with nothing
    // pending. The run must not stay "running" with nobody on it.
    const error = String(err?.message ?? err).slice(0, 500)
    await deps.updateRun(run.id, { status: 'failed', error, finished_at: new Date().toISOString() })
    deps.log(`${label} failed: ${error}`)
    return 'failed'
  }
}
