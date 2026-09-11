#!/bin/bash
# Tend worker — start script for the Mac mini.
#
# launchd runs this at boot and again whenever the worker exits (it exits on
# purpose when it sees new commits). So: pull, install, build, run. If the
# pull fails (no network yet at boot), run what is already here.

set -u
cd "$(dirname "$0")/.."

echo "$(date -u +%FT%TZ) [run.sh] pulling…"
git pull --ff-only origin master || echo "$(date -u +%FT%TZ) [run.sh] pull failed, running current code"

echo "$(date -u +%FT%TZ) [run.sh] installing…"
npm install --no-audit --no-fund --silent || echo "$(date -u +%FT%TZ) [run.sh] npm install failed, continuing"

echo "$(date -u +%FT%TZ) [run.sh] building…"
node node_modules/typescript/bin/tsc --outDir .worker-build || { echo "$(date -u +%FT%TZ) [run.sh] build failed"; sleep 30; exit 1; }

echo "$(date -u +%FT%TZ) [run.sh] starting worker"
exec node .worker-build/worker/index.js
