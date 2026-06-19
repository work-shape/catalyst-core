# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY . ./

ARG APP_PACKAGE
ARG UI_PACKAGE
ARG VITE_CHAT_API_URL
ARG VITE_CHAT_API_PORT

ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}
ENV VITE_CHAT_API_PORT=${VITE_CHAT_API_PORT}

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm \
    --filter "${APP_PACKAGE}..." \
    --filter "${UI_PACKAGE}..." \
    install --frozen-lockfile
RUN pnpm -r \
  --filter "${APP_PACKAGE}..." \
  --filter "${UI_PACKAGE}..." \
  build

FROM node:24-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production
ARG SERVER_ENTRY
ENV SERVER_ENTRY=${SERVER_ENTRY}

COPY --from=build /app ./

EXPOSE 4100
CMD ["sh", "-c", "node ${SERVER_ENTRY}"]

FROM nginx:1.27-alpine AS ui

ARG UI_DIST_DIR
ARG NGINX_CONFIG_PATH=platform/docker/nginx-spa.conf

COPY --from=build /app/${UI_DIST_DIR} /usr/share/nginx/html
COPY ${NGINX_CONFIG_PATH} /etc/nginx/conf.d/default.conf

EXPOSE 80
