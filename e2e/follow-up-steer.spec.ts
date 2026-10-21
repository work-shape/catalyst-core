import type { Page, Request } from "@playwright/test";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// A person chooses Steer on You > Language and appearance, and the choice holds on another
// device: during their run Enter steers and Cmd+Enter (Ctrl+Enter) queues, with no run both
// just send, and the send button's tooltip names the mode (FU-2, check 89).

/** The person of this spec, from `tests/fixtures/e2e-users/follow-up-steer.yaml`. */
const person = { email: "e2e-steer@example.test", password: "e2e-steer-password" };

/** The fixture model echoes about 20 ms a word: this keeps a run going for some 30 seconds. */
const RUN_WORDS = 1_500;
/** The key that sends in the other mode in the browser the suite runs. */
const OTHER = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";

async function signIn(page: Page): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

/** The follow-up mode a message was sent with. */
function sentMode(request: Request): unknown {
  const body: unknown = request.postDataJSON();
  return typeof body === "object" && body !== null && "followUp" in body
    ? body.followUp
    : undefined;
}

function nextSend(page: Page): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === "POST" && /\/api\/v1\/conversations\/[^/]+\/runs$/u.test(request.url())
  );
}

test("Steer, chosen once, decides what Enter does during the person's run on another device", async ({
  browser
}) => {
  test.setTimeout(180_000);
  // The first device chooses Steer. A new person starts with Queue.
  const first = await browser.newContext({ baseURL: uiOrigin });
  const settings = await first.newPage();
  await signIn(settings);
  await settings.goto("/settings/you/language-appearance");
  const choice = settings.getByRole("radiogroup", { name: "Enter while an answer runs" });
  await expect(choice.getByRole("radio", { name: "Queue" })).toBeChecked();
  const saved = settings.waitForResponse(
    (response) => response.url().endsWith("/api/v1/me") && response.request().method() === "PATCH"
  );
  await choice.getByRole("radio", { name: "Steer" }).click();
  expect((await saved).ok()).toBe(true);
  await first.close();

  // Another device, where nothing of the first is stored.
  const second = await browser.newContext({ baseURL: uiOrigin });
  const page = await second.newPage();
  await signIn(page);
  await page.goto("/");
  const input = page.getByPlaceholder("Message");

  // A run starts with either key while none goes: here the one that would queue during a run.
  await input.fill(
    ["Start", ...Array.from({ length: RUN_WORDS - 1 }, (_, i) => `w${i}`)].join(" ")
  );
  await input.press(OTHER);
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

  // During the run Enter steers: the button and its tooltip say so.
  await input.fill("Also look at the attic");
  const steerButton = page.getByRole("button", { name: "Steer the running answer" });
  await expect(steerButton).toBeVisible();
  await expect(steerButton).toHaveAttribute(
    "title",
    /^Steer: read after the current step\. (⌘|Ctrl)\+Enter sends after this answer instead\.$/u
  );
  const steered = nextSend(page);
  await input.press("Enter");
  expect(sentMode(await steered)).toBe("steer");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("Also look at the attic")).toBeVisible();
  await expect(queue.getByText("Read after the current step")).toBeVisible();

  // Cmd+Enter (Ctrl+Enter) queues instead.
  await input.fill("Then summarise");
  const queued = nextSend(page);
  await input.press(OTHER);
  expect(sentMode(await queued)).toBe("queue");
  await expect(queue.getByText("Then summarise")).toBeVisible();

  await page.getByRole("button", { name: "Stop generating" }).click();
  await second.close();
});
