import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// SKILL-LIVE-1, clicked: a person who may publish a skill saves it live and restores an earlier
// revision in one click, with no draft in sight. A person who holds `skill.write` alone submits
// the change for approval: the live revision stays until an admin approves it in the Inbox.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/skill-live-on-save.yaml`. */
const writer = { email: "e2e-skill-writer@example.test", password: "e2e-skill-writer-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const WIDE = { width: 1280, height: 900 };

const idSchema = z.object({ id: z.string() });
const liveSchema = z.object({
  id: z.string(),
  revision: z.number(),
  config: z.object({ summary: z.string().optional() }).loose()
});

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `skill-live-${name}.png`) });
}

const summary = (page: Page) => page.getByRole("textbox", { name: /^Summary/u });

test("a skill goes live on save for who may publish it, and waits for an approval for who may not", async ({
  page,
  browser,
  baseURL
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  const name = `e2e_live_${randomUUID().slice(0, 8)}`;
  const skillUrl = `${apiBaseUrl}/api/v1/assets/skill/${name}`;
  const created = await requestWithOrigin(page, "put", skillUrl, {
    data: {
      expectedRevision: null,
      config: {
        name,
        title: name,
        description: "Use when the spec checks a save.",
        content: "The first text."
      }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const live = async () => liveSchema.parse(await (await page.request.get(skillUrl)).json());

  const writerContext = await browser.newContext({ baseURL, viewport: WIDE });
  const writerPage = await writerContext.newPage();
  const grants: string[] = [];
  try {
    // Who may publish: "Save" is live at once, with no draft and no Publish on the page.
    await page.goto(`/build/skills/${name}`);
    await summary(page).fill("Saved live.");
    await expect(page.locator("[data-skill-publish]")).toHaveCount(0);
    await shoot(page, "publisher-before-save");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await live()).revision).toBe(2);
    expect((await live()).config.summary).toBe("Saved live.");
    await expect(page.locator('[data-asset-status="draft"]')).toHaveCount(0);
    await expect(page.locator("[data-skill-publish]")).toHaveCount(0);

    // One click brings an earlier revision back, live, with no question in between.
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "History", exact: true }).click();
    await page
      .getByRole("dialog", { name: "History", exact: true })
      .getByRole("button", { name: /revision 1|version 1/iu })
      .click();
    await expect.poll(async () => (await live()).revision).toBe(3);
    expect((await live()).config.summary).toBeUndefined();
    await shoot(page, "restored");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // Who holds `skill.write` alone: the button says what happens, and live stays.
    await signIn(writerPage, writer);
    const me = idSchema.parse(
      await (await writerPage.request.get(`${apiBaseUrl}/api/v1/me`)).json()
    );
    const { id: assetId } = await live();
    for (const action of ["skill.read", "skill.write"]) {
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
            scopeKind: "asset",
            scopeId: assetId
          }
        }
      );
      expect(granted.ok(), await granted.text()).toBe(true);
      grants.push(idSchema.parse(await granted.json()).id);
    }
    await writerPage.goto(`/build/skills/${name}`);
    await summary(writerPage).fill("Submitted for a decision.");
    await expect(writerPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await writerPage.getByRole("button", { name: "Submit for approval", exact: true }).click();
    const filed = writerPage.locator("[data-skill-filed]");
    await expect(filed).toContainText("Submitted for approval.");
    await shoot(writerPage, "submitted");
    expect(await live()).toMatchObject({ revision: 3 });
    await expect(summary(writerPage)).toHaveValue("");
    await expect(writerPage.locator('[data-asset-status="draft"]')).toHaveCount(0);

    // The admin decides in the Inbox, and the change goes live at once.
    await page.goto("/inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await inbox.getByTestId("inbox-row").filter({ hasText: name }).getByRole("button").click();
    await expect(page.getByTestId("inbox-item")).toContainText("Submitted for a decision.");
    await shoot(page, "inbox-item");
    await page.locator('button[data-decision="approve"]').click();
    await expect.poll(async () => (await live()).revision, { timeout: 30_000 }).toBe(4);
    expect((await live()).config.summary).toBe("Submitted for a decision.");
  } finally {
    for (const grant of grants) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grant}`
      );
    }
    const { revision } = await live();
    await requestWithOrigin(page, "delete", skillUrl, { data: { expectedRevision: revision } });
    await writerContext.close();
  }
});
