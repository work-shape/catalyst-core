# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

WORKDIR /app
RUN corepack enable

# `dependency-filters <package>...` prints `--filter=<name>...` for every workspace project the
# packages declare as a dependency, so that pnpm selects it together with its own dependencies.
# pnpm's `--filter "<package>^..."` would select the same only where the packages name those
# dependencies with `workspace:`. A deployment pins released Catalyst versions instead, and in
# the local workspace root it reaches their source through overrides (`pnpm dev:links` in the
# workspace repository), which that filter does not follow. The helper fails rather than print
# nothing, so that pnpm never runs without a filter.
COPY --chmod=755 <<'EOF' /usr/local/bin/dependency-filters
#!/bin/sh
set -eu
pnpm --recursive list --depth -1 --json | node -e '
  const projects = new Map(
    JSON.parse(require("node:fs").readFileSync(0, "utf8")).map((project) => [project.name, project.path])
  );
  const fail = (message) => {
    console.error(`dependency-filters: ${message}`);
    process.exit(1);
  };
  const names = new Set();
  for (const name of process.argv.slice(1)) {
    const path = projects.get(name);
    if (path === undefined) fail(`no workspace project is named ${name}`);
    const manifest = require(`${path}/package.json`);
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"])
      for (const dependency of Object.keys(manifest[group] ?? {}))
        if (projects.has(dependency)) names.add(dependency);
  }
  if (names.size === 0) fail(`${process.argv.slice(1).join(" ")} depend on no workspace project`);
  for (const name of [...names].sort()) console.log(`--filter=${name}...`);
