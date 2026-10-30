import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// What a person is shown of a guardrail where they act (GR-3): on the tool card of a refused
// call, on the confirmation card of a call a guardrail warned about, in the Inbox item of a call
// a guardrail held, and on the read-only Rules in force page, which every answer links to. Each
// answer names the guardrail, its reason, its outcome, its scope and version and who can change
// it, and offers to ask them. The suite's server holds `e2e.confirm_note` for a confirmation
// (clients/demo/src/e2e-server.ts); a guardrail holds it for an approval. Fails without GR-3:
// a refused call showed the model's sentence alone, and there was no Rules in force page.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const admin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/guardrail-answers.yaml`. */
const member = {
  email: "e2e-guardrail-answers@example.test",
  password: "e2e-guardrail-answers-password"
};
/** Set to a directory to keep pictures: 1280 and 390, light and dark. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const CONFIRMED_TOOL = "e2e.confirm_note";
const guardrailUrl = (name: string) => `${apiBaseUrl}/api/v1/assets/guardrail/${name}`;

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: who.email, password: who.password, rememberMe: true }
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
  await expect(page.getByPlaceholder("Nachricht")).toBeVisible();
}

async function adminPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, admin);
  return page;
}

/** Writes and publishes an instance guardrail on calls of one tool whose input holds `marker`. */
async function publishGuardrail(
  page: Page,
  name: string,
  input: { tool: string; marker: string; outcome: "block" | "warn" | "require_approval" }
): Promise<void> {
  const url = guardrailUrl(name);
  const written = await requestWithOrigin(page, "put", url, {
    data: {
      expectedRevision: await assetBaseRevision(page, url),
      config: {
        name,
        displayName: `E2E Regel ${name.slice(-6)}`,
        on: "operation.before_call",
        filter: { operation: input.tool },
        check: {
          kind: "pattern",
          pattern: input.marker,
          reason: "Notizen mit diesem Wort prüft das Team vorher."
        },
        outcome: input.outcome
      }
    }
  });
  expect(written.ok(), await written.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${url}/publish`, {
    data: { revision: await assetRevision(page, url) }
  });
  expect(published.ok(), await published.text()).toBe(true);
}

async function removeGuardrail(page: Page, name: string): Promise<void> {
  const url = guardrailUrl(name);
  if ((await page.request.get(url)).status() === 404) return;
  await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/guardrails/${name}/unpublish`, {
    data: {}
  });
  const removed = await requestWithOrigin(page, "post", `${url}/delete`, {
    data: { expectedRevision: await assetRevision(page, url) }
  });
  expect(removed.ok(), `Delete during cleanup: ${removed.status()}`).toBe(true);
}

async function callTool(page: Page, tool: string, text: string): Promise<void> {
  await page.getByPlaceholder("Nachricht").fill(`/tool ${tool} ${JSON.stringify({ text })}`);
  await page.getByRole("button", { name: "Nachricht senden" }).click();
}

/** Pictures of what `ready` shows: 1280 and 390 wide, light and dark. */
async function shoot(page: Page, name: string, ready: Locator, settled = ready): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        (chosen) => window.localStorage.setItem("vivd-catalyst:theme", chosen),
        theme
      );
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(ready).toBeVisible();
      await expect(settled).toBeVisible();
      await ready.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(shotsDir, `guardrail-answers-${name}-${width}-de-${theme}.png`),
        animations: "disabled"
      });
    }
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(ready).toBeVisible();
}

