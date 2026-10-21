# syntax=docker/dockerfile:1.7
# Expected HTTP entrypoint: python -m loopit_api.
ARG UV_IMAGE=ghcr.io/astral-sh/uv:python3.11-bookworm-slim@sha256:4f5d923c9dcea037f57bda425dd209f3ec643da2f0b74227f68d09dab0b3bb36

FROM ${UV_IMAGE} AS builder
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY . .
# uv.lock still omits packages the API imports at boot (git sync, hosting,
# patch, local domains). Name them explicitly so a frozen sync installs them.
RUN uv sync --frozen --no-dev --no-editable \
    --package loopit-api \
    --package loopit-store \
    --package loopit-deployer \
    --package loopit-patch \
    --package loopit-domains \
    --package loopit-verify

FROM ${UV_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    LOOPIT_CONTRACTS_DIR=/opt/loopit/contracts/schemas \
    PORT=8000 \
    LOOPIT_PROJECTS=/var/lib/loopit/projects
WORKDIR /app
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 loopit \
    && useradd --system --uid 10001 --gid loopit --home-dir /app --shell /usr/sbin/nologin loopit \
    && mkdir -p /var/lib/loopit/projects \
    && chown -R loopit:loopit /var/lib/loopit
COPY --from=builder --chown=loopit:loopit /app/.venv /app/.venv
COPY --chown=loopit:loopit packages/contracts/schemas /opt/loopit/contracts/schemas
# Platform volumes (Railway network mounts) attach root-owned regardless of
# image contents - unlike docker named volumes, which inherit the image dir's
# ownership. Boot as root under tini, hand the projects root to the runtime
# user, then drop privileges for the app process itself.
COPY <<'SH' /app/entrypoint.sh
#!/bin/sh
set -eu
chown 10001:10001 /var/lib/loopit/projects || true
exec setpriv --reuid=10001 --regid=10001 --init-groups -- \
    python -m loopit_api --host 0.0.0.0 --port "${PORT:-8000}"
SH
RUN chmod +x /app/entrypoint.sh
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/entrypoint.sh"]
