---
section: Database
---

- **An agent's call waits for its person's confirmation (EW-2a):** a call whose policy is
  `confirm`, made by an Agent Run's worker, pauses the run instead of being refused. Its
  Operation Run becomes `pending_confirmation` (24 hours), the run becomes
  `waiting_for_decision` and holds no lease and no worker. `operations.decide`
  (`POST /api/v1/operations/runs/:runId/decision`, `{ "decision": "confirm" | "decline",
"reason"?: string }`) records the run owner's decision; the run goes on in a worker in the
  same reply, with the call executed once, or answered to the agent as declined with the
  reason. The same decision again answers the same run; another one is a `409 CONFLICT`. The
  run status `waiting_for_permission` is now `waiting_for_decision`, the event
  `tool_permission_requested` is now `tool_decision_requested` (with `tool_decision_recorded`
  beside it), and the run command `tool_permission_decision` is removed: `continue` is the only
  run command.
- **Migrations:** `0085_agent_run_resume_state` adds the nullable column
  `agent_runs.resume_state` (jsonb), what a waiting run goes on from; it is cleared when the run
  ends. `0086_agent_run_waiting_for_decision_index` recreates the unique index
  `agent_runs_active_conversation_idx` with `waiting_for_decision` in place of
  `waiting_for_permission`, concurrently. No row has ever held `waiting_for_permission`: the
  worker failed such a run instead. **Deploy order:** run the migration step before the new
  release starts, as always. Without it the release refuses to start with: `The database is
behind this release. Run the migration step before starting. Missing migrations:
0085_agent_run_resume_state, 0086_agent_run_waiting_for_decision_index`. **Rollback:** the
  previous release ignores the column, but it knows no `waiting_for_decision` run: such a run
  keeps its conversation from starting another run, and its upkeep never ends it. Before
  starting the previous release, end the waiting runs:
  `UPDATE agent_runs SET status = 'failed', resume_state = NULL, failed_at = now(),
updated_at = now(), error = '{"code":"AGENT_RUN_ROLLED_BACK","message":"The release that
paused this run was rolled back","category":"internal_error"}'::jsonb WHERE status =
'waiting_for_decision'`. The index can stay as it is.

- **Packaging:** postgres-store keeps Drizzle schema snapshots in the source checkout and ships
  only the migration SQL and journal. Runtime migration history and startup checks are unchanged.
