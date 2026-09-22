#!/bin/sh
# Materialize the tunnel credential from a base64 env var, then run the connector.
# Keeps the secret out of the image and the repository.
set -eu

TUNNEL_ID="${TUNNEL_ID:-bc0a90c0-e120-44ba-99ea-15a6d138619b}"
CREDS=/etc/cloudflared/tunnel-creds.json

if [ -n "${TUNNEL_CREDS_B64:-}" ]; then
  printf '%s' "$TUNNEL_CREDS_B64" | base64 -d > "$CREDS"
elif [ ! -f "$CREDS" ]; then
  echo "TUNNEL_CREDS_B64 is required (or mount $CREDS)" >&2
  exit 1
fi

# A local (credentials-file) tunnel uses this config.yml. TUNNEL_LOGLEVEL=debug
# surfaces the applied ingress and per-request matching.
exec cloudflared tunnel \
  --config /etc/cloudflared/config.yml \
  --credentials-file "$CREDS" \
  --loglevel "${TUNNEL_LOGLEVEL:-info}" --retries 10 \
  run "$TUNNEL_ID"
