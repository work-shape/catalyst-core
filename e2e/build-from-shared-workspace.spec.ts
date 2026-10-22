import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { newWithAgent } from "./new-with-agent";
import { expect, test } from "./test";

// ACCEPT-FIX-11 E3: a workspace whose members read its conversations builds nothing in them.
// "New workflow" there starts a private conversation of the SAME workspace before its first
// turn, and a build refused in a shared conversation offers one press to go on in such a
// conversation, with the person's request in its composer. Fails without the change: New was
// missing in such a workspace, and the refusal left the person with an error line only.
// "Continue privately" opens the start page and makes the private conversation with its send.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = {
  email: process.env.E2E_SUPERADMIN_EMAIL ?? "e2e-superadmin@example.test",
  password: process.env.E2E_SUPERADMIN_PASSWORD ?? "e2e-superadmin-password"
};
const WIDE = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
const threadSchema = z.object({
  conversation: z.object({
    id: z.string(),
    collaborationWorkspaceId: z.string(),
    visibility: z.string()
  })
});

const NEW_WORKFLOW =
  /^(?:New workflow|Neuer Workflow|Build one with the agent|Einen mit dem Agenten bauen)$/u;
const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);

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
      name: `Kanzlei ${randomUUID().slice(0, 8)}`,
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

test("New workflow in a workspace with shared conversations builds in a private one there", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const workspaceId = await sharedWorkspace(page);
  const listPath = `/w/${workspaceId}/workflows`;

  await page.goto(listPath);
  await newWithAgent(page, NEW_WORKFLOW);
  await expect(composerOf(page)).toHaveValue(
    /^(?:Build a new workflow that |Bau einen neuen Workflow, der )$/u
  );
  await expect(page).toHaveURL(
    (url) => url.pathname === listPath && (url.searchParams.get("chat") ?? "") !== ""
  );
  const conversationId = new URL(page.url()).searchParams.get("chat") ?? "";
  expect(await conversation(page, conversationId)).toMatchObject({
    collaborationWorkspaceId: workspaceId,
    visibility: "private"
  });
});

test("a build refused in a shared conversation goes on privately with the request", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
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

  // A conversation of the workspace as it starts them: its members read it.
  await page.goto(`/w/${workspaceId}`);
  await composerOf(page).fill(request);
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
  const offer = page.getByTestId("private-build-offer");
  await expect(offer).toBeVisible({ timeout: 90_000 });
  const sharedPath = new URL(page.url()).pathname;
  const sharedId = sharedPath.split("/").at(-1) ?? "";
  expect(await conversation(page, sharedId)).toMatchObject({ visibility: "workspace" });
  expect(
    (
      await page.request.get(
        `${apiBaseUrl}/api/v1/assets/workflow/${id}?workspaceId=${workspaceId}`
      )
    ).status()
  ).toBe(404);

  // One press: the workspace's start page with the request to send again. As a new chat, it
  // makes no conversation before the send (ACCEPT-2e: an empty one stayed when the person left).
  await offer
    .getByRole("button", { name: /^(?:Continue privately|Privat weitermachen)$/u })
    .click();
  await expect(page).toHaveURL((url) => url.pathname.replace(/\/$/u, "") === `/w/${workspaceId}`);
  await expect(composerOf(page)).toHaveValue(request);
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
