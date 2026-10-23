import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// WS-PUB-1b, access checks 11 and 37 (browser half): a Builder and Publisher of a workspace who
// is no member of it and holds no agent.approve publishes the workspace's agent. Nothing goes
// live; the publish waits in an instance admin's Inbox as "Agent to publish" with the draft
// against live and the workspace it will be offered in. The admin approves it there, and the
// draft is live and offered in that workspace.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/agent-publish.yaml`. */
const publisher = {
  email: "e2e-agent-publisher@example.test",
  password: "e2e-agent-publisher-password"
};
const shotsDir = process.env.E2E_SHOTS_DIR;
const WIDE = { width: 1280, height: 900 };

const idSchema = z.object({ id: z.string() });
const heldSchema = z.object({ status: z.literal("pending_approval") });
const liveSchema = z.object({
  revision: z.number(),
  config: z.object({ instructions: z.string() })
});
const agentsSchema = z.object({ items: z.array(z.object({ name: z.string() })) });

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

/** The review at 1280 in light and dark and at 390 in light, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const [theme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 390]
  ] as const) {
    await page.setViewportSize({ width, height: WIDE.height });
    await page.evaluate((value) => {
      window.localStorage.setItem("vivd-catalyst:theme", value);
    }, theme);
    await page.reload();
    await ready();
    await page.screenshot({
      path: join(shotsDir, `ws-pub-1b-inbox-${theme}-${width}.png`),
      fullPage: width < 600
    });
  }
  await page.evaluate(() => {
    window.localStorage.removeItem("vivd-catalyst:theme");
  });
  await page.setViewportSize(WIDE);
  await page.reload();
  await ready();
}

test("a workspace agent's publish waits in the Inbox and goes live once an admin approves it", async ({
  page,
  browser,
  baseURL
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  const tag = randomUUID().slice(0, 8);
  const name = `ws-pub-${tag}`;
  const displayName = `Offer check ${tag}`;
  const workspaceName = `Agent review ${tag}`;
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspaceName }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${name}`;
  const live = async () =>
    liveSchema.parse(
      await (await page.request.get(`${agentUrl}?workspaceId=${workspaceId}`)).json()
    );
  const offered = async () =>
    agentsSchema
      .parse(
        await (
          await page.request.get(`${apiBaseUrl}/api/v1/workspaces/${workspaceId}/agents`)
        ).json()
      )
      .items.map((agent) => agent.name);

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

    // The publisher makes the agent in the workspace and pushes a draft over it: it starts
    // hidden, so nobody of the workspace is offered it.
    const config = (instructions: string) => ({
      name,
      displayName,
      description: "Checks offers before they go out.",
      instructions
    });
    const made = await requestWithOrigin(publisherPage, "put", agentUrl, {
      data: { workspaceId, expectedRevision: null, config: config("Check every offer.") }
    });
    expect(made.ok(), await made.text()).toBe(true);
    const pushed = await requestWithOrigin(publisherPage, "put", agentUrl, {
      data: {
        workspaceId,
        expectedRevision: 1,
        expectedDraftRevision: null,
        config: config("Check every offer and name the missing price.")
      }
    });
    expect(pushed.ok(), await pushed.text()).toBe(true);
    expect(await offered()).not.toContain(name);

    // Their publish waits: the live revision and the workspace's agents stay as they were.
    const published = await requestWithOrigin(publisherPage, "post", `${agentUrl}/publish`, {
      data: { workspaceId, revision: 1 }
    });
    expect(published.status(), await published.text()).toBe(202);
    heldSchema.parse(await published.json());
    expect(await live()).toMatchObject({
      revision: 1,
      config: { instructions: "Check every offer." }
    });
    expect(await offered()).not.toContain(name);

    // The admin finds it in the Inbox with the draft against live and the workspace.
    await page.goto("/inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const row = inbox.getByTestId("inbox-row").filter({ hasText: displayName });
    await expect(row).toContainText("Agent to publish");
    await row.getByRole("button").click();
    const review = page.getByTestId("publish-review");
    await expect(review.getByTestId("operation-call-headline")).toHaveText(
      `E2E Zz Agent Publisher wants to publish a new version of the agent “${displayName}”.`
    );
    await expect(review.locator('[data-field="version"]')).toHaveText(
      /Draft version 1, in place of version 1/u
    );
    await expect(review.getByTestId("publish-review-workspace")).toHaveText(workspaceName);
    await expect(review.getByTestId("publish-review-offers")).toHaveText(
      `Approving also offers the agent to everyone in ${workspaceName}.`
    );
    await expect(review.locator('[data-agent-field="instructions"]')).toContainText("Changed");
    await expect(review.getByTestId("publish-review-instructions")).toContainText(
      "name the missing price"
    );
    await shoot(page, () => expect(review.getByTestId("publish-review-offers")).toBeVisible());

    await page.locator('button[data-decision="approve"]').click();
    await expect(page.getByTestId("inbox-item")).toContainText("Decision by E2E Superadmin");
    await expect.poll(async () => (await live()).revision, { timeout: 30_000 }).toBe(2);
    expect((await live()).config.instructions).toBe(
      "Check every offer and name the missing price."
    );
    await expect.poll(offered).toContain(name);
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
