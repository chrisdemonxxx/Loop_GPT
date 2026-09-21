#!/bin/bash
set -e

# HF Spaces sets PORT dynamically.
PORT="${PORT:-7860}"

# Generate a random secret key if none is provided in Secrets.
if [ -z "$SEARXNG_SECRET_KEY" ]; then
  export SEARXNG_SECRET_KEY="$(head -c 32 /dev/urandom | base64)"
fi

# Override the SearXNG port to match HF Spaces routing.
export SEARXNG_PORT="${PORT}"
export SEARXNG_BIND_ADDRESS="0.0.0.0"

# The base image's entrypoint is /sbin/tini -- /usr/local/searxng/dockerfiles/docker-entrypoint.sh
exec /sbin/tini -- /usr/local/searxng/dockerfiles/docker-entrypoint.sh "$@"
