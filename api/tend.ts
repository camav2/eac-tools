/*
 * EAC Tend — roster and log API
 *
 * GET  /api/tend                → { agents, runs, workspace, tools, providers }
 * GET  /api/tend?runId={uuid}   → { run }  (full transcript and log)
 * POST /api/tend                → { op: 'create' | 'update' | 'delete' | 'workspace', ... }
 *
 * Running an agent and resolving an approval live in /api/tend-run, because
 * they call the model and need the long maxDuration. This file stays fast.
 *
 * Input validation is in _lib/tend-validate.ts so it can be tested without a
 * server. Nothing from req.body reaches the database except through it.
 *
 * Admin-only. Tend can read the whole member list and send mail as EAC, so
 * member-level access is deliberately not enough.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAuth } from './_lib/auth'
import { toolCatalogue } from './_lib/tend-tools'
import { providerCatalogue } from './_lib/tend-providers'
import { sanitiseAgent, sanitiseWorkspace } from './_lib/tend-validate'
import {
  listAgents, createAgent, updateAgent, deleteAgent,
  listRuns, getRun,
  getWorkspace, updateWorkspace,
} from './_lib/tend-db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  const session = await requireAuth(req, res)
  if (!session) return
  if (!session.isAdmin) return res.status(403).json({ error: 'Admin only' })

  try {
    if (req.method === 'GET') {
      const { runId } = req.query as Record<string, string>
      if (runId) {
        const run = await getRun(runId)
        if (!run) return res.status(404).json({ error: 'Run not found' })
        return res.json({ run })
      }
      const [agents, runs, workspace] = await Promise.all([listAgents(), listRuns(), getWorkspace()])
      return res.json({ agents, runs, workspace, tools: toolCatalogue(), providers: providerCatalogue() })
    }

    if (req.method === 'POST') {
      const { op } = req.body ?? {}

      if (op === 'create') {
        const patch = sanitiseAgent(req.body)
        if (!patch.name) return res.status(400).json({ error: 'Name required' })
        const agent = await createAgent(patch)
        console.log(`[tend] ${session.email} created agent ${agent.name} (${agent.id})`)
        return res.json({ agent })
      }

      if (op === 'update') {
        const { id } = req.body ?? {}
        if (!id) return res.status(400).json({ error: 'id required' })
        await updateAgent(id, sanitiseAgent(req.body))
        console.log(`[tend] ${session.email} updated agent ${id}`)
        return res.json({ ok: true })
      }

      if (op === 'delete') {
        const { id } = req.body ?? {}
        if (!id) return res.status(400).json({ error: 'id required' })
        await deleteAgent(id)
        console.log(`[tend] ${session.email} deleted agent ${id}`)
        return res.json({ ok: true })
      }

      if (op === 'workspace') {
        await updateWorkspace(sanitiseWorkspace(req.body))
        console.log(`[tend] ${session.email} updated workspace`)
        return res.json({ ok: true })
      }

      return res.status(400).json({ error: 'Unknown op' })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err: any) {
    console.error('[tend]', err)
    return res.status(500).json({ error: String(err?.message ?? err).slice(0, 300) })
  }
}
