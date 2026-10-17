# syntax=docker/dockerfile:1.7

# The six release images of a deployment, built from the deployment folder alone. Platform and
# capability code arrives built, as the exact versions the deployment's lockfile pins.
#
# Build context: the deployment folder. Build arguments:
#   DEPLOYMENT_DIR  the folder name the images keep it under, deployment.<instance>. Compose
#                   commands and CLIENT_CONFIG_PATH address /app/deployment.<instance>/...
# Secret npmrc: an npmrc that may read the restricted @work-shape packages. Only the download
# step mounts it; no layer keeps it.
#
# Targets: api, workspace-command-worker, artifact-preview-worker, ui, doc-worker, runner.
# The system layers (LibreOffice, fonts, Python) are copies of those in the source Dockerfiles
# of the platform and capabilities repositories. tests/packages.test.mjs and the capabilities
# test deployment-kit-system-layers.test.ts fail when the package lists drift apart.

FROM node:24-bookworm-slim AS base

RUN corepack enable

FROM base AS deps

# No interactive question before corepack downloads the pnpm of the deployment's packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ARG DEPLOYMENT_DIR
RUN test -n "${DEPLOYMENT_DIR}" || { echo "build argument DEPLOYMENT_DIR is required" >&2; exit 1; }
WORKDIR /app/${DEPLOYMENT_DIR}

# The manifest, the lockfile and the deployment's own pnpm settings, if it has any.
COPY package.json pnpm-lock.yaml .npmr[c] pnpm-workspace.yam[l] ./
# The package tarballs catalyst-deploy pack-local puts in place of the registry; a release
# build has none.
COPY .local-package[s] ./.local-packages/

# Downloads every package the lockfile names into node_modules/.pnpm, which stays in this layer,
# so the offline install below also works on a builder with an empty cache mount.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
  --mount=type=cache,id=catalyst-deployment-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm fetch --frozen-lockfile

COPY . ./

RUN --mount=type=cache,id=catalyst-deployment-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --offline --frozen-lockfile

FROM deps AS server-build

RUN pnpm run build:server \
  && test -s dist/server.js

FROM deps AS ui-build

ARG VITE_CHAT_API_URL=""
ARG VITE_CHAT_API_PORT=""
ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}
ENV VITE_CHAT_API_PORT=${VITE_CHAT_API_PORT}

RUN pnpm run build:ui \
  && test -s dist/client/index.html \
  && mkdir -p /out \
  && cp -R dist/client /out/html \
  && cp node_modules/@work-shape/catalyst-deployment-kit/docker/nginx-spa.conf /out/default.conf

# The packages the runner and the document worker run, each with exactly the packages they
# depend on, taken from the same install. The deployment's own code stays out of both images.
FROM deps AS packages

ARG DEPLOYMENT_DIR
RUN kit=node_modules/@work-shape/catalyst-deployment-kit/docker \
  && node "$kit/copy-packages.mjs" --from . --to /opt/catalyst \
    --commands /opt/catalyst/commands.tsv \
    @work-shape/catalyst-app-build \
    @work-shape/catalyst-asset-repo \
    @work-shape/catalyst-artifact-helpers \
  && node "$kit/copy-packages.mjs" --from . --to /opt/document-worker \
    @work-shape/catalyst-document-worker \
  && test -s /opt/catalyst/commands.tsv \
  && test -d /opt/document-worker/node_modules/@work-shape/catalyst-document-worker \
  && mkdir -p "/opt/document-worker/${DEPLOYMENT_DIR}" \
  && cp -R config "/opt/document-worker/${DEPLOYMENT_DIR}/config"

FROM node:24-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production
ARG DEPLOYMENT_DIR
ENV SERVER_ENTRY=${DEPLOYMENT_DIR}/dist/server.js

COPY --from=server-build /app ./
COPY --from=runner-system /usr/local/share/catalyst/runner-packages.json /usr/local/share/catalyst/runner-packages.json

EXPOSE 4100
CMD ["sh", "-c", "node ${SERVER_ENTRY}"]

