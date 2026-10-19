import { randomUUID } from "node:crypto";
import { test, expect, selected, sql, json, saveObservation } from "./support.mjs";
import { CASES } from "../scripts/agent-stories/catalog.mjs";
import { workflowOracle } from "../scripts/agent-stories/oracles.mjs";
import { until } from "../scripts/agent-stories/processes.mjs";
const id = "workflow-safe-test";
async function deliverySnapshot(story) {
  const [row] =
    await sql`select (select count(*) from approval_requests) as inbox,(select count(*) from notice_mail) as mail,(select count(*) from platform_jobs where kind like '%notice%' or kind like '%mail%' or kind like '%deliver%') as jobs`;
  const mail = await json(story.root.request, "GET", "/api/v1/dev/captured-mail?limit=200");
  const attempts = await fetch(
    `http://127.0.0.1:${process.env.AGENT_STORIES_SAMPLE_PORT}/__story_attempts`,
    { signal: AbortSignal.timeout(5000) }
  ).then((r) => r.json());
  return {
    inbox: Number(row.inbox),
    mail: Number(row.mail),
    jobs: Number(row.jobs),
    captured: mail.items.length,
    attempts: attempts.attempts
  };
}
test(id, async ({ story }) => {
  test.skip(!selected(id));
  const run = await story.start(
    CASES.find((c) => c.id === id).prompt.replace(
      "{name}",
      `synthetic-check-${randomUUID().slice(0, 8)}`
    )
  );
  await story.waitRun(run);
  const workflow = await story.created("workflow", run);
  const before = await deliverySnapshot(story);
  const page = story.actor.page;
  await page.goto(`/w/${story.workspace.id}/workflows/${workflow.name}`);
  await page
    .getByTestId("workflow-page")
    .getByRole("button", { name: "Test run", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Start test run", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  const result = await until(
    async () =>
      (
        await sql`select id,status,mode,definition_revision_id,output,started_by from workflow_runs where id=${runId}`
      )[0],
    (r) => ["done", "failed", "cancelled", "limit_reached"].includes(r?.status),
    story.deadline
  );
  // Drain the actual jobs of this test before taking its negative delivery oracle.
  await until(
    async () =>
      (
        await sql`select count(*) as total from platform_jobs where status in ('queued','running') and (subject=${runId} or payload::text like ${"%" + runId + "%"})`
      )[0],
    (r) => Number(r.total) === 0,
    story.deadline
  );
  const steps =
    await sql`select id,step_type,status,target,output,operation_run_id from workflow_step_runs where run_id=${runId}`;
  const operationIds = steps.map((step) => step.operation_run_id).filter(Boolean);
  const operations = operationIds.length
    ? await sql`select id,operation,status,effect,target from operation_runs where id in ${sql(operationIds)}`
    : [];
  for (const operation of operations) {
    expect(operation.status).toBe("done");
    if (operation.effect === "changing") expect(operation.target).not.toBe("live");
  }
  const jobs =
    await sql`select id,kind,status from platform_jobs where subject=${runId} or payload::text like ${"%" + runId + "%"}`;
  story.observations.jobs = jobs;
  story.observations.operations = [
    ...(story.observations.operations ?? []),
    ...operations.map(({ id, operation, status, target }) => ({
      id,
      operation,
      status,
      target
    }))
  ];
  const after = await deliverySnapshot(story);
  const [current] =
    await sql`select published_revision_id from config_assets where id=${workflow.id}`;
  const [live] =
    await sql`select count(*) as total from workflow_runs where workflow=${workflow.name} and mode='live'`;
  Object.assign(story.observations, {
    runId,
    status: result.status,
    mode: result.mode,
    revision: result.definition_revision_id,
    expectedRevision: workflow.revisionId,
    tester: result.started_by.id,
    expectedTester: story.actor.me.id,
    total: result.output?.value?.total,
    notify: steps
      .filter((s) => s.step_type === "notify")
      .map((s) => ({
        id: s.id,
        status: s.status,
        target: s.target,
        operation: s.output?.value?.wouldHaveDone?.operation
      })),
    deliveries: Object.keys(before).reduce((n, k) => n + Math.max(0, after[k] - before[k]), 0),
    published: current.published_revision_id !== null,
    liveRuns: Number(live.total)
  });
  await saveObservation(story);
  workflowOracle(story.observations);
});
