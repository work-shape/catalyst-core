# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

WORKDIR /app
RUN corepack enable

FROM base AS workspace-artifact-runtime

WORKDIR /workspace
ENV NODE_ENV=production
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PYTHONDONTWRITEBYTECODE=1

RUN --mount=type=cache,id=vivd-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  --mount=type=cache,id=vivd-apt-cache,target=/var/cache/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    file \
    fontconfig \
    fonts-dejavu \
    fonts-liberation \
    imagemagick \
    jq \
    libreoffice-calc-nogui \
    libreoffice-impress-nogui \
    libreoffice-writer-nogui \
    poppler-utils \
    python3 \
    python3-pip \
    unzip \
    zip \
  && python3 -m pip install --no-cache-dir --break-system-packages \
    Pillow==10.4.0 \
    XlsxWriter==3.2.0 \
    openpyxl==3.1.5 \
    pdfplumber==0.11.4 \
    pypdf==4.3.1 \
    python-docx==1.1.2 \
    python-pptx==0.6.23 \
    reportlab==4.2.2 \
  && /bin/bash --version \
  && python3 -c "import docx, openpyxl, pdfplumber, pptx, pypdf, reportlab, xlsxwriter; from PIL import Image" \
  && node --version \
  && soffice --headless --version \
  && pdfinfo -v \
  && pdftoppm -v \
  && convert -version \
  && rm -rf /var/lib/apt/lists/*

FROM workspace-artifact-runtime AS workspace-command-runner

WORKDIR /workspace
CMD ["/bin/bash"]

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm fetch --frozen-lockfile

COPY . ./

ARG APP_PACKAGE
ARG UI_PACKAGE

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm \
    --filter "${APP_PACKAGE}..." \
    --filter "${UI_PACKAGE}..." \
    install --offline --frozen-lockfile

FROM deps AS server-build

ARG APP_PACKAGE
ARG ARTIFACT_PREVIEW_WORKER_ENTRY=""

RUN pnpm --filter "${APP_PACKAGE}^..." build \
  && pnpm --filter "${APP_PACKAGE}" build:server \
  && if [ -n "${ARTIFACT_PREVIEW_WORKER_ENTRY}" ]; then \
    test -f "${ARTIFACT_PREVIEW_WORKER_ENTRY}" \
    && pnpm --filter "${APP_PACKAGE}" exec node --input-type=module -e "const module = await import('@vivd-catalyst/client-assembly'); if (typeof module.runClientInstanceArtifactPreviewWorker !== 'function') throw new Error('artifact preview worker runtime export is missing');"; \
  fi

FROM deps AS ui-build

ARG UI_PACKAGE
ARG VITE_CHAT_API_URL
ARG VITE_CHAT_API_PORT

ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}
ENV VITE_CHAT_API_PORT=${VITE_CHAT_API_PORT}

RUN pnpm --filter "${UI_PACKAGE}^..." build \
  && pnpm --filter "${UI_PACKAGE}" build:ui

FROM node:24-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production
ARG SERVER_ENTRY
ENV SERVER_ENTRY=${SERVER_ENTRY}

COPY --from=server-build /app ./

EXPOSE 4100
CMD ["sh", "-c", "node ${SERVER_ENTRY}"]

FROM docker:29-cli AS docker-cli

FROM api AS workspace-command-worker

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN docker --version

FROM workspace-artifact-runtime AS artifact-preview-runtime

WORKDIR /app
ENV NODE_ENV=production

FROM artifact-preview-runtime AS artifact-preview-worker

ARG ARTIFACT_PREVIEW_WORKER_ENTRY
ENV ARTIFACT_PREVIEW_WORKER_ENTRY=${ARTIFACT_PREVIEW_WORKER_ENTRY}

COPY --from=server-build /app ./
RUN test -n "${ARTIFACT_PREVIEW_WORKER_ENTRY}" \
  && test -f "${ARTIFACT_PREVIEW_WORKER_ENTRY}"

CMD ["sh", "-c", "node ${ARTIFACT_PREVIEW_WORKER_ENTRY}"]

FROM nginx:1.27-alpine AS ui

ARG UI_DIST_DIR
ARG NGINX_CONFIG_PATH=platform/docker/nginx-spa.conf

COPY --from=ui-build /app/${UI_DIST_DIR} /usr/share/nginx/html
COPY ${NGINX_CONFIG_PATH} /etc/nginx/conf.d/default.conf

EXPOSE 80

FROM deps AS ui-dev

ARG UI_PACKAGE
ARG UI_DEV_PORT=5173
ARG VITE_CHAT_API_URL
ARG VITE_CHAT_API_PORT

ENV UI_PACKAGE=${UI_PACKAGE}
ENV UI_DEV_PORT=${UI_DEV_PORT}
ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}
ENV VITE_CHAT_API_PORT=${VITE_CHAT_API_PORT}
ENV NODE_ENV=development

RUN pnpm --filter @vivd-catalyst/core build \
  && pnpm --filter @vivd-catalyst/config-schema build

EXPOSE 5173
CMD ["sh", "-c", "pnpm --filter \"${UI_PACKAGE}\" exec vite --host 0.0.0.0 --port ${UI_DEV_PORT}"]
