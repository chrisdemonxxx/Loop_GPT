# Loop GPT backend (Express + agent runtime)
FROM node:20-slim AS build
WORKDIR /app
# Prisma needs OpenSSL to build/detect its query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# OpenSSL is required by the Prisma query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
# Runtime-generated data (artifacts, config) live under these dirs.
# Run as the non-root `node` user and give it ownership of the writable dirs.
RUN mkdir -p uploads data && chown -R node:node /app/uploads /app/data
USER node
EXPOSE 3001
CMD ["./docker-entrypoint.sh"]
