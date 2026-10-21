# syntax=docker/dockerfile:1.7
# Expected HTTP entrypoint: python -m loopit_workspace_dispatch.server
ARG UV_IMAGE=ghcr.io/astral-sh/uv:python3.11-bookworm-slim@sha256:4f5d923c9dcea037f57bda425dd209f3ec643da2f0b74227f68d09dab0b3bb36
# Debian's repos have no docker-cli package; the CLI ships as a static binary
# in the official image. Pinned by digest like every other base image here.
ARG DOCKER_CLI_IMAGE=docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${UV_IMAGE} AS builder
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY . .
# e2b extra: Railway sets LOOPIT_SANDBOX_PROVIDER=e2b. The server refuses to
# boot in that mode unless e2b-code-interpreter is installed.
RUN uv sync --frozen --no-dev --no-editable --package loopit-workspace-dispatch --extra e2b

FROM ${UV_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PORT=8005 \
    LOOPIT_WORKSPACE_DISPATCH_PORT=8005 \
    LOOPIT_CONTRACTS_DIR=/opt/loopit/contracts/schemas
WORKDIR /app
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 loopit \
    && useradd --system --uid 10001 --gid loopit --home-dir /app --shell /usr/sbin/nologin loopit
COPY --from=builder --chown=loopit:loopit /app/.venv /app/.venv
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# The tool-call contract schema, for validate_tool_call inside the container.
COPY --chown=loopit:loopit packages/contracts/schemas /opt/loopit/contracts/schemas
USER 10001:10001
EXPOSE 8005
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8005/healthz', timeout=3).read()"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "exec python -m loopit_workspace_dispatch.server --host 0.0.0.0 --port ${PORT:-8005}"]
