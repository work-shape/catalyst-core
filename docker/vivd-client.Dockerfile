# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS deps

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

FROM deps AS build

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

FROM docker:29-cli AS docker-cli

FROM api AS workspace-command-worker

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN docker --version

FROM nginx:1.27-alpine AS ui

ARG UI_DIST_DIR
ARG NGINX_CONFIG_PATH=platform/docker/nginx-spa.conf

COPY --from=build /app/${UI_DIST_DIR} /usr/share/nginx/html
COPY ${NGINX_CONFIG_PATH} /etc/nginx/conf.d/default.conf

EXPOSE 80

FROM deps AS ui-dev

ARG UI_PACKAGE
ARG UI_DEV_PORT=5173

ENV UI_PACKAGE=${UI_PACKAGE}
ENV UI_DEV_PORT=${UI_DEV_PORT}
ENV NODE_ENV=development

RUN pnpm --filter @vivd-catalyst/core build \
  && pnpm --filter @vivd-catalyst/config-schema build

EXPOSE 5173
CMD ["sh", "-c", "pnpm --filter \"${UI_PACKAGE}\" exec vite --host 0.0.0.0 --port ${UI_DEV_PORT}"]
