# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
ENV PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui-kit/package.json packages/ui-kit/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --frozen-lockfile --filter @loopit/admin...
COPY packages/contracts packages/contracts
COPY packages/ui-kit packages/ui-kit
COPY apps/admin apps/admin
RUN pnpm --filter @loopit/admin... build

FROM nginxinc/nginx-unprivileged:1.27-alpine-slim@sha256:ec6b8b1f1bfa594db13e99fc692b9fb816cb7e365927196610f622659de95913
ENV PORT=8081 \
    LOOPIT_ADMIN_API_BASE_URL=http://abuse-engine:8007
COPY --from=builder /app/apps/admin/dist /usr/share/nginx/html
COPY apps/admin/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["wget", "-qO-", "http://127.0.0.1:8081/healthz"]
