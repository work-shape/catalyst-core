import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

// EW-2b: an agent's call under `confirm` pauses its run, and the conversation shows the host's
// own card on that call. Allow runs the call once and the same assistant message goes on; Deny
// with a reason gives the agent a denied result that names the reason. A second tab on the
// conversation closes its card when the first decides. The suite's server holds the calls of
// `e2e.confirm_note` for a confirmation (clients/demo/src/e2e-server.ts). Fails without EW-2a
// and EW-2b: the call was refused, and there was no card.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const TOOL = "e2e.confirm_note";

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByPlaceholder("Message")).toBeVisible();
}

async function askFor(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder("Message").fill(`/tool ${TOOL} ${JSON.stringify({ text })}`);
  await page.getByRole("button", { name: "Send message" }).click();
}

/** Pictures of the waiting card in both languages, light and dark, wide and at phone width. */
async function shootCard(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize() ?? { width: 1280, height: 900 };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: size.height });
    for (const locale of ["en", "de"] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(
          ([localeValue, themeValue]) => {
            window.localStorage.setItem("vivd-catalyst:locale", localeValue);
            window.localStorage.setItem("vivd-catalyst:theme", themeValue);
          },
          [locale, theme] as const
        );
        // A reload reads the waiting run from the conversation's snapshot.
        await page.reload();
        const card = page.getByTestId("tool-decision-card");
        await expect(card).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(shotsDir, `${name}-${theme}-${locale}-${width}.png`) });
      }
    }
  }
  await page.setViewportSize(size);
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "en");
    window.localStorage.setItem("vivd-catalyst:theme", "light");
  });
  await page.reload();
}

test("an agent's call waits for the person's Allow, runs once, and the same message goes on", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 240_000 : 90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const note = `Call the tenant ${Date.now()}`;
  await askFor(page, note);

  // The card on the call: what it is, the input as it will run, when it expires, the answers.
  const card = page.getByTestId("tool-decision-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Runs only when you allow it.");
  await expect(card.locator('[data-input-key="text"]')).toContainText(note);
  await expect(card.getByTestId("tool-decision-expires")).toContainText("Expires");
  await expect(card.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(page.getByText(`"recorded"`)).toHaveCount(0);
  await shootCard(page, "tool-confirmation-waiting");

  // A second tab on the conversation shows the same card.
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1280, height: 900 });
  await other.goto(page.url());
  const otherCard = other.getByTestId("tool-decision-card");
  await expect(otherCard).toBeVisible();

  await card.getByRole("button", { name: "Allow", exact: true }).click();

  // The second tab closes its card from the run's record of the decision.
  await expect(otherCard).toHaveCount(0);
  await other.close();

  // The call ran once, and the agent's answer goes on in the message that holds the call: its
  // work history folds the call above the answer.
  const message = page
    .locator('[data-role="assistant"]')
    .filter({ has: page.getByTestId("assistant-work-group-trigger") })
    .last();
  await expect(message.getByText(/Tool work completed/u)).toBeVisible();
  await expect(message).toContainText(note);
  await expect(page.getByTestId("tool-decision-card")).toHaveCount(0);
  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: /Tool work completed/u })
  ).toHaveCount(1);
});

test("Deny with a reason gives the agent a denied result that names the reason", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await askFor(page, `Order new meters ${Date.now()}`);

  const card = page.getByTestId("tool-decision-card");
  await expect(card).toBeVisible();
  // Denying needs no reason; this person gives one.
  await card.getByRole("button", { name: "Add a reason", exact: true }).click();
  const reason = "The meters were replaced last month.";
  await card.getByRole("textbox", { name: /Reason/u }).fill(reason);
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await card.screenshot({ path: join(shotsDir, "tool-confirmation-reason-light-en-1280.png") });
  }
  await card.getByRole("button", { name: "Deny", exact: true }).click();

  // Nothing ran, and the agent read why.
  await expect(page.getByText(/Tool work completed/u).last()).toBeVisible();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(reason);
  await expect(page.getByText(`"recorded"`)).toHaveCount(0);
  await expect(page.getByTestId("tool-decision-card")).toHaveCount(0);
});
