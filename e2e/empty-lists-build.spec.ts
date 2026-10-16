import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { shootEverywhere } from "./surface-shots";
import { expect, test, type PageErrorWatch } from "./test";

// An empty Apps, Workflows or Data Stores list offers a person who may build there "Build one
// with the agent" with two examples, which open the dock as the New buttons do; a person who may
// not build reads what the kind is, and no sentence about a builder (UXA-3b, navigation check
// 39). Fails without the change: the empty Workflows list offered New alone, the empty Apps list
// opened a chat, Data Stores named the CLI, and a member read "A builder of this workspace can
// add one". A member who may not read Data Stores has no Studio; the unit tests hold that list.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** Kai: may build Apps, Workflows and Data Stores. No other spec uses this person. */
const builder = {
  email: "e2e-empty-lists-builder@example.test",
  password: "e2e-empty-lists-builder-password"
};
/** Tobias: may build nothing. No other spec uses this member. */
const member = {
  email: "e2e-empty-lists-member@example.test",
  password: "e2e-empty-lists-member-password"
};
const WIDE = { width: 1440, height: 900 };

const BUILD_ACTION = /^(?:Build one with the agent|(?:Eine|Einen) mit dem Agenten bauen)$/u;
const EXAMPLES = /^(?:Examples to start with|Beispiele für den Einstieg)$/u;
const BUILDER_SENTENCE = /builder|bauen darf/u;

const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const listSchema = z.object({ items: z.array(z.unknown()) }).loose();

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

/**
 * Answers the instance's Workflows as none. Every spec of the run shares the instance's list,
 * so it is empty only where the answer is narrowed; the rights of the page stay the instance's.
 */
async function noWorkflows(page: Page): Promise<void> {
  for (const path of ["/api/v1/workflows", "/api/v1/assets/workflow"]) {
    await page.route(
      (url) => url.pathname === path,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const answer = listSchema.parse(await response.json());
        delete answer.nextCursor;
        await route.fulfill({ response, json: { ...answer, items: [] } });
      }
    );
  }
}

const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);

