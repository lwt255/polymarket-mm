#!/usr/bin/env bash
# v4-health — Quick health check for the live v4 microstructure bot.
#
# Runs on your local Mac. SSHes to the VPS and runs the health-check script
# there, which inspects systemd state, process state, log freshness, and
# recent error patterns — then prints a clean summary with NO P&L info.
#
# Install:
#   ln -s "$(pwd)/scripts/v4-health.sh" ~/bin/v4-health    (or wherever ~/bin is)
#   chmod +x scripts/v4-health.sh
#
# Usage:
#   v4-health           pretty human-readable output
#   v4-health --json    raw JSON (for scripting)

VPS="${POLYBOT_VPS:-root@178.62.235.212}"
REMOTE_SCRIPT="/home/polybot/polymarket-mm/src/scripts/crypto-5min/v4-health-check.py"

# Pass through args so --json works
ssh -o ConnectTimeout=5 -o BatchMode=no "$VPS" "python3 $REMOTE_SCRIPT $*"
exit $?
