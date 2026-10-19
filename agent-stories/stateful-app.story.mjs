import { until } from "../scripts/agent-stories/processes.mjs";
import { test, expect, selected, session, frame, saveObservation, sql } from "./support.mjs";
import { CASES } from "../scripts/agent-stories/catalog.mjs";
import { appOracle } from "../scripts/agent-stories/oracles.mjs";
const id = "stateful-app";
test(id, async ({ story, browser }) => {
  test.skip(!selected(id));
  const run = await story.start(CASES.find((c) => c.id === id).prompt);
  await story.waitRun(run);
  const app = await story.created("app", run);
  const page = story.actor.page;
  await page.goto(`/w/${story.workspace.id}/app-drafts/${app.name}`);
  await page.getByTestId("app-edit").getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const audience = dialog.getByTestId("app-publish-audience");
  const choice = audience.getByRole("radio").nth(1);
  await choice.click();
  await expect(choice).toBeChecked();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  // Keep the shipped policy: where sharing asks for review, the setup reviewer
  // with the shipped approve right decides the frozen request through the Inbox.
  const published = await until(
    async () => {
      const [asset] = await sql`select published_revision_id from config_assets where id=${app.id}`;
      const [approval] =
        await sql`select id from approval_requests where kind='app_publish' and status='pending' and payload#>>'{subject,assetId}'=${app.id} and requested_by->>'id'=${story.actor.me.id}`;
      return { revision: asset?.published_revision_id, approval };
    },
    (state) => Boolean(state.revision || state.approval),
    story.deadline
  );
  if (published.approval) {
    story.watch(story.root);
    const reviewer = await story.root.newPage();
    await reviewer.goto(`/inbox/${published.approval.id}`);
    await expect(reviewer.getByTestId("publish-review")).toBeVisible();
    await reviewer.locator('button[data-decision="approve"]').click();
    const approved = await until(
      async () =>
        (await sql`select published_revision_id from config_assets where id=${app.id}`)[0],
      (asset) => Boolean(asset?.published_revision_id),
      story.deadline
    );
    expect(approved.published_revision_id).toBe(app.revisionId);
    story.observations.approvals = [
      { id: published.approval.id, kind: "app_publish", status: "approved" }
    ];
    await reviewer.close();
    if (await dialog.isVisible())
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  }
  await expect(dialog).toBeHidden();
  const path = `/w/${story.workspace.id}/apps/${app.name}`;
  await page.goto(path);
  const rows = (p) => frame(p).getByRole("table").locator("tbody").getByRole("row");
  await expect(frame(page).getByLabel("Leave date", { exact: true })).toBeVisible();
  await frame(page).getByRole("button", { name: "Submit", exact: true }).click();
  story.observations.invalidRows = await rows(page).count();
  expect(story.observations.invalidRows).toBe(0);
  const before =
    await sql`select values from app_user_storage where app_id=${app.id} and user_id=${story.actor.me.id}`;
  story.observations.baseline = { calls: before.length };
  await frame(page).getByLabel("Leave date", { exact: true }).fill("2026-11-01");
  const persisted = page.waitForResponse(
    (r) => r.url().endsWith("/storage") && r.request().method() === "POST" && r.status() === 200
  );
  await frame(page).getByRole("button", { name: "Submit", exact: true }).click();
  const receipt = await persisted;
  expect(receipt.headers()["operation-run-id"]).toBeTruthy();
  const [persistedState] =
    await sql`select values from app_user_storage where app_id=${app.id} and user_id=${story.actor.me.id}`;
  expect(JSON.stringify(persistedState?.values)).toContain("2026-11-01");
  story.observations.storageCommitted = true;
  await expect(rows(page)).toHaveCount(1);
  story.observations.validRows = await rows(page).count();
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  story.observations.reloadedRows = await rows(page).count();
  const fresh = await session(browser, story.watch, story.people[0]);
  await fresh.page.goto(path);
  await expect(rows(fresh.page)).toHaveCount(1);
  story.observations.freshRows = await rows(fresh.page).count();
  const other = await session(browser, story.watch, story.people[1]);
  await other.page.goto(path);
  await expect(frame(other.page).getByLabel("Leave date", { exact: true })).toBeVisible();
  await expect(frame(other.page).getByText("No requests yet", { exact: true })).toBeVisible();
  const otherState =
    await sql`select values from app_user_storage where app_id=${app.id} and user_id=${other.me.id}`;
  expect(JSON.stringify(otherState)).not.toContain("2026-11-01");
  story.observations.otherRows = await rows(other.page).count();
  story.observations.errors = story.errors.length;
  await saveObservation(story);
  appOracle(story.observations);
});
