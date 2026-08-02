#!/usr/bin/env bash
# Runs the Ktor server in dev mode. OIDC env is set automatically when the
# Dex test provider is reachable (always true inside the devcontainer), so
# the SSO button appears without any manual configuration.
set -euo pipefail
cd "$(dirname "$0")/.."

export SHOPKEEP_DEV=true
export BASE_URL=http://localhost:5173
# App approved 2026-08-02 — real Etsy is the default now. ETSY_MOCK=true re-enables the test double.
export ETSY_MOCK=${ETSY_MOCK:-false}
if [ "$ETSY_MOCK" = "true" ]; then
  echo "▸ Etsy MOCK mode — connect flow runs against the built-in test double"
else
  echo "▸ Etsy REAL mode — callback must be registered in the Etsy app: \$BASE_URL/api/v1/integrations/etsy/callback"
fi

if curl -sf -m 1 http://localhost:5556/.well-known/openid-configuration >/dev/null 2>&1; then
  echo "▸ Dex detected — enabling OIDC (sign in with dev@shopkeep.local / password)"
  export OIDC_ISSUER=http://localhost:5556
  export OIDC_CLIENT_ID=shopkeep-dev
  export OIDC_CLIENT_SECRET=shopkeep-dev-secret
else
  echo "▸ No Dex on localhost:5556 — starting with local login only"
fi

exec ./gradlew :server:run
