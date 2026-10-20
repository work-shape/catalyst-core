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
- You can seed those users explicitly with `pnpm --filter @work-shape/catalyst-demo seed:auth`.

Each client has a development Compose file at `docker-compose.yml` and a production-style Compose file at `docker-compose.prod.yml`. The demo stack intentionally avoids premium/restricted capabilities. External deployments can opt into additional capability packages and runtime services without adding those implementations to this repository.

Default standalone login users:

- `DEMO_SUPERADMIN_EMAIL` / `DEMO_SUPERADMIN_PASSWORD`
- `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`

The example values are `superadmin@example.test` / `demo-superadmin-password` and
`user@example.test` / `demo-user-password`.

Builder's pre-review check (from this repository's root):

```bash
git fetch origin main
pnpm check:affected
```

This checks packages changed since the merge base with `origin/main`, plus every dependent in
our workspace graph. It includes staged, unstaged and untracked edits. It builds their dependency
prerequisites, checks package types, lints complete package scopes against the quality baseline,
and runs tests whose imports reach those packages (including through test support). Knip resolves
the whole workspace before findings are restricted to selected scopes. Set
`POSTGRES_STORE_TEST_DATABASE_URL` for database tests, as with `pnpm test`.

Shared configuration and tooling changes conservatively select all packages and tests, including
`packages/quality-config/` and model adapter sources read by its rules. Selected packages always
run the whole shared test typecheck, since Vitest strips types. A root-test-only edit runs that
test (or tests importing changed support files) and the shared test typecheck, without package
builds or lint.
Docs and change files alone select no packages. Use `pnpm check:affected --list` to inspect the
selection, or `AFFECTED_BASE=<ref>` for a different comparison base. The full integration and
browser checks still run in the landing batch.
Before it builds anything, it refuses a test Postgres whose `max_connections` has too little room for
the test files it would run at once, and prints the `docker run` command for one of the right size.

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

`pnpm check:local` runs the steps of `pnpm check` with a throwaway Postgres 17 container of its own;
it needs Docker. After the build it runs the other steps side by side, each line led by its step's name,
and repeats the output of every failed step at the end. `CHECK_LOCAL_SERIAL=1` runs them one after
another, and `CATALYST_TEST_WORKERS` sets how many test files the suite runs at once.

`pnpm check:images` builds the API and UI images of the demo client in the layout of a deployment's
build workspace, where only the client and what it depends on is installed, and keeps no image. It
needs Docker and is its own job in the hosted check. Run it after changing a package manifest, a
`tsconfig.json` or `docker/vivd-client.Dockerfile`.

A scale test proves a property at a customer's volume, such as a loop over 1,000 items or 600 child
runs, and takes minutes. It is a file `tests/**/*.scale.test.ts`, which `pnpm test`, `pnpm check`,
`pnpm check:local` and the lander's gate leave out. The nightly hosted check, a dispatched one and a
release push run them with `CATALYST_SCALE_TESTS=1`; so does
`CATALYST_SCALE_TESTS=1 pnpm exec vitest run tests/workflow-run-blocks.scale.test.ts` locally. Without
the variable, Vitest finds no test in a scale file even when it is named.

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

The checks here start the instance's own Postgres image instead
(ADR-0023): `docker/postgres/Dockerfile`, the official image the live hosts ran plus pgvector,
pinned by digest in `docker/postgres/pinned-image`. `.github/scripts/start-postgres.sh` and
`pnpm check:local` read that file, and the demo Compose files repeat it. The workflow "Postgres
image" checks the pinned image with `docker/postgres/check-image.sh`; when the Dockerfile changed,
it builds the image, checks it, pushes it for amd64 and arm64 on a push to a branch of this
repository and fails with the line to pin. Commit that line here and in the capabilities', the
demo's and the deployments' files that name the digest.

`work-shape/catalyst-postgres` is private and belongs to `work-shape/catalyst-core`.
Before another repository consumes it, grant that repository **Read** under **Manage Actions
access** in the [package settings](https://github.com/orgs/work-shape/packages/container/catalyst-postgres/settings).
This applies to `catalyst-capabilities`, `deployment.catalyst` and
`deployment.musterbau` when they switch to the pinned image. Keep core's existing
publishing access. Repository transfers and image publication do not grant these other
repositories access. Each consuming workflow also needs `packages: read` and must sign in
with its own `GITHUB_TOKEN` before pulling (service containers use `credentials`). A successful
registry login alone does not prove access to the package.

If Actions reports `manifest unknown`, first inspect the exact pin with an authorized
local Docker login: `docker manifest inspect "$(grep '^ghcr.io/' docker/postgres/pinned-image)"`.
If the digest resolves locally, check the failing repository's Actions access and token
permissions before rebuilding or changing the pin. A local pull uses the local credential;
rerun the failing workflow to verify its repository token can pull too. Keep the package
private; local Compose and checks that pull it require an authorized registry login as well.

Capabilities CI currently starts stock Postgres 17.6 from public ECR. The deployments install
versioned npm packages for their release checks and use stock Postgres in Compose. Granting
package access does not switch those consumers to the pinned image.

Images used as build inputs (`node`, `nginx`, `docker` in
`docker/vivd-client.Dockerfile`) still come from Docker Hub, which by GitHub's account does not
limit hosted runners.

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

From a clean release branch, run `pnpm release:cut 0.8.0 --root ../capabilities` to cut both
repositories. `--root` is required: core and capabilities always cut together. Every root, package
and reference-client manifest advances to that version, including private packages; dependencies
stay `workspace:*`.
Both repositories must share one current version. The command refuses SemVer build metadata,
invalid versions, versions at or below any current package version, detached HEADs, and dirty
trees (including staged and untracked files) in either repository before making changes.

The cut uses `scripts/release/changelog.mjs` to turn each repository's Unreleased section and
change files into `## <version> — <today>`, then deletes the folded files. Empty companion releases
get a version section too. It refreshes OpenAPI and runs `release:check` before creating one
`chore(release): cut <version>` commit per repository. A failed gate leaves the cut uncommitted
for inspection; restore or commit it before retrying from a clean tree. Both cuts are staged and
verified before either commit. If a commit fails, the error lists both repository SHAs and exact
commands to finish the staged cut or undo both cuts; do not rerun `release:cut`. Run both
repositories' `pnpm check` on scratch release branches to validate the cut. The command never tags, pushes or
publishes; CI publication on a release tag is a separate step.

`pnpm changelog --release <version> --date YYYY-MM-DD` remains available for folding change files
alone. Entries in the Unreleased section of `CHANGELOG.md` are the ones written before change
files existed.

A release that offers the Connect a local agent command publishes the CLI of its version to npm
before it names that version in `PUBLISHED_CLI_VERSION` and before the instance switches on
`personalApiKeys`. The order is in `packages/docs/src/content/docs/configure/cli.md`, For
maintainers.
