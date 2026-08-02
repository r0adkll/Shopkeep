#!/usr/bin/env bash
# Runs the Ktor server in dev mode. OIDC env is set automatically when the
# Dex test provider is reachable (always true inside the devcontainer), so
# the SSO button appears without any manual configuration.
set -euo pipefail
cd "$(dirname "$0")/.."

export SHOPKEEP_DEV=true
export BASE_URL=http://localhost:5173
# Until the Etsy app is approved, default to the in-process mock (ETSY_MOCK=false for real keys)
export ETSY_MOCK=${ETSY_MOCK:-true}
[ "$ETSY_MOCK" = "true" ] && echo "▸ Etsy MOCK mode — connect flow runs against the built-in test double"

if curl -sf -m 1 http://localhost:5556/.well-known/openid-configuration >/dev/null 2>&1; then
  echo "▸ Dex detected — enabling OIDC (sign in with dev@shopkeep.local / password)"
  export OIDC_ISSUER=http://localhost:5556
  export OIDC_CLIENT_ID=shopkeep-dev
  export OIDC_CLIENT_SECRET=shopkeep-dev-secret
else
  echo "▸ No Dex on localhost:5556 — starting with local login only"
fi

exec ./gradlew :server:run
