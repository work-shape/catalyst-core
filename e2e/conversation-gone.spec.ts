import type { Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { shootEverywhere } from "./surface-shots";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";
import { requestAnswered } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "conversation-that-is-gone",
        reason:
          "Chromium's own log line: the test opens addresses of conversations that were deleted, " +
          "expired, are another person's or never were. The instance answers 404 to the thread and " +
          "to the reads beside it, and the chat says the conversation is gone, which the test asserts.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/conversations\/[^/]+\/(?:thread|subagents|resources|draft-attachments)$/u,
        tests: ["a conversation that is gone says so, however it went, and leads to a new chat"]
      }
    ]
  }
});

// An address of a conversation that is gone opened an empty chat: no messages, no title, only
// the composer, and nothing said why. The instance refuses the thread read alike whether the
// conversation was deleted, expired, lies in a workspace the reader does not reach or never
// was, so the chat says the same for each and offers a new chat.

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
/** The members of this file alone. */
const reader = {
  email: "e2e-conversation-gone@example.test",
  password: "e2e-conversation-gone-password"
};
const other = {
  email: "e2e-conversation-gone-other@example.test",
  password: "e2e-conversation-gone-other-password"
};
const gone = "There is no conversation at this address.";

const conversationSchema = z.object({ id: z.string(), collaborationWorkspaceId: z.string() });

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: { email: person.email, password: person.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function createConversation(page: Page, title: string) {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations`, {
    data: { title }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return conversationSchema.parse(await created.json());
}

/** What the retention job leaves of a conversation whose retention date has passed. */
async function expire(conversationId: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const expired = await sql`
      update conversations
      set status = 'retention_expired', retained_until = now() - interval '1 day'
      where id = ${conversationId}
    `;
    expect(expired.count).toBe(1);
  } finally {
    await sql.end();
  }
}

function goneState(page: Page) {
  return page.locator("[data-conversation-gone]");
}

/** The chat says the conversation is gone, as its one title, and shows no thread to write in. */
async function expectGone(page: Page, address: string): Promise<void> {
  const answered = page.waitForResponse((response) =>
    /\/api\/v1\/conversations\/[^/]+\/thread$/u.test(new URL(response.url()).pathname)
  );
  await page.goto(address);
  expect((await answered).status()).toBe(404);
  const sentence = goneState(page).getByRole("heading", { level: 1 });
  await expect(sentence).toHaveText(gone);
  await expect(sentence).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByPlaceholder("Message")).toHaveCount(0);
  // The address stays as it was opened; nothing leads it elsewhere by itself.
  await expect(page).toHaveURL(
    new RegExp(`${address.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u")
  );
}

test("a conversation that is gone says so, however it went, and leads to a new chat", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  // The other person's conversation, in the other person's own workspace.
  await signIn(page, other);
  const othersConversation = await createConversation(page, "Not for the reader");

  await signIn(page, reader);
  const deleted = await createConversation(page, "Deleted");
  const workspace = encodeURIComponent(deleted.collaborationWorkspaceId);
  const removed = await requestWithOrigin(
    page,
    "delete",
    `${apiOrigin}/api/v1/conversations/${encodeURIComponent(deleted.id)}`
  );
  expect(removed.ok(), await removed.text()).toBe(true);
  const expired = await createConversation(page, "Expired");
  await expire(expired.id);

  const cases = {
    deleted: `/w/${workspace}/c/${deleted.id}`,
    expired: `/w/${workspace}/c/${expired.id}`,
    otherWorkspace: `/w/${workspace}/c/${othersConversation.id}`,
    neverMade: `/w/${workspace}/c/conv_never_made`
  };
  for (const address of Object.values(cases)) {
    await expectGone(page, address);
  }

  // The one step opens a new chat of the same workspace, ready to write in.
  await goneState(page).getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspace}$`, "u"));
  await expect(goneState(page)).toHaveCount(0);
  await expect(page.getByPlaceholder("Message")).toBeFocused();

  // Back returns to the address and to what it says.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${cases.neverMade}$`, "u"));
  await expect(goneState(page).getByRole("heading", { level: 1 })).toHaveText(gone);

  // A conversation that is there opens as before.
  const kept = await createConversation(page, "Kept");
  await page.goto(`/w/${workspace}/c/${kept.id}`);
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await expect(goneState(page)).toHaveCount(0);

  await page.goto(cases.deleted);
  await shootEverywhere(page, "conversation-gone", async () => {
    await expect(goneState(page).getByRole("heading", { level: 1 })).toHaveText(
      /^(There is no conversation at this address\.|Unter dieser Adresse gibt es keine Unterhaltung\.)$/u
    );
    await expect(goneState(page).getByRole("button")).toBeInViewport({ ratio: 1 });
  });
});
