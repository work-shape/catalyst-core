import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

/** The member of this file alone: its conversations ride in the dock. */
const member = { email: "e2e-dock@example.test", password: "e2e-dock-password" };

/**
 * The fixture model echoes a message one word every 20 ms, so this many words are a run of
 * about ten seconds.
 */
const longRunWords = 500;

/** The one column the conversation lives in, on the chat route and in the dock. */
const chatColumn = (page: Page) => page.locator("[data-dock-chat]");

const dockHead = (page: Page) => chatColumn(page).locator("header").first();

const pageAction = (page: Page) => page.getByTestId("dock-page-action");

// DOCK-1, acceptance check 24: fails where a change of route ends the run's stream; the dock
// would then open the stream again or lose the answer's end.
test("a run in the dock keeps streaming while the person goes to another page, and a closed dock comes back", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const stamp = Date.now();
  const conversation = await createListedConversation(
    page,
    `Dock streams ${stamp}`,
    `Opening ${stamp}`
  );
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  const eventRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /^\/api\/v1\/conversations\/[^/]+\/runs\/[^/]+\/events$/u.test(
        new URL(request.url()).pathname
      )
    ) {
      eventRequests.push(request.url());
    }
  });

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  const composer = chatColumn(page).getByPlaceholder("Message");
  const stop = chatColumn(page).getByRole("button", { name: "Stop generating" });
  await composer.fill(words(`stream-${stamp}`, longRunWords));
  await composer.press("Enter");
  await expect(stop).toBeVisible();
  await expect.poll(() => eventRequests.length).toBeGreaterThan(0);
  const streamsBefore = eventRequests.length;

  await page.getByRole("button", { name: "E2E Zz Dock account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(stop).toBeVisible();

  // Closed, the dock leaves the address and the page head offers it back, with a dot while
  // its answer runs.
  await dockHead(page).getByRole("button", { name: "Close chat" }).click();
  await expect(page).toHaveURL(/\/settings\/you\/profile$/u);
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "closed");
  await expect(chatColumn(page)).not.toBeVisible();
  await expect(pageAction(page)).toHaveText(/^Chat/u);
  await expect(pageAction(page).getByTestId("dock-running-dot")).toBeVisible();
  await pageAction(page).click();
  await expect(page).toHaveURL(new RegExp(`/settings/you/profile\\?chat=${conversation.id}$`, "u"));
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");

  // The answer ends in the dock, from the stream it had all along.
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(
    chatColumn(page)
      .getByText(`w${longRunWords - 2}`, { exact: false })
      .last()
  ).toBeVisible();
  expect(eventRequests).toHaveLength(streamsBefore);
  await expect(pageAction(page)).toHaveCount(0);
});

declare global {
  interface Window {
    /** How many view transitions the page started, counted by the test. */
    dockViewTransitions?: number;
  }
}

function words(token: string, count: number): string {
  return [token, ...Array.from({ length: count - 1 }, (_, index) => `w${index}`)].join(" ");
}

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A conversation the list shows: one with a message, whose run has ended. */
async function createListedConversation(
  page: Page,
  title: string,
  text: string
): Promise<{ id: string; collaborationWorkspaceId: string }> {
  if (page.url() === "about:blank") {
    await page.goto("/");
  }
  const started = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
    data: { idempotencyKey: randomUUID(), conversation: { title }, message: { text } }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = z
    .object({ conversation: z.object({ id: z.string(), collaborationWorkspaceId: z.string() }) })
    .parse(await started.json());
  await expect
    .poll(
      async () => {
        const thread = await page.request.get(
          `${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/thread`
        );
        expect(thread.ok()).toBe(true);
        const snapshot = z
          .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
          .parse(await thread.json());
        return { running: snapshot.activeRun !== undefined, messages: snapshot.messages.length };
      },
      { timeout: 30_000 }
    )
    .toEqual({ running: false, messages: 2 });
  return conversation;
}

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const WIDE = { width: 1280, height: 800 };

const idSchema = z.object({ id: z.string() });

const studioDockHead = (page: Page) => page.getByTestId("dock-head");

const studioChatAction = (page: Page) => page.getByTestId("dock-page-action");

const studioConversationOf = (page: Page) => new URL(page.url()).searchParams.get("chat");

/** The dock is shut: never opened on this page yet, or closed. */
const expectDockShut = (page: Page) => expect(chatColumn(page)).not.toBeVisible();

