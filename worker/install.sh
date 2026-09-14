#!/bin/bash
# Tend worker — one-time Mac mini setup.
#
#   bash worker/install.sh
#
# Registers the worker with launchd so it starts at login and restarts if it
# stops. Idempotent: run it again after changing worker/.env.

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="community.expertauthor.tend-worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/tend-worker.log"

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Install the LTS from https://nodejs.org then run this again."
  exit 1
fi
NODE_DIR="$(dirname "$(command -v node)")"

if [ ! -f "$REPO/worker/.env" ]; then
  cp "$REPO/worker/.env.example" "$REPO/worker/.env"
  echo "Created $REPO/worker/.env"
  echo "Open it, paste the values from Vercel → Settings → Environment Variables, save, then run this again."
  exit 1
fi

chmod +x "$REPO/worker/run.sh"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/worker/run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo
echo "Worker installed and started."
echo "  Log:      tail -f $LOG"
echo "  Stop:     launchctl unload $PLIST"
echo "  Restart:  launchctl unload $PLIST && launchctl load $PLIST"
echo
echo "One more thing, once: stop the Mac from sleeping."
echo "  sudo pmset -a sleep 0 disablesleep 1"
