# Persistence fixtures

How to run the tests and get a test Postgres: [`tests/README.md`](../README.md). This page holds
the rules of the fixtures.

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

Connections are counted, not hoped for. `scripts/test-postgres-capacity.mjs` holds the budget of
one test file (40 connections, the highest measured is 32) and the arithmetic:
`workers * (budget + 1) + 3 <= max_connections`. `pnpm check:local` starts its server with
`max_connections` for every worker of the machine (618 on 16 cores). On any other server
`vitest.config.ts` reads `max_connections` and runs only as many files side by side as fit, and
says so in one line: a server left at the default of 100 runs two. A file that needs more than
the budget raises the constant; the server and the worker count follow.

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

## Rows from chat: real model acceptance

`POSTGRES_STORE_TEST_DATABASE_URL=<throwaway Postgres URL> pnpm exec vitest run --config vitest.records-live.config.ts tests/data-store-chat.live.ts`

This explicit opt-in suite runs the EN/DE platform-agent journeys with the authenticated
Opus CLI as its model transport. It sends the platform's messages and offered schemas;
the CLI's native tools are disabled. Catalyst executes and confirms the row tools against
synthetic fixtures. It starts no stack and writes its conversation evidence beside the
platform checkout. The ordinary suite covers the deterministic confirmation path.
