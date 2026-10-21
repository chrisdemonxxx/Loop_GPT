# Sandbox base image (P1-3, Doc 02 §4).
#
# Every second this image does not spend on `npm install` is a second the user
# spends watching a spinner and a second of leased CPU the platform pays for.
# Cold dependency installs dominate first-run latency, so the caches, the
# runtimes, and the browsers are all baked in here rather than fetched per run.
#
# Security posture, in order of importance:
#
#   * Nothing in this image holds a credential. Secrets reach a sandbox only as
#     a short-lived, lease-scoped injection from the secrets broker (I2). An
#     image layer is world-readable to anyone who can pull it, and image layers
#     are exactly where leaked keys are found.
#   * The runtime user is unprivileged and owns nothing outside its own
#     workspace. Root inside a microVM is still a much better starting position
#     for an escape than a nobody-user is.
#   * The image is pinned by digest, not by tag. A mutable `:20` tag means the
#     contents of a "reproducible" run change without anything in this repo
#     changing.
#
# This image is the *inner* layer only. Isolation is provided by the microVM
# that runs it (I1); container boundaries are not the security boundary here.

# renovate: datasource=docker depName=node
FROM node:20.18.1-bookworm-slim@sha256:a4b757cd491c7f0b57f57951f35f4e85b7e1ad54dbffca4cf9af0725e1650cd8 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=development \
    # Caches live at fixed, pre-warmed paths so a run finds them without config.
    PNPM_HOME=/opt/caches/pnpm \
    npm_config_cache=/opt/caches/npm \
    UV_CACHE_DIR=/opt/caches/uv \
    PIP_CACHE_DIR=/opt/caches/pip \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

# System packages. `git` is required for checkpoint diffs; `ca-certificates`
# for TLS to the egress proxy; the rest are Playwright's runtime libraries,
# which are not optional and fail at navigation time rather than install time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        python3 \
        python3-venv \
        python3-pip \
        tini \
        libnss3 \
        libnspr4 \
        libdbus-1-3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libatspi2.0-0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libxkbcommon0 \
        libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Agents emit `python file.py` reflexively (and so does every Python template).
# Debian only provides `python3`, so expose the bare name before dropping
# privileges to the runtime user.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# Package managers, pinned. An unpinned `npm i -g pnpm` makes the toolchain
# version a function of build date.
RUN corepack enable \
    && corepack prepare pnpm@9.15.0 --activate \
    && pip3 install --break-system-packages --no-cache-dir uv==0.5.11

# Agent runtime vehicle. Both the production dispatch path and the local docker
# provider start the signed JSON-lines runtime inside the leased sandbox via
# `python -m loopit_agent_runtime`, so the import closure must be baked into the
# image rather than mounted per run. Build this Dockerfile from the repository
# root: `docker build -f sandbox/image/Dockerfile -t loopit-sandbox:latest .`
COPY packages/sandbox-sdk /opt/loopit-src/sandbox-sdk
COPY packages/agent-core /opt/loopit-src/agent-core
COPY packages/patch /opt/loopit-src/patch
COPY sandbox/agent-runtime /opt/loopit-src/agent-runtime
RUN python3 -m pip install --no-cache-dir --break-system-packages \
        /opt/loopit-src/sandbox-sdk \
        /opt/loopit-src/agent-core \
        /opt/loopit-src/patch \
        /opt/loopit-src/agent-runtime \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        "jsonschema>=4.23" "ruff==0.8.4" "mypy==1.13.0" pytest \
    && rm -rf /opt/loopit-src \
    && python3 -c "import loopit_agent_runtime, loopit_sandbox_sdk, loopit_agent_core, loopit_patch" \
    && ruff --version && mypy --version

# Playwright browsers, baked in. Downloading ~300 MB of Chromium on first
# navigation would blow the run's time budget before the agent saw a page — and
# it would require opening egress to a CDN that has no business being reachable
# from a running build.
RUN npm install -g playwright@1.49.1 \
    && playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"

# Pre-warm the dependency caches for the stacks the platform ships templates
# for. This is the single largest cold-start win in the image.
COPY sandbox/image/warmup/ /opt/warmup/
# The exec bit does not survive every VCS/transport (Windows checkouts lose
# it), so set it here rather than trusting the context.
RUN chmod +x /opt/warmup/prewarm.sh \
    && /opt/warmup/prewarm.sh && rm -rf /opt/warmup

# The unprivileged runtime user. `node` exists already in the base image but is
# UID 1000 with a home directory we do not control; an explicit user keeps the
# ownership of the workspace and the caches unambiguous.
RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
    && mkdir -p /workspace /opt/caches \
    && chown -R agent:agent /workspace /opt/caches

USER agent
WORKDIR /workspace

# tini reaps the orphaned dev servers and browser processes an agent run leaves
# behind. Without it PID 1 is a shell, zombies accumulate, and the microVM hits
# its process cap partway through a long run.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

# Deliberately absent, and not an oversight:
#   * No ARG/ENV for API keys, tokens, or registry credentials.
#   * No SSH server. Access is via the signed control-plane channel only (I2).
#   * No sudo. A sandbox that can escalate is a sandbox with one boundary, not
#     two.
