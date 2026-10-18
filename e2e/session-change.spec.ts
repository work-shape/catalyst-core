import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// ACCEPT-FIX-1 F3: a person who signs out, or whose browser is signed in as somebody else,
// leaves nothing in the tab for the next person: no upload notice with a file name, no draft,
// no conversation read before. Fails without the change: the next person saw the notice of the
// person before (`urlaub.txt: This file type is not supported ...`) until the page reloaded.

interface Person {
  displayLabel: string;
  email: string;
  password: string;
}

/** Makes a person of the test's own, with a password made for this run alone. */
async function createPerson(page: Page, label: string): Promise<Person> {
  const id = randomUUID();
  const person = {
    displayLabel: `${label} ${id.slice(0, 8)}`,
    email: `session-${id}@example.test`,
    password: randomUUID()
  };
  await signIn(page, reviewer);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/instance/users`, {
    data: {
      displayLabel: person.displayLabel,
      email: person.email,
      roles: ["user"],
      passwordSignIn: { password: person.password }
    }
  });
  expect(created.ok()).toBe(true);
  const signedOut = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-out`);
  expect(signedOut.ok()).toBe(true);
  return person;
}

async function signInOnPage(page: Page, person: Person): Promise<void> {
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password").fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: `${person.displayLabel} account` })).toBeVisible();
}

/**
 * What person A leaves in the tab: a conversation read, a refused upload whose notice names
 * the file, and a message typed and not sent.
 */
async function leaveStateOf(page: Page, tag: string) {
  const conversation = `A private ${tag}`;
  const refusedFile = `a-private-${tag}.exe`;
  const draft = `A draft ${tag}`;
  const message = page.getByPlaceholder("Message");

  await message.fill(conversation);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/^Local agent response:/u)).toBeVisible();
  await expect(page.getByTitle(conversation).first()).toBeVisible();

  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: refusedFile,
    mimeType: "application/x-msdownload",
    buffer: Buffer.from("not a document")
  });
  await expect(page.getByText(refusedFile, { exact: false })).toBeVisible();
  await message.fill(draft);
  await expect(message).toHaveValue(draft);
  return { conversation, refusedFile, draft };
}

async function expectNothingOf(page: Page, left: Awaited<ReturnType<typeof leaveStateOf>>) {
  await expect(page.getByText(left.refusedFile, { exact: false })).toHaveCount(0);
  await expect(page.getByTitle(left.conversation)).toHaveCount(0);
  await expect(page.getByText(left.draft, { exact: false })).toHaveCount(0);
  await expect(page.getByPlaceholder("Message")).toHaveValue("");
}

test("the next person in the same tab after a sign-out sees nothing of the person before", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const a = await createPerson(page, "Session A");
  const b = await createPerson(page, "Session B");
  const tag = randomUUID().slice(0, 8);

  await page.goto("/");
  await signInOnPage(page, a);
  const left = await leaveStateOf(page, tag);
  // The same document all along: a reload would forget everything and prove nothing.
  await page.evaluate(() => document.documentElement.setAttribute("data-session-probe", "kept"));

  await page.getByRole("button", { name: `${a.displayLabel} account` }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await signInOnPage(page, b);

  await expect(page.locator("html")).toHaveAttribute("data-session-probe", "kept");
  await expectNothingOf(page, left);
});

test("a tab whose browser is signed in as another person without a sign-out forgets the person before", async ({
  page,
  context
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const a = await createPerson(page, "Session A");
  const b = await createPerson(page, "Session B");
  const tag = randomUUID().slice(0, 8);

  await page.goto("/");
  await signInOnPage(page, a);
  const left = await leaveStateOf(page, tag);
  await page.evaluate(() => document.documentElement.setAttribute("data-session-probe", "kept"));

  // Another tab of the same browser signs in as B; this tab hears of it when it is shown again.
  const other = await context.newPage();
  await other.bringToFront();
  const signedIn = await requestWithOrigin(other, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: b.email, password: b.password, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await other.close();
  await page.bringToFront();
  // The synthetic event bubbles to the window listener, as a browser's event does.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
  );

  await expect(page.getByRole("button", { name: `${b.displayLabel} account` })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-session-probe", "kept");
  await expectNothingOf(page, left);
});
