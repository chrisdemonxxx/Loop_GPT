#!/bin/sh
set -e

# The hosting platform (HF Spaces, Railway) sets PORT dynamically.
PORT="${PORT:-7860}"

# Generate a random secret key if none is provided.
if [ -z "$SEARXNG_SECRET_KEY" ]; then
  export SEARXNG_SECRET_KEY="$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 2>/dev/null || openssl rand -base64 32)"
fi

# Force the runtime port into the config (idempotent; independent of build-time
# templating) so the app binds the port the platform routes to.
sed -i "s/^\([[:space:]]*port:\).*/\1 ${PORT}/" /etc/searxng/settings.yml
export SEARXNG_BIND_ADDRESS="0.0.0.0"

# The base image's entrypoint is /sbin/tini -- /usr/local/searxng/dockerfiles/docker-entrypoint.sh
exec /sbin/tini -- /usr/local/searxng/dockerfiles/docker-entrypoint.sh "$@"
