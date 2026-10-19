import { randomUUID } from "node:crypto";
import { test, expect, selected, sql, json, saveObservation, terminal } from "./support.mjs";
import { CASES } from "../scripts/agent-stories/catalog.mjs";
import { consentOracle } from "../scripts/agent-stories/oracles.mjs";
import { until } from "../scripts/agent-stories/processes.mjs";
const id = "live-skill-consent";
const instruction = "For synthetic bookkeeping examples, show amounts in EUR.";
async function state(name, conversationId) {
  const [row] =
    await sql`select (select count(*) from config_assets where kind='skill' and name=${name}) as assets,(select count(*) from config_asset_revisions r join config_assets a on a.id=r.asset_id where a.kind='skill' and a.name=${name}) as revisions,(select count(*) from execution_workspace_files where conversation_id=${conversationId} and deleted_at is null and path like '%SKILL.md') + (select count(*) from file_sets f join config_assets a on a.id=f.owner_id where a.kind='skill' and a.name=${name}) as files`;
  return { Assets: Number(row.assets), Revisions: Number(row.revisions), Files: Number(row.files) };
}
function collect(story, prefix, values) {
  for (const [key, value] of Object.entries(values)) story.observations[prefix + key] = value;
}
async function pending(run, deadline) {
  return until(
    async () => {
      const [call] =
        await sql`select id,status from operation_runs where conversation_id=${run.conversationId} and origin->>'agentRunId'=${run.runId} and status='pending_confirmation'`;
      if (call) return call;
      const [agent] = await sql`select status from agent_runs where id=${run.runId}`;
      if (terminal(agent))
        throw new Error("Agent finished without the required live-save confirmation");
      return null;
    },
    Boolean,
    deadline
  );
}
test(id, async ({ story }) => {
  test.skip(!selected(id));
  test.setTimeout(6 * 60_000);
  story.deadline = Math.min(story.deadline, Date.parse(story.startedAt) + 6 * 60_000);
  const prompt = CASES.find((c) => c.id === id).prompt;
  const name = `synthetic-consent-${randomUUID().slice(0, 8)}`;
  const denied = await story.start(prompt.replace("{name}", name));
  const first = await pending(denied, story.deadline);
  story.observations.pendingStatus = first.status;
  story.observations.operations = [{ id: first.id, status: first.status }];
  const page = story.actor.page;
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  const before = await state(name, denied.conversationId);
  collect(story, "before", before);
  expect(before).toEqual({ Assets: 0, Revisions: 0, Files: 0 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  const reconnect = await state(name, denied.conversationId);
  collect(story, "reconnect", reconnect);
  expect(reconnect).toEqual({ Assets: 0, Revisions: 0, Files: 0 });
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await story.waitRun(denied);
  collect(story, "denied", await state(name, denied.conversationId));
  const [refused] = await sql`select status from operation_runs where id=${first.id}`;
  story.observations.deniedStatus = refused.status;
  story.observations.operations[0].status = refused.status;
  // A fresh request and conversation, never a retry of the denied mutation.
  const allowedName = `synthetic-consent-${randomUUID().slice(0, 8)}`;
  const allowed = await story.start(prompt.replace("{name}", allowedName));
  const second = await pending(allowed, story.deadline);
  story.observations.operations.push({ id: second.id, status: second.status });
  const beforeAllow = await state(allowedName, allowed.conversationId);
  expect(beforeAllow).toEqual({ Assets: 0, Revisions: 0, Files: 0 });
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await story.waitRun(allowed);
  const skill = await story.created("skill", allowed);
  const [asset] =
    await sql`select a.scope_id,r.config from config_assets a join config_asset_revisions r on r.id=a.active_revision_id where a.id=${skill.id}`;
  const count = async () =>
    (
      await sql`select count(*) as total from audit_events where type='config_asset.updated' and metadata->>'operationRunId'=${second.id}`
    )[0].total;
  const after = await state(allowedName, allowed.conversationId);
  Object.assign(story.observations, {
    allowedAssets: after.Assets,
    allowedRevisions: after.Revisions,
    allowedExecutions: Number(await count()),
    instructionMatches: asset.config.content?.trim() === instruction,
    ownerMatches: asset.scope_id === story.workspace.id
  });
  await json(
    story.actor.context.request,
    "POST",
    `/api/v1/operations/runs/${second.id}/decision`,
    { decision: "confirm" },
    [200, 409]
  );
  await until(
    async () =>
      (
        await sql`select count(*) as total from platform_jobs where status in ('queued','running') and payload::text like ${"%" + allowed.runId + "%"}`
      )[0],
    (row) => Number(row.total) === 0,
    story.deadline
  );
  const replay = await state(allowedName, allowed.conversationId);
  story.observations.replayRevisions = replay.Revisions;
  story.observations.replayExecutions = Number(await count());
  await saveObservation(story);
  consentOracle(story.observations);
});
