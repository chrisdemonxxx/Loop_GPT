# Context: REPOSITORY ROOT (builds the Next.js product UI in frontend/ and
# serves its static export through the hardened shared nginx template).
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
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN} \
    NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
    NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST}
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
# Static export; then the hardened shell-only PWA worker + icons.
RUN npm run build && node build/pwa.mjs

FROM nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284 AS runtime
COPY --from=build /app/out /usr/share/nginx/html
COPY web/nginx.template.conf /etc/nginx/templates/default.conf.template
COPY <<'SH' /docker-entrypoint.d/19-owned-upstream.sh
#!/bin/sh
set -eu
fail() { echo 'Invalid owned-web operator configuration (origin, upstream, port or resolver).' >&2; exit 1; }
# grep anchors match individual lines: reject CR/LF across the entire value first.
cr=$(printf '\r')
lf='
'
for value in "${PORT:-8080}" "${OWNED_WEB_ORIGIN:-}" "${API_UPSTREAM:-}"; do
  case "$value" in *"$cr"*|*"$lf"*) fail ;; esac
done
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
# Subprocess exports do not reach the stock entrypoint. Render explicitly here.
envsubst '${PORT} ${API_UPSTREAM} ${API_HOST} ${API_TLS_NAME} ${API_RESOLVER}' \
  < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
# Keep restarts idempotent; the stock renderer must not overwrite these values.
export NGINX_ENVSUBST_TEMPLATE_DIR=/nonexistent
nginx -t
SH
RUN chmod +x /docker-entrypoint.d/19-owned-upstream.sh
ENV PORT=8080 NGINX_ENVSUBST_TEMPLATE_DIR=/nonexistent
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
