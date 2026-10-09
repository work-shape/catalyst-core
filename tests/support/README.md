# Persistence fixtures

Every persisted platform/capability test uses `createTestInstance()` or `usePostgresSuite()`.
Both use one database per Vitest file, cloned from one lazily migrated template per run.
Both Vitest configs use stack-ordered hooks so suite connections and held transactions close
before file cleanup. Separate pools within a file share the database. `fixtureFile` exists only for lifecycle
probes that simulate two files. Tests are sequential within each file; test-scoped instances
close and public tables reset after each test. Fixtures created in suite setup retain their
state until file teardown. Raw SQL connections must use `fileTestDatabaseUrl()` and close
before the fixture teardown. File teardown drops clones; run teardown also removes leftovers
and the template. Database names use a random run prefix and a bounded hash of the file path.
The configured administrative database is never migrated, reset or dropped.

Set `POSTGRES_STORE_TEST_DATABASE_URL` to a disposable Postgres 17 database reachable by a role
with `CREATEDB` and permission to terminate its own connections. Missing/unreachable Postgres
fails tests. Use `beforeAllWithPostgres` for database suite setup: it reports setup failures on
each test, because Vitest otherwise counts tests behind a failed `beforeAll` as skipped.

The template is migrated by `migrateDatabase`, the entry an operator's migration step runs. It
reads migrations from `CATALYST_TEST_MIGRATIONS_DIRECTORY`, defaulting to
`platform/packages/postgres-store/migrations` independently of the working directory.
`pnpm test:compatibility` runs a release's suite from a checkout of its tag and sets this variable
to the migrations of the commit under test. Stores never migrate: `createPostgresStores` stops on
a database that lacks committed migrations.
The lifecycle test creates a temporary alternate directory and proves its schema is cloned.
Historical migration assertions use disposable empty clones through the same lifecycle owner,
because applying older migrations to a head-migrated template would invalidate those assertions.

Rows follow the real constraints. A test that needs a child row creates its parents through the
stores first: `createConversationForTesting` and `createAgentRunForTesting` on the test store,
`claimAttachmentsForStoredMessage` for sent attachments, a stored workspace command for a file's
last command. Leases are measured against the database clock, so a live lease ends after today.
Two requests that race reach the database on separate connections; assert the outcome, not which
one wins.

A test that needs a fixed time fakes `Date` alone (`vi.useFakeTimers({ toFake: ["Date"] })`).
A test that must advance timeouts uses `fake-clock.ts`: the driver opens connections through a
timeout, so every promise that may reach the database is awaited through its helpers while the
fake clock is installed.

Only the fixtures that made a run's prefix drop the whole run (`close()`); fixtures that joined a
run through `inject("postgresFixturePrefix")` drop the databases they created with `drop()`.

Keep object storage, mail, provider and clock fakes. The capability worker uses real persistence
and an explicit object-storage fake. The deterministic model adapter is unchanged.

With Postgres configured, run from the workspace root:

```sh
pnpm --dir platform exec vitest run tests/test-instance.test.ts
pnpm --dir platform check
pnpm --dir capabilities check
for seed in 1091 1092 1093; do
  pnpm --dir platform exec vitest run --sequence.shuffle.files --sequence.seed="$seed" --reporter=default --reporter=json --outputFile="/tmp/cb3b1-platform-$seed.json" || exit 1
  pnpm --dir capabilities exec vitest run --sequence.shuffle.files --sequence.seed="$seed" --reporter=default --reporter=json --outputFile="/tmp/cb3b1-capabilities-$seed.json" || exit 1
done
```

Inspect all six reports for zero skipped/pending tests. Native-tool/OS gates remain for external
services/tooling; use the fully provisioned Linux runner (Poppler, Python/python-pptx and the
artifact runtime tooling) for the full zero-skip acceptance runs.

For missing-infrastructure verification (expected nonzero exit, failed tests and no skips):

```sh
env -u POSTGRES_STORE_TEST_DATABASE_URL pnpm --dir platform exec vitest run tests/test-instance.test.ts tests/postgres-conversation-store.test.ts tests/platform-stores.test.ts
```

For the existing local chat journey, run `pnpm --dir platform dev:demo` with its documented
local configuration, open `http://127.0.0.1:5173`, send a chat and reload it. Docker and browser
ports are required. The demo remains local.
