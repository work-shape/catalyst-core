import type { Page } from "@playwright/test";
import { z } from "zod";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The empty Apps list of a team offers to build one with the agent only where an agent offered
// there builds Apps. Where the team offers only agents that cannot, the list says there are no
// Apps yet and nothing more: before, it offered the agent anyway and its button opened a chat
// with the team's default agent, which cannot build an App. Where one builds, the button opens
// the conversation with that agent. The person is in `tests/fixtures/e2e-users/empty-lists-build.yaml`.

const builder = {
  email: "e2e-empty-lists-builder@example.test",
  password: "e2e-empty-lists-builder-password"
};
const DESKTOP = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
const runSchema = z.object({ agentName: z.string() }).passthrough();
const agentsSchema = z
  .object({
    items: z.array(
      z.object({ name: z.string(), buildsAssets: z.boolean().optional() }).passthrough()
    )
  })
  .passthrough();

/**
 * The team's agents as the server lists them, with a default that builds no assets: with
 * `building` false, only the agents that build none are offered. Answers the agent a build
 * starts with, the first that builds.
 */
/**
 * The team's own Apps alone: an App another spec publishes for the whole instance is listed in
 * every workspace, and the team has none of its own.
 */
async function listNoAppsElsewhere(page: Page, teamId: string): Promise<void> {
  await page.route(
    (url) =>
      url.pathname === "/api/v1/assets/app" && url.searchParams.get("workspaceId") === teamId,
    async (route) => {
      const response = await route.fetch();
      const listed = z
        .object({})
        .passthrough()
        .parse(await response.json());
      await route.fulfill({ response, json: { ...listed, items: [], nextCursor: undefined } });
    }
  );
}

async function offerDefaultThatCannotBuild(
  page: Page,
  teamId: string,
  building: boolean
): Promise<{ builder: string | undefined }> {
  const seen: { builder: string | undefined } = { builder: undefined };
  await page.route(`**/api/v1/workspaces/${teamId}/agents*`, async (route) => {
    const response = await route.fetch();
    const listed = agentsSchema.parse(await response.json());
    const plain = listed.items.filter((agent) => agent.buildsAssets !== true);
    expect(plain.length).toBeGreaterThan(0);
    const items = building ? listed.items : plain;
    seen.builder = items.find((agent) => agent.buildsAssets === true)?.name;
    await route.fulfill({
      response,
      json: { ...listed, items, defaultAgentName: plain[0]?.name }
    });
  });
  return seen;
}

test("the empty Apps list offers building only where an agent there builds Apps, and starts the chat with it", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DESKTOP);
  await signIn(page, builder);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Apps empty ${Date.now().toString(36)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const teamId = idSchema.parse(await created.json()).id;
  const apps = page.getByTestId("apps-area");
  const build = apps.getByRole("button", { name: "Build one with the agent" });

  try {
    // Without an agent that builds, the list says only that there are none.
    await listNoAppsElsewhere(page, teamId);
    await offerDefaultThatCannotBuild(page, teamId, false);
    await page.goto(`/w/${teamId}/apps`);
    await expect(
      apps.getByText(
        "No apps yet. An app is a small tool for this workspace, such as a fee calculator or a leave request."
      )
    ).toBeVisible();
    await expect(build).toHaveCount(0);
    await expect(apps.getByText("Fee calculator", { exact: true })).toHaveCount(0);
    await expect(apps.getByRole("button", { name: "New app" })).toHaveCount(0);

    // With one beside that default, the button opens the conversation with the one that builds
    // and the started sentence.
    await page.unrouteAll({ behavior: "wait" });
    await listNoAppsElsewhere(page, teamId);
    const offered = await offerDefaultThatCannotBuild(page, teamId, true);
    await page.reload();
    await expect(build).toBeVisible();
    await build.click();
    const chat = page.locator("[data-dock-chat]");
    await expect(chat.getByRole("heading", { name: "What should the new app do?" })).toBeVisible();
    const composer = chat.getByPlaceholder("Message");
    await expect(composer).toHaveValue("Build an app for this workspace: ");
    // Its first message runs with the agent that builds, not with the team's default.
    const run = page.waitForRequest(
      (request) => request.method() === "POST" && /\/runs$/u.test(new URL(request.url()).pathname)
    );
    await composer.fill("Build an app for this workspace: a fee calculator");
    await composer.press("Enter");
    expect(offered.builder).toBeDefined();
    expect(runSchema.parse((await run).postDataJSON()).agentName).toBe(offered.builder);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${teamId}`);
  }
});
