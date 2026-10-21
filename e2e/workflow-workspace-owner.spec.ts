import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";
import { shootThemes } from "./surface-shots";
import { showWorkflowsUntil } from "./workflow-list-paging";

// WS-OWN-1b: a workspace owns the Workflows made in it. Its Workflows page lists them beside the
// instance's, each with the workspace's chip, as Studio's lists name an owner. Fails without
// WS-OWN-1b: a Workflow could not be saved with a workspace, and the list read the instance's
// alone.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });
const revisionSchema = z.object({ revision: z.number() });

test("a Workflow a workspace owns is listed on its Workflows page with the workspace's chip", async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const tag = randomUUID().slice(0, 8);
  const id = `ws-owned-${tag}`;
  const title = `Team intake ${tag}`;
  const runAs = `${id}-runner`;
  const workspaceName = `Workflow team ${tag}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspaceName }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  try {
    const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
    const saved = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        workspaceId,
        config: {
          name: id,
          manifest: {
            id,
            name: title,
            description: "Takes in what the team sends.",
            runAs,
            inputs: { type: "object", additionalProperties: false },
            outputs: { type: "object" },
            steps: [
              {
                id: "start",
                name: "Start by hand",
                type: "trigger",
                triggers: [{ kind: "manual" }]
              },
              { id: "result", name: "Result", type: "output", input: {} }
            ]
          }
        }
      }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const { revision } = revisionSchema.parse(await saved.json());
    const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
      data: { revision, workspaceId }
    });
    expect(published.ok(), await published.text()).toBe(true);
    // Addressed without its workspace, the Workflow is not there: the instance owns no such one.
    expect((await page.request.get(assetUrl)).status()).toBe(404);

    await page.goto(`/w/${workspaceId}/workflows`);
    const list = page.getByRole("list", { name: "Workflows" });
    const card = list.getByRole("listitem").filter({ hasText: title });
    await showWorkflowsUntil(page, card);
    await expect(card.getByText(workspaceName, { exact: true })).toBeVisible();

    // Its page opens from the card, read from the workspace.
    await card.getByRole("link", { name: `Open ${title}` }).click();
    await expect(page).toHaveURL((url) => url.pathname === `/w/${workspaceId}/workflows/${id}`);
    await expect(page.getByTestId("workflow-page")).toContainText(title);

    await page.goto(`/w/${workspaceId}/workflows`);
    await shootThemes(page, "ws-own-1b-workflow-chip", async () => {
      await showWorkflowsUntil(page, card);
      await card.scrollIntoViewIfNeeded();
    });
  } finally {
    // What the workspace owns goes with it.
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});
