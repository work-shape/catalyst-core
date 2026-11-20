import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// ACCEPT-FIX-11 E3: a workspace whose members read its conversations builds nothing in them. A
// refused build offers one press to go on privately: the workspace's start page with the
// request in its composer, and the first send makes the conversation private. Fails without
// the change: the start page said nothing of the conversation being private, and after a
// reload of the refused conversation it offered the workspace's default agent, not the one
// that was refused.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = {
  email: process.env.E2E_SUPERADMIN_EMAIL ?? "e2e-superadmin@example.test",
  password: process.env.E2E_SUPERADMIN_PASSWORD ?? "e2e-superadmin-password"
};
const BUILDER = "Asset Builder";

const idSchema = z.object({ id: z.string() });
const threadSchema = z.object({
  conversation: z.object({
    id: z.string(),
    collaborationWorkspaceId: z.string(),
    visibility: z.string()
  })
});

const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
const startPageAgent = (page: Page) =>
  page.getByRole("region", { name: "Chat" }).getByRole("button", { name: /^Select agent/u });

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: superadmin.email, password: superadmin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A workspace whose conversations its members read, as a team's is by default. */
async function sharedWorkspace(page: Page): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: {
      name: `Team ${randomUUID().slice(0, 8)}`,
      defaultConversationVisibility: "workspace"
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

async function conversation(page: Page, conversationId: string) {
  const response = await page.request.get(
    `${apiBaseUrl}/api/v1/conversations/${conversationId}/thread`
  );
  expect(response.ok(), await response.text()).toBe(true);
  return threadSchema.parse(await response.json()).conversation;
}

test("a build refused in a shared conversation goes on privately with the request", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const workspaceId = await sharedWorkspace(page);
  const id = `shared-refusal-${randomUUID().slice(0, 8)}`;
  const request = `/tool platform.assets.put ${JSON.stringify({
    kind: "workflow",
    name: id,
    config: {
      name: id,
      manifest: {
        id,
        name: `Shared refusal ${id.slice(-8)}`,
        inputs: { type: "object", additionalProperties: false },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] }
        ]
      }
    }
  })}`;

  // A conversation of the workspace as it starts them, with an agent that builds: its members
  // read it, so the save is refused.
  await page.goto(`/w/${workspaceId}`);
  await startPageAgent(page).click();
  await page.getByRole("option", { name: BUILDER }).click();
  await composerOf(page).fill(request);
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
  const offer = page.getByTestId("private-build-offer");
  await expect(offer).toBeVisible({ timeout: 60_000 });
  const sharedPath = new URL(page.url()).pathname;
  const sharedId = sharedPath.split("/").at(-1) ?? "";
  expect(await conversation(page, sharedId)).toMatchObject({ visibility: "workspace" });

  // The refused conversation read again, as after a reload: the start page's own pick is gone.
  await page.reload();
  await expect(offer).toBeVisible();

  // One press: the workspace's start page, private, with the request and the refused agent.
  // As a new chat, it makes no conversation before the send (ACCEPT-2e).
  await offer
    .getByRole("button", { name: /^(?:Continue privately|Privat weitermachen)$/u })
    .click();
  await expect(page).toHaveURL((url) => url.pathname.replace(/\/$/u, "") === `/w/${workspaceId}`);
  await expect(composerOf(page)).toHaveValue(request);
  await expect(page.getByTestId("new-conversation-private-hint")).toHaveText(
    "Private: only you see this conversation."
  );
  await expect(startPageAgent(page)).toHaveAccessibleName(`Select agent: ${BUILDER}`);

  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname.startsWith(`/w/${workspaceId}/c/`) && url.pathname !== sharedPath
  );
  const privateId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect(await conversation(page, privateId)).toMatchObject({
    collaborationWorkspaceId: workspaceId,
    visibility: "private"
  });
});