FROM docker:29-cli AS docker-cli

FROM api AS workspace-command-worker

ARG DEPLOYMENT_DIR
ENV SERVER_ENTRY=${DEPLOYMENT_DIR}/dist/workspace-command-worker.js

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN docker --version \
  && test -f "${SERVER_ENTRY}"

# Copied from the stage of the same name in platform/docker/vivd-client.Dockerfile.
FROM node:24-trixie-slim AS workspace-artifact-runtime

WORKDIR /workspace
ENV NODE_ENV=production
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV SAL_USE_VCLPLUGIN=svp

RUN --mount=type=cache,id=vivd-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  --mount=type=cache,id=vivd-apt-cache,target=/var/cache/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    file \
    fontconfig \
    fonts-crosextra-caladea \
    fonts-crosextra-carlito \
    fonts-dejavu \
    fonts-inter-variable \
    fonts-lato \
    fonts-liberation \
    fonts-montserrat \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-noto-core \
    fonts-open-sans \
    fonts-roboto \
    fonts-urw-base35 \
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
  && fc-match Carlito | grep -i Carlito > /dev/null \
  && fc-match Caladea | grep -i Caladea > /dev/null \
  && fc-match "Noto Sans" | grep -i "Noto Sans" > /dev/null \
  && fc-match Montserrat | grep -i Montserrat > /dev/null \
  && python3 -c "import docx, openpyxl, pdfplumber, pptx, pypdf, reportlab, xlsxwriter; from PIL import Image" \
  && node --version \
  && soffice --headless --version \
  && pdfinfo -v \
  && pdftoppm -v \
  && convert -version \
  && rm -rf /var/lib/apt/lists/*

FROM workspace-artifact-runtime AS artifact-preview-runtime

WORKDIR /app
ENV NODE_ENV=production

FROM artifact-preview-runtime AS artifact-preview-worker

ARG DEPLOYMENT_DIR
ENV ARTIFACT_PREVIEW_WORKER_ENTRY=${DEPLOYMENT_DIR}/dist/artifact-preview-worker.js

COPY --from=server-build /app ./
COPY --from=runner-system /usr/local/share/catalyst/runner-packages.json /usr/local/share/catalyst/runner-packages.json
RUN test -f "${ARTIFACT_PREVIEW_WORKER_ENTRY}"

CMD ["sh", "-c", "node ${ARTIFACT_PREVIEW_WORKER_ENTRY}"]

FROM nginx:1.27-alpine AS ui

COPY --from=ui-build /out/html /usr/share/nginx/html
COPY --from=ui-build /out/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Copied from the stage document-runtime of capabilities/docker/document-worker.Dockerfile.
FROM node:24-bookworm-slim AS document-runtime

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
    pdfplumber \
    pypdf \
  && rm -rf /var/lib/apt/lists/*

FROM document-runtime AS doc-worker

ENV DOCUMENT_WORKER_ENTRY=node_modules/@work-shape/catalyst-document-worker/dist/server.js

COPY --from=packages /opt/document-worker ./
RUN test -f "${DOCUMENT_WORKER_ENTRY}"

EXPOSE 4110
CMD ["sh", "-c", "node ${DOCUMENT_WORKER_ENTRY}"]

# Copied from the stage runner-base of capabilities/docker/catalyst-runner-base.Dockerfile.
FROM node:24-trixie-slim AS runner-system

WORKDIR /opt/catalyst
ENV NODE_ENV=production
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV WORKSPACE_DIR=/workspace
ENV HOME=/workspace
ENV CATALYST_LAYOUT_LIBRARY_DIR=/usr/local/share/catalyst-layout-library
ENV PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENV SAL_USE_VCLPLUGIN=svp

RUN --mount=type=cache,id=vivd-runner-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  --mount=type=cache,id=vivd-runner-apt-cache,target=/var/cache/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    file \
    fontconfig \
    git \
    fonts-crosextra-caladea \
    fonts-crosextra-carlito \
    fonts-dejavu \
    fonts-inter-variable \
    fonts-lato \
    fonts-liberation \
    fonts-montserrat \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-noto-core \
    fonts-open-sans \
    fonts-roboto \
    fonts-urw-base35 \
    libreoffice-calc-nogui \
    libreoffice-impress-nogui \
    libreoffice-writer-nogui \
    poppler-utils \
    python3 \
    python-is-python3 \
    python3-pip \
    unzip \
  && python3 -m pip install --break-system-packages --no-cache-dir \
    numpy==2.1.3 \
    openpyxl==3.1.5 \
    pandas==2.2.3 \
    pdfplumber==0.11.4 \
    Pillow==10.4.0 \
    pypdf==4.3.1 \
    python-docx==1.1.2 \
    python-pptx==0.6.23 \
    reportlab==4.2.2 \
  && mkdir -p /usr/local/share/catalyst \
  && python3 -m pip list --format=json > /usr/local/share/catalyst/runner-packages.json \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.29.3 --activate \
  && pnpm --version

FROM runner-system AS runner

# The fixed commands of the runner: the Page build, the repository of an asset and every
# artifact helper, linked by the names their packages declare. The build runs each once.
COPY --from=packages /opt/catalyst /opt/catalyst
RUN while IFS="$(printf '\t')" read -r command file; do \
      ln -sf "$file" "/usr/local/bin/$command"; \
    done < /opt/catalyst/commands.tsv \
  && ln -sfn /opt/catalyst/node_modules/@work-shape/catalyst-artifact-helpers/skills/presentations/assets/catalyst-layout-library "$CATALYST_LAYOUT_LIBRARY_DIR" \
  && python3 --version \
  && python --version \
  && python -c "from docx import Document; doc=Document(); doc.add_paragraph('python-docx ok'); print('python-docx ok')" \
  && python -c "from pptx import Presentation; prs=Presentation(); prs.slides.add_slide(prs.slide_layouts[0]); print('python-pptx ok')" \
  && python -c "import numpy, openpyxl, pandas; print('python-tabular ok')" \
  && python -c "import pdfplumber, pypdf, reportlab; print('python-pdf ok')" \
  && python -c "from PIL import Image; Image.new('RGB', (1, 1)); print('pillow ok')" \
  && node --version \
  && git --version \
  && fc-match Carlito | grep -i Carlito > /dev/null \
  && fc-match Caladea | grep -i Caladea > /dev/null \
  && fc-match "Noto Sans" | grep -i "Noto Sans" > /dev/null \
  && fc-match Montserrat | grep -i Montserrat > /dev/null \
  && libreoffice --version \
  && pdfinfo -v >/tmp/poppler-version.txt 2>&1 \
  && unzip -v >/tmp/unzip-version.txt 2>&1 \
  && test -f "$CATALYST_LAYOUT_LIBRARY_DIR/ARTIFACT.md" \
  && test -f "$CATALYST_LAYOUT_LIBRARY_DIR/layout_registry.json" \
  && while IFS="$(printf '\t')" read -r command file; do \
      command -v "$command" && "$command" --version || exit 1; \
    done < /opt/catalyst/commands.tsv \
  && catalyst-page-build --check \
  && catalyst-asset-repo --check

RUN mkdir -p /workspace /tmp \
  && chmod 1777 /workspace /tmp

# Commands run as this user, never as root. The platform's worker names the same ids on
# `docker run` (RUNNER_USER_ID); the image has the user so that a container started without
# them is not root either. HOME stays /workspace.
RUN groupadd --gid 10001 catalyst-runner \
  && useradd --uid 10001 --gid 10001 --home-dir /workspace --no-create-home --shell /bin/bash catalyst-runner \
  && chown 10001:10001 /workspace

USER 10001:10001
WORKDIR /workspace
RUN test "$(id -u)" = "10001" \
  && test "$HOME" = "/workspace" \
  && artifact_runtime_info --version \
  && catalyst-page-build --check \
  && catalyst-asset-repo --check
CMD ["/bin/sh"]
