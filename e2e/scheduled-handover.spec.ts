import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

// NL-10: a deactivated person's scheduled prompts are paused and run as nobody. On the person's
// page under Settings > Users an instance admin hands one to another member of its workspace,
// who gets it paused; it is gone from the deactivated person's list. The admin never reads the
// prompts' wording, and one in the person's Personal Workspace can only be deleted.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/scheduled-handover.yaml`. */
const owner = {
  email: "e2e-scheduled-owner@example.test",
  password: "e2e-scheduled-owner-password"
};
const taker = {
  email: "e2e-scheduled-taker@example.test",
  password: "e2e-scheduled-taker-password"
};

const idSchema = z.object({ id: z.string() });
const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const startsSchema = z.object({
  items: z.array(z.object({ id: z.string(), ownerUserId: z.string(), state: z.string() }))
});

/** Signs in through the API and answers the person's id. */
async function signIn(page: Page, user: { email: string; password: string }): Promise<string> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  return idSchema.parse(await me.json()).id;
}

/** The person's Personal Workspace, which the first visit of the interface sets up. */
async function personalWorkspace(page: Page): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${apiBaseUrl}/api/v1/workspaces?limit=100`);
      if (!response.ok()) return "";
      id =
        workspaceListSchema
          .parse(await response.json())
          .items.find((workspace) => workspace.kind === "personal")?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

test("an admin hands a deactivated person's scheduled prompt to a member, paused, without reading it", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const takerId = await signIn(page, taker);
  const ownerId = await signIn(page, owner);

  await signIn(page, superadmin);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Scheduled handover ${randomUUID().slice(0, 8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  for (const person of [owner, taker]) {
    const member = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: person.email } }
    );
    expect(member.ok(), await member.text()).toBe(true);
  }

  await signIn(page, owner);
  await page.goto("/");
  const ownWorkspaceId = await personalWorkspace(page);
  const schedule = async (collaborationWorkspaceId: string, prompt: string, cron: string) => {
    const start = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/scheduled-starts`, {
      data: {
        collaborationWorkspaceId,
        agentName: "application_assistant",
        prompt,
        cron,
        timeZone: "Europe/Berlin"
      }
    });
    expect(start.ok(), await start.text()).toBe(true);
    return idSchema.parse(await start.json()).id;
  };
  const prompt = `Weekly digest ${randomUUID().slice(0, 8)}`;
  const privatePrompt = `Private reminder ${randomUUID().slice(0, 8)}`;
  const startId = await schedule(workspaceId, prompt, "0 9 * * 1");
  await schedule(ownWorkspaceId, privatePrompt, "0 7 * * *");

  await signIn(page, superadmin);
  const disabled = await requestWithOrigin(
    page,
    "patch",
    `${apiBaseUrl}/api/v1/instance/users/${ownerId}`,
    { data: { status: "disabled" } }
  );
  expect(disabled.ok(), await disabled.text()).toBe(true);

  await page.goto("/settings/instance/users");
  await page.getByLabel("Search users").fill("Scheduled Owner");
  await page.getByRole("button", { name: /E2E Zz Scheduled Owner/u }).click();
  const card = page.getByTestId("owner-scheduled-starts");
  await expect(card.getByRole("listitem")).toHaveCount(2);
  // The admin reads agent, schedule and workspace, never what the prompts say.
  await expect(card).not.toContainText(prompt);
  await expect(card).not.toContainText(privatePrompt);
  const shared = card.getByRole("listitem").filter({ hasText: "Shared workspace" });
  const personal = card.getByRole("listitem").filter({ hasText: "Personal workspace" });
  await expect(shared).toContainText("Paused");
  await expect(shared).toContainText("application_assistant");
  // A start in the Personal Workspace can only be deleted.
  await expect(personal.getByRole("button", { name: "Hand over" })).toHaveCount(0);
  await expect(
    personal.getByRole("button", { name: /^Delete the scheduled prompt for/u })
  ).toBeVisible();

  await shared.getByRole("button", { name: "Hand over" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Hand over this scheduled prompt?");
  await expect(dialog).not.toContainText(prompt);
  const confirm = dialog.getByRole("button", { name: "Hand over" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("combobox", { name: "New owner" }).selectOption(takerId);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText("Handed over to E2E Zz Scheduled Taker, paused.");
  await expect(card.getByRole("listitem")).toHaveCount(1);

  await personal.getByRole("button", { name: /^Delete the scheduled prompt for/u }).click();
  await expect(dialog).not.toContainText(privatePrompt);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText("This person owns no scheduled prompts.");

  // The member owns it now, paused until they resume it.
  await signIn(page, taker);
  const listed = await page.request.get(
    `${apiBaseUrl}/api/v1/scheduled-starts?collaborationWorkspaceId=${workspaceId}`
  );
  expect(listed.ok()).toBe(true);
  expect(startsSchema.parse(await listed.json()).items).toEqual([
    expect.objectContaining({ id: startId, ownerUserId: takerId, state: "paused" })
  ]);
});
