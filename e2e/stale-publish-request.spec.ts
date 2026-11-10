import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A publish request a newer revision overtook: a publisher's draft waits for an approver as
// "Agent to publish"; before anyone decides it, an admin publishes a newer draft of the same
// agent. The waiting request leaves the admin's To decide at once, and both read under Decided
// and My requests that it was settled without a decision and can do nothing.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/stale-publish-request.yaml`. */
const publisher = {
  email: "e2e-stale-publisher@example.test",
  password: "e2e-stale-publisher-password"
};
const WIDE = { width: 1280, height: 900 };
const OVERTAKEN =
  "Settled without a decision: a newer version went live (version 2). Nothing of this request was published, and it can do nothing any more.";

const idSchema = z.object({ id: z.string() });
const heldSchema = z.object({ status: z.literal("pending_approval") });

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

test("a publish request a newer revision overtook leaves To decide and says it can do nothing", async ({
  page,
  browser,
  baseURL
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  const tag = randomUUID().slice(0, 8);
  const name = `stale-pub-${tag}`;
  const displayName = `Stale check ${tag}`;
  const workspaceName = `Stale publish ${tag}`;
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspaceName }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${name}`;
  const config = (instructions: string, toolNames: string[] = []) => ({
    name,
    displayName,
    description: "Checks offers before they go out.",
    instructions,
    toolNames
  });

  const publisherContext = await browser.newContext({ baseURL, viewport: WIDE });
  const publisherPage = await publisherContext.newPage();
  const grants: string[] = [];
  try {
    await signIn(publisherPage, publisher);
    const me = idSchema.parse(
      await (await publisherPage.request.get(`${apiBaseUrl}/api/v1/me`)).json()
    );
    for (const action of ["builder", "publisher"]) {
      const granted = await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/instance/access/grants`,
        {
          data: {
            holderKind: "user",
            holderId: me.id,
            action,
            effect: "allow",
            scopeKind: "workspace",
            scopeId: workspaceId
          }
        }
      );
      expect(granted.ok(), await granted.text()).toBe(true);
      grants.push(idSchema.parse(await granted.json()).id);
    }

    // The admin makes the agent, live at version 1.
    const made = await requestWithOrigin(page, "put", agentUrl, {
      data: { workspaceId, expectedRevision: null, config: config("Check every offer.") }
    });
    expect(made.ok(), await made.text()).toBe(true);

    // The publisher's draft adds a tool, so its publish waits for an approver (GR-PUB-2).
    const pushed = await requestWithOrigin(publisherPage, "put", agentUrl, {
      data: {
        workspaceId,
        expectedRevision: 1,
        expectedDraftRevision: null,
        config: config("Check every offer and name the price.", ["read_skill"])
      }
    });
    expect(pushed.ok(), await pushed.text()).toBe(true);
    const held = await requestWithOrigin(publisherPage, "post", `${agentUrl}/publish`, {
      data: { workspaceId, revision: 1 }
    });
    expect(held.status(), await held.text()).toBe(202);
    heldSchema.parse(await held.json());

    // The admin's To decide holds it.
    await page.goto("/inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const row = inbox.getByTestId("inbox-row").filter({ hasText: displayName });
    await expect(row).toContainText("Agent to publish");

    // The admin writes a newer draft and publishes it: version 2 goes live on the admin's click.
    const own = await requestWithOrigin(page, "put", agentUrl, {
      data: {
        workspaceId,
        expectedRevision: 1,
        // The write names the publisher's draft it replaces, the agent's first.
        expectedDraftRevision: 1,
        config: config("Check every offer, name the price and the date.", ["read_skill"])
      }
    });
    expect(own.ok(), await own.text()).toBe(true);
    // A publish of an agent names its draft's revision.
    const live = await requestWithOrigin(page, "post", `${agentUrl}/publish`, {
      data: { workspaceId, revision: 2 }
    });
    expect(live.status(), await live.text()).toBe(200);

    // To decide no longer holds it; Decided does, with the reason.
    await page.reload();
    await expect(inbox.getByRole("tab", { name: /To decide/u })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(row).toHaveCount(0);
    await expect(inbox.getByTestId("inbox-row")).toHaveCount(0);
    await inbox.getByRole("tab", { name: "Decided" }).click();
    // A row of the decided list names the workspace it lands in.
    const decided = inbox.getByTestId("inbox-row").filter({ hasText: workspaceName });
    await expect(decided).toContainText("Agent to publish");
    await decided.getByRole("button").click();
    await expect(page.getByTestId("inbox-item")).toContainText(OVERTAKEN);
    await expect(page.locator('button[data-decision="approve"]')).toHaveCount(0);
    if (process.env.E2E_SHOTS_DIR)
      await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/stale-publish-decided.png` });

    // The publisher reads the same under My requests.
    await publisherPage.goto("/inbox");
    const theirInbox = publisherPage.getByRole("region", { name: "Inbox", exact: true });
    await expect(theirInbox).toBeVisible();
    // A person who may decide some kind has tabs; one who may decide none sees this list alone.
    const mineTab = theirInbox.getByRole("tab", { name: "My requests" });
    if ((await mineTab.count()) > 0) await mineTab.click();
    const theirs = theirInbox
      .getByTestId("inbox-row")
      // The publisher is no member of the workspace, so the row names none: this person has
      // made no other request.
      .filter({ hasText: "Agent to publish" });
    await expect(theirs).toHaveCount(1);
    await theirs.getByRole("button").click();
    await expect(publisherPage.getByTestId("inbox-item")).toContainText(OVERTAKEN);
  } finally {
    for (const grant of grants) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grant}`
      );
    }
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
    await publisherContext.close();
  }
});
