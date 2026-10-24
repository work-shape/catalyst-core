# Workshape Catalyst platform

The platform of Workshape Catalyst: the open-source packages every Catalyst instance is built
from, and the reference clients that assemble them. Customer assemblies and premium capabilities
live in other repositories and consume these packages.

- `packages/`: the platform packages (`@work-shape/catalyst-*`), including the docs site in
  `packages/docs/`.
- `clients/demo/`: the reference client. Tests, the browser suite and the docs use it; it is never
  deployed.
- `clients/chat-standalone/`: the standalone chat client.
- `tests/`: the Vitest suite. `e2e/`: the Playwright suite.
- `scripts/`: checks, the browser test runner, migrations and release tooling.
- `docker/`: the client image and the instance's Postgres image.
- `changes/unreleased/`: change files for the next release.

## Run it

This repository is the `platform/` folder of the Catalyst workspace (`work-shape/catalyst-workspace`),
whose README says how to clone and install everything. From the workspace root:

```sh
pnpm install
sh scripts/local.sh start catalyst  # http://127.0.0.1:5274
```

A deployment repository starts its own local instance against this checkout.
`sh scripts/local.sh check <instance>` says whether one is ready, `stop` stops it and keeps its data.

`pnpm docs:dev` serves the docs site. The reference client on its own is described in
[Run the reference client locally](packages/docs/src/content/docs/getting-started/local-demo.md).

## Test it

```sh
pnpm check:local   # the whole check with a throwaway Postgres; needs Docker
pnpm test:e2e      # the browser suite with its own stack
```

[`tests/README.md`](tests/README.md) says which command and Vitest config runs what, how to get a
test Postgres for single files, and how to run the browser suite.

## Make a change

1. Branch from `main`.
2. A change that users or operators of the packages notice gets a change file
   `changes/unreleased/<branch, with / as ->.md`. Do not edit `CHANGELOG.md`:

   ```md
   ---
   section: Fixed
   ---

   - **Chat:** what changed, in the words of the person who notices it.
   ```

   `section` is one of `Added`, `Changed`, `Fixed` and `Database`; the body is one or more list
   items without headings. A change that breaks config, adds a migration or needs a deploy order
   names the exact refusal text and the rollback caveat. `pnpm check:changes` refuses a file the
   release could not place.

3. A schema change comes with a migration. Change the Drizzle schema, run `pnpm db:generate`, read
   the SQL and commit both together. Never use `drizzle-kit push` or any other schema push.
   Committed migrations never change, a new one expands before a later one contracts, and its
   number follows `main`'s last: `pnpm check:migrations` checks all three against
   `packages/postgres-store/migration-policy.json`. Migrations run as a deploy step; the API and
   the workers never migrate.
4. Push and open a pull request.
5. When the check on the Mac mini runner is green, merge with rebase:
   `gh pr merge --rebase --delete-branch`. On a conflict, rebase onto `main` and push again.

## Code rules

- Storage code works through product-owned store interfaces. The Postgres adapters use Drizzle
  inside; Drizzle table and query types never leak into public platform APIs.
- Interface is built only from `@work-shape/catalyst-ui` and its tokens.
- Lint, type and boundary rules live in `packages/quality-config/` (see its README).

## Releases

[`scripts/release/README.md`](scripts/release/README.md) covers cutting a release
(`pnpm release:cut`), validation and publication, the public mirror, and the pinned Postgres
image. The public mirror ships its own README from `scripts/release/public/README.md`.
