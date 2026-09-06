# Loop GPT production LibreChat: branded UI + full MCP connector suite
FROM ghcr.io/danny-avila/librechat:latest

ENV CONFIG_PATH=/app/librechat.yaml

WORKDIR /app
# NOTE: flat build context (nested dirs were dropped by the railway CLI indexer)
COPY librechat.yaml /app/librechat.yaml
COPY mcp-package.json /app/loop-mcp/package.json

USER root
RUN npm install --omit=dev --no-audit --no-fund --prefix /app/loop-mcp

COPY media-server.mjs /app/loop-mcp/media-server.mjs
COPY code-runner.mjs /app/loop-mcp/code-runner.mjs
COPY selftest.mjs /app/loop-mcp/selftest.mjs

# Branding: inject Loop GPT theme + icon into the prebuilt client at build time.
COPY branding/loop.css /tmp/loop-brand/loop.css
COPY branding/favicon.svg /tmp/loop-brand/favicon.svg
RUN set -e; \
    IDX=$(find /app/client -name index.html | head -1); \
    if [ -n "$IDX" ]; then \
      DIR=$(dirname "$IDX"); \
      mkdir -p "$DIR/assets"; \
      cp /tmp/loop-brand/loop.css "$DIR/assets/loop.css"; \
      cp /tmp/loop-brand/favicon.svg "$DIR/assets/favicon.svg"; \
      grep -q 'assets/loop.css' "$IDX" || sed -i 's|</head>|<link rel="stylesheet" href="/assets/loop.css"><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"></head>|' "$IDX"; \
      echo "[branding] injected into $IDX"; \
    else \
      echo "[branding] WARNING: client index.html not found"; \
    fi

# Sandbox dirs for code execution + file connector (writable by node).
RUN mkdir -p /tmp/loop-sandbox /tmp/loop-files && chown -R node:node /tmp/loop-sandbox /tmp/loop-files
RUN chown -R node:node /app/loop-mcp

USER node

EXPOSE 3080
# Boot: selftest output goes to container stdout (visible in deploy logs); app starts immediately
CMD ["sh", "-c", "(node /app/loop-mcp/selftest.mjs &) ; exec node api/server/index.js"]
# rebuild-cache-bust 0a7c21c
# bust 2026-09-06a
