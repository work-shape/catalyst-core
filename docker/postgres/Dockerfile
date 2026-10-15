# syntax=docker/dockerfile:1.7
#
# The Postgres server of an instance: the official image the live hosts ran, unchanged, plus
# pgvector from the PGDG apt repository for the same Debian release (ADR-0023). Only the
# extension's files are added; glibc, the ICU library and Postgres itself stay those of the
# base, so collations do not change and switching to this image is a container restart.
#
# Every input is pinned. The base by the digest of its index, which `postgres:17.11-trixie` and
# the floating `postgres:17` named on 2026-10-14 and which both Musterbau hosts ran. The
# extension by its package version and the SHA-256 of the package for each platform, the
# figures of the PGDG index. The built image is pinned by its own digest in `pinned-image`
# beside this file; the workflow "Postgres image" builds it, tests it and pushes it.
#
# Not pgvector/pgvector: its base and its Debian release are its maintainer's.

ARG POSTGRES_BASE=postgres:17.11-trixie@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3

FROM ${POSTGRES_BASE}

ARG TARGETARCH
ARG PGVECTOR_VERSION=0.8.7-1.pgdg13+1
ARG PGVECTOR_SHA256_AMD64=60420d97c25f1ca907d2d428167e3e3d2a596b183d0d6658099636245f2b98e2
ARG PGVECTOR_SHA256_ARM64=4c20eaf2490a0c28def3a557ca19f955b24c19d9799f1f8c416faf9f94941c3c
# The SHA-256 of this file, which the workflow passes: an image pinned for another revision of
# this file is told apart from one built from this revision.
ARG DOCKERFILE_SHA256=unset

# The base lists PGDG as an apt source for amd64 and arm64 and trusts its key. The package is
# fetched, compared with its pinned sum and installed with dpkg alone, so apt changes no other
# package of the base. Its dependencies, postgresql-17 and libc6, are already there.
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) sum="$PGVECTOR_SHA256_AMD64" ;; \
    arm64) sum="$PGVECTOR_SHA256_ARM64" ;; \
    *) echo "no pgvector package is pinned for $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  before="$(dpkg-query -W -f '${Package}=${Version}\n' | sort)"; \
  cd /tmp; \
  apt-get update; \
  apt-get download "postgresql-17-pgvector=$PGVECTOR_VERSION"; \
  deb="$(ls postgresql-17-pgvector_*.deb)"; \
  echo "$sum  $deb" | sha256sum --check --strict; \
  dpkg --install "$deb"; \
  rm -f "$deb"; \
  rm -rf /var/lib/apt/lists/*; \
  after="$(dpkg-query -W -f '${Package}=${Version}\n' | sort)"; \
  test "$(printf '%s\n' "$after" | grep -vxF "$before")" = "postgresql-17-pgvector=$PGVECTOR_VERSION"; \
  test -f /usr/share/postgresql/17/extension/vector.control

LABEL org.opencontainers.image.source="https://github.com/work-shape/catalyst-core" \
  org.opencontainers.image.description="Postgres 17 of a Catalyst instance: the official image plus pgvector from PGDG" \
  org.opencontainers.image.base.name="${POSTGRES_BASE}" \
  dev.workshape.catalyst.postgres.pgvector="${PGVECTOR_VERSION}" \
  dev.workshape.catalyst.postgres.dockerfile-sha256="${DOCKERFILE_SHA256}"
