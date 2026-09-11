# Tend worker — the Mac mini

The worker is a small program that runs on the Mac mini at home and does the
teammates' jobs. It exists because a Vercel function stops at 5 minutes, and
a teammate that browses LinkedIn for an hour cannot live there.

## How it fits

- **Vercel** (cloud) is the app: the chat page, the API, the database, the cron.
- **Mac mini** is the hands: it asks the database every 3 seconds "any jobs?",
  does them, saves progress after every step, and reports back.

**Nothing on the Mac mini is reachable from the internet.** It only reaches
out. No ports to open. No router changes.

**If the Mac mini is off, Tend still works.** The API notices there is no
heartbeat and runs jobs in the cloud as before (5-minute cap). Anything that
was queued for the worker is drained by the hourly cron. When the Mac mini
comes back, it takes over again. No switches to flip.

## Setup, once

On the Mac mini:

1. Install Node LTS from https://nodejs.org if it is not there. Check with `node -v`.
2. Get the repo:
   ```
   cd ~ && git clone https://github.com/camav2/eac-tools.git && cd eac-tools
   ```
   (Or `git pull` if it is already there.)
3. Run the installer once to create the env file:
   ```
   bash worker/install.sh
   ```
   It creates `worker/.env` and stops.
4. Open `worker/.env` and paste the values from **Vercel → eac-tools → Settings → Environment Variables**. Save.
5. Run the installer again:
   ```
   bash worker/install.sh
   ```
   It registers the worker with launchd, starts it, and prints where the log is.
6. Stop the Mac from sleeping:
   ```
   sudo pmset -a sleep 0 disablesleep 1
   ```

Then open `/tend`. The left panel should say **Worker online · <name>** within a few seconds.

## Day to day

| Want to | Do |
|---|---|
| See what it is doing | `tail -f ~/Library/Logs/tend-worker.log` |
| Stop it | `launchctl unload ~/Library/LaunchAgents/community.expertauthor.tend-worker.plist` |
| Start it | `launchctl load ~/Library/LaunchAgents/community.expertauthor.tend-worker.plist` |
| Update it | Push to `master`. The worker checks every 15 minutes while idle, exits, and launchd restarts it on the new code. |
| Change a key | Edit `worker/.env`, then stop and start. |

## What is inside

| File | What it does |
|---|---|
| `worker/index.ts` | Entry point. Heartbeat timer, poll loop, self-update, clean shutdown. |
| `worker/loop.ts` | One tick: claim a run, execute it, persist. Tested with fakes. |
| `worker/env.ts` | Reads `worker/.env`. |
| `worker/run.sh` | What launchd runs: pull, install, build, start. |
| `worker/install.sh` | One-time launchd registration. |
| `api/_lib/tend-db.ts` → Worker section | `heartbeat`, `getWorkerStatus`, `claimNextRun`, `queueDecision`. |

The worker shares every line of the runner and the tools with Vercel. There
is one runner. It just runs in two places.

## Safety

- The worker only ever runs the code on `origin/master`. Nothing else.
- It runs one job at a time.
- A crash loses at most one step. The run is swept to "failed" after 15 minutes without progress and the teammate is unblocked.
- Keys live in `worker/.env`, which is git-ignored.
