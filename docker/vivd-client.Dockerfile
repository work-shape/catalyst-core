# syntax=docker/dockerfile:1.7

FROM node:23-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY platform ./platform
COPY deployments ./deployments

ARG APP_PACKAGE
ARG UI_PACKAGE
ARG VITE_CHAT_API_URL

ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm \
  --filter "${APP_PACKAGE}..." \
  --filter "${UI_PACKAGE}..." \
  --filter "@vivd-catalyst/document-worker..." \
  install --frozen-lockfile
RUN pnpm -r \
  --filter "${APP_PACKAGE}..." \
  --filter "${UI_PACKAGE}..." \
  --filter "@vivd-catalyst/document-worker..." \
  build

FROM node:23-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production
ARG SERVER_ENTRY
ENV SERVER_ENTRY=${SERVER_ENTRY}

RUN corepack enable
COPY --from=build /app ./

EXPOSE 4100
CMD ["sh", "-c", "node ${SERVER_ENTRY}"]

FROM node:23-bookworm-slim AS document-runtime

WORKDIR /app
ENV NODE_ENV=production

RUN --mount=type=cache,id=vivd-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  --mount=type=cache,id=vivd-apt-cache,target=/var/cache/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui \
    python3 \
    python3-pip \
    poppler-utils \
  && python3 -m pip install --break-system-packages --no-cache-dir \
    'markitdown[pdf,docx]==0.1.6' \
    pdfplumber \
    pypdf \
  && rm -rf /var/lib/apt/lists/*

FROM document-runtime AS doc-worker

COPY --from=build /app ./

EXPOSE 4110
CMD ["node", "platform/packages/document-worker/dist/server.js"]

FROM nginx:1.27-alpine AS ui

ARG UI_DIST_DIR

COPY --from=build /app/${UI_DIST_DIR} /usr/share/nginx/html
COPY platform/docker/nginx-spa.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
