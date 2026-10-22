# Vitest projects

`vitest.projects.config.ts` partitions every `tests/**/*.test.ts` at discovery time. The
`pure` project uses threads with `isolate: false`; it runs together after the `isolated`
project so that Vitest can reuse its workers and module graphs. The global worker budget,
source aliases, timeouts, duration sharding and scale opt-in apply to both projects.

Runtime imports through test helpers, including re-exports, `import()` and `require()`,
keep persistence fixtures and test instances in the isolated project. Type-only imports do
not need persistence. Module mocks also require isolation: their replacements and cached
imports otherwise survive into another file, or fail to replace an already loaded module.

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

Files calling `openConnectionDraft` also stay isolated: SSR leaves its requested draft in a
module singleton, because it cannot run the consuming React effect. The classifier follows
these calls through helpers. The current writers are:

- `chat-ui-connection-draft-approval.test.ts`
- `chat-ui-connection-draft.test.ts`
- `chat-ui-connection-proposal.test.ts`
- `chat-ui-connection-refusals.test.ts`
- `chat-ui-shell-session.test.ts`

The pure project restores stubbed globals and environment values after each file. Stubs created
at file scope remain available to all tests in that file. The upgrade,
probe and live configurations clear the inherited projects and retain their isolated Postgres
setup. `vitest-configs.test.ts` checks that they discover only their opt-in files.

Scale files remain excluded unless `CATALYST_SCALE_TESTS=1`. This includes the source-import
volume cases, 600-row and 100,000-row batch cases, and the full continuation matrix. The default
suite retains the 1,200-row batch case and the four continuation corners (concurrency 1 and 8,
budget 7 and 16).
