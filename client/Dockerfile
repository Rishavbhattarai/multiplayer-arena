# Static client build served by nginx. Build from the repo root:  docker build -f client/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci -w client -w shared
COPY shared shared
COPY client client
# Empty = the browser uses <page host>:8080, which matches docker-compose port mapping.
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
RUN npm run build -w client

FROM nginx:1.27-alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
