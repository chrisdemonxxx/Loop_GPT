#!/bin/bash
set -e
# HF Spaces sets PORT dynamically; override SearXNG port to match.
PORT="${PORT:-7860}"
export SEARXNG_PORT="$PORT"
export SEARXNG_SECRET_KEY="${SEARXNG_SECRET_KEY:-loopsearch-generated-key}"
exec /sbin/tini -- /usr/local/searxng/dockerfiles/docker-entrypoint.sh "$@"
