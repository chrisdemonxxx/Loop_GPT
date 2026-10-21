# syntax=docker/dockerfile:1.7
# Expected HTTP entrypoint: python -m loopit_egress.server
ARG UV_IMAGE=ghcr.io/astral-sh/uv:python3.11-bookworm-slim@sha256:4f5d923c9dcea037f57bda425dd209f3ec643da2f0b74227f68d09dab0b3bb36

FROM ${UV_IMAGE} AS builder
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY . .
RUN uv sync --frozen --no-dev --no-editable --package loopit-egress

FROM ${UV_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PORT=8128 \
    LOOPIT_EGRESS_PORT=3128 \
    LOOPIT_EGRESS_ADMIN_HOST=0.0.0.0 \
    LOOPIT_EGRESS_ADMIN_PORT=8128
WORKDIR /app
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 loopit \
    && useradd --system --uid 10001 --gid loopit --home-dir /app --shell /usr/sbin/nologin loopit
COPY --from=builder --chown=loopit:loopit /app/.venv /app/.venv
USER 10001:10001
EXPOSE 3128 8128
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import os, urllib.request; port=os.environ.get('LOOPIT_EGRESS_ADMIN_PORT', '8128'); urllib.request.urlopen('http://127.0.0.1:%s/healthz' % port, timeout=3).read()"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "loopit_egress.server"]
