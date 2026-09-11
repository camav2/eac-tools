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
  summary:       string | null
  error:         string | null
  messages:      any[]
  log:           LogEntry[]
  pending:       PendingAction | null
  input_tokens:  number
  output_tokens: number
  started_at:    string
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
    body:    JSON.stringify(patch),
  })
}

/**
 * Recent runs for the dashboard. `messages` is deliberately excluded — a
 * transcript can be hundreds of kilobytes and the list view never shows it.
 */
export async function listRuns(limit = 40): Promise<Omit<TendRun, 'messages'>[]> {
  const cols = 'id,agent_id,agent_name,status,trigger,provider,model,summary,error,log,pending,' +
               'input_tokens,output_tokens,started_at,finished_at'
  return (await sb<Omit<TendRun, 'messages'>[]>(
    `tend_runs?select=${cols}&order=started_at.desc&limit=${limit}`
  )) ?? []
}

/**
 * An agent runs one at a time. A second start while a run is live would fork
 * the transcript, and the approval gate would then be attached to whichever
 * row finished last.
 */
export async function hasLiveRun(agentId: string): Promise<boolean> {
  const rows = await sb<{ id: string }[]>(
    `tend_runs?agent_id=eq.${agentId}&status=in.(running,awaiting_approval)&select=id&limit=1`
  )
  return (rows?.length ?? 0) > 0
}
