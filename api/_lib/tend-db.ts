/*
 * EAC Tend — Supabase persistence
 *
 * Thin REST wrapper over the tend_agents / tend_runs tables, in the same
 * style as mail-merge-worker: no SDK, service key, PostgREST filters inline.
 *
 * Schema lives in sql/tend.sql and is applied by hand once.
 *
 * Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import type { ProviderId } from './tend-providers'

export type Schedule = 'manual' | 'hourly' | 'daily' | 'weekly'
export type Effort   = 'low' | 'medium' | 'high'
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'rejected'

/**
 * Who this install belongs to. One row. Every EAC-specific fact an agent needs
 * lives here rather than in the prompt source, so a second community is a form
 * to fill in rather than a file to edit.
 */
export interface TendWorkspace {
  id:             string
  community_name: string
  operator_name:  string
  admin_name:     string
  about:          string
  style_notes:    string
  updated_at:     string
}

export interface TendAgent {
  id:                string
  name:              string
  role:              string
  instructions:      string
  tools:             string[]
  approval_required: boolean
  effort:            Effort
  /** Which vendor and which model this teammate thinks with. */
  provider:          ProviderId
  model:             string
  schedule:          Schedule
  hour_utc:          number
  dow:               number
  enabled:           boolean
  last_run_at:       string | null
  created_at:        string
}

export interface PendingAction {
  toolUseId: string
  name:      string
  input:     unknown
}

export interface LogEntry {
  at:      string
  tool:    string
  input:   unknown
  result?: string
  error?:  string
  /** Set when the entry records an approval decision rather than a plain call. */
  decision?: 'approved' | 'rejected'
}

export interface TendRun {
  id:            string
  agent_id:      string
  agent_name:    string
  status:        RunStatus
  trigger:       'manual' | 'schedule'
  /**
   * Pinned at creation from the agent. The transcript is in this provider's
   * native shape, so a run must resume on the provider it started with even
   * if the agent has since been switched.
   */
  provider:      ProviderId
  model:         string
  /** What the operator typed to start this run. Null for scheduled runs. */
  prompt:        string | null
  summary:       string | null
  error:         string | null
  messages:      any[]
  log:           LogEntry[]
  pending:       PendingAction | null
  input_tokens:  number
  output_tokens: number
  /** Which worker took the run. Null while queued, or when Vercel ran it. */
  claimed_by:    string | null
  /** An approval decided in the UI but executed on the worker. Cleared on claim. */
  pending_decision: 'approve' | 'reject' | null
  started_at:    string
  /** Touched on every persist. The stale sweep keys on this, not started_at. */
  updated_at:    string
  finished_at:   string | null
}

// ── Supabase REST ─────────────────────────────────────────────────────────────

function sbUrl(path: string) {
  return `${(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1/${path}`
}

function sbHeaders(prefer = 'return=representation') {
  return {
    'apikey':        process.env.SUPABASE_SERVICE_KEY!,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        prefer,
  }
}

