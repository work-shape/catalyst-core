---
title: Run the reference client locally
description: Start the repository's reference client as a local test instance.
---

The repository includes a reference client at `clients/demo`. It runs as a local test instance and shows how a client assembly is put together.

## Requirements

- Node.js compatible with the workspace toolchain
- pnpm 10
- Docker for the local Postgres service, the workers and the command sandbox
- an OpenAI API key for the default model

## Start It

From the repository root:

```bash
pnpm install
cp clients/demo/.env.example clients/demo/.env
pnpm dev
```

Add your OpenAI API key to `clients/demo/.env` before you chat with an agent. `pnpm dev` builds
the images itself and generates the demo's local secrets into that file when they are missing.
The reference client keeps its tools, prompts, and tool result widgets under `clients/demo`.

This starts:

- chat API on `http://127.0.0.1:4100`
- the chat UI on `http://127.0.0.1:5173`
- Postgres through `clients/demo/docker-compose.yml`
- the artifact preview worker and the workspace command worker, which runs the agent's commands and Page builds in containers of the runner image it builds

## Default Standalone Users

The reference client seeds standalone users from release config.

Use the credentials configured by:

- `DEMO_SUPERADMIN_EMAIL` / `DEMO_SUPERADMIN_PASSWORD`
- `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`

The example values in the repository are:

- `superadmin@example.test` / `demo-superadmin-password`
- `user@example.test` / `demo-user-password`

Replace seeded credentials before using any production-shaped standalone deployment.

## Tests

```bash
pnpm check:local
pnpm test:e2e
```

`pnpm check:local` runs the whole check with a throwaway Postgres of its own. `pnpm test:e2e`
runs the browser suite with a deterministic fixture config and does not require an OpenAI key.
Both need Docker.
