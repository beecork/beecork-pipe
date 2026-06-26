#!/bin/bash
# Beecork Pipe — Clean Uninstall Script
# Removes everything so you can test a fresh install experience

set -e

echo "=== Beecork Pipe Clean Uninstall ==="
echo ""

# 1. Stop the daemon if running
echo "[1/5] Stopping daemon..."
beecork-pipe stop 2>/dev/null || true

# 2. Remove platform service (launchd on macOS, systemd on Linux)
# NOTE: the service label (com.beecork.daemon / beecork.service) is intentionally
# kept across the beecork -> beecork-pipe rename so upgrades reuse the same unit.
echo "[2/5] Removing platform service..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.beecork.daemon.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "  Removed launchd service"
  fi
elif [[ "$OSTYPE" == "linux"* ]]; then
  SERVICE="$HOME/.config/systemd/user/beecork.service"
  if [ -f "$SERVICE" ]; then
    systemctl --user stop beecork 2>/dev/null || true
    systemctl --user disable beecork 2>/dev/null || true
    rm -f "$SERVICE"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "  Removed systemd service"
  fi
fi

# 3. Uninstall npm package
echo "[3/5] Uninstalling npm package..."
npm uninstall -g beecork-pipe 2>/dev/null || true

# 4. Remove Beecork Pipe data directory
# (This is ~/.beecork-pipe — NOT ~/.beecork, which belongs to the separate
#  beecork coding agent. Do not touch the agent's directory.)
echo "[4/5] Removing ~/.beecork-pipe/..."
rm -rf "$HOME/.beecork-pipe"

# 5. Remove any leftover log files
echo "[5/5] Removing logs..."
rm -f /tmp/beecork-*.log 2>/dev/null || true

echo ""
echo "Done!"
echo ""
echo "Beecork Pipe is fully removed. To test a fresh install:"
echo ""
echo "  npm install -g beecork-pipe"
echo "  beecork-pipe setup"
echo "  beecork-pipe start"
echo ""
