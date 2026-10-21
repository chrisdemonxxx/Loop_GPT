# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
ENV PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui-kit/package.json packages/ui-kit/package.json
RUN pnpm install --frozen-lockfile --filter @loopit/web...
COPY apps/web apps/web
COPY packages/ui-kit packages/ui-kit
# The trailing ... builds workspace dependencies first: @loopit/ui-kit resolves
# to dist/, which does not exist until its own build runs.
RUN pnpm --filter @loopit/web... build

FROM nginxinc/nginx-unprivileged:1.27-alpine-slim@sha256:ec6b8b1f1bfa594db13e99fc692b9fb816cb7e365927196610f622659de95913
ENV PORT=8080 \
    LOOPIT_API_BASE_URL=http://api:8000 \
    LOOPIT_WEB_API_BASE_URL=/api \
    LOOPIT_PREVIEW_BASE_URL=http://preview-proxy:8003
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