' "$@"
EOF

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
  && fc-match Carlito | grep -qi Carlito \
  && fc-match Caladea | grep -qi Caladea \
  && fc-match "Noto Sans" | grep -qi "Noto Sans" \
  && fc-match Montserrat | grep -qi Montserrat \
  && python3 -c "import docx, openpyxl, pdfplumber, pptx, pypdf, reportlab, xlsxwriter; from PIL import Image" \
  && node --version \
  && soffice --headless --version \
  && pdfinfo -v \
  && pdftoppm -v \
  && convert -version \
  && rm -rf /var/lib/apt/lists/*

# The command that builds a saved Page (the `apps` module). It runs in the runner image, so it
# is built here from the lockfile and copied there with its production dependencies only. The
# first three steps are those of `deps`, so both stages share their layers.
FROM base AS page-build-command

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm fetch --frozen-lockfile

COPY . ./

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm --filter "@work-shape/catalyst-app-build..." install --offline --frozen-lockfile \
  && pnpm --filter "@work-shape/catalyst-app-build..." build \
  && pnpm --config.inject-workspace-packages=true --filter "@work-shape/catalyst-app-build" deploy --prod --offline /opt/catalyst-page-build

# The command that keeps the repository of an asset. It is built beside the Page build and
# reaches the runner image the same way.
RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm --filter "@work-shape/catalyst-asset-repo..." install --offline --frozen-lockfile \
  && pnpm --filter "@work-shape/catalyst-asset-repo..." build \
  && pnpm --config.inject-workspace-packages=true --filter "@work-shape/catalyst-asset-repo" deploy --prod --offline /opt/catalyst-asset-repo

FROM workspace-artifact-runtime AS workspace-command-runner

# Git is in this image alone: `catalyst-asset-repo` runs it here, in a container without a
# network. The API image and the worker images, which build on other stages, carry none.
RUN --mount=type=cache,id=vivd-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  --mount=type=cache,id=vivd-apt-cache,target=/var/cache/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git \
  && git --version \
  && rm -rf /var/lib/apt/lists/*

COPY --from=page-build-command /opt/catalyst-page-build /opt/catalyst-page-build
COPY --from=page-build-command /opt/catalyst-asset-repo /opt/catalyst-asset-repo
RUN chmod +x /opt/catalyst-page-build/dist/cli.js /opt/catalyst-asset-repo/dist/cli.js \
  && ln -s /opt/catalyst-page-build/dist/cli.js /usr/local/bin/catalyst-page-build \
  && ln -s /opt/catalyst-asset-repo/dist/cli.js /usr/local/bin/catalyst-asset-repo \
  && catalyst-page-build --version \
  && catalyst-page-build --check \
  && catalyst-asset-repo --version \
  && catalyst-asset-repo --check

# Commands run as this user, never as root. The worker names the same ids on `docker run`
# (RUNNER_USER_ID in packages/tool-execution/src/docker-workspace-command-runner.ts); the image
# has the user so that a container started without them is not root either.
RUN groupadd --gid 10001 catalyst-runner \
  && useradd --uid 10001 --gid 10001 --home-dir /workspace --no-create-home --shell /bin/bash catalyst-runner \
  && chown 10001:10001 /workspace

ENV HOME=/workspace
USER 10001:10001
WORKDIR /workspace
RUN test "$(id -u)" = "10001" \
  && catalyst-page-build --check \
  && catalyst-asset-repo --check
CMD ["/bin/bash"]

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# The cache mount only speeds up downloads. "pnpm fetch" also writes every package into
# node_modules/.pnpm, which is part of this layer, and the offline install below links from
# there. A restored layer on a builder with an empty mount therefore still installs.
RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm fetch --frozen-lockfile

COPY . ./

ARG APP_PACKAGE
ARG UI_PACKAGE

RUN --mount=type=cache,id=vivd-pnpm-store,target=/root/.local/share/pnpm/store \
  dependencies=$(dependency-filters "${APP_PACKAGE}" "${UI_PACKAGE}") \
  && pnpm --filter "${APP_PACKAGE}" --filter "${UI_PACKAGE}" ${dependencies} \
    install --offline --frozen-lockfile

FROM deps AS server-build

ARG APP_PACKAGE
ARG ARTIFACT_PREVIEW_WORKER_ENTRY=""

RUN dependencies=$(dependency-filters "${APP_PACKAGE}") \
  && pnpm --fail-if-no-match ${dependencies} build \
  && pnpm --filter "${APP_PACKAGE}" build:server \
  && if [ -n "${ARTIFACT_PREVIEW_WORKER_ENTRY}" ]; then \
    test -f "${ARTIFACT_PREVIEW_WORKER_ENTRY}" \
    && pnpm --filter "${APP_PACKAGE}" exec node --input-type=module -e "const module = await import('@work-shape/catalyst-client-assembly'); if (typeof module.runClientInstanceArtifactPreviewWorker !== 'function') throw new Error('artifact preview worker runtime export is missing');"; \
  fi

FROM deps AS api-dev

ENV NODE_ENV=development

EXPOSE 4100

FROM deps AS ui-build

ARG UI_PACKAGE
ARG VITE_CHAT_API_URL
ARG VITE_CHAT_API_PORT

ENV VITE_CHAT_API_URL=${VITE_CHAT_API_URL}
ENV VITE_CHAT_API_PORT=${VITE_CHAT_API_PORT}

RUN dependencies=$(dependency-filters "${UI_PACKAGE}") \
  && pnpm --fail-if-no-match ${dependencies} build \
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

FROM api-dev AS workspace-command-worker-dev

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

FROM artifact-preview-runtime AS artifact-preview-worker-dev

ENV NODE_ENV=development

COPY --from=deps /app ./

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

# The Vite plugin of chat-ui runs in Node and imports these three from their built output, and
# they import the packages they depend on the same way, so those are built with them. The last
# line loads the plugin as Vite does at start: the image fails to build when a package it needs
# has no built output, instead of the container stopping when it starts.
RUN pnpm \
    --filter "@work-shape/catalyst-core..." \
    --filter "@work-shape/catalyst-config-schema..." \
    --filter "@work-shape/catalyst-ui..." \
    build \
  && pnpm --filter "${UI_PACKAGE}" exec node --input-type=module -e "await import('@work-shape/catalyst-chat-ui/vite');"

EXPOSE 5173
CMD ["sh", "-c", "pnpm --filter \"${UI_PACKAGE}\" exec vite --host 0.0.0.0 --port ${UI_DEV_PORT}"]
