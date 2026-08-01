#!/usr/bin/env bash
# Runs the Vite dev server, installing dependencies first if they're missing
# (a fresh devcontainer's node_modules volume starts empty).
set -euo pipefail
cd "$(dirname "$0")/../web"

if [ ! -d node_modules/.bin ]; then
  echo "▸ node_modules missing — running npm install"
  npm install
fi

exec npm run dev
