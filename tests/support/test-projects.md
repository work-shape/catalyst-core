# Vitest projects

`vitest.projects.config.ts` partitions every `tests/**/*.test.ts` at discovery time:

- `pure`: threads, `isolate: false`, unchanged from DIET-UNIT.
- `postgres`: forks, `isolate: false`, with a separate database per file and shared modules.
- `isolated`: forks, `isolate: true`, for module mocks and the exceptions below.

Runtime imports through helpers, including re-exports, `import()` and `require()`, identify
persistence users. Type-only imports do not need persistence. Isolation is classified separately:
module mocks replace cached imports for a worker's lifetime, so their callers stay isolated.
The worker budget, source aliases, timeouts and scale opt-in apply to every product project.

`toolingFiles` is the single inventory for `vitest.tooling.config.ts` and the product exclusions.
`pnpm test:tooling` runs those tests beside lint in `check:local` and after lint in PR and nightly
checks. The tooling suite uses isolated forks and Postgres for the real CLI PTY tests. The crash
probe `workflow-worker-kill.test.ts` runs only in `vitest.probes.config.ts`.

These pure files use module mocks and therefore remain isolated:

- `chat-ui-conversation-palette.test.ts`
- `chat-ui-right-verb-words.test.ts`
- `chat-ui-user-menu.test.ts`
- `chat-ui-workflow-run-steps.test.ts`
- `config-cli-skill-pull.test.ts`
- `e2e-instance-turn.test.ts`
- `knowledge-worker-ready.test.ts`
- `ui-chart-load.test.ts`

The shared-worker and UTC runs also found these files require isolation. They are listed
explicitly in `vitest.projects.config.ts`:

| File                                      | Failure without isolation                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `chat-ui-connection-create.test.ts`       | A draft left by an earlier SSR file opens a later dialog step.                     |
| `chat-ui-thread-time.test.ts`             | A UTC thread does not apply the test's `process.env.TZ` change.                    |
| `chat-ui-connection-typed.test.ts`        | A pending draft bypasses the initial MCP/type selector.                            |
| `chat-ui-workflow-fix-with-agent.test.ts` | A reused flow observer receives no height.                                         |
| `chat-ui-workflow-rights.test.ts`         | A reused flow observer receives no height.                                         |
| `ui-chart.test.ts`                        | Earlier renders have loaded the lazy engine; the initial skeleton assertion fails. |
| `ui-library-page-head-fold.test.ts`       | DOM prototype spies no longer find `clientWidth`.                                  |
| `ui-table-fold.test.ts`                   | DOM prototype spies no longer find `clientWidth`.                                  |
| `ui-tabs-scroll.test.ts`                  | DOM prototype spies no longer find `clientWidth`.                                  |

The infrastructure file also stays isolated: its rootless provider-check tests install fake
timers without creating an infrastructure root. The original per-test timer cleanup must run
before Postgres reset. Applying it to every shared file would undo unrelated files' fake clocks.

| File                             | Failure without isolation                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure.test.ts`         | Rootless fake-clock checks leave timers installed, so Postgres reset waits on a timer that cannot fire.                                                                                                       |
| `chat-server-agent-runs.test.ts` | With unpaced streaming, the second send is accepted after the first run has already completed, and cancellation still observes the last token in the stream. Keeps real pacing for both unchanged assertions. |

Files calling `openConnectionDraft` also stay isolated: SSR leaves its requested draft in a
module singleton, because it cannot run the consuming React effect. The classifier follows
these calls through helpers. The current writers are:

- `chat-ui-connection-draft-approval.test.ts`
- `chat-ui-connection-draft.test.ts`
- `chat-ui-connection-proposal.test.ts`
- `chat-ui-connection-refusals.test.ts`
- `chat-ui-shell-session.test.ts`

Both shared projects restore real timers, spies, stubbed globals and environment values after
each file. File-scoped stubs remain available to every test in that file. Postgres setup files
run in list order: cleanup registers first, then `postgres-file-hooks.ts` registers fixture hooks
for each file. Helpers export their registration functions; they still register themselves in
isolated and opt-in configurations. `test-instance` resets suite retention and instance tracking
at file start. Stack-ordered teardown releases helper resources before closing instances and
dropping file databases. `vitest-projects.test.ts` exercises both shared worker lifetimes.

The shared Postgres setup replaces deterministic streaming with the same word deltas and completed
event, without its 20 ms per-chunk sleep. It installs at file start and restores after the file;
before each test it reinstalls only when a prior test restored all mocks. Existing file-specific
stream spies take precedence. A test that requires pacing can restore the spy in its own setup.
Product provider code is unchanged.

`http-runtime-boundary`, `postgres-executor-guards` and `postgres-executor-tls` remove the process
listeners they install. They can share a worker.

The upgrade, probe, live and tooling configurations clear inherited projects and exclusions, so
they discover only their opt-in files. `vitest-configs.test.ts` checks these suites and the exact
product/tooling partition.

Scale files remain excluded unless `CATALYST_SCALE_TESTS=1`. This includes the source-import
volume cases, 600-row and 100,000-row batch cases, and the full continuation matrix. The default
suite retains the 1,200-row batch case and the four continuation corners (concurrency 1 and 8,
budget 7 and 16).
