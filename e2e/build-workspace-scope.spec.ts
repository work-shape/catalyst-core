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
  const agentName = `scope_helper_${attempt}`;
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

    // The new agent is saved into the workspace of the scope, and starts offered there.
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New agent", exact: true });
    await create.getByRole("textbox", { name: /^Display name/u }).fill("Scope helper");
    await create.getByRole("textbox", { name: /^Id/u }).fill(agentName);
    await expect(
      create.getByRole("combobox", { name: "Available in" }).locator("option:checked")
    ).toHaveText(workspaceName);
    await create.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .locator("form")
      .getByRole("textbox", { name: /^System prompt/u })
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
