import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { shootLocales } from "./surface-shots";
import { expect, test } from "./test";

// "New" opens the dock and creates nothing; the agent's first save creates the asset and takes
// the person to its page (NAV-2, navigation checks 30 and 36, Platform Access check 44). The
// agent of the e2e instance that holds the platform tools is Application Assistant. Fails
// without the change: "New workflow" did not exist, "New agent" opened its form, and a save
// in a conversation about nothing was refused.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const agentsSchema = z.object({ items: z.array(z.object({ name: z.string() })) });

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

const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);

/**
 * The list's way to the agent: New, or while the instance has no Workflow yet, the empty list's
 * offer, which stands in its place with the same start (UXA-3b).
 */
const NEW_WORKFLOW =
  /^(?:New workflow|Neuer Workflow|Build one with the agent|Einen mit dem Agenten bauen)$/u;

test("New workflow opens the dock, and the agent's first save creates the draft and moves there", async ({
  page
}) => {
  test.setTimeout(180_000);
  const id = `first-save-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  const title = `First save ${id.slice(-8)}`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const personalId = await personalWorkspaceId(page);
  const listPath = `/w/${personalId}/workflows`;
  const stored = async () =>
    (await page.request.get(`${apiBaseUrl}/api/v1/assets/workflow/${id}`)).status();

  // "New workflow" opens the dock with a started sentence and creates nothing; leaving the
  // list leaves it as it was.
  await page.goto(listPath);
  const newWorkflow = page.getByRole("button", { name: NEW_WORKFLOW }).first();
  await newWorkflow.click();
  await expect(composerOf(page)).toHaveValue("Build a new workflow that ");
  expect(new URL(page.url()).pathname).toBe(listPath);
  expect(await stored()).toBe(404);
  await shootLocales(page, "nav-2-new-workflow-dock", async () => {
    await page.getByRole("button", { name: NEW_WORKFLOW }).first().click();
    await expect(composerOf(page)).toHaveValue(/^(?:Build a new workflow|Bau einen neuen)/u);
  });
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.goto(listPath);
  await page.getByRole("button", { name: NEW_WORKFLOW }).first().click();

  // The agent's first save creates the draft of the instance, and the person moves to it.
  await sendToolCall(page, "platform.assets.put", {
    kind: "workflow",
    name: id,
    config: {
      name: id,
      manifest: {
        id,
        name: title,
        runAs,
        inputs: { type: "object", additionalProperties: false },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      }
    }
  });
  const workflowPath = `/w/${personalId}/workflows/${id}`;
  await expect(page).toHaveURL(
    (url) => url.pathname === workflowPath && url.searchParams.has("chat")
  );
  await expect(page.getByTestId("asset-opened-line").last()).toHaveText(`Opened ${title}`);
  await expect(page.getByText("Draft · not published").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true }).first()).toBeVisible();
  expect(await stored()).toBe(200);
  await shootLocales(page, "nav-2-workflow-created", async () => {
    await expect(
      page.getByText(/^(?:Draft · not published|Entwurf · nicht veröffentlicht)$/u).first()
    ).toBeVisible();
  });
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));

  // Back on the list, the draft is there.
  await page.goto(listPath);
  await expect(page.getByText(title).first()).toBeVisible();
});

test("New agent in a workspace's Studio opens the dock, and the first save creates an agent offered nowhere", async ({
  page
}) => {
  test.setTimeout(180_000);
  const name = `built_${randomUUID().slice(0, 8).replaceAll("-", "_")}`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    // Its conversations start private: a first save creates only in the person's own.
    data: { name: `Studio ${name.slice(-8)}`, defaultConversationVisibility: "private" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const offered = async () =>
    agentsSchema
      .parse(
        await (
          await page.request.get(`${apiBaseUrl}/api/v1/workspaces/${workspaceId}/agents`)
        ).json()
      )
      .items.map((agent) => agent.name);

  // The workspace is the open one and Studio's scope: what is made here, it owns.
  const workspaceName = `Studio ${name.slice(-8)}`;
  await page.goto(`/w/${workspaceId}`);
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(workspaceName);
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Kinds in Studio" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("button", { name: /^Scope: / }).click();
  await page.getByRole("option", { name: workspaceName }).click();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New agent", exact: true })).toHaveCount(0);
  await expect(composerOf(page)).toHaveValue("Build a new agent that ");

  await sendToolCall(page, "platform.assets.put", {
    kind: "agent",
    name,
    config: {
      name,
      displayName: "Built helper",
      instructions: "Help the team.",
      modelProviderId: "local",
      toolNames: [],
      skillNames: [],
      initialPrompts: []
    }
  });
  await expect(page).toHaveURL((url) => url.pathname === `/build/agents/${name}`);
  await expect(page.getByTestId("asset-opened-line").last()).toHaveText("Opened Built helper");
  // The agent is offered to nobody: it is not among the workspace's agents. Other tests change
  // that list meanwhile, so only this agent is asked about.
  expect(await offered()).not.toContain(name);
  await shootLocales(page, "nav-2-agent-created", async () => {
    await expect(page.getByTestId("asset-opened-line").last()).toBeVisible();
  });
});

test("the first save of a Data Store in a personal chat opens its draft in Studio's Personal scope, and Publish makes it", async ({
  page
}) => {
  test.setTimeout(180_000);
  const name = `leads-${randomUUID().slice(0, 8)}`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const personalId = await personalWorkspaceId(page);

  // A plain chat of the person's own workspace, about nothing yet.
  await page.goto(`/w/${personalId}`);
  await sendToolCall(page, "platform.assets.put", {
    kind: "data_store",
    name,
    files: [
      { path: "store.yaml", text: `id: ${name}\nname: Leads ${name.slice(-8)}\n` },
      { path: "migrations/0001_init.sql", text: "create table leads (name text not null);" }
    ]
  });

  // The person moves to the draft, read where it is: the Personal Workspace owns it.
  await expect(page).toHaveURL((url) => url.pathname === `/build/data-stores/${name}`);
  await expect(page.getByTestId("asset-opened-line").last()).toHaveText(
    `Opened Leads ${name.slice(-8)}`
  );
  const draft = page.locator("[data-data-store-draft]");
  await expect(draft).toHaveText("Draft · not published");
  await expect(page.locator("[data-data-store-draft-migration]")).toHaveText("0001_init.sql");
  const publish = page.locator("[data-data-store-publish]");
  await expect(publish).toBeVisible();
  await shootLocales(page, "nav-2-data-store-draft", async () => {
    await expect(draft).toHaveText(/^(?:Draft · not published|Entwurf · nicht veröffentlicht)$/u);
  });
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.reload();

  // Publish is the person's click: the store then has a database and a state.
  await page.locator("[data-data-store-publish]").click();
  await expect(page.locator("[data-data-store-draft]")).toHaveCount(0);
  await expect(page.locator("[data-data-store-state]")).toBeVisible();

  // Studio lists it under Personal.
  await page.goto("/build/data-stores");
  await expect(page.getByRole("button", { name: "Scope: Personal" })).toBeVisible();
  await expect(page.getByText(`Leads ${name.slice(-8)}`).first()).toBeVisible();
});
