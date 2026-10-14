# Workshape Catalyst

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
- A one-shot migration service runs committed Drizzle migrations before the API starts; the API and the workers never migrate.
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
pnpm check:local
pnpm check:images
pnpm test:e2e
pnpm test:e2e:chat-state
```

`pnpm check:local` is `pnpm check` with a throwaway Postgres 17 container of its own; it needs Docker.

`pnpm check:images` builds the API and UI images of the demo client in the layout of a deployment's
build workspace, where only the client and what it depends on is installed, and keeps no image. It
needs Docker and is its own job in the hosted check. Run it after changing a package manifest, a
`tsconfig.json` or `docker/vivd-client.Dockerfile`.

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

Runs on one machine that share a Postgres server must not share its `agent_chat` database: one
run's migration, fixtures and cleanup would erase the other's data. Give each run an empty
database of its own and name it with `E2E_DATABASE_URL`, together with `E2E_EXTERNAL_POSTGRES=1`.
The runner creates and drops no database or role; the specs read the same variable.

```bash
E2E_EXTERNAL_POSTGRES=1 E2E_DATABASE_URL=postgres://me:secret@127.0.0.1:5432/e2e_run1 pnpm test:e2e:chat-state
```

The hosted check runs the same `pnpm test:e2e` as its own job. It provides the database itself
and sets `E2E_EXTERNAL_POSTGRES=1`, so the runner starts no container there.

### Images of the hosted checks

A hosted runner shares its address with many others, and a public registry limits what an address
may pull without a sign-in: `public.ecr.aws` answered "toomanyrequests" to the Postgres image and
failed a release check twice. The checks therefore pull such an image from a copy in the
organisation's own registry, `ghcr.io/vivd-solutions/mirror/NAME`, by digest.

`.github/mirrored-images` lists the images, one `NAME:TAG DIGEST` per line. The workflow "Mirror
images" copies what the registry does not hold yet, with all platforms and the digest of the
original, from the first public registry that serves it. It runs when the list changes on `main`,
every Monday and by hand. The weekly run pulls nothing; it fails when a copy is gone.

Who pulls the copy: the service containers of a deployment's release checks, until they move
to the instance's Postgres image below. To move to another version, change the line in
`.github/mirrored-images`, let "Mirror images" run on `main`, and then change the digest in the
deployments' workflows.

The checks here and the capabilities' start the instance's own Postgres image instead
(ADR-0023): `docker/postgres/Dockerfile`, the official image the live hosts ran plus pgvector,
pinned by digest in `docker/postgres/pinned-image`. `.github/scripts/start-postgres.sh` and
`pnpm check:local` read that file, and the demo Compose files repeat it. The workflow "Postgres
image" checks the pinned image with `docker/postgres/check-image.sh`; when the Dockerfile changed,
it builds the image, checks it, pushes it for amd64 and arm64 on a push to a branch of this
repository and fails with the line to pin. Commit that line here and in the capabilities', the
demo's and the deployments' files that name the digest. The package is the repository's; a job
signs in to `ghcr.io` with its own token before it pulls.

The package `mirror/postgres` is public, because it is the unchanged official image and a pull
request from a fork has to read it. An image that is built from, not started (`node`, `nginx`,
`docker` in `docker/vivd-client.Dockerfile`), still comes from Docker Hub, which by GitHub's
account does not limit hosted runners.

Use `E2E_SKIP_BUILD=1` for a faster rerun when the package dist output is already fresh, or pass
Playwright flags after `--`:

```bash
pnpm test:e2e:chat-state -- --headed
```

The deterministic model provider is kept for local tests and repeatable debugging. The demo client config uses OpenAI by default and lets the model call registered tools automatically.

Storage code uses product-owned store interfaces at package boundaries. The Postgres-backed adapters use Drizzle internally for typed database interactions; Drizzle table/query types should not leak into public platform APIs.

Database schema changes must go through committed migrations. Use `pnpm db:generate` after changing Drizzle schema files, review the generated SQL, and commit the schema and migration together. Do not use `drizzle-kit push` or any `db push` workflow. Committed migrations never change, and a new migration expands before a later one contracts: `pnpm check:migrations` checks both against `packages/postgres-store/migration-policy.json`.

Branches built side by side generate the same next migration number. `pnpm check:migrations` also
stops a migration whose number `main` (and `origin/main`) already gives to another one, with the
steps to renumber it onto `main`'s head; the hosted check runs it before the long suite.

## Changelog

A change that users or operators of the packages notice gets an entry, and the entry is a file of
its own, so two pull requests never edit the same lines of `CHANGELOG.md`. Add
`changes/unreleased/<branch>.md`, named after the branch with `/` as `-` (more than one file per
branch is fine), and do not edit `CHANGELOG.md`:

```md
---
section: Fixed
---

- **Chat:** what changed, in the words of the person who notices it. A change that breaks config,
  adds a migration or needs a deploy order names the exact refusal text and the rollback caveat.
```

`section` is one of `Added`, `Changed`, `Fixed` and `Database`; the entry is one or more Markdown
list items without headings. `pnpm check:changes` (part of `pnpm check`) refuses a file the release
could not place, and `pnpm changelog` prints the next release's section as it will read.

The release runs `pnpm changelog --release <version>` (`--date YYYY-MM-DD`, default today) and
commits the result with the version bump. It turns the Unreleased section of `CHANGELOG.md` into
`## <version> — <date>`, puts each file's entry after the entries already in its section, files in
name order, and deletes the files. Entries in the Unreleased section of `CHANGELOG.md` are the ones
written before change files existed.
