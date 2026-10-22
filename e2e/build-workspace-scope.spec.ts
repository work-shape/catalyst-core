import { z } from "zod";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";
import { shootThemes } from "./surface-shots";

// Studio works in a scope: the instance's own agents and skills, or what one Shared Workspace
// owns (WS-OWN-1a). An agent saved in a workspace's scope is that workspace's.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const idSchema = z.object({ id: z.string() });
const storedSchema = z.object({
  scope: z.object({ kind: z.string(), workspaceId: z.string().optional() })
});

test("an agent made in a workspace's Studio scope is the workspace's, listed with its chip", async ({
  page,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  const attempt = test.info().retry;
  const workspaceName = `Scope team ${attempt}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspaceName }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const skillName = `scope_notes_${attempt}`;
  // A new agent's id is made from its name on its page.
  const agentTitle = `Scope helper ${attempt}`;
  const agentName = `scope-helper-${attempt}`;
  try {
    const skill = await requestWithOrigin(
      page,
      "put",
      `${apiBaseUrl}/api/v1/assets/skill/${skillName}`,
      {
        data: {
          expectedRevision: null,
          workspaceId,
          config: {
            name: skillName,
            title: "Scope notes",
            description: "What the team writes down.",
            content: "# Scope notes"
          }
        }
      }
    );
    expect(skill.ok(), await skill.text()).toBe(true);

    await page.goto("/build/agents");
    await page.getByRole("button", { name: /^Scope: / }).click();
    await page.getByRole("option", { name: workspaceName }).click();
    await expect(page.getByRole("button", { name: `Scope: ${workspaceName}` })).toBeVisible();
    await expect(page.getByText(`Nothing in ${workspaceName} yet.`)).toBeVisible();

    // "New agent" opens the empty page of a new agent. It is saved into the workspace of the
    // scope, and starts offered there.
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New agent", level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Available in" }).locator("option:checked")
    ).toHaveText(workspaceName);
    await page
      .getByRole("textbox", { name: /^Display name/u })
      .first()
      .fill(agentTitle);
    await page
      .locator("form")
      .getByRole("textbox", { name: /^Agent instructions/u })
      .fill("You help the team.");
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/build/agents/${agentName}$`, "u"));
    const stored = await page.request.get(
      `${apiBaseUrl}/api/v1/assets/agent/${agentName}?workspaceId=${workspaceId}`
    );
    expect(stored.ok(), await stored.text()).toBe(true);
    expect(storedSchema.parse(await stored.json()).scope).toEqual({
      kind: "workspace",
      workspaceId
    });

    await page.goto("/build/agents");
    const row = page
      .getByRole("list", { name: "Agents" })
      .getByRole("link", { name: /Scope helper/u });
    await expect(row).toBeVisible();
    await expect(row.getByText(workspaceName, { exact: true })).toBeVisible();
    await shootThemes(page, "build-workspace-scope", async () => {
      await expect(row).toBeVisible();
    });
  } finally {
    // What the workspace owns goes with it.
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});

// ACCEPT-2e C-1: the Skills list opened on the instance by itself, because the workspace Studio
// was set to had no skills. That carried over: Agents and New agent in the same tab then worked
// in the instance too. The Skills list's own opening holds for Skills alone.
test("Skills opening on the instance leaves Agents and New agent where Studio is set", async ({
  page
}) => {
  const workspaceName = `Opening scope ${test.info().retry}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspaceName }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  try {
    // Studio is set to the workspace, which owns no skills, and remembers it.
    await page.goto("/build/agents");
    await page.getByRole("button", { name: /^Scope: / }).click();
    await page.getByRole("option", { name: workspaceName }).click();
    await expect(page.getByRole("button", { name: `Scope: ${workspaceName}` })).toBeVisible();

    // A new visit opens Skills on the instance, whose shipped skills it lists.
    await page.goto("/build/skills");
    await expect(page.getByRole("button", { name: "Scope: Instance" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Skills" })).toBeVisible();

    // Agents in the same tab is still where Studio is set, and so is a new agent.
    const kinds = page.getByRole("navigation", { name: "Kinds in Studio" });
    await kinds.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/build/agents");
    await expect(page.getByRole("button", { name: `Scope: ${workspaceName}` })).toBeVisible();
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Available in" }).locator("option:checked")
    ).toHaveText(workspaceName);
  } finally {
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});
