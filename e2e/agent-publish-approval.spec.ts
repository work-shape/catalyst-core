import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// WS-PUB-1b, access checks 11 and 37 (browser half): a Builder and Publisher of a workspace who
// is no member of it and holds no agent.approve makes the workspace's agent, which starts offered
// nowhere. Its first publish, without a draft, waits in an instance admin's Inbox as "Agent to
// publish" with version 1 alone and the workspace it will be offered in; approved, it is
// offered there. A later draft's publish waits too, reviewed against the live version, and its
// approval makes the draft live.

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

/** The publisher's publish of one revision, which waits for an approver. */
async function publishAndWait(
  page: Page,
  url: string,
  workspaceId: string,
  revision: number
): Promise<void> {
  const published = await requestWithOrigin(page, "post", url, {
    data: { workspaceId, revision }
  });
  expect(published.status(), await published.text()).toBe(202);
  heldSchema.parse(await published.json());
}

/** The admin opens the agent's waiting publish in the Inbox and answers its review. */
async function openItem(page: Page, displayName: string) {
  await page.goto("/inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const row = inbox.getByTestId("inbox-row").filter({ hasText: displayName });
  await expect(row).toContainText("Agent to publish");
  await row.getByRole("button").click();
  const review = page.getByTestId("publish-review");
  await expect(review.getByTestId("operation-call-headline")).toHaveText(
    `E2E Zz Agent Publisher wants to publish a new version of the agent “${displayName}”.`
  );
  return review;
}

async function approve(page: Page): Promise<void> {
  await page.locator('button[data-decision="approve"]').click();
  await expect(page.getByTestId("inbox-item")).toContainText("Decision by E2E Superadmin");
}

/** The review at 1280 in light and dark and at 390 in light, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
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
      path: join(shotsDir, `ws-pub-1b-${name}-${theme}-${width}.png`),
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

    // The publisher makes the agent in the workspace. Without agent.approve there it starts
    // offered nowhere, so nobody of the workspace is offered it (access check 11).
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
    expect(await offered()).not.toContain(name);

    // Its first publish needs no draft and waits for an approver, who reviews version 1 alone.
    await publishAndWait(publisherPage, `${agentUrl}/publish`, workspaceId, 1);
    expect(await live()).toMatchObject({ revision: 1 });
    expect(await offered()).not.toContain(name);
    const first = await openItem(page, displayName);
    await expect(first.locator('[data-field="version"]')).toHaveText(/First version/u);
    await expect(first.getByTestId("publish-review-workspace")).toHaveText(workspaceName);
    await expect(first.getByTestId("publish-review-offers")).toHaveText(
      `Approving also offers the agent to everyone in ${workspaceName}.`
    );
    await expect(first.getByTestId("publish-review-instructions")).toContainText(
      "Check every offer."
    );
    await expect(first.locator('[data-field="instructions-live"]')).toHaveCount(0);
    await shoot(page, "first", () =>
      expect(first.getByTestId("publish-review-offers")).toBeVisible()
    );
    await approve(page);
    await expect.poll(offered, { timeout: 30_000 }).toContain(name);
    expect(await live()).toMatchObject({ revision: 1 });

    // A push writes a draft over it; its publish waits too, reviewed against the live version.
    const pushed = await requestWithOrigin(publisherPage, "put", agentUrl, {
      data: {
        workspaceId,
        expectedRevision: 1,
        expectedDraftRevision: null,
        config: config("Check every offer and name the missing price.")
      }
    });
    expect(pushed.ok(), await pushed.text()).toBe(true);
    await publishAndWait(publisherPage, `${agentUrl}/publish`, workspaceId, 1);
    expect(await live()).toMatchObject({
      revision: 1,
      config: { instructions: "Check every offer." }
    });
    const update = await openItem(page, displayName);
    await expect(update.locator('[data-field="version"]')).toHaveText(/Draft based on version 1/u);
    await expect(update.getByTestId("publish-review-offers")).toHaveText(
      "Where the agent is offered stays as it is."
    );
    await expect(update.locator('[data-agent-field="instructions"]')).toContainText("Changed");
    await expect(update.getByTestId("publish-review-instructions")).toContainText(
      "name the missing price"
    );
    await shoot(page, "update", () =>
      expect(update.getByTestId("publish-review-offers")).toBeVisible()
    );
    await approve(page);
    await expect.poll(async () => (await live()).revision, { timeout: 30_000 }).toBe(2);
    expect((await live()).config.instructions).toBe(
      "Check every offer and name the missing price."
    );
    expect(await offered()).toContain(name);
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
