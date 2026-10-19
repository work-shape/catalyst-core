# Local real-model stories

From `platform/` in a composite workspace:

```sh
pnpm test:agent-stories --stories S2,S5,S14
```

This explicitly starts paid calls through the normal demo's shipped `workflow_assistant`. It acquires the composite workspace's `scripts/lane/browser` once; that helper acquires heavy before browser. The helper and private `platform/clients/demo/.env` containing `OPENAI_API_KEY` must exist in that workspace. Missing prerequisites stop with exit 2. The command never falls back to another checkout's credentials, a shared server or `e2e-server`.

The owned stack's agents run on the demo binding `gpt56Luna` (gpt-5.6-luna) at reasoning effort `xhigh`, because it is cheap. A rerun can choose another binding and effort, for instance to tell model weakness from a platform bug when a story fails on Luna:

```sh
pnpm test:agent-stories --stories S2 --model primary --reasoning high
```

Only the stack's own copy changes: its `primary` binding takes the chosen binding's model at that effort, and its staged copy of the demo's agents carries that effort, because an agent's own effort outranks its binding's. `clients/demo/config/app.yaml` and the shipped agents stay as they are. A reused stack keeps the model it was started with and refuses `--model`/`--reasoning`. The manifest records the chosen binding, model and effort; each usage event records the model it called and any effort a person picked for its run, and the Runs line shows both what was chosen and the models agent runs actually called.

Selection accepts only nonempty S1–S17 ids. Cases are deduplicated and run serially once, with no Playwright retries. S2 selects `workflow-safe-test`, S5 `stateful-app`, S14 `live-skill-consent`. Other ids remain unimplemented. A mixed selection runs its implemented cases and still exits 2 for uncovered ids. The plan prints before building or starting services.

The App publisher chooses its workspace audience; if the shipped policy asks for approval, the setup reviewer approves that exact request through the normal Inbox. Workflow prompts use a fresh synthetic name because deletion preserves revision history. The fixture uses ordinary synthetic members, workspace grants and a separate setup session. Setup preserves the shipped superadmin tool references. Builders receive ordinary use grants on the two read-only sample Connections held by the shipped Workflow account, so discovery can offer that account without supplying its name in a prompt. It seeds the normal shared Workflow account once via committed `seedDemo`, with scratch URLs/config and a separate ephemeral CLI credential file. Generated assets are resolved from successful creation receipts, their conversation, revision actor and run; seeded assets cannot satisfy a case. Generated reads keep the asset’s workspace scope and request files only for file-backed kinds. The Workflow test records the active draft revision. Source is retained without editing it. Workspace cleanup runs as its owner with the name confirmation, waits for deletion, then removes the people; a cleanup failure preserves the primary verdict and accounting. Model answers are never graded.

The owned stack builds the normal demo and a uniquely tagged command runner, starts the pinned Postgres image read from `docker/postgres/pinned-image` with 618 connections, explicitly migrates it, and starts API/UI/workspace/knowledge services. The sample-system proxy counts attempts without retaining request contents. The UI build receives only its scratch API address, never the model key. Mail stays capture-only. API/worker output is discarded; evidence contains controlled phases rather than raw service/provider logs. Seed diagnostics retain only request paths/statuses and source stack frames. The seed adapter keeps workspace package imports external so their declared dependencies resolve from their owning packages.

The approved trial ceilings are 2 million tokens, EUR 10 in demo accounting and 60 minutes including startup and cleanup. Startup has at most 20 minutes; App and Workflow each 12; skill 6. Both scratch daily and monthly spend ceilings are at most EUR 10. The existing product admission reserves conservative cost before a call. The all-call watchdog includes title/worker usage and unsettled reservations, never resets at a period boundary, stops new work and requests actor cancellation at a limit. In-flight overshoot is reported. Missing cost accounting blocks. These are test ceilings, not provider invoice guarantees. The later 5M-token / EUR-20 / 120-minute ceiling is documentation only in this slice. The manager reserves and settles each invocation against the approved EUR-100/calendar-month pilot; the runner never edits Brain or maintains a ledger.

Reports are private under the composite workspace's `tmp/agent-stories/<UTC>-<id>/`: manifest, per-case assertions and generated source, summary and Markdown report with a ready-to-paste Runs line. Each case records all-call token/cost deltas, including unsettled reservations, and elapsed time. Playwright clears only its `playwright/` child directory; stack credentials, ownership and reports remain outside it. No trace/video, raw SSE, HTTP headers, cookies or auth bodies are retained as evidence. `.private/` is temporary credential/store data and is removed with a cold stack. Retain evidence for 14 days, longer only for an open finding. Screenshots, when added for a finding, must show synthetic content after credentials leave the screen.

Exit 0 means selected implemented **cases** passed and every selected story has a case; it never means complete story coverage. Exit 1 means fail/unstable. Exit 2 means tooling/budget/prerequisite failure or an uncovered requested id. Language, phone, broader discovery, full journeys and records writing remain acceptance work; every report lists them. There is no diagnostic retry option in this slice; a failed safety case is never retried seeking green.

For an explicitly retained debug stack:

```sh
pnpm test:agent-stories --stories S2,S5,S14 --keep-stack
pnpm test:agent-stories --stories S2,S5,S14 --reuse /absolute/path/to/owned/stack.json
```

Keeping a stack retains its protected setup credentials and stores for reuse. Reuse is restricted to this workspace's private receipt, matching source (including dirty files), capabilities ref, builds, config, migrations, entrypoint, Docker owner and worker readiness, and an exclusive idle lease. The usage baseline is captured before idle/readiness checks, so refusal charges no inherited calls. Only the explicitly inspected future maintenance schedules are permitted; active runs, reservations and unknown or model jobs still refuse reuse. Existing spend reduces the remaining allowance. New actors/data are created each invocation; counters are never reset. Reused services are retained. Inspect fixture cleanup status after failures. Never reuse arbitrary loopback URLs. A source change or commit invalidates a receipt. `resources.json` records the exact debug processes and Docker names for eventual owner cleanup; never prune Docker or kill by a shared port.

`pnpm test` runs `tests/agent-stories-runner.test.ts`, which invokes the deterministic Node tests. Those test selection, reuse validation, process failure/SIGTERM cleanup, budget cancellation, canary redaction, state-oracle rejection and paid/ordinary discovery separation. They make no provider calls. Existing deterministic App/Workflow/consent regressions remain unchanged. A mutation-observation unit test proves oracle rejection; only a real browser/model trial establishes the generated journey. Product-mutation evidence must name the existing regression and its precise claim.