/** The answer has no part wider than the page at phone width. */
async function expectFitsPhone(page: Page, answer: Locator): Promise<void> {
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(answer).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await answer.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("a refused call shows the guardrail's answer on its card, the person asks, and Rules in force lists it", async ({
  page,
  browser,
  baseURL
}) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  const id = randomUUID().replaceAll("-", "").slice(0, 8);
  const name = `e2e-gr3-block-${id}`;
  const marker = `SPERRWORT${id}`;
  const setup = await adminPage(browser, baseURL);
  try {
    await publishGuardrail(setup, name, { tool: CONFIRMED_TOOL, marker, outcome: "block" });
    await signIn(page, member);
    await callTool(page, CONFIRMED_TOOL, `Notiz mit ${marker}`);

    const answer = page.locator(`[data-testid="guardrail-answer"][data-guardrail="${name}"]`);
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(answer).toHaveAttribute("data-outcome", "block");
    await expect(answer).toContainText(`Leitplanke „E2E Regel ${name.slice(-6)}“`);
    await expect(answer.getByTestId("guardrail-answer-reason")).toHaveText(
      "Notizen mit diesem Wort prüft das Team vorher."
    );
    await expect(answer.getByTestId("guardrail-answer-facts")).toHaveText(
      "Blockiert · Alle Arbeitsbereiche · Version 1"
    );
    await expect(answer.getByTestId("guardrail-answer-who")).toContainText("Version 1");
    // The call never ran and no confirmation was asked.
    await expect(page.getByTestId("tool-decision-card")).toHaveCount(0);
    await expectFitsPhone(page, answer);
    await shoot(page, "tool-card", answer, answer.getByTestId("guardrail-answer-ask"));

    // The person asks who can change it; the question goes to their Inbox.
    await answer.getByTestId("guardrail-answer-ask").click();
    await answer.getByLabel("Deine Frage").fill("Warum ist dieses Wort gesperrt?");
    await answer.getByRole("button", { name: "Frage senden" }).click();
    await expect(answer.getByTestId("guardrail-answer-asked")).toContainText("Inbox");

    // The answer leads to Rules in force, which lists the rule with its count.
    await answer.getByTestId("guardrail-answer-rules").click();
    await expect(page).toHaveURL(/\/settings\/you\/rules$/u);
    await expect(page.getByRole("heading", { name: "Geltende Regeln", level: 1 })).toBeVisible();
    // The suite's configuration sets no floor; the unit tests show the operator's rules.
    const instance = page.locator('[data-testid="rules-in-force-group"][data-group="instance"]');
    const row = instance.locator(`[data-testid="rule-in-force"][data-rule="${name}"]`);
    await expect(row).toContainText("Blockiert");
    await expect(row.getByTestId("rule-in-force-hits")).toHaveText("1-mal in den letzten 30 Tagen");
    await expect(row.getByTestId("rule-in-force-reason")).toHaveText(
      "Notizen mit diesem Wort prüft das Team vorher."
    );
    await expectFitsPhone(page, row);
    await shoot(page, "rules-in-force", row);
  } finally {
    await removeGuardrail(setup, name);
    await setup.context().close();
  }
});

test("the confirmation card and the Inbox item show the guardrails that warned about or held a call", async ({
  page,
  browser,
  baseURL
}) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  const id = randomUUID().replaceAll("-", "").slice(0, 8);
  const warned = `e2e-gr3-warn-${id}`;
  const held = `e2e-gr3-hold-${id}`;
  const marker = `HINWEIS${id}`;
  const heldMarker = `FREIGABE${id}`;
  const setup = await adminPage(browser, baseURL);
  try {
    await publishGuardrail(setup, warned, { tool: CONFIRMED_TOOL, marker, outcome: "warn" });
    // On the confirmed tool too: the Inbox spec counts the rows of the held one.
    await publishGuardrail(setup, held, {
      tool: CONFIRMED_TOOL,
      marker: heldMarker,
      outcome: "require_approval"
    });
    await signIn(page, member);

    // A warning stands on the confirmation card, above Allow and Deny.
    await callTool(page, CONFIRMED_TOOL, `Notiz mit ${marker}`);
    const card = page.locator('[data-testid="tool-decision-card"][data-mode="confirm"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const warning = card.locator(`[data-testid="guardrail-answer"][data-guardrail="${warned}"]`);
    await expect(warning).toHaveAttribute("data-outcome", "warn");
    await expect(warning.getByTestId("guardrail-answer-facts")).toHaveText(
      "Warnt · Alle Arbeitsbereiche · Version 1"
    );
    // The rule is found in Rules in force: who can change it, and the way to ask them.
    await expect(warning.getByTestId("guardrail-answer-ask")).toBeVisible();
    await expect(warning.getByTestId("guardrail-answer-who")).toContainText("E2E Superadmin");
    await expectFitsPhone(page, card);
    await shoot(page, "confirmation-card", card, warning.getByTestId("guardrail-answer-ask"));
    await card.getByRole("button", { name: "Ablehnen", exact: true }).click();
    await expect(card).toHaveCount(0);

    // A held call's Inbox item says which guardrail held it, for who decides it.
    await callTool(page, CONFIRMED_TOOL, `Notiz mit ${heldMarker}`);
    await expect(
      page.locator('[data-testid="tool-decision-card"][data-mode="approval"]')
    ).toBeVisible({ timeout: 30_000 });
    await setup.goto("/inbox");
    const row = setup
      .getByTestId("inbox-row")
      .filter({ hasText: CONFIRMED_TOOL })
      .filter({ hasText: "E2E Zz Guardrail Answers" })
      .first();
    await row.getByRole("button").first().click();
    const call = setup.getByTestId("operation-call");
    const holding = call.locator(`[data-testid="guardrail-answer"][data-guardrail="${held}"]`);
    await expect(holding).toHaveAttribute("data-outcome", "require_approval");
    await expect(holding).toContainText("Eine Freigabe ist angefragt.");
    await expectFitsPhone(setup, holding);
    await shoot(setup, "inbox-item", holding, holding.getByTestId("guardrail-answer-ask"));
    await setup.locator('button[data-decision="reject"]').click();
    await expect(setup.locator('button[data-decision="reject"]')).toHaveCount(0);
  } finally {
    await removeGuardrail(setup, warned);
    await removeGuardrail(setup, held);
    await setup.context().close();
  }
});
