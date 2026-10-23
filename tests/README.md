# How to test

Every command runs from the platform root. Most tests need a test Postgres (below); the browser
suite starts its own.

## What runs what

- `pnpm test` (`vitest.config.ts`): every `tests/**/*.test.ts`, then the deployment kit's own
  tests. `vitest.projects.config.ts` splits the files into two projects: `pure` shares workers,
  `isolated` gives each file a fresh one (anything that reaches Postgres or mocks a module).
- `pnpm test:upgrade` (`vitest.upgrade.config.ts`): `tests/upgrade/`, a database of the oldest
  supported release migrated to this commit.
- `pnpm test:compatibility` (`scripts/migrations/compatibility.mjs`): the database tests of the
  previous and the oldest supported release, run against this commit's schema.
- `pnpm --filter @work-shape/catalyst-workflows probes` (`vitest.probes.config.ts`): the Workflow
  engine's probes in `tests/probes/` and the killed-worker test, one at a time.
- `pnpm exec vitest run --config vitest.records-live.config.ts`: `tests/data-store-chat.live.ts`,
  real-model journeys through the authenticated Opus CLI. Opt-in only.
- `pnpm test:e2e` and `pnpm test:e2e:chat-state` (`playwright.config.ts`, started by
  `scripts/run-chat-e2e.mjs`): the browser suite in `e2e/`, or its `@chat-state` subset.
- `pnpm test:release` (`node --test`): the release tooling against local fixtures.

A scale test (`tests/**/*.scale.test.ts`) proves a property at a customer's volume and takes
minutes. Vitest leaves those files out unless `CATALYST_SCALE_TESTS=1` is set:

```sh
CATALYST_SCALE_TESTS=1 pnpm exec vitest run tests/workflow-run-blocks.scale.test.ts
```

## The checks

- `pnpm check`: build, format, lint, types, OpenAPI, contract, migrations, change files, `pnpm test`
  and `pnpm test:upgrade`. It needs a test Postgres.
- `pnpm check:local`: the same steps with a throwaway Postgres of its own; needs Docker. After the
  build the steps run side by side and every failed step is repeated at the end.
  `CHECK_LOCAL_SERIAL=1` runs them one after another; `CATALYST_TEST_WORKERS` caps the test files
  run at once.
- `pnpm check:affected`: only the packages and tests a branch reaches, compared with `origin/main`
  (`--list` shows the selection).
- `pnpm check:images`: builds the demo's API and UI images the way a deployment builds them.
  Run it after changing a package manifest, a `tsconfig.json` or `docker/vivd-client.Dockerfile`.

## A test Postgres

Database tests read `POSTGRES_STORE_TEST_DATABASE_URL`. Without it they fail; they never skip.
The role needs `CREATEDB`: every test file gets its own database, cloned from one migrated
template (`tests/support/README.md`).

Inside the Catalyst workspace, wrap the command and a throwaway server is started and removed for
it:

```sh
node ../scripts/lane/test-postgres.mjs -- pnpm exec vitest run tests/test-instance.test.ts
```

Anywhere else, start the instance's Postgres image yourself. The image is private on GHCR, so
sign in to `ghcr.io` first:

```sh
docker run --detach --name catalyst-test-postgres --publish 127.0.0.1:55432:5432 \
  --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_USER=catalyst --env POSTGRES_PASSWORD=local-check --env POSTGRES_DB=catalyst_test \
  "$(grep '^ghcr.io/' docker/postgres/pinned-image)" -c max_connections=400
export POSTGRES_STORE_TEST_DATABASE_URL=postgres://catalyst:local-check@127.0.0.1:55432/catalyst_test
```

Vitest asks the server for `max_connections` and runs only as many files side by side as fit
(`scripts/test-postgres-capacity.mjs`); it prints one line when that is fewer than the machine
could run.

## Browser tests

`pnpm test:e2e` needs Docker and no OpenAI key: it uses a deterministic fixture config. It builds
the packages, starts its own Postgres, API and Vite stack, runs Playwright and tears the stack
down. Defaults are API `4210`, UI `5273` and Postgres `55433`; move them when something already
listens there:

```sh
E2E_API_PORT=4211 E2E_UI_PORT=5283 E2E_POSTGRES_PORT=55434 pnpm test:e2e:chat-state
```

- `E2E_SKIP_BUILD=1` skips the build when the packages' `dist` is fresh.
- Playwright flags go after `--`: `pnpm test:e2e:chat-state -- --headed`.
- Two runs that share one Postgres server must not share a database. Give each run an empty
  database with `E2E_EXTERNAL_POSTGRES=1 E2E_DATABASE_URL=postgres://…/e2e_run1`; the runner
  then creates and drops no database or role.
- `node scripts/run-chat-e2e.mjs --help` lists every option.
