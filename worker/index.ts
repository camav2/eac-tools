/*
 * Tend worker — entry point
 *
 * Runs on the Mac mini. Heartbeats every 10 seconds so the API knows to route
 * runs here; polls the queue every 3 seconds; executes one run at a time.
 *
 * Self-update: every 15 minutes, while idle, it checks whether origin/master
 * has moved. If so it exits cleanly. launchd restarts it via worker/run.sh,
 * which pulls and rebuilds first. Pushing to master is therefore how the
 * worker gets updated. It never restarts mid-run.
 *
 * Nothing here listens on a port. The worker only reaches out — to Supabase,
 * to the model, to the tools. The Mac mini needs no open ports and no router
 * changes.
 *
 * Env: worker/.env (see worker/.env.example). Same keys as Vercel.
 */

import os from 'node:os'
import { execSync } from 'node:child_process'
import { loadEnv } from './env'
import { processOne } from './loop'
import { drive, resolveApproval } from '../api/_lib/tend-runner'
import { listConnectedAdmins } from '../api/_lib/gmail'
import { resolveAdminEmail } from '../api/_lib/tend-schedule'
import {
  claimNextRun, getAgent, getWorkspace, updateRun, heartbeat,
} from '../api/_lib/tend-db'

const POLL_MS         = 3_000
const HEARTBEAT_MS    = 10_000
const UPDATE_CHECK_MS = 15 * 60_000

const loaded = loadEnv()
const WORKER_ID = process.env.TEND_WORKER_ID || os.hostname()

function git(cmd: string): string | null {
  try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return null }
}
const VERSION = git('rev-parse --short HEAD')

const log = (message: string) => console.log(`${new Date().toISOString()} [tend-worker] ${message}`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY']) {
  if (!process.env[key]) {
    console.error(`[tend-worker] ${key} is not set. Copy worker/.env.example to worker/.env and fill it in.`)
    process.exit(1)
  }
}

let stopping = false
let busy = false
process.on('SIGTERM', () => { stopping = true; log('SIGTERM — finishing the current run, then stopping') })
process.on('SIGINT',  () => { stopping = true; log('SIGINT — finishing the current run, then stopping') })

async function beat() {
  try { await heartbeat(WORKER_ID, VERSION) } catch (err: any) { log(`heartbeat failed: ${err?.message ?? err}`) }
}

/** True when origin/master has commits this process is not running. */
function updateAvailable(): boolean {
  if (!git('fetch --quiet origin master')) { /* fetch prints nothing on success; null means it threw */ }
  const local  = git('rev-parse HEAD')
  const remote = git('rev-parse origin/master')
  return Boolean(local && remote && local !== remote)
}

async function main() {
  log(`starting as ${WORKER_ID}${VERSION ? ` @ ${VERSION}` : ''}; loaded ${loaded.length} env keys`)
  await beat()
  // A timer, not part of the loop: a run can take an hour, and the API must
  // keep seeing this worker as alive the whole time.
  const beatTimer = setInterval(beat, HEARTBEAT_MS)

  let lastUpdateCheck = Date.now()

  while (!stopping) {
    busy = true
    const result = await processOne(WORKER_ID, {
      claimNextRun, getAgent, getWorkspace, updateRun, drive, resolveApproval, log,
      adminEmail: async () => resolveAdminEmail(process.env.TEND_ADMIN_EMAIL, await listConnectedAdmins()).adminEmail,
    })
    busy = false

    if (result === 'idle') {
      if (Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
        lastUpdateCheck = Date.now()
        if (updateAvailable()) {
          log('new commits on origin/master — exiting so launchd restarts me on the new code')
          break
        }
      }
      await sleep(POLL_MS)
    }
    // After 'done' or 'failed': loop straight back for the next queued run.
  }

  clearInterval(beatTimer)
  log('stopped')
  process.exit(0)
}

main().catch(err => {
  console.error('[tend-worker] fatal:', err)
  process.exit(1)
})

// Unused-variable guard for the busy flag, kept for future signal handling.
void busy
