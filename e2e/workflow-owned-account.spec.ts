import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Page } from "@playwright/test";
import { z } from "zod";
import {
  ALLOWED_URL,
  plantConnection,
  removeConnection,
  removeGrantsOn
} from "./connection-fixtures";
import { sendToolCall } from "./page-surface-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// LIVE-1: a Workflow the agent writes in a conversation names no `runAs`. Its first publish
// makes the Workflow's own account with the use rights its steps need, and the publish question
// says so in one plain line that names the Connection. The run then acts as that account and
// ends done. The spec creates and grants no service principal itself. Fails without LIVE-1: the
// save refused a definition without `runAs`, and the question named no account.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };
const shotsDir = resolve(process.env.E2E_SHOTS_DIR ?? "../shots");

const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const runSchema = z.object({
  status: z.string(),
  mode: z.string().optional(),
  principal: z.object({ id: z.string(), displayLabel: z.string() })
});

const NEW_WORKFLOW =
  /^(?:New workflow|Neuer Workflow|Build one with the agent|Einen mit dem Agenten bauen)$/u;

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: superadmin.email, password: superadmin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** The person's own workspace, which the instance makes when the person first opens it. */
async function personalWorkspaceId(page: Page): Promise<string> {
  await page.goto("/");
  let id = "";
  await expect
    .poll(async () => {
      const workspaces = workspaceListSchema.parse(
        await (await page.request.get(`${apiBaseUrl}/api/v1/workspaces?limit=100`)).json()
      );
      id = workspaces.items.find((workspace) => workspace.kind === "personal")?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

async function setLocale(page: Page, locale: "en" | "de"): Promise<void> {
  await page.evaluate(
    (chosen) => window.localStorage.setItem("vivd-catalyst:locale", chosen),
    locale
  );
  await page.reload();
}

test("a Workflow written in chat without runAs publishes with its own account and runs done", async ({
  page,
  // It plants a Connection no release config names.
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const id = `own-account-${tag}`;
  const title = `Own account ${tag}`;
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `exampledata_${tag}`,
    displayName: `Exampledata ${tag}`,
    url: ALLOWED_URL,
    authScheme: "none" as const,
    operations: [
      { name: "echo", effect: "reading", exposure: ["workflow"], enabled: true }
    ] as const
  };
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  await mkdir(shotsDir, { recursive: true });
  await plantConnection(connection);
  try {
    const personalId = await personalWorkspaceId(page);
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));

    // The agent's first save, from a new conversation, creates the draft with no `runAs`.
    await page.goto(`/w/${personalId}/workflows`);
    await page.getByRole("button", { name: NEW_WORKFLOW }).first().click();
    await sendToolCall(page, "platform.assets.put", {
      kind: "workflow",
      name: id,
      config: {
        name: id,
        manifest: {
          id,
          name: title,
          inputs: { type: "object", additionalProperties: false },
          outputs: { type: "object" },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "read",
              name: "Read Exampledata",
              type: "operation",
              operation: `connection.${connection.name}.echo`,
              input: { text: { value: "clients" } }
            },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        }
      }
    });
    const workflowPath = `/w/${personalId}/workflows/${id}`;
    await expect(page).toHaveURL((url) => url.pathname === workflowPath);
    const stored = z
      .object({ config: z.object({ manifest: z.record(z.string(), z.unknown()) }) })
      .parse(await (await page.request.get(assetUrl)).json());
    expect(stored.config.manifest).not.toHaveProperty("runAs");

    // The publish question names the Workflow's own account and what it may use, in English.
    const workflowPage = page.getByTestId("workflow-page");
    const bar = workflowPage.locator("[data-workflow-draft]");
    await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    const publish = page.getByRole("dialog", { name: `Publish “${title}”?` });
    const question = publish.getByTestId("workflow-publish-question");
    await expect(question).toContainText(
      `Runs as its own account “${title}” and may use ${connection.displayName}.`
    );
    // The question names the Connection by its title, never by its machine name.
    await expect(question).not.toContainText(connection.name);
    // Nothing in the question says an account is missing.
    await expect(publish).not.toContainText("does not exist");
    await page.screenshot({
      path: join(shotsDir, "live-1-publish-en.png"),
      animations: "disabled"
    });
    await publish.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(publish).toBeHidden();

    // The same line in German.
    await setLocale(page, "de");
    await bar.getByRole("button", { name: "Veröffentlichen", exact: true }).click();
    const german = page.getByRole("dialog", { name: `„${title}“ veröffentlichen?` });
    await expect(german.getByTestId("workflow-publish-question")).toContainText(
      `Läuft unter einem eigenen Konto „${title}“ und darf ${connection.displayName} nutzen.`
    );
    await page.screenshot({
      path: join(shotsDir, "live-1-publish-de.png"),
      animations: "disabled"
    });
    await german.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await expect(german).toBeHidden();
    await setLocale(page, "en");

    // The person's click publishes it: no bar, and the Workflow can be started.
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    await publish.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(publish).toBeHidden();
    await expect(bar).toHaveCount(0);

    // Started by hand, the run opens and ends done, as the Workflow's own account.
    await workflowPage.getByRole("button", { name: "Start now", exact: true }).click();
    const start = page.getByRole("dialog", { name: `Start “${title}” now?` });
    await start.getByRole("button", { name: "Start", exact: true }).click();
    await expect(start).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/w/${personalId}/workflows/${id}/runs/[^/]+$`, "u"));
    const runPage = page.getByTestId("workflow-run-page");
    await expect(runPage.getByText("Done", { exact: true }).first()).toBeVisible({
      timeout: 60_000
    });
    const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const readRun = async () =>
      runSchema.parse(
        await (await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`)).json()
      );
    await expect.poll(async () => (await readRun()).status, { timeout: 60_000 }).toBe("done");
    const run = await readRun();
    expect(run.mode).not.toBe("test");
    expect(run.principal.displayLabel).toBe(title);
    await page.screenshot({ path: join(shotsDir, "live-1-run-done.png"), animations: "disabled" });
  } finally {
    // Deleting the Workflow deletes its own account; the rows on the Connection go with it.
    const revision = await assetRevision(page, assetUrl).catch(() => undefined);
    if (revision !== undefined) {
      await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
        data: { expectedRevision: revision }
      });
    }
    await removeGrantsOn(connection.id);
    await removeConnection(connection.id);
  }
});
