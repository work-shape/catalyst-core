import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// The section rows Apps and Workflows (NAV-VIS-1): a member who is shown no App and no Workflow
// has neither row, open or collapsed; a builder has both while there is nothing in them, so the
// first one has a place to go; and the member's Workflows row comes once a Workflow is theirs
// to read. Fails without the rule: the rail showed both rows to everyone with the module on.
//
// The Agents row follows the list of the workspace's agents: the instance names it where two
// agents or more are offered or the person may write one. With one agent the row is gone and
// New chat starts that agent. Fails without the rule: the row stood in every workspace.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** Holds every right on Apps and Workflows through the admin role. */
const builder = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Holds nothing on Apps or Workflows. No other spec uses this member. */
const member = {
  email: "e2e-sidebar-sections@example.test",
  password: "e2e-sidebar-sections-password"
};
const WIDE = { width: 1440, height: 900 };

const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  person: { email: string; password: string }
): Promise<Page> {
  const context = await browser.newContext({ viewport: WIDE });
  await watch(context);
  const page = await context.newPage();
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...person, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  return page;
}

/** Opens the start page with the rail open and waits until it has its rows. */
async function openRail(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(rail(page).getByRole("button", { name: "Agents", exact: true })).toBeVisible();
}

/** Asserts which of the two rows the rail holds, open and collapsed. */
async function expectRows(page: Page, rows: { apps: boolean; workflows: boolean }) {
  const navigation = rail(page);
  for (const collapsed of [false, true]) {
    if (collapsed) {
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    }
    // The Agents row is there for everyone with a workspace: the rail has its rows by now.
    await expect(navigation.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
    for (const [name, shown] of [
      ["Apps", rows.apps],
      ["Workflows", rows.workflows]
    ] as const) {
      await expect(navigation.getByRole("button", { name, exact: true })).toHaveCount(
        shown ? 1 : 0
      );
    }
  }
  await page.getByRole("button", { name: "Expand sidebar" }).click();
}

/** Stores and publishes a Workflow that starts by hand. Answers the id of its asset. */
async function publishWorkflow(root: Page, id: string): Promise<string> {
  const runAs = `sections-${id}`;
  const principal = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  const saved = await requestWithOrigin(root, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name: "Sidebar sections",
          description: "A Workflow a spec gives a member to read.",
          runAs,
          inputs: { type: "object", additionalProperties: false },
          outputs: {
            type: "object",
            properties: { done: { type: "integer" } },
            required: ["done"]
          },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stored = z
    .object({ id: z.string(), revision: z.number() })
    .parse(await (await root.request.get(assetUrl)).json());
  const published = await requestWithOrigin(root, "post", `${assetUrl}/publish`, {
    data: { revision: stored.revision }
  });
  expect(published.ok(), await published.text()).toBe(true);
  return stored.id;
}

test("a member is shown no empty Apps or Workflows row, a builder is, and a Workflow given to read brings the member's row", async ({
  browser,
  pageErrors
}) => {
  test.setTimeout(90_000);
  const memberPage = await sessionOf(browser, pageErrors.watch, member);
  const builderPage = await sessionOf(browser, pageErrors.watch, builder);

  // The member's own workspace holds no App, and no Workflow is theirs to read: no row.
  await openRail(memberPage);
  await expectRows(memberPage, { apps: false, workflows: false });
  // The addresses stay where they were: the row is gone, not the page.
  await memberPage.goto(`/w/${await workspaceOf(memberPage)}/apps`);
  await expect(memberPage.getByTestId("apps-area")).toContainText("No apps yet.");

  // The builder's rows stand whatever they hold, to make the first App and Workflow.
  await openRail(builderPage);
  await expectRows(builderPage, { apps: true, workflows: true });

  // A published Workflow the member may read is listed to them, and the row comes with it.
  const root = await sessionOf(browser, pageErrors.watch, superadmin);
  const workflowId = `sections-${randomUUID().slice(0, 8)}`;
  const assetId = await publishWorkflow(root, workflowId);
  const memberId = z
    .object({ id: z.string() })
    .parse(await (await memberPage.request.get(`${apiBaseUrl}/api/v1/me`)).json()).id;
  const granted = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/access/grants`,
    {
      data: {
        holderKind: "user",
        holderId: memberId,
        action: "workflow.read",
        effect: "allow",
        scopeKind: "asset",
        scopeId: assetId
      }
    }
  );
  expect(granted.ok(), await granted.text()).toBe(true);
  await openRail(memberPage);
  await expectRows(memberPage, { apps: false, workflows: true });
  await rail(memberPage).getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(memberPage).toHaveURL(/\/workflows$/u);
  await expect(memberPage.getByText("Sidebar sections", { exact: true })).toBeVisible();
});

test("a member with one agent has no Agents row, and New chat starts that agent", async ({
  browser,
  pageErrors
}) => {
  const page = await sessionOf(browser, pageErrors.watch, member);
  const workspaceId = await workspaceOf(page);
  const agentsUrl = `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/agents`;
  const listSchema = z.object({
    defaultAgentName: z.string(),
    visibleSections: z.array(z.string()),
    items: z.array(z.object({ name: z.string(), displayName: z.string() }).loose())
  });

  // The instance offers this member the two agents of the run, so it names the row.
  const offered = listSchema.parse(await (await page.request.get(agentsUrl)).json());
  expect(offered.items.length).toBeGreaterThanOrEqual(2);
  expect(offered.visibleSections).toEqual(["agents"]);
  await openRail(page);

  // The workspace offers its default agent alone, and the instance then names no row, as the
  // server tests prove: the answer is narrowed to that here, the instance's agents are shared.
  const only = offered.items.find((agent) => agent.name === offered.defaultAgentName);
  if (!only) {
    throw new Error("The workspace's default agent is not among its agents");
  }
  const agentsPath = new URL(agentsUrl).pathname;
  await page.route(
    (url) => url.pathname === agentsPath,
    async (route) => {
      const response = await route.fetch();
      const answer = listSchema.parse(await response.json());
      await route.fulfill({
        response,
        json: {
          ...answer,
          items: answer.items.filter(({ name }) => name === only.name),
          visibleSections: []
        }
      });
    }
  );
  const narrowed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === agentsPath
  );
  await page.reload();
  await narrowed;
  // The composer names the one agent and offers no other, as it does for one agent.
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByRole("button", { name: /^Select agent/u })).toHaveCount(0);
  await expect(chat).toContainText(only.displayName);
  const navigation = rail(page);
  // The row New chat stands first; the Recent heading carries a second New chat.
  const newChat = navigation.getByRole("button", { name: "New chat", exact: true }).first();
  await expect(newChat).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Agents", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Agents", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand sidebar" }).click();

  // New chat starts a conversation with that agent: the first message makes it and its run.
  await newChat.click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Which agent answers here?");
  const started = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /^\/api\/v1\/conversations(?:\/[^/]+)?\/runs$/u.test(new URL(request.url()).pathname)
  );
  await composer.press("Enter");
  expect(
    z
      .object({ agentName: z.string() })
      .loose()
      .parse((await started).postDataJSON())
  ).toMatchObject({ agentName: only.name });
});

/** The id of the workspace the start page opened. */
async function workspaceOf(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  const match = /\/w\/([^/]+)$/u.exec(new URL(page.url()).pathname);
  if (!match?.[1]) {
    throw new Error("The start page opened no workspace");
  }
  return match[1];
}
