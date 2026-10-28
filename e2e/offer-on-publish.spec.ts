import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { assetBaseRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// OFFER-ON-PUBLISH: offering is part of publishing. The publish dialog of an agent that no chat
// can choose asks "Wählbar in:", with the agent's own place chosen; Publish sets it through
// `assets.set_availability` and makes the draft live, and the head says where a chat can choose
// the agent now. Fails where the dialog asks nothing, where no availability is set, or where the
// head still says that no chat can choose it.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

/** A new agent saves live and hidden; a save of an existing one writes its draft. */
async function putAgent(page: Page, name: string, instructions: string, draft: boolean) {
  const stored = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      ...(draft ? { expectedDraftRevision: null } : {}),
      config: {
        name,
        displayName: `Vertragsprüfer ${name.slice(-8)}`,
        description: "Prüft Verträge auf fehlende Unterschriften.",
        instructions
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

/** One picture, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, `offer-on-publish-${name}.png`),
    animations: "disabled"
  });
}

test("publishing an agent no chat can choose offers it where the dialog says", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);
  await signIn(page);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const agent = `offer_publish_${tag}`;
  await putAgent(page, agent, "Antworte knapp.", false);
  await putAgent(page, agent, "Antworte knapp und nenne die fehlende Unterschrift.", true);

  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
  });
  await page.goto(`/build/agents/${agent}`);
  await expect(page.getByRole("heading", { name: `Vertragsprüfer ${tag}` })).toBeVisible();
  const place = page.locator("[data-asset-place]");
  await expect(place.getByText("In keinem Chat wählbar", { exact: true })).toBeVisible();

  // The dialog asks where, with the agent's own place chosen: every workspace, for an agent of
  // everyone. It may also stay in no chat.
  await page.locator("[data-agent-publish]").click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  const where = dialog.getByRole("radiogroup", { name: "Wählbar in:" });
  await expect(where).toBeVisible();
  const all = where.getByRole("radio", { name: "Alle Arbeitsbereiche" });
  const nowhere = where.getByRole("radio", { name: "Noch in keinem Chat" });
  await expect(all).toBeChecked();
  await expect(nowhere).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Veröffentlichen" })).toBeEnabled();
  await shoot(page, "dialog-390");
  await page.setViewportSize(DESKTOP);
  await expect(where).toBeVisible();
  await shoot(page, "dialog-1280");
  await page.setViewportSize(PHONE);

  // The reader chooses the place, and Publish sets it through the availability's operation.
  await nowhere.check();
  await all.check();
  await expect(all).toBeChecked();
  const offered = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith(`/agent/${agent}/availability`)
  );
  const published = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes(`/agent/${agent}/publish`)
  );
  await dialog.getByRole("button", { name: "Veröffentlichen" }).click();
  expect((await offered).postDataJSON()).toMatchObject({ mode: "all" });
  await published;
  await expect(dialog).toBeHidden();

  // The head says where a chat can choose the agent now, and the draft is live.
  await expect(place.getByText("Wählbar in: Alle Arbeitsbereiche", { exact: true })).toBeVisible();
  await expect(place.getByText("In keinem Chat wählbar", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-agent-draft-badge]")).toHaveCount(0);
  await shoot(page, "head-after-390");
});
