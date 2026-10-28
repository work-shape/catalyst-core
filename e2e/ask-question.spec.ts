import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// ASK-1: the agent asks one question with a few answers. The card stands in the conversation,
// the recommended answer first; the run ends its turn there. Picking an answer sends it as the
// person's message and the agent goes on by itself; the answered card shows the answer, takes
// no other and stays so after a reload. An answer typed on the card works the same way. Fails
// without the change: the tool does not exist, and the agent would answer the question itself.

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;

const question = {
  question: "Wer soll die Übersicht nutzen können?",
  options: [
    { label: "Mein ganzes Team", description: "Alle sehen dieselben Zahlen" },
    { label: "Nur ich", description: "Teilen kannst du sie später", recommended: true }
  ]
};

/** Lets the agent call a tool, and waits for the card the call leaves, not for an answer. */
async function ask(page: Page, input: unknown): Promise<void> {
  const composer = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
  await composer.fill(`/tool ask_question ${JSON.stringify(input)}`);
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
}

/** Pictures of the card at phone width in both themes, and at desktop width, where asked. */
async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize() ?? { width: 390, height: 844 };
  for (const [theme, width] of [
    ["light", 390],
    ["dark", 390],
    ["light", 1280],
    ["dark", 1280]
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(
      (value) => window.localStorage.setItem("vivd-catalyst:theme", value),
      theme
    );
    await page.reload();
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotsDir, `ask-question-${name}-${theme}-${width}.png`),
      animations: "disabled"
    });
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "light"));
  await page.setViewportSize(size);
  await page.reload();
}

test("the agent asks with a card, the person picks an answer, and the agent goes on", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 300_000 : 180_000);
  await signIn(page, superadmin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();

  await ask(page, question);
  const card = page.getByTestId("question-card").first();
  await expect(card).toHaveAttribute("data-state", "open");
  await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/]+$/u);
  // The recommended answer stands first and says so.
  const options = card.locator("[data-question-option]");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText("Nur ich");
  await expect(options.first()).toContainText("Empfohlen");
  await expect(options.first()).toContainText("Teilen kannst du sie später");
  await expect(options.last()).toContainText("Mein ganzes Team");
  await expect(card.getByPlaceholder("Oder eigene Antwort")).toBeVisible();
  // The run ended its turn with the question: the agent answers nothing of its own.
  await expect(page.getByRole("button", { name: "Nachricht senden" })).toBeVisible();
  await expect(page.getByText(/^Tool work completed:/u)).toHaveCount(0);
  await shoot(page, card, "open");

  // Picking an answer sends it as the person's message, and the agent goes on by itself.
  await options.first().click();
  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card.locator("[data-question-answer]")).toContainText("Deine Antwort");
  await expect(card.locator("[data-question-answer]")).toContainText("Nur ich");
  await expect(card.locator("[data-question-option]")).toHaveCount(0);
  await expect(page.locator('[data-role="user"]').last()).toContainText("Nur ich");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(
    'Local agent response: I received "Nur ich"',
    { timeout: 60_000 }
  );
  await shoot(page, card, "answered");

  // After a reload the card is still answered and takes no other answer.
  await page.reload();
  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card.locator("[data-question-answer]")).toContainText("Nur ich");
  await expect(card.locator("[data-question-option]")).toHaveCount(0);
  await expect(card.locator("[data-question-own]")).toHaveCount(0);
  await shoot(page, card, "reloaded");

  // An answer of the person's own, typed on the card, goes the same way.
  await ask(page, {
    question: "Was soll die Übersicht zuerst zeigen?",
    options: [
      { label: "Offene Aufgaben", recommended: true, description: "Was heute ansteht" },
      { label: "Umsatz des Monats" }
    ]
  });
  const second = page.getByTestId("question-card").nth(1);
  await expect(second).toHaveAttribute("data-state", "open");
  await second.getByPlaceholder("Oder eigene Antwort").fill("Beides nebeneinander");
  await second.getByRole("button", { name: "Antworten", exact: true }).click();
  await expect(second).toHaveAttribute("data-state", "answered");
  await expect(second.locator("[data-question-answer]")).toContainText("Beides nebeneinander");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(
    'Local agent response: I received "Beides nebeneinander"',
    { timeout: 60_000 }
  );
  // The first card keeps its own answer.
  await expect(card.locator("[data-question-answer]")).toContainText("Nur ich");
});