async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(sbUrl(path), {
    ...init,
    headers: { ...sbHeaders(), ...(init.headers as Record<string, string> ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status} on ${path}: ${body.slice(0, 300)}`)
  }
  // PATCH/POST with return=minimal, and DELETE, come back empty.
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

// ── Workspace ─────────────────────────────────────────────────────────────────

/** Used when the row is missing, so a fresh install runs instead of crashing. */
const BLANK_WORKSPACE: TendWorkspace = {
  id: 'default',
  community_name: 'this community',
  operator_name:  'the community owner',
  admin_name:     'the operator',
  about:          '',
  style_notes:    '',
  updated_at:     '',
}

export async function getWorkspace(): Promise<TendWorkspace> {
  const rows = await sb<TendWorkspace[]>('tend_workspace?id=eq.default&select=*')
  return rows?.[0] ?? BLANK_WORKSPACE
}

export async function updateWorkspace(patch: Partial<TendWorkspace>): Promise<void> {
  // Upsert, not patch: the row is seeded by sql/tend.sql, but an install that
  // skipped the seed should still be able to save its details from the UI.
  await sb('tend_workspace', {
    method:  'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify({ ...patch, id: 'default', updated_at: new Date().toISOString() }),
  })
}

// ── Agents ────────────────────────────────────────────────────────────────────

export async function listAgents(): Promise<TendAgent[]> {
  return (await sb<TendAgent[]>('tend_agents?select=*&order=created_at.asc')) ?? []
}

export async function getAgent(id: string): Promise<TendAgent | null> {
  const rows = await sb<TendAgent[]>(`tend_agents?id=eq.${id}&select=*`)
  return rows?.[0] ?? null
}

export async function createAgent(patch: Partial<TendAgent>): Promise<TendAgent> {
  const rows = await sb<TendAgent[]>('tend_agents', {
    method: 'POST',
    body:   JSON.stringify(patch),
  })
  return rows[0]
}

export async function updateAgent(id: string, patch: Partial<TendAgent>): Promise<void> {
  await sb(`tend_agents?id=eq.${id}`, {
    method:  'PATCH',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify(patch),
  })
}

export async function deleteAgent(id: string): Promise<void> {
  await sb(`tend_agents?id=eq.${id}`, {
    method:  'DELETE',
    headers: { Prefer: 'return=minimal' },
  })
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export async function createRun(patch: Partial<TendRun>): Promise<TendRun> {
  const rows = await sb<TendRun[]>('tend_runs', {
    method: 'POST',
    body:   JSON.stringify(patch),
  })
  return rows[0]
}

export async function getRun(id: string): Promise<TendRun | null> {
  const rows = await sb<TendRun[]>(`tend_runs?id=eq.${id}&select=*`)
  return rows?.[0] ?? null
}

export async function updateRun(id: string, patch: Partial<TendRun>): Promise<void> {
  await sb(`tend_runs?id=eq.${id}`, {
    method:  'PATCH',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  })
}

/**
 * Recent runs for the dashboard. `messages` is deliberately excluded — a
 * transcript can be hundreds of kilobytes and the list view never shows it.
 */
const RUN_LIST_COLS =
  'id,agent_id,agent_name,status,trigger,provider,model,prompt,summary,error,log,pending,' +
  'input_tokens,output_tokens,claimed_by,pending_decision,started_at,updated_at,finished_at'

export type RunSummary = Omit<TendRun, 'messages'>

export async function listRuns(limit = 40): Promise<RunSummary[]> {
  return (await sb<RunSummary[]>(
    `tend_runs?select=${RUN_LIST_COLS}&order=started_at.desc&limit=${limit}`
  )) ?? []
}

/** One teammate's thread, oldest first, so it reads top to bottom. */
export async function listRunsForAgent(agentId: string, limit = 60): Promise<RunSummary[]> {
  const rows = await sb<RunSummary[]>(
    `tend_runs?agent_id=eq.${agentId}&select=${RUN_LIST_COLS}&order=started_at.desc&limit=${limit}`
  )
  return (rows ?? []).reverse()
}

/**
 * A run that is still "running" long after it started is a run whose
 * function was killed — timeout, deploy, crash. Left alone it blocks its
 * teammate forever (hasLiveRun) and shows "Working…" in the thread until the
 * end of time. The cron sweeps these into failed with a plain reason.
 */
export async function expireStaleRuns(cutoffIso: string): Promise<number> {
  const rows = await sb<{ id: string }[]>(
    `tend_runs?status=eq.running&updated_at=lt.${encodeURIComponent(cutoffIso)}`,
    {
      method:  'PATCH',
      headers: { Prefer: 'return=representation' },
      body:    JSON.stringify({
        status:      'failed',
        error:       'Stopped: the run did not finish in time. Try again, or give it a smaller job.',
        finished_at: new Date().toISOString(),
      }),
    },
  )
  return rows?.length ?? 0
}

/**
 * An agent runs one at a time. A second start while a run is live would fork
 * the transcript, and the approval gate would then be attached to whichever
 * row finished last.
 */
export async function hasLiveRun(agentId: string): Promise<boolean> {
  const rows = await sb<{ id: string }[]>(
    `tend_runs?agent_id=eq.${agentId}&status=in.(queued,running,awaiting_approval)&select=id&limit=1`
  )
  return (rows?.length ?? 0) > 0
}

// ── Worker ────────────────────────────────────────────────────────────────────

/** A worker that has not heartbeated within this window is treated as gone. */
export const WORKER_TIMEOUT_MS = 60 * 1000

export interface TendWorker {
  id:         string
  last_seen:  string
  version:    string | null
  started_at: string | null
}

export function isWorkerAlive(lastSeenIso: string | null | undefined, now: Date): boolean {
  if (!lastSeenIso) return false
  const t = new Date(lastSeenIso).getTime()
  return Number.isFinite(t) && now.getTime() - t < WORKER_TIMEOUT_MS
}

export async function heartbeat(id: string, version: string | null): Promise<void> {
  await sb('tend_workers', {
    method:  'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify({ id, version, last_seen: new Date().toISOString() }),
  })
}

export async function getWorkerStatus(now = new Date()): Promise<{ alive: boolean; worker: TendWorker | null }> {
  const rows = await sb<TendWorker[]>('tend_workers?select=*&order=last_seen.desc&limit=1')
  const worker = rows?.[0] ?? null
  return { alive: isWorkerAlive(worker?.last_seen, now), worker }
}

/**
 * Take the oldest queued run. Two steps, optimistic: read the candidate, then
 * PATCH it with `status=eq.queued` still in the filter. If a second worker
 * got there first the PATCH matches nothing and this returns null. The
 * decision is read before the claim because the claim clears it.
 */
export async function claimNextRun(
  workerId: string,
): Promise<{ run: TendRun; decision: 'approve' | 'reject' | null } | null> {
  const next = await sb<{ id: string; pending_decision: string | null }[]>(
    'tend_runs?status=eq.queued&select=id,pending_decision&order=started_at.asc&limit=1'
  )
  const cand = next?.[0]
  if (!cand) return null

  const claimed = await sb<TendRun[]>(`tend_runs?id=eq.${cand.id}&status=eq.queued`, {
    method: 'PATCH',
    body:   JSON.stringify({
      status:           'running',
      claimed_by:       workerId,
      pending_decision: null,
      updated_at:       new Date().toISOString(),
    }),
  })
  const run = claimed?.[0]
  if (!run) return null

  const decision = cand.pending_decision === 'approve' || cand.pending_decision === 'reject'
    ? cand.pending_decision
    : null
  return { run, decision }
}

/** Hand an approval decision to the worker instead of executing it here. */
export async function queueDecision(runId: string, decision: 'approve' | 'reject'): Promise<void> {
  await updateRun(runId, { status: 'queued', pending_decision: decision })
}
