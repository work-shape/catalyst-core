import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { requestAnswered } from "./allowed-page-errors";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The guardrails on a person's chat message (GR-4), in the composer. The suite's instance runs
// the default rules on chat input. A password written out is warned about: the message is not
// sent until the person sends it anyway. A card number is blocked: nothing is sent or stored,
// the draft stays in the composer, and after a reload neither the transcript nor the page holds
// it. Fails without GR-4: both messages went out as they were.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** From `tests/fixtures/e2e-users/chat-input-guardrails.yaml`. No other spec uses this person. */
const person = {
  email: "e2e-chat-input-guardrails@example.test",
  password: "e2e-chat-input-guardrails-password"
};
/** Set to a directory to keep pictures: 1280 and 390, light and dark. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const WARN_TITLE = "the composer warns about a password and sends it once the person says so";
const BLOCK_TITLE =
  "the composer keeps a blocked card number as a draft, and nothing of it is stored";
/** A test card number that passes the Luhn check. */
const CARD_NUMBER = "4111 1111 1111 1111";

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "chat-input-warned",
        reason:
          "Chromium's own log line: the instance answers a message a guardrail warns about with " +
          "409 until the person sends it anyway, which the test does.",
        matches: requestAnswered(409),
        path: /^\/api\/v1\/conversations\/(?:[^/]+\/)?runs$/u,
        tests: [WARN_TITLE]
      },
      {
        name: "chat-input-blocked",
        reason:
          "Chromium's own log line: the instance answers a message a guardrail blocks with 403, " +
          "and the test asserts that the draft stays and nothing is stored.",
        matches: requestAnswered(403),
        path: /^\/api\/v1\/conversations\/(?:[^/]+\/)?runs$/u,
        tests: [BLOCK_TITLE]
      }
    ]
  }
});

test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: person.email, password: person.password, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("vivd-catalyst:locale")) {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      window.localStorage.setItem("vivd-catalyst:theme", "light");
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
}

function composer(page: Page): Locator {
  return page.getByPlaceholder("Nachricht");
}

function userMessages(page: Page): Locator {
  return page.locator('[data-role="user"]');
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Nachricht senden" }).click();
}

/** The notice has no part wider than the page at phone width. */
async function expectFitsPhone(page: Page, notice: Locator): Promise<void> {
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(notice).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await notice.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
}

/**
 * Pictures of the notice at 1280 and 390, light and dark. The notice lives in the page only, so
 * after each reload in a theme the message is sent once more to bring it back.
 */
async function shoot(page: Page, name: string, text: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (chosen) => window.localStorage.setItem("vivd-catalyst:theme", chosen),
      theme
    );
    await page.reload();
    await send(page, text);
    await expect(page.getByTestId("chat-input-refusal")).toBeVisible({ timeout: 30_000 });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: join(shotsDir, `chat-input-${name}-${width}-de-${theme}.png`),
        animations: "disabled"
      });
    }
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await send(page, text);
  await expect(page.getByTestId("chat-input-refusal")).toBeVisible({ timeout: 30_000 });
}

test(WARN_TITLE, async ({ page }) => {
  test.setTimeout(shotsDir ? 180_000 : 90_000);
  const id = randomUUID().slice(0, 8);
  const text = `Für den Zugang: Passwort: Sommer-${id}`;
  await signIn(page);

  // The first message of a conversation: the guardrail warns, nothing is sent.
  await send(page, text);
  const notice = page.getByTestId("chat-input-refusal");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("data-outcome", "warn");
  await expect(notice).toContainText("Noch nicht gesendet.");
  const answer = notice.locator(
    '[data-testid="guardrail-answer"][data-guardrail="chat-passwords"]'
  );
  await expect(answer).toContainText("Passwörter im Chat");
  await expect(answer.getByTestId("guardrail-answer-reason")).toContainText(
    "Die Nachricht enthält offenbar ein Passwort."
  );
  await expect(composer(page)).toHaveValue(text);
  await expect(userMessages(page)).toHaveCount(0);
  await expectFitsPhone(page, notice);
  await shoot(page, "warn", text);

  // The person sends it anyway: it goes out as written, and the notice goes.
  await notice.getByTestId("chat-input-send-anyway").click();
  await expect(userMessages(page).filter({ hasText: `Sommer-${id}` })).toHaveCount(1, {
    timeout: 30_000
  });
  await expect(notice).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
});

test(BLOCK_TITLE, async ({ page }) => {
  test.setTimeout(shotsDir ? 180_000 : 90_000);
  const id = randomUUID().slice(0, 8);
  const first = `Bitte fasse den Vorgang ${id} zusammen.`;
  await signIn(page);

  // A conversation the person already has, whose run has ended.
  await send(page, first);
  await expect(userMessages(page).filter({ hasText: first })).toHaveCount(1, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByRole("button", { name: "Nachricht senden" })).toBeVisible({
    timeout: 30_000
  });

  const blocked = `Meine Karte ist ${CARD_NUMBER}, Vorgang ${id}`;
  await send(page, blocked);
  const notice = page.getByTestId("chat-input-refusal");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("data-outcome", "block");
  await expect(notice).toContainText("Nicht gesendet.");
  await expect(
    notice.locator('[data-testid="guardrail-answer"][data-guardrail="chat-card-numbers"]')
  ).toContainText("Kartennummern im Chat");
  // A block cannot be sent anyway; the draft stays to be changed.
  await expect(notice.getByTestId("chat-input-send-anyway")).toHaveCount(0);
  await expect(composer(page)).toHaveValue(blocked);
  await expect(userMessages(page)).toHaveCount(1);
  // The refusal is said above the composer, not as a failure of the answer before it.
  await expect(page.getByTestId("message-error")).toHaveCount(0);
  await expectFitsPhone(page, notice);
  await shoot(page, "block", blocked);

  // After a reload, the conversation holds the first message and nothing of the blocked one.
  await page.reload();
  await expect(userMessages(page).filter({ hasText: first })).toHaveCount(1, { timeout: 30_000 });
  await expect(userMessages(page)).toHaveCount(1);
  expect(await page.locator("main, body").first().innerText()).not.toContain(CARD_NUMBER);
  const conversationId = /\/c\/([^/]+)$/u.exec(page.url())?.[1];
  expect(conversationId).toBeDefined();
  const history = await page.request.get(
    `${apiBaseUrl}/api/v1/conversations/${conversationId ?? ""}/thread`
  );
  expect(history.ok()).toBe(true);
  expect(await history.text()).not.toContain(CARD_NUMBER);
});
