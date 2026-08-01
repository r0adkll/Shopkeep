#!/usr/bin/env bash
# One-command dev loop for plain terminals (JetBrains, ssh, etc.):
# starts the Ktor server in the background and Vite in the foreground;
# Ctrl-C tears both down. VS Code users don't need this — the "dev" task
# auto-runs both on folder open.
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/dev-server.sh &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

./scripts/dev-web.sh
