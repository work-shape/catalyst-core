import { randomUUID } from "node:crypto";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { requestAnswered } from "./allowed-page-errors";
import { apiOrigin, uiOrigin } from "./view-fixtures";
// A member can read the shared queue but not the owner's held operation details.
// The tool card asks for those details while its confirmation waits; assert the refusal below.
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "shared-queue-operation-details-refused",
        reason:
          "The held tool belongs to the owner; the member's operation-details requests are refused, asserted by HTTP below, while both can read the queue.",
        matches: requestAnswered(403),
        path: /^\/api\/v1\/operations\/runs\/[^/]+$/u,
        tests: [
          "a message sent during a run waits in a queue both members see, and starts as the next turn"
        ]
      }
    ]
  }
});
const idSchema = z.object({ id: z.string() });
const owner = { email: "e2e-follow-ups@example.test", password: "e2e-follow-ups-password" };
const member = {
  email: "e2e-follow-ups-member@example.test",
  password: "e2e-follow-ups-member-password"
};

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // A new person steers their own run with Enter; the people of this spec queue (FU-2).
  const queues = await requestWithOrigin(page, "patch", `${apiOrigin}/api/v1/me`, {
    data: { followUpMode: "queue" }
  });
  expect(queues.ok()).toBe(true);
}

/** A workspace of the owner whose conversations its members see, with `invite` as a member. */
async function sharedWorkspace(page: Page, name: string, invite?: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  if (invite) {
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: invite } }
    );
    expect(added.ok()).toBe(true);
  }
  return workspaceId;
}

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop generating" });
}

/** The conversation queue. */
function queueOf(page: Page): Locator {
  return page.getByRole("region", {
    name: "Queued messages"
  });
}

/** The user messages of the transcript, in order. */
function userMessages(page: Page): Locator {
  return page.getByRole("region", { name: "Chat" }).locator('[data-role="user"]');
}

async function queueMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder("Message");
  await input.fill(text);
  // While the run goes Send stays beside Stop, and names what it does now.
  await expect(stopButton(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send after this answer" })).toBeVisible();
  await input.press("Enter");
  await expect(queueOf(page).getByText(text)).toBeVisible();
  await expect(input).toHaveValue("");
}

test("a message sent during a run waits in a queue both members see, and starts as the next turn", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(15_000);
  const suffix = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, owner), signIn(memberPage, member)]);
  const workspaceId = await sharedWorkspace(page, `Queue team ${suffix}`, member.email);

  // Set up a real server run held by its tool decision, then open it in both members' tabs.
  const held = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title: `Queue run ${suffix}`, collaborationWorkspaceId: workspaceId },
      message: { text: `/tool e2e.confirm_note ${JSON.stringify({ text: `queue-run-${suffix}` })}` }
    }
  });
  expect(held.ok()).toBe(true);
  const conversation = z.object({ conversation: idSchema }).parse(await held.json()).conversation;
  const conversationPath = `/w/${workspaceId}/c/${conversation.id}`;
  await Promise.all([page.goto(conversationPath), memberPage.goto(conversationPath)]);
  await expect(page.getByTestId("tool-decision-card")).toBeVisible();
  await expect(stopButton(memberPage)).toBeVisible();

  const ownText = `Then check the March numbers ${suffix}`;
  await queueMessage(page, ownText);
  await expect(queueOf(page)).toContainText("Sent once the agent has finished this whole answer.");
  // The member's tab follows the run, and the queue change is one more event on its stream.
  const memberQueue = queueOf(memberPage);
  await expect(memberQueue.getByText(ownText)).toBeVisible();
  await expect(memberQueue).toContainText("From E2E Zz Follow-ups");
  await expect(queueOf(page)).not.toContainText("From E2E Zz Follow-ups");
  await expect(memberQueue.getByRole("button", { name: "Edit" })).toHaveCount(0);
  // The queue lives on the server: a reload keeps it.
  await memberPage.reload();
  await expect(queueOf(memberPage).getByText(ownText)).toBeVisible();
  await expect(queueOf(memberPage)).toContainText("From E2E Zz Follow-ups");

  // The member's own message queues behind the owner's.
  const memberText = `And add a short summary ${suffix}`;
  await queueMessage(memberPage, memberText);
  await expect(queueOf(page).getByText(memberText)).toBeVisible();
  await expect(queueOf(page)).toContainText("From E2E Zz Follow-ups Member");
  const thread = await page.request.get(
    `${apiOrigin}/api/v1/conversations/${conversationPath.split("/").at(-1)}/thread`
  );
  expect(thread.ok()).toBe(true);
  const snapshot = apiOperations["conversations.thread.get"].response.schema.parse(
    await thread.json()
  );
  const operationId = snapshot.activeRun?.projection.activeToolCalls.find((call) => call.decision)
    ?.decision?.operationRunId;
  expect(operationId).toBeDefined();
  const operation = `${apiOrigin}/api/v1/operations/runs/${operationId}`;
  expect((await memberPage.request.get(operation)).status()).toBe(403);
  expect((await page.request.get(operation)).ok()).toBe(true);

  await page
    .getByTestId("tool-decision-card")
    .getByRole("button", { name: "Allow", exact: true })
    .click();

  // Each queued message starts as a turn of its own, in order, once the run before it completes.
  await expect(userMessages(page).filter({ hasText: ownText })).toBeVisible();
  await expect(userMessages(page).filter({ hasText: memberText })).toBeVisible();
  await expect(userMessages(page).last()).toContainText(memberText);
  await expect(queueOf(page)).toHaveCount(0);
  await memberContext.close();
});
