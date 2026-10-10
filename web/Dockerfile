# Context: REPOSITORY ROOT (builds the Next.js product UI in apps/web/ — an
# npm-workspaces monorepo with shared packages in packages/ — and serves its
# static export through the hardened shared nginx template).
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<12))process.exit(1)"
# NEXT_PUBLIC_* must be baked into the static export by `next build`. Railway
# exposes service variables as Docker build args; declare + export them so the
# frontend bundle carries the Sentry/PostHog keys. Empty defaults keep local
# builds working when the keys are absent (Analytics stays inert).
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST=""
# Bake the Build section into the static export. Empty keeps /code on /developer.
ARG LOOPIT_ENABLED=""
# Served revision of THIS image (contract AF). For repo-triggered builds,
# Railway injects RAILWAY_GIT_COMMIT_SHA (provided variable) — declare it as
# an ARG so it reaches the build (the ${{RAILWAY_GIT_COMMIT_SHA}} *reference*
# in a service variable resolves EMPTY at build time — proven 2026-10-05, the
# RUN logged `""`). GIT_REVISION stays as the manual override for `railway up`
# CLI snapshot builds, which carry no git context.
ARG GIT_REVISION=""
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN} \
    NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
    NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST} \
    LOOPIT_ENABLED=${LOOPIT_ENABLED} \
    NEXT_PUBLIC_LOOPIT_ENABLED=${LOOPIT_ENABLED}
# npm workspaces: `npm ci` needs every workspace's package.json (manifests
# only) before install, then the sources can land for the build.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api-client/package.json packages/api-client/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
COPY apps/web ./apps/web
WORKDIR /app/apps/web
# Static export; then the hardened shell-only PWA worker + icons.
RUN npm run build && node build/pwa.mjs
# Served-revision marker (contract §F) — the web half of the deploy gate, with
# the same field name as backend `GET /api/version`, so a probe compares one
# vocabulary: revision(/api/version) == revision(/version.json) == git HEAD.
# An absent or empty build arg writes "unknown" — never a guess. Prefer the
# explicit GIT_REVISION override, then the Railway git SHA, then "unknown".
# The file lands in out/ as a plain file, which nginx serves through
# `try_files $uri`; `.json` gets its content-type from mime.types, and its
# no-store is one `map` entry in web/nginx.template.conf.
RUN node -e "const fs=require('fs');const r=(process.argv[1]||process.argv[2]||'').trim();fs.writeFileSync('out/version.json',JSON.stringify({surface:'web',revision:r||'unknown',builtAt:new Date().toISOString()}))" "$GIT_REVISION" "$RAILWAY_GIT_COMMIT_SHA"

FROM nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284 AS runtime
COPY --from=build /app/apps/web/out /usr/share/nginx/html
COPY web/nginx.template.conf /etc/nginx/templates/default.conf.template
COPY <<'SH' /docker-entrypoint.d/19-owned-upstream.sh
#!/bin/sh
set -eu
fail() { echo 'Invalid owned-web operator configuration (origin, upstream, port or resolver).' >&2; exit 1; }
# grep anchors match individual lines: reject CR/LF across the entire value first.
cr=$(printf '\r')
lf='
'
for value in "${PORT:-8080}" "${OWNED_WEB_ORIGIN:-}" "${API_UPSTREAM:-}" "${PROXY_SHARED_SECRET:-}"; do
  case "$value" in *"$cr"*|*"$lf"*) fail ;; esac
done
# Optional; rendered into a quoted nginx header value, so keep it to a token charset.
# Unset is allowed: skip the grep (grep on zero-byte input has no lines, so even
# a {0,} pattern fails — the old form hard-failed every secretless deployment).
[ -z "${PROXY_SHARED_SECRET:-}" ] || { printf '%s' "$PROXY_SHARED_SECRET" | grep -Eq '^[A-Za-z0-9_-]{1,256}$' || fail; }
export PROXY_SHARED_SECRET="${PROXY_SHARED_SECRET:-}"
case "${PORT:-8080}" in ''|*[!0-9]*) fail ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail
printf '%s' "${OWNED_WEB_ORIGIN:-}" | grep -Eq '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' || fail
printf '%s' "${API_UPSTREAM:-}" | grep -Eq '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' || fail
authority=${API_UPSTREAM#*://}
host=${authority%%:*}
case "$API_UPSTREAM" in
  https://*) ;;
  http://*) case "$host" in *.railway.internal|backend) ;; *) fail ;; esac ;;
  *) fail ;;
esac
if [ "$authority" != "$host" ]; then
  upstream_port=${authority##*:}
  [ "$upstream_port" -ge 1 ] && [ "$upstream_port" -le 65535 ] || fail
fi
[ "$API_UPSTREAM" != "$OWNED_WEB_ORIGIN" ] || fail
# Runtime DNS from the platform; bracket IPv6 nameservers and retain AAAA lookup.
resolver=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)
case "$resolver" in ''|*[!0-9a-fA-F.:]*) fail ;; esac
case "$resolver" in *:*) resolver="[$resolver]" ;; esac
export API_HOST="$authority" API_TLS_NAME="$host" API_RESOLVER="$resolver"
# Optional Loop-IT gateway. Unset copies the main API upstream so /api/loopit/
# stays on Loop-GPT until LOOPIT_API_UPSTREAM is set. http is limited to
# platform-internal names, matching API_UPSTREAM.
if [ -n "${LOOPIT_API_UPSTREAM:-}" ]; then
  case "$LOOPIT_API_UPSTREAM" in *"$cr"*|*"$lf"*) fail ;; esac
  printf '%s' "$LOOPIT_API_UPSTREAM" | grep -Eq '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' || fail
  loopit_authority=${LOOPIT_API_UPSTREAM#*://}
  loopit_host=${loopit_authority%%:*}
  case "$LOOPIT_API_UPSTREAM" in
    https://*) ;;
    http://*) case "$loopit_host" in *.railway.internal|loopit-api|backend) ;; *) fail ;; esac ;;
    *) fail ;;
  esac
  if [ "$loopit_authority" != "$loopit_host" ]; then
    loopit_port=${loopit_authority##*:}
    [ "$loopit_port" -ge 1 ] && [ "$loopit_port" -le 65535 ] || fail
  fi
  export LOOPIT_API_HOST="$loopit_authority" LOOPIT_API_TLS_NAME="$loopit_host"
else
  export LOOPIT_API_UPSTREAM="$API_UPSTREAM"
  export LOOPIT_API_HOST="$API_HOST"
  export LOOPIT_API_TLS_NAME="$API_TLS_NAME"
fi
# Subprocess exports do not reach the stock entrypoint. Render explicitly here.
envsubst '${PORT} ${API_UPSTREAM} ${API_HOST} ${API_TLS_NAME} ${API_RESOLVER} ${PROXY_SHARED_SECRET} ${LOOPIT_API_UPSTREAM} ${LOOPIT_API_HOST} ${LOOPIT_API_TLS_NAME}' \
  < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
# Keep restarts idempotent; the stock renderer must not overwrite these values.
export NGINX_ENVSUBST_TEMPLATE_DIR=/nonexistent
nginx -t
SH
RUN chmod +x /docker-entrypoint.d/19-owned-upstream.sh
ENV PORT=8080 NGINX_ENVSUBST_TEMPLATE_DIR=/nonexistent
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
