# Build from the REPOSITORY ROOT using the adjacent Dockerfile-specific ignore.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/prisma ./prisma
RUN npx --no-install prisma generate
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3002 STAGING_API_PORT=3001 STAGING_REPLICAS=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/prisma ./prisma
RUN npx --no-install prisma generate
COPY --from=build /app/dist ./dist
COPY backend/scripts/staging-runtime.mjs backend/scripts/private-storage.mjs backend/scripts/daily-settlement-worker.mjs backend/scripts/api-settlement-worker.mjs backend/scripts/video-job-worker.mjs ./scripts/
COPY deploy/owned-staging/prepare-storage.mjs ./scripts/prepare-storage.mjs
RUN mkdir -p /app/data /app/uploads /private-store && chown node:node /app/data /app/uploads /private-store
USER node
EXPOSE 3001 3002
HEALTHCHECK --interval=15s --timeout=6s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/staging-runtime.mjs"]

# Optional attached-PVC maintenance image when the platform cannot override USER.
# Build explicitly with --target storage-maintenance; it prepares an empty dir
# only, exits, and NEVER creates the namespace marker or starts the API/workers.
FROM runtime AS storage-maintenance
USER root
HEALTHCHECK NONE
CMD ["node", "scripts/prepare-storage.mjs"]

# The default build always returns to the non-root supervised runtime.
FROM runtime AS candidate
