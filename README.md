# Agent Chat Platform

This repository is a greenfield foundation for reusable, code-deployed AI agent chat client instances.

The first implementation keeps product-owned contracts separate from adapters and client assembly code:

- `packages/` contains reusable platform packages.
- `clients/demo/` is a thin client instance that imports platform packages, defines release config, and registers custom tools.
- `docs/` keeps product planning and architecture decisions.

Run the local vertical slice:

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm dev
```

Paste an OpenAI API key into `.env` before using the default demo config. The demo API listens on `http://127.0.0.1:4100` and the standalone chat UI listens on `http://127.0.0.1:5173`.

`pnpm dev` runs the demo client stack:

- `clients/demo` starts Postgres with `docker compose up -d postgres`.
- Workspace packages resolve from `src` through the local `development` export condition.
- The API starts from `clients/demo/src/server.ts` with `tsx watch` and restarts when client, config, tool, env, or platform package source changes.
- The standalone UI starts with Vite from `packages/chat-standalone` and hot reloads standalone and shared chat UI/package source changes.
- API startup runs idempotent migrations when `RUN_MIGRATIONS` is not `false`.
- Standalone Better Auth users from `clients/demo/config/app.yaml` are seeded into Postgres on startup.
- You can seed those users explicitly with `pnpm --filter @agent-chat-platform/demo seed:auth`.

Default standalone login users:

- `DEMO_SUPERADMIN_EMAIL` / `DEMO_SUPERADMIN_PASSWORD`
- `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`

The example values are `superadmin@example.test` / `demo-superadmin-password` and
`user@example.test` / `demo-user-password`.

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm test:e2e
```

`pnpm test:e2e` uses a deterministic fixture config so it does not require an OpenAI key.

The deterministic model provider is kept for local tests and repeatable debugging. The demo client config uses OpenAI by default and lets the model call registered tools automatically.

Storage code uses product-owned store interfaces at package boundaries. The Postgres-backed adapters use Drizzle internally for typed database interactions; Drizzle table/query types should not leak into public platform APIs.
