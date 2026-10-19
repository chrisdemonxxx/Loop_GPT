#!/bin/sh
set -e

# Apply reviewed migrations idempotently before starting the server when a
# database is configured.
if [ -n "$DATABASE_URL" ]; then
  npx prisma migrate deploy
fi

exec node dist/server.js

