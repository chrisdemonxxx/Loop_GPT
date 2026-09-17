# Loop GPT backend (Express + agent runtime)
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
# Prisma needs OpenSSL to build/detect its query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Both stages use the same committed dependency resolution.
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS validation
COPY scripts/private-storage.mjs ./scripts/private-storage.mjs
COPY vitest.config.ts vitest.integration.config.ts ./
COPY scripts/daily-settlement-worker.mjs ./scripts/daily-settlement-worker.mjs
COPY scripts/api-settlement-worker.mjs ./scripts/api-settlement-worker.mjs
COPY scripts/video-job-worker.mjs ./scripts/video-job-worker.mjs
RUN npm test

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# OpenSSL is required by the Prisma query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY scripts/make-admin.mjs ./scripts/make-admin.mjs
COPY scripts/private-storage.mjs ./scripts/private-storage.mjs
COPY scripts/daily-settlement-worker.mjs ./scripts/daily-settlement-worker.mjs
COPY scripts/api-settlement-worker.mjs ./scripts/api-settlement-worker.mjs
COPY scripts/video-job-worker.mjs ./scripts/video-job-worker.mjs
RUN chmod +x docker-entrypoint.sh
# Runtime-generated data (artifacts, config) live under these dirs.
# Run as the non-root `node` user and give it ownership of the writable dirs.
RUN mkdir -p uploads data && chown -R node:node /app/uploads /app/data
USER node
EXPOSE 3001
CMD ["sh", "./docker-entrypoint.sh"]
