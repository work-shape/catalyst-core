import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// While the host's confirmation card waits, the run's person sends a steer: the call is
// declined and nothing runs, the run goes on, and the agent answers the new message. Every tab
// on the conversation shows the steer in place, after the declined call and before the answer
// (FU-2, checks 85 and 87). The suite's server holds `e2e.confirm_note` for a confirmation.

/** The person of this spec, from `tests/fixtures/e2e-users/follow-up-steer-confirmation.yaml`. */
const person = { email: "e2e-steer-confirm@example.test", password: "e2e-steer-confirm-password" };
/** A new person steers their own run with Enter. */
const STEER = "Enter";

async function signIn(page: Page): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

/** The thread: the request, the declined call, the steer and the answer to it, in order. */
async function expectSteerInPlace(page: Page, steer: string, answer: string): Promise<void> {
  const messages = page.locator('[data-role="user"], [data-role="assistant"]');
  const steered = messages.filter({ hasText: steer }).and(page.locator('[data-role="user"]'));
  await expect(steered).toHaveCount(1);
  const answered = page.locator('[data-role="assistant"]').filter({ hasText: answer });
  await expect(answered).toHaveCount(1);
  // The call's message, the steer, then the answer to it, and nothing after it.
  await expect
    .poll(() =>
      messages.evaluateAll(
        (nodes, texts) =>
          nodes.map((node) => {
            const role = node.getAttribute("data-role");
            const text = node.textContent ?? "";
            if (role === "user" && text.includes(texts.steer)) return "steer";
            return role === "assistant" && text.includes(texts.answer) ? "answer" : role;
          }),
        { steer, answer }
      )
    )
    .toEqual(["user", "assistant", "steer", "answer"]);
}

function card(page: Page): Locator {
  return page.getByTestId("tool-decision-card");
}

test("a steer declines the waiting confirmation, and every tab shows it in place", async ({
  browser
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: uiOrigin });
  const page = await context.newPage();
  await signIn(page);
  await page.goto("/");
  const note = `Call the tenant ${Date.now()}`;
  await page
    .getByPlaceholder("Message")
    .fill(`/tool e2e.confirm_note ${JSON.stringify({ text: note })}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(card(page)).toBeVisible();
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);

  // A second tab on the conversation shows the same card.
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(card(other)).toBeVisible();

  const steer = `Leave the tenant be ${Date.now()}`;
  const input = page.getByPlaceholder("Message");
  await input.fill(steer);
  await input.press(STEER);

  // The call was declined and nothing ran; the agent answered the steer.
  const answer = `I received "${steer}"`;
  for (const tab of [page, other]) {
    await expect(card(tab)).toHaveCount(0);
    await expectSteerInPlace(tab, steer, answer);
    await expect(tab.getByText(`"recorded"`)).toHaveCount(0);
  }
  // After a reload, from the stored rows.
  await other.reload();
  await expectSteerInPlace(other, steer, answer);
  await context.close();
});
