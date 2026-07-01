# Vivd Catalyst

This repository is a greenfield foundation for reusable, code-deployed AI agent chat client instances.

The first implementation keeps product-owned contracts separate from adapters and client assembly code:

- `packages/` contains reusable OSS platform packages.
- `clients/demo/` is the generic reference client instance.
- Customer assemblies and premium/restricted capabilities are expected to live in separate repositories that consume these packages.
- Product planning and private deployment notes are intentionally outside this OSS platform repository.

The OSS platform owns generic extension surfaces: tool contracts, capability assembly, datasource registry/adapters, managed files, conversation attachments, managed artifacts, and model-context projection rules. Restricted capabilities plug into those surfaces for heavier or proprietary behavior such as document preprocessing or private hydrated data views.

Run the local vertical slice:

```bash
pnpm install
cp clients/demo/.env.example clients/demo/.env
pnpm dev
```

Paste an OpenAI API key into `.env` before using the default demo config. The demo Compose stack exposes the API on `http://127.0.0.1:4100` and the standalone chat UI on `http://127.0.0.1:5173`.

`pnpm dev` is an alias for `pnpm dev:demo`.

`pnpm dev:demo` runs the demo client stack:

- Docker Compose starts Postgres, the API, the artifact-preview worker, and the UI.
- Workspace packages resolve from `src` through the local `development` export condition.
- The API image is Node-only and does not install LibreOffice, Poppler, or Python document tooling.
- The artifact-preview worker image is the only demo runtime image that installs LibreOffice and Poppler.
- The UI is served from a built Vite bundle.
- A one-shot migration service runs committed Drizzle migrations before the API starts.
- Standalone Better Auth users from `clients/demo/config/app.yaml` are seeded into Postgres on startup.
- You can seed those users explicitly with `pnpm --filter @vivd-catalyst/demo seed:auth`.

Each client has a development Compose file at `docker-compose.yml` and a production-style Compose file at `docker-compose.prod.yml`. The demo stack intentionally avoids premium/restricted capabilities. External deployments can opt into additional capability packages and runtime services without adding those implementations to this repository.

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
pnpm test:e2e:chat-state
```

`pnpm test:e2e` uses a deterministic fixture config so it does not require an OpenAI key.
It runs the standalone chat Playwright suite through `scripts/run-chat-e2e.mjs`, which builds
the required packages, starts an isolated Postgres/API/Vite stack, runs Playwright, and tears the
stack down again. `pnpm test:e2e:chat-state` runs only the `@chat-state` regression subset for
streaming, resume, loading indicators, and session-switching behavior.

The e2e runner defaults to API `4210`, UI `5273`, and Postgres `55433`. Override ports when local
development servers are already using them:

```bash
E2E_API_PORT=4211 E2E_UI_PORT=5274 E2E_POSTGRES_PORT=55434 pnpm test:e2e:chat-state
```

Use `E2E_SKIP_BUILD=1` for a faster rerun when the package dist output is already fresh, or pass
Playwright flags after `--`:

```bash
pnpm test:e2e:chat-state -- --headed
```

The deterministic model provider is kept for local tests and repeatable debugging. The demo client config uses OpenAI by default and lets the model call registered tools automatically.

Storage code uses product-owned store interfaces at package boundaries. The Postgres-backed adapters use Drizzle internally for typed database interactions; Drizzle table/query types should not leak into public platform APIs.

Database schema changes must go through committed migrations. Use `pnpm db:generate` after changing Drizzle schema files, review the generated SQL, and commit the schema and migration together. Do not use `drizzle-kit push` or any `db push` workflow.
