#!/bin/sh
set -e

# When a real database is configured, sync the Prisma schema (no migrations are
# committed, so `db push` creates/updates tables from schema.prisma). If it
# fails or no DB is set, the app falls back to its in-memory store.
if [ -n "$DATABASE_URL" ] && ! echo "$DATABASE_URL" | grep -q "postgresql://user:password"; then
  echo "→ Applying database schema (prisma db push)…"
  npx prisma db push --skip-generate --accept-data-loss || echo "⚠️  prisma db push failed; continuing."
fi

exec node dist/server.js
