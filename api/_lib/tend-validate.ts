/*
 * EAC Tend — input validation
 *
 * The bodies that reach /api/tend come from a browser. These two functions
 * are the whole boundary between "what the page sent" and "what gets written
 * to the database", so they live here, pure, where a test can hit every
 * branch without a server.
 *
 * Whitelisted field by field rather than spread: `id`, `last_run_at`, or an
 * unknown column must never be settable from outside.
 */

import { getTool } from './tend-tools'
import { getProvider } from './tend-providers'
import type { TendAgent, TendWorkspace } from './tend-db'

export const SCHEDULES = ['manual', 'hourly', 'daily', 'weekly'] as const
export const EFFORTS   = ['low', 'medium', 'high'] as const

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  // Number(null) and Number('') are both 0, which is a valid hour. "Not
  // provided" must not quietly become midnight.
  if (value === null || value === undefined || value === '') return fallback
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

export function sanitiseAgent(body: any): Partial<TendAgent> {
  const patch: Partial<TendAgent> = {}
  if (!body || typeof body !== 'object') return patch

  if (typeof body.name === 'string')         patch.name         = body.name.trim().slice(0, 80)
  if (typeof body.role === 'string')         patch.role         = body.role.trim().slice(0, 200)
  if (typeof body.instructions === 'string') patch.instructions = body.instructions.slice(0, 20000)
  if (typeof body.enabled === 'boolean')     patch.enabled      = body.enabled
  if (typeof body.approval_required === 'boolean') patch.approval_required = body.approval_required

  if (Array.isArray(body.tools)) {
    // Unknown tool names are dropped, not rejected: a tool removed from the
    // registry should not make every agent that once used it uneditable.
    const known = (body.tools as unknown[]).filter(
      (t): t is string => typeof t === 'string' && Boolean(getTool(t))
    )
    patch.tools = [...new Set(known)]
  }
  if (SCHEDULES.includes(body.schedule)) patch.schedule = body.schedule
  if (EFFORTS.includes(body.effort))     patch.effort   = body.effort
  if (body.hour_utc !== undefined) patch.hour_utc = clampInt(body.hour_utc, 0, 23, 21)
  if (body.dow      !== undefined) patch.dow      = clampInt(body.dow, 0, 6, 1)

  // Provider must be in the registry. Model is free text only where the
  // provider says so; otherwise an unknown id falls back to the default rather
  // than saving something that will 404 at 3am.
  const provider = typeof body.provider === 'string' ? getProvider(body.provider) : undefined
  if (provider) patch.provider = provider.id
  if (typeof body.model === 'string') {
    const model = body.model.trim().slice(0, 120)
    if (provider && !provider.freeText && !provider.models.some(m => m.id === model)) {
      patch.model = provider.defaultModel
    } else if (model) {
      patch.model = model
    }
  }

  return patch
}

export function sanitiseWorkspace(body: any): Partial<TendWorkspace> {
  const patch: Partial<TendWorkspace> = {}
  if (!body || typeof body !== 'object') return patch

  const text = (key: keyof TendWorkspace, max: number) => {
    if (typeof body[key] === 'string') patch[key] = body[key].trim().slice(0, max) as any
  }
  text('community_name', 120)
  text('operator_name',  120)
  text('admin_name',     120)
  text('about',          4000)
  text('style_notes',    2000)
  return patch
}
