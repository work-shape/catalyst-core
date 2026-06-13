---
title: Local Demo
description: Run the repository's demo client instance locally.
---

The repository includes a demo client instance at `clients/demo`. It is useful for local testing and for understanding the client assembly shape.

## Requirements

- Node.js compatible with the workspace toolchain
- pnpm 10
- Docker for the local Postgres service
- an OpenAI API key for the default model-backed demo path

## Start The Demo

From the repository root:

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm dev
```

Add your OpenAI API key to `.env` before using the model-backed demo. The demo client owns
its configured tools, prompts, and domain-specific tool result widgets under `clients/demo`.

The demo starts:

- chat API on `http://127.0.0.1:4100`
- demo chat UI on `http://127.0.0.1:5173`
- Postgres through `clients/demo/docker-compose.yml`

## Default Standalone Users

The demo seeds representative standalone users from release config.

Use the credentials configured by:

- `DEMO_SUPERADMIN_EMAIL` / `DEMO_SUPERADMIN_PASSWORD`
- `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`

The example values in the repository are:

- `superadmin@example.test` / `demo-superadmin-password`
- `user@example.test` / `demo-user-password`

Replace seeded credentials before using any production-shaped standalone deployment.

## Useful Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm test:e2e
```

`pnpm test:e2e` uses deterministic fixture config and does not require an OpenAI key.
