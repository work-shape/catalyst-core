# @work-shape/catalyst-workflows

The Workflow engine of Workshape Catalyst: the module `workflows`, switched with `modules.workflows.enabled`. The names and shapes other packages read are in `@work-shape/catalyst-core` (`src/workflows.ts`); the design is in `docs/planning/specs/events-workflows-and-guardrails.md`.

The probes that the suite does not run (a loop over 10,000 items in `tests/probes`, and `tests/workflow-worker-kill.test.ts` with its waits in real time under `WORKFLOW_PROBE_REAL_TIME=1`): `pnpm --filter @work-shape/catalyst-workflows probes`, with the test Postgres in `POSTGRES_STORE_TEST_DATABASE_URL`.

## Continue-as-new (EW-CAN; check 112)

A loop opts in with `continueAsNew: { position: "offset" }`. `position` names a field
in the Workflow's `inputs`: declare it as an optional integer for the initial start.
The engine writes the number of rows completed to that field in the successor's input,
including earlier histories. With `batch`, it counts rows rather than batches.
`after: 1000` optionally requests a new history after 1,000 complete iterations;
otherwise the step-run budget and active duration decide when it continues.

For a source that pages by a cursor or last key, add `cursor: "id"` (a dotted item
field path). The declared position input then receives that value from the last
completed row, checked against its own schema, rather than a numeric offset. A
nonempty page continues after the loop, and an empty page proceeds to the following
steps. Map that input into the source operation's cursor parameter. A completed
page starts a fresh source read; an unfinished page retains its remaining rows.

Until resume positions and finished-step outputs are carried between histories, publishing
and draft test runs refuse these shapes, naming the step and rule in English and German:

- A write, send, notify, child Workflow start, or loop containing one before a
  `continueAsNew` loop at the same or any enclosing level. Reads, triggers and code
  steps may precede it; those steps run again in every history.
- A loop after a `continueAsNew` loop at the same or any enclosing level.
- A `limits.stepRuns` budget smaller than the steps before the loop, the loop containers,
  one item and the tail together. The refusal states the minimum count and the limit.

A `continueAsNew` loop can be the last loop, with non-loop steps after it. These are
publish-time restrictions pending EW-CAN-RESUME, which will resume at step boundaries
without repeating finished work.

Each history starts its trigger and fixed steps on the revision published at that
moment. The checkpointed loop resumes its remaining immutable dataset view or inline
items. Checkpoints are internal values, never included in list/read responses. A
history admits a complete next item only when its step budget has room, drains items
already admitted, then commits `continued` and the successor together. New items stop
at a deadline; admitted items finish their current boundary. No process sleeps while
waiting for a successor. Dataset grants transfer before the old history releases them.

The public product contract is `WorkflowRunIdentity.continuation` in catalyst-core and
the matching API schema: `{ rootRunId, previousRunId?, successorRunId?, number }`, numbered from 1. A caller can follow `successorRunId` from a `continued` response, even for an
unkeyed run, without scanning the runs list. The
base `runKey` stays unchanged for idempotent starts; the interface shows `<key>/<number>`.
`continued` releases the per-history key, while its successor holds it. A failed or
cancelled final history releases it as usual. Each step and its usage stay on exactly
one history; totals add the histories, rather than duplicating usage events. Labels
are evaluated from the first trigger and retained, as is the original `onFailure`.
A child continuation transfers the parent's wait; a linked run transfers non-owning
waiters without granting ownership. Only the final history wakes those waiters.

The successor input is checked against the newly published revision. If it no longer
fits, a failed successor records `continuation_invalid` and names the field, with no
input value in its error or audit event. Publishing new instructions does not change
the history already executing. This is the continuation contract for Workflow-fed
Knowledge Bases (KBW-1); consumers pass positions through declared inputs and use the
sequence identity instead of parsing a key or copying another run's history.

Loop outputs `total`, `done` and `failed` cover the whole continuation chain (one Lauf),
including items finished in earlier histories. Later steps reading `each_x.done` or
`each_x.failed`, and a parent reading its child's output, receive these cumulative totals.
The checkpoint carries only fixed-size counts per loop level; it does not keep item results.
