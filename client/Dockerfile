# Static client build served by nginx. Build from the repo root:  docker build -f client/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci -w client -w shared
COPY shared shared
COPY client client
# Empty = the browser uses its own origin; nginx proxies /rooms and /ws to the server.
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
RUN npm run build -w client

FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1/healthz || exit 1
