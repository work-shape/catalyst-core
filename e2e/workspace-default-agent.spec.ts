import type { Page } from "@playwright/test";
import { z } from "zod";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A team names its own default agent in Settings > Workspace > General. The instance's default
// agent can then be taken out of that team: a member there is no longer offered it, and a new
// chat starts with the team's agent. Fails where the team cannot name a default of its own,
// where the instance default may not leave it, or where the member still gets it.
// The people are in `tests/fixtures/e2e-users/workspace-default-agent.yaml`.

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const owner = {
  email: "e2e-workspace-default-owner@example.test",
  password: "e2e-workspace-default-owner-password"
};
const member = {
  email: "e2e-workspace-default-member@example.test",
  password: "e2e-workspace-default-member-password"
};
const DESKTOP = { width: 1280, height: 900 };

const TAG = Date.now().toString(36);
const TEAM = `Außenteam ${TAG}`;
const AGENT = `team_agent_${TAG}`;
const AGENT_LABEL = `Teamagent ${TAG}`;

const idSchema = z.object({ id: z.string() });
const pageSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
  nextCursor: z.string().optional()
});
const overviewSchema = z.object({ defaultAgentName: z.string() });
const agentsSchema = z.object({
  defaultAgentName: z.string().optional(),
  items: z.array(z.object({ name: z.string() }))
});

async function inGerman(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
}

/** Every Shared Workspace of the instance, as the agent page lists them. */
async function sharedWorkspaceIds(page: Page): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await page.request.get(
      `${apiBaseUrl}/api/v1/instance/workspaces?limit=100${cursor ? `&cursor=${cursor}` : ""}`
    );
    expect(response.ok(), await response.text()).toBe(true);
    const listed = pageSchema.parse(await response.json());
    ids.push(...listed.items.map(({ id }) => id));
    cursor = listed.nextCursor;
  } while (cursor);
  return ids;
}

/** Where the instance's default agent is offered: everywhere, or everywhere but the team. */
async function offerInstanceDefault(page: Page, name: string, without?: string): Promise<void> {
  const url = `${apiBaseUrl}/api/v1/assets/agent/${name}/availability`;
  // Another spec may make a workspace meanwhile; the next try lists it too.
  await expect
    .poll(async () => {
      const response = await requestWithOrigin(page, "put", url, {
        data:
          without === undefined
            ? { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
            : {
                mode: "selected",
                personalWorkspaces: true,
                collaborationWorkspaceIds: (await sharedWorkspaceIds(page)).filter(
                  (id) => id !== without
                )
              }
      });
      return response.status();
    })
    .toBe(200);
}

test("a team's own default agent replaces the instance default for its members", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(120_000);
  // The member signs in once, so that an account stands to be added.
  const memberContext = await browser.newContext({ baseURL, viewport: DESKTOP });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  await inGerman(memberPage);

  // The Owner makes the team and adds the member.
  const ownerContext = await browser.newContext({ baseURL, viewport: DESKTOP });
  await pageErrors.watch(ownerContext);
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);
  await inGerman(ownerPage);
  const created = await requestWithOrigin(ownerPage, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: TEAM }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const teamId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    ownerPage,
    "post",
    `${apiBaseUrl}/api/v1/workspaces/${teamId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);

  // An instance admin makes the team's agent and offers it in the team alone.
  await page.setViewportSize(DESKTOP);
  await signIn(page, superadmin);
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${AGENT}`;
  const put = await requestWithOrigin(page, "put", agentUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: AGENT,
        displayName: AGENT_LABEL,
        description: "Beantwortet Fragen des Außenteams.",
        instructions: "Antworte knapp."
      }
    }
  });
  expect(put.ok(), await put.text()).toBe(true);
  const offered = await requestWithOrigin(page, "put", `${agentUrl}/availability`, {
    data: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [teamId] }
  });
  expect(offered.ok(), await offered.text()).toBe(true);
  const overview = await page.request.get(`${apiBaseUrl}/api/v1/instance/config/assets`);
  expect(overview.ok()).toBe(true);
  const instanceDefault = overviewSchema.parse(await overview.json()).defaultAgentName;

  // Before: the member chooses between the instance default and the team's agent.
  const teamAgents = async () => {
    const response = await memberPage.request.get(
      `${apiBaseUrl}/api/v1/workspaces/${teamId}/agents`
    );
    expect(response.ok()).toBe(true);
    const listed = agentsSchema.parse(await response.json());
    return { defaultAgentName: listed.defaultAgentName, names: listed.items.map((a) => a.name) };
  };
  expect(await teamAgents()).toEqual({
    defaultAgentName: instanceDefault,
    names: expect.arrayContaining([instanceDefault, AGENT])
  });

  // The Owner names the team's agent its default agent in the workspace's settings.
  await ownerPage.goto("/settings/workspace/general");
  await expect(ownerPage.getByRole("heading", { name: "Allgemein", level: 1 })).toBeVisible();
  const scope = ownerPage.getByRole("button", { name: /^Arbeitsbereich für diese Seiten: / });
  if ((await scope.count()) > 0 && !(await scope.textContent())?.includes(TEAM)) {
    await scope.click();
    await ownerPage.getByRole("option", { name: TEAM, exact: true }).click();
  }
  const defaultAgent = ownerPage.getByLabel("Standardagent", { exact: true });
  await expect(defaultAgent).toHaveValue("");
  await expect(defaultAgent.locator("option", { hasText: AGENT_LABEL })).toHaveCount(1);
  await defaultAgent.selectOption(AGENT);
  await ownerPage.getByRole("button", { name: "Änderungen speichern" }).click();
  await expect(ownerPage.getByText("Arbeitsbereich aktualisiert")).toBeVisible();
  await ownerPage.screenshot({
    path: test.info().outputPath("evidence-workspace-default-agent-1280.png"),
    animations: "disabled",
    fullPage: true
  });

  // The instance default can now leave the team, and only the team.
  try {
    await offerInstanceDefault(page, instanceDefault, teamId);

    // The member is no longer offered the instance default there, and a new chat starts with the
    // team's agent. (Agents the e2e instance offers everywhere stay on offer.)
    const after = await teamAgents();
    expect(after.defaultAgentName).toBe(AGENT);
    expect(after.names).toContain(AGENT);
    expect(after.names).not.toContain(instanceDefault);
    await memberPage.goto(`/w/${teamId}`);
    const chat = memberPage.getByRole("region", { name: "Chat" });
    await expect(chat.getByTitle(AGENT_LABEL, { exact: true })).toBeVisible();
  } finally {
    // The instance's default agent is shared by every spec: it is offered everywhere again.
    await offerInstanceDefault(page, instanceDefault);
  }
  await memberContext.close();
  await ownerContext.close();
});
