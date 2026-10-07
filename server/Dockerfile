# Game server image. Build from the repo root:  docker build -f server/Dockerfile .
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install only what the server needs (workspace manifests first for layer caching).
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci --omit=dev -w server -w shared

COPY shared shared
COPY server server

# tsx runs the TypeScript sources directly (no separate build step for the MVP).
USER node
EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
