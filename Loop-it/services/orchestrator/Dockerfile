# syntax=docker/dockerfile:1.7
ARG UV_IMAGE=ghcr.io/astral-sh/uv:python3.11-bookworm-slim@sha256:4f5d923c9dcea037f57bda425dd209f3ec643da2f0b74227f68d09dab0b3bb36

FROM ${UV_IMAGE} AS builder
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY . .
RUN uv sync --frozen --no-dev --no-editable --package loopit-orchestrator

FROM ${UV_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    LOOPIT_CONTRACTS_DIR=/opt/loopit/contracts/schemas \
    LOOPIT_TEMPORAL_ADDRESS=temporal:7233 \
    LOOPIT_TEMPORAL_NAMESPACE=default \
    LOOPIT_TEMPORAL_TASK_QUEUE=loopit-runs
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 loopit \
    && useradd --system --uid 10001 --gid loopit --home-dir /app --shell /usr/sbin/nologin loopit
COPY --from=builder --chown=loopit:loopit /app/.venv /app/.venv
COPY --chown=loopit:loopit packages/contracts/schemas /opt/loopit/contracts/schemas
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "loopit_orchestrator.worker"]