async function signInStudio(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

/** A shared workspace, opened once so the sidebar and Studio's scope know it. */
async function openSharedWorkspace(page: Page, name: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = idSchema.parse(await created.json()).id;
  await page.goto(`/w/${id}/agents`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return id;
}

/** Studio's Agents under one scope: the instance, or a workspace by its name. */
async function agentsUnder(page: Page, scope: string): Promise<void> {
  await page.goto("/build/agents");
  const picker = page.getByRole("button", { name: /^(?:Scope|Geltungsbereich): / });
  await picker.click();
  await page.getByRole("option", { name: scope, exact: true }).click();
  await expect(picker).toHaveAccessibleName(new RegExp(`: ${scope}$`, "u"));
}

test("Chat opens the dock from a list, and brings its conversation back after a close and a reload", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(WIDE);
  await signInStudio(page);
  const team = `Team ${randomUUID().slice(0, 8)}`;
  const workspaceId = await openSharedWorkspace(page, team);
  try {
    await agentsUnder(page, team);
    await expectDockShut(page);

    // With no conversation yet, Chat opens an empty dock with the agent that builds. It says
    // where a new agent is created.
    await expect(studioChatAction(page)).toHaveText(/^Chat/u);
    await studioChatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    await expect(chatColumn(page)).toContainText("What should the new agent do?");
    await expect(chatColumn(page).locator("[data-dock-creation-target]")).toHaveText(
      `New agents are created in “${team}”.`
    );
    // The page head offers no second Chat while the dock is open.
    await expect(studioChatAction(page)).toHaveCount(0);

    const composer = chatColumn(page).getByPlaceholder("Message");
    await composer.fill("Hello from the list");
    await composer.press("Enter");
    await expect.poll(() => studioConversationOf(page)).not.toBeNull();
    await expect(chatColumn(page)).toContainText("Local agent response");
    const conversation = studioConversationOf(page);

    // Closed, Chat brings the same conversation back.
    await studioDockHead(page).getByRole("button", { name: "Close chat" }).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "closed");
    await studioChatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    expect(studioConversationOf(page)).toBe(conversation);

    // So does a reload with the dock closed: the browser keeps which conversation it was.
    await studioDockHead(page).getByRole("button", { name: "Close chat" }).click();
    await page.reload();
    await expectDockShut(page);
    await studioChatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    expect(studioConversationOf(page)).toBe(conversation);
    await expect(chatColumn(page)).toContainText("Hello from the list");

    // ⌘J / Ctrl+J closes and opens it too.
    await page.keyboard.press("ControlOrMeta+j");
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "closed");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    expect(studioConversationOf(page)).toBe(conversation);

    // "New chat" in the dock's head starts an empty one for the page.
    await studioDockHead(page).getByRole("button", { name: "New chat" }).click();
    await expect(chatColumn(page)).toContainText("What should the new agent do?");
    expect(studioConversationOf(page)).not.toBe(conversation);
  } finally {
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});

// CHAT-LINK-1: the agent named the way to a page as text, and the person clicked through the
// interface to find it. A link in its answer to a page of the app now opens that page in place,
// with the same conversation in the dock.
test("a link in an answer opens the Data Store's page in place, the conversation docked beside it", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(WIDE);
  await page.goto("/");
  await signInStudio(page);
  const suffix = randomUUID().slice(0, 8);
  const store = `e2e-link-orders-${suffix}`;
  const title = `Orders ${suffix}`;
  const written = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/data_store/${store}`,
    {
      data: {
        expectedRevision: null,
        files: [
          { path: "store.yaml", text: `id: ${store}\nname: ${title}\n` },
          {
            path: "migrations/0001_init.sql",
            text: "create table orders (id text primary key);\n"
          }
        ]
      }
    }
  );
  expect(written.ok(), await written.text()).toBe(true);
  try {
    const conversation = await createListedConversation(
      page,
      `Link ${suffix}`,
      `Publish it on [${title}](/build/data-stores/${store}?chat=conv_other).`
    );
    await page.goto(
      `/w/${encodeURIComponent(conversation.collaborationWorkspaceId)}/c/${conversation.id}`
    );
    const link = chatColumn(page).locator("a[data-page-link]").last();
    await expect(link).toHaveText(title);
    // The address a copy or a new tab takes is the page's own, with no conversation.
    await expect(link).toHaveAttribute("href", `/build/data-stores/${store}`);

    await link.click();
    await expect(page).toHaveURL(
      new RegExp(`/build/data-stores/${store}\\?chat=${conversation.id}$`, "u")
    );
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    await expect(chatColumn(page)).toContainText("Local agent response");
  } finally {
    const storeUrl = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
    const deleted = await requestWithOrigin(page, "post", `${storeUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, storeUrl) }
    });
    expect(deleted.ok()).toBe(true);
  }
});
