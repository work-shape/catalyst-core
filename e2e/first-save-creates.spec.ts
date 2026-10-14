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

async function personalWorkspaceId(page: Page): Promise<string> {
  const workspaces = workspaceListSchema.parse(
    await (await page.request.get(`${apiBaseUrl}/api/v1/workspaces?limit=100`)).json()
  );
  const personal = workspaces.items.find((workspace) => workspace.kind === "personal");
  expect(personal).toBeDefined();
  return personal?.id ?? "";
}

const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);

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
  const newWorkflow = page.getByRole("button", { name: "New workflow", exact: true }).first();
  await newWorkflow.click();
  await expect(composerOf(page)).toHaveValue("Build a new workflow that ");
  expect(new URL(page.url()).pathname).toBe(listPath);
  expect(await stored()).toBe(404);
  await shootLocales(page, "nav-2-new-workflow-dock", async () => {
    await page
      .getByRole("button", { name: /^(?:New workflow|Neuer Workflow)$/u })
      .first()
      .click();
    await expect(composerOf(page)).toHaveValue(/^(?:Build a new workflow|Bau einen neuen)/u);
  });
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.goto(listPath);
  await page.getByRole("button", { name: "New workflow", exact: true }).first().click();

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
  const before = await offered();

  // The workspace is the open one and Studio's scope: what is made here, it owns.
  await page.goto(`/w/${workspaceId}`);
  await page.goto("/build/agents");
  await page.getByRole("button", { name: /^Scope: / }).click();
  await page.getByRole("option", { name: `Studio ${name.slice(-8)}` }).click();
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
  // Nobody's agent list changed.
  expect(await offered()).toEqual(before);
  await shootLocales(page, "nav-2-agent-created", async () => {
    await expect(page.getByTestId("asset-opened-line").last()).toBeVisible();
  });
});
