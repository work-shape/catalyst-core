// Scheduled maintenance remains queued between ticks. Only these inspected, non-model
// schedules may wait on an otherwise idle normal demo; every unknown job is refused.
const PASSIVE_TICKS = new Set([
  "conversation.expire",
  // Adopters cannot start model work when the active-run/reservation checks below are zero.
  "agent_run.adopt",
  "workspace_command.adopt_legacy",
  "workspace_command.clean_temp_state",
  "connection_bindings.keep_alive",
  "notice.deliver_mail",
  "data_store.measure_size_tick",
  "data_store.upgrade_owned_tick",
  "execution_workspace.cleanup",
  "audit.prune",
  "platform_jobs.prune",
  "platform_jobs.adopt_legacy",
  "usage.backfill_attribution",
  "usage.recover_abandoned_calls",
  "usage.reconcile",
  "connection_setup_sessions.sweep",
  "infrastructure.check",
  "infrastructure.check_sandbox",
  "operation_runs.expire",
  "operation_runs.recover",
  "operation_call.remove_ended_input",
  "asset_repo.sweep",
  "workflow_run.repair_schedules",
  "workflow_run.prune_data",
  "workspace_command.sweep",
  "workflow_run.sweep_code"
]);
export function requireIdle({ runs, pending, jobs }, now = Date.now()) {
  if (runs || pending) throw new Error("Refusing active model work on reuse");
  for (const job of jobs) {
    if (
      job.status !== "queued" ||
      !PASSIVE_TICKS.has(job.kind) ||
      job.dedupe_key !== `schedule:${job.kind}` ||
      new Date(job.run_after).getTime() <= now
    )
      throw new Error("Refusing active or unknown queued work on reuse");
  }
}
