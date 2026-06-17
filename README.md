# Vivd Catalyst

This repository is a greenfield foundation for reusable, code-deployed AI agent chat client instances.

The first implementation keeps product-owned contracts separate from adapters and client assembly code:

- `packages/` contains reusable platform packages.
- `clients/demo/` is the generic reference client instance.
- Customer assemblies such as Musterbau live outside this repo under `../deployments/<customer>/`.
- `docs/` keeps product planning and architecture decisions.

Run the local vertical slice:

```bash
pnpm install
cp clients/demo/.env.example clients/demo/.env
pnpm dev
```

Paste an OpenAI API key into `.env` before using the default demo config. The demo Compose stack exposes the API on `http://127.0.0.1:4100`, the document worker on `http://127.0.0.1:4110`, and the standalone chat UI on `http://127.0.0.1:5173`.

`pnpm dev` is an alias for `pnpm dev:demo`. To run the Musterbau customer assembly from the top-level workspace instead:

```bash
cd ..
cp deployments/musterbau/.env.example deployments/musterbau/.env
pnpm dev:musterbau
```

`pnpm dev:demo` runs the demo client stack:

- Docker Compose starts Postgres, S3Mock, the API, the document worker, and the UI.
- Workspace packages resolve from `src` through the local `development` export condition.
- The API image is Node-only and does not install LibreOffice, Poppler, or Python document tooling.
- The document worker image owns DOCX-to-PDF conversion, PDF text/page extraction, and on-demand page rendering.
- The UI is served from a built Vite bundle.
- API startup runs committed Drizzle migrations when `RUN_MIGRATIONS` is not `false`.
- Standalone Better Auth users from `clients/demo/config/app.yaml` are seeded into Postgres on startup.
- You can seed those users explicitly with `pnpm --filter @vivd-catalyst/demo seed:auth`.

The Musterbau client follows the same local shape from `../deployments/musterbau` and can seed users from the top-level workspace with `pnpm --filter @vivd-catalyst/musterbau seed:auth`.

Each client has a development Compose file at `docker-compose.yml` and a production-style Compose file at `docker-compose.prod.yml`. The development stack includes S3Mock. The production-style stack keeps Postgres local by default but expects real object storage configuration through environment variables.

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

Database schema changes must go through committed migrations. Use `pnpm db:generate` after changing Drizzle schema files, review the generated SQL, and commit the schema and migration together. Do not use `drizzle-kit push` or any `db push` workflow.