test("Kai, who may build there, is offered the agent with two examples on the empty Apps, Workflows and Data Stores lists, and an example opens the dock with its start", async ({
  browser,
  pageErrors
}) => {
  test.setTimeout(240_000);
  const page = await sessionOf(browser, pageErrors.watch, builder);
  page.setDefaultTimeout(30_000);
  const personalId = await personalWorkspaceId(page);
  await noWorkflows(page);

  try {
    // Workflows: the action and each example open the dock on the list with their start.
    const workflowsPath = `/w/${personalId}/workflows`;
    const workflows = page.getByTestId("workflows-area");
    await page.goto(workflowsPath);
    await expect(workflows.getByRole("button", { name: BUILD_ACTION })).toBeVisible();
    const workflowExamples = workflows.getByRole("group", { name: EXAMPLES });
    await expect(workflowExamples.getByRole("button")).toHaveCount(2);
    await expect(workflows).not.toContainText(BUILDER_SENTENCE);
    await shootEverywhere(page, "uxa-3b-workflows-builder", async () => {
      await expect(workflows.getByRole("button", { name: BUILD_ACTION })).toBeVisible();
    });
    await workflows.getByRole("button", { name: BUILD_ACTION }).click();
    await expect(composerOf(page)).toHaveValue("Build a new workflow that ");
    await page.goto(workflowsPath);
    await workflowExamples.getByRole("button", { name: /Monday task summary/u }).click();
    await expect(composerOf(page)).toHaveValue(
      "Build a new workflow that runs every Monday at 8:00, collects last week's open tasks per person and sends me a summary."
    );
    expect(new URL(page.url()).pathname).toBe(workflowsPath);
    await shootEverywhere(page, "uxa-3b-workflows-example-dock", async () => {
      await page.goto(workflowsPath);
      await workflowExamples.getByRole("button").first().click();
      await expect(composerOf(page)).toHaveValue(/^(?:Build a new workflow|Bau einen neuen)/u);
    });

    // Apps: the Personal workspace holds none, and an example opens the dock, as on Workflows.
    const appsPath = `/w/${personalId}/apps`;
    const apps = page.getByTestId("apps-area");
    await page.goto(appsPath);
    await expect(apps.getByRole("button", { name: BUILD_ACTION })).toBeVisible();
    await expect(apps.getByRole("group", { name: EXAMPLES }).getByRole("button")).toHaveCount(2);
    await expect(apps).not.toContainText(BUILDER_SENTENCE);
    await shootEverywhere(page, "uxa-3b-apps-builder", async () => {
      await expect(apps.getByRole("button", { name: BUILD_ACTION })).toBeVisible();
    });
    await apps.getByRole("button", { name: /^Fee calculator/u }).click();
    await expect(composerOf(page)).toHaveValue(
      "Build an app that calculates a client's fee from the hours worked and the hourly rate, adds VAT and shows the total."
    );
    expect(new URL(page.url()).pathname).toBe(appsPath);

    // Data Stores: Studio's Personal scope holds none, and the offer stands under its picker.
    await page.goto("/build/data-stores");
    const scope = page.getByRole("button", { name: /^Scope: / });
    await expect(scope).toBeVisible();
    if ((await scope.textContent())?.includes("Personal") !== true) {
      await scope.click();
      await page.getByRole("option", { name: "Personal", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "Scope: Personal" })).toBeVisible();
    await expect(page.getByRole("button", { name: BUILD_ACTION })).toBeVisible();
    await expect(
      page.getByRole("group", { name: EXAMPLES }).getByRole("button", { name: /Client list/u })
    ).toBeVisible();
    await shootEverywhere(page, "uxa-3b-data-stores-builder", async () => {
      await expect(page.getByRole("button", { name: BUILD_ACTION })).toBeVisible();
    });
    await page.getByRole("button", { name: /Hours per project/u }).click();
    await expect(composerOf(page)).toHaveValue(
      "Build a new data store that holds the hours worked per person and project, with the date and a note."
    );
    expect(new URL(page.url()).pathname).toBe("/build/data-stores");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("Tobias, who may not build, reads what a Workflow and an App are, and no builder sentence", async ({
  browser,
  pageErrors,
  accessState: _accessState
}) => {
  test.setTimeout(180_000);
  const page = await sessionOf(browser, pageErrors.watch, member);
  page.setDefaultTimeout(30_000);
  const personalId = await personalWorkspaceId(page);

  // The Workflows area opens to whoever may read a Workflow: a draft of this spec's own is given
  // to the member to read. A draft is listed to builders only, so the list stays empty to them.
  const root = await sessionOf(browser, pageErrors.watch, superadmin);
  const id = `empty-lists-${randomUUID().slice(0, 8)}`;
  const principal = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: id, displayLabel: id, description: "Runs the Workflow of a spec." } }
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
          name: "Empty lists",
          runAs: id,
          inputs: { type: "object", additionalProperties: false },
          outputs: { type: "object" },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const assetId = z
    .object({ id: z.string() })
    .parse(await (await root.request.get(assetUrl)).json()).id;
  const memberId = z
    .object({ id: z.string() })
    .parse(await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json()).id;
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
  const grantId = z.object({ id: z.string() }).parse(await granted.json()).id;
  await noWorkflows(page);

  try {
    const workflows = page.getByTestId("workflows-area");
    await page.goto(`/w/${personalId}/workflows`);
    await expect(workflows).toContainText(
      "No workflows yet. A workflow, for example, sends a summary every Monday or reminds clients of overdue invoices."
    );
    await expect(workflows).not.toContainText(BUILDER_SENTENCE);
    await expect(workflows.getByRole("button", { name: BUILD_ACTION })).toHaveCount(0);
    await expect(workflows.getByRole("button", { name: "New workflow" })).toHaveCount(0);
    await shootEverywhere(page, "uxa-3b-workflows-member", async () => {
      await expect(workflows).toContainText(/No workflows yet|Noch keine Workflows/u);
    });

    const apps = page.getByTestId("apps-area");
    await page.goto(`/w/${personalId}/apps`);
    await expect(apps).toContainText(
      "No apps yet. An app is a small tool for this workspace, such as a fee calculator or a leave request."
    );
    await expect(apps).not.toContainText(BUILDER_SENTENCE);
    await expect(apps.getByRole("button", { name: BUILD_ACTION })).toHaveCount(0);
    await shootEverywhere(page, "uxa-3b-apps-member", async () => {
      await expect(apps).toContainText(/No apps yet|Noch keine Apps/u);
    });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const revoked = await requestWithOrigin(
      root,
      "delete",
      `${apiBaseUrl}/api/v1/instance/access/grants/${grantId}`
    );
    expect(revoked.ok(), await revoked.text()).toBe(true);
  }
});
