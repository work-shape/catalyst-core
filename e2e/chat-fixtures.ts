import { randomUUID } from "node:crypto";
import { requestWithOrigin } from "./request-with-origin";
import type { Locator, Page } from "@playwright/test";
import { expect, test as baseTest } from "./test";
import { z } from "zod";
import { uiOrigin } from "./view-fixtures";
import type { APIRequestContext } from "@playwright/test";

export const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
export const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;
type SessionUser = "user" | "superadmin" | "anonymous";
export const test = baseTest.extend<
  { sessionUser: SessionUser },
  { sessionStates: (user: SessionUser) => Promise<StorageState> }
>({
  sessionUser: ["user", { option: true }],
  sessionStates: [
    async ({ playwright }, use) => {
      const states = new Map<SessionUser, StorageState>();
      await use(async (user) => {
        if (user === "anonymous") return { cookies: [], origins: [] };
        const stored = states.get(user);
        if (stored) return stored;
        const request = await playwright.request.newContext();
        try {
          const response = await request.post(apiBaseUrl + "/api/auth/sign-in/email", {
            headers: { Origin: uiOrigin },
            data: { ...(user === "user" ? normalUser : superadminUser), rememberMe: true }
          });
          expect(response.ok()).toBe(true);
          const state = await request.storageState();
          states.set(user, state);
          return state;
        } finally {
          await request.dispose();
        }
      });
    },
    { scope: "worker" }
  ],
  storageState: async ({ sessionUser, sessionStates }, use) => {
    await use(await sessionStates(sessionUser));
  }
});

export function settingsGear(page: Page): Locator {
  return page.getByRole("button", { name: "Settings", exact: true });
}

export function settingsPages(page: Page): Locator {
  return page.getByRole("navigation", { name: "Settings pages" });
}

export async function createListedConversation(page: Page, title: string): Promise<{ id: string }> {
  const started = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title },
      message: { text: `Opening message for ${title}` }
    }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = z
    .object({ conversation: z.object({ id: z.string() }) })
    .parse(await started.json());
  await expect
    .poll(async () => {
      const thread = await page.request.get(
        `${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/thread`
      );
      expect(thread.ok()).toBe(true);
      const snapshot = z
        .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
        .parse(await thread.json());
      return { running: snapshot.activeRun !== undefined, messages: snapshot.messages.length };
    })
    .toEqual({ running: false, messages: 2 });
  return conversation;
}

export function legacyConversationPath(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}

export const collaborationWorkspaceUrlPattern = /\/w\/[^/]+$/u;

export const collaborationWorkspaceConversationUrlPattern = /\/w\/[^/]+\/c\/[^/]+$/u;

export function conversationUrlPattern(conversationId: string): RegExp {
  return new RegExp(`/w/[^/]+/c/${escapeRegExp(encodeURIComponent(conversationId))}$`, "u");
}

export const COMPOSER_GROWTH_LINES = 6;

export const LONG_RUN_WORDS = 500;

export const LONG_RUN_END_TIMEOUT_MS = 30_000;

export const LONG_RUN_TEST_TIMEOUT_MS = 60_000;

export function holdAnswer(page: Page): Promise<() => void> {
  return holdGet(page, isRunEventsPath);
}

export function longRunMessage(token: string): string {
  return [token, ...Array.from({ length: LONG_RUN_WORDS - 1 }, (_, index) => `w${index}`)].join(
    " "
  );
}

export function isRunEventsPath(pathname: string): boolean {
  return /^\/api\/v1\/conversations\/[^/]+\/runs\/[^/]+\/events$/u.test(pathname);
}

export function currentConversationId(page: Page): string {
  const match = /^\/w\/[^/]+\/c\/([^/]+)$/u.exec(new URL(page.url()).pathname);
  if (!match?.[1]) {
    throw new Error(`Current route is not a conversation route: ${page.url()}`);
  }
  return decodeURIComponent(match[1]);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function holdGet(
  page: Page,
  matches: (pathname: string) => boolean
): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.origin === new URL(apiBaseUrl).origin && matches(url.pathname),
    async (route) => {
      if (route.request().method() === "GET") {
        await gate;
      }
      await route.continue();
    }
  );
  return () => release();
}

export function countRequests(
  page: Page,
  method: string,
  matches: (pathname: string) => boolean
): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === method && matches(new URL(request.url()).pathname)) {
      count += 1;
    }
  });
  return () => count;
}

export function countResponses(
  page: Page,
  method: string,
  matches: (pathname: string) => boolean
): () => number {
  let count = 0;
  page.on("response", (response) => {
    if (response.request().method() === method && matches(new URL(response.url()).pathname)) {
      count += 1;
    }
  });
  return () => count;
}

export async function expandDisclosure(trigger: Locator): Promise<void> {
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

export async function openWorkHistoryToolCard(chatRegion: Locator): Promise<Locator> {
  await expandDisclosure(chatRegion.getByRole("button", { name: /^Work history/u }));
  await expandDisclosure(weatherStepFold(chatRegion));
  const toolCallCard = chatRegion.getByTestId("tool-call-card").last();
  await expect(toolCallCard).toBeVisible();
  return toolCallCard;
}

export function weatherStepFold(chatRegion: Locator): Locator {
  return chatRegion
    .getByTestId("assistant-work-group-trigger")
    .filter({ hasText: /^Weather Forecast$/u });
}

export async function stopActiveRun(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop generating" });
  if ((await stopButton.count()) === 0) {
    return;
  }
  await stopButton.click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 10_000 });
}

export async function readPagedList<Item>(
  page: Page,
  path: string,
  schema: z.ZodType<{ items: Item[]; nextCursor?: string }>
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(path, apiBaseUrl);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await page.request.get(url.toString());
    expect(response.ok()).toBe(true);
    const result = schema.parse(await response.json());
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}
