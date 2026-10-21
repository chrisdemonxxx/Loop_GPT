#!/usr/bin/env bash
# Pre-warm dependency caches at image build time (P1-3).
#
# The goal is a populated cache, not a populated node_modules. Projects get
# their own tree; what they must not do is re-download the same few hundred
# tarballs from the registry on every cold start, over a proxied egress path,
# while the user watches a spinner.
#
# Each stack is warmed in a throwaway directory so nothing but the cache
# survives into the image.
set -euo pipefail

warm_node() {
    local name="$1"
    shift
    local dir
    dir="$(mktemp -d)"
    echo "warming node stack: ${name}"
    (
        cd "${dir}"
        npm init -y >/dev/null 2>&1
        # `--lockfile-only` fills the store without building a tree we would
        # immediately discard.
        pnpm add --lockfile-only "$@" >/dev/null 2>&1
    )
    rm -rf "${dir}"
}

warm_python() {
    local name="$1"
    shift
    echo "warming python stack: ${name}"
    # Install into a throwaway target: every wheel passes through UV_CACHE_DIR
    # (which survives in the image) while the target dir is deleted, so a
    # project's runtime environment stays exactly what that project asks for.
    # (`uv pip download` does not exist; --target is the cache-warming form.)
    uv pip install --target /tmp/uv-warm "$@" >/dev/null 2>&1
    rm -rf /tmp/uv-warm
}

# Keep this list in step with stack-templates/. A template whose dependencies
# are not warmed here silently reintroduces the cold-start cost this image
# exists to remove.
warm_node "react-postgres" react react-dom vite @vitejs/plugin-react typescript vitest pg
warm_node "express-api" express zod pino tsx typescript vitest
warm_node "tooling" eslint prettier @types/node

warm_python "fastapi" fastapi uvicorn pydantic httpx pytest
warm_python "tooling" ruff mypy

echo "cache warm-up complete"
