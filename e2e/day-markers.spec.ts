import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { shootThemes } from "./surface-shots";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
/** The member of this file alone. */
const member = { email: "e2e-day-markers@example.test", password: "e2e-day-markers-password" };
const dayMs = 86_400_000;

// Days are counted in UTC, the time zone the browser is given, so the spec knows where they turn.
test.use({ timezoneId: "UTC", locale: "en-US" });

const markers = (scope: Page | ReturnType<Page["locator"]>) => scope.getByTestId("day-marker");

test("a conversation over several days shows when it started and where each day begins", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await signIn(page);
  const stamp = Date.now();
  const conversation = await startRun(page, undefined, `First question ${stamp}`);
  await startRun(page, conversation.id, `Second question ${stamp}`);

  // The first turn was four days ago, the second yesterday, both at a known time of day.
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );
  const fourDaysAgo = today - 4 * dayMs + (9 * 60 + 15) * 60_000;
  const yesterday = today - dayMs + (16 * 60 + 12) * 60_000;
  await moveTurns(conversation.id, [fourDaysAgo, yesterday]);
  const weekday = new Date(fourDaysAgo).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC"
  });

  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  await page.goto(`/w/${workspace}/c/${conversation.id}`);
  const thread = page.locator("[data-dock-chat] .chat-thread-inset");
  await expect(thread.getByText(`Second question ${stamp}`, { exact: true })).toBeVisible();
  await expect(markers(thread)).toHaveText([`${weekday} 9:15 AM`, "Yesterday 4:12 PM"]);
  // The marker at the very top stands above the first message, and each marker is a separator.
  await expect(
    thread.getByRole("separator", { name: `${weekday} 9:15 AM`, exact: true })
  ).toBeVisible();
  expect(
    await markers(thread)
      .first()
      .evaluate((marker) => marker.nextElementSibling?.textContent ?? "")
  ).toContain(`First question ${stamp}`);

  // A message today opens a day: its marker comes with the message and keeps its place while
  // the answer streams in and once it is stored.
  const words = [`Today question ${stamp}`, ...Array.from({ length: 150 }, (_, i) => `w${i}`)];
  await thread.getByPlaceholder("Message").fill(words.join(" "));
  await thread.getByPlaceholder("Message").press("Enter");
  const todayMarker = markers(thread).nth(2);
  await expect(todayMarker).toHaveText(/^Today \d{1,2}:\d{2}\s[AP]M$/u);
  await expect(page.getByTestId("run-activity")).toBeVisible();
  await expect(markers(thread)).toHaveCount(3);
  const besideToday = () =>
    todayMarker.evaluate((marker) => marker.nextElementSibling?.getAttribute("data-role"));
  expect(await besideToday()).toBe("user");
  await expect(page.getByTestId("run-activity")).toBeHidden({ timeout: 30_000 });
  await expect(markers(thread)).toHaveCount(3);
  expect(await besideToday()).toBe("user");
  await expect(
    todayMarker.evaluate((marker) => marker.nextElementSibling?.textContent ?? "")
  ).resolves.toContain(`Today question ${stamp}`);

  const fullReady = async () => {
    await expect(markers(thread)).toHaveCount(3);
    await thread.evaluate((element) => {
      element.style.scrollBehavior = "auto";
      element.scrollTop = 0;
    });
  };
  await fullReady();
  await shootThemes(page, "day-markers-full", fullReady);

  // The side chat beside a page shows the same markers.
  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  const dock = page.locator("[data-dock-chat]");
  await expect(dock).toHaveAttribute("data-chat-mode", "dock");
  const dockReady = async () => {
    await expect(markers(dock)).toHaveCount(3);
    await dock.locator(".chat-thread-inset").evaluate((element) => {
      element.style.scrollBehavior = "auto";
      element.scrollTop = 0;
    });
  };
  await dockReady();
  await expect(markers(dock).first()).toHaveText(`${weekday} 9:15 AM`);
  await shootThemes(page, "day-markers-side", dockReady);

  // At the reader's midnight the markers are read again, without a reload: today's becomes
  // yesterday's, and yesterday's names its weekday.
  await page.clock.install();
  await page.goto(`/w/${workspace}/c/${conversation.id}`);
  await expect(markers(thread).nth(2)).toHaveText(/^Today /u);
  await page.clock.fastForward(today + dayMs - Date.now() + 1_000);
  const yesterdaysWeekday = new Date(yesterday).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC"
  });
  await expect(markers(thread)).toHaveText([
    `${weekday} 9:15 AM`,
    `${yesterdaysWeekday} 4:12 PM`,
    /^Yesterday \d{1,2}:\d{2}\s[AP]M$/u
  ]);
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: member.email, password: member.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const conversationSchema = z.object({
  conversation: z.object({ id: z.string(), collaborationWorkspaceId: z.string() })
});

/** A run in a new conversation or in `conversationId`, awaited until its answer is stored. */
async function startRun(
  page: Page,
  conversationId: string | undefined,
  text: string
): Promise<{ id: string; collaborationWorkspaceId: string }> {
  const started = conversationId
    ? await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/runs`,
        { data: { idempotencyKey: randomUUID(), message: { text } } }
      )
    : await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
        data: { idempotencyKey: randomUUID(), conversation: { title: text }, message: { text } }
      });
  expect(started.ok()).toBe(true);
  const { conversation } = conversationSchema.parse(await started.json());
  await expect
    .poll(
      async () => {
        const thread = await page.request.get(
          `${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/thread`
        );
        const snapshot = z
          .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
          .parse(await thread.json());
        return snapshot.activeRun === undefined;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return conversation;
}

/**
 * Moves each turn of the conversation, in order, to its moment: the question at that moment
 * and every later message of the turn a minute after it. The server stamps a message when it
 * stores it, so a past day is written into the rows.
 */
async function moveTurns(conversationId: string, moments: number[]): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<Array<{ id: string; role: string }>>`
      select id, role from messages
      where conversation_id = ${conversationId}
      order by storage_ordinal
    `;
    let turn = -1;
    for (const row of rows) {
      if (row.role === "user") {
        turn += 1;
      }
      const moment = moments[turn];
      if (moment === undefined) {
        throw new Error(`No moment for turn ${turn} of ${conversationId}`);
      }
      const at = new Date(row.role === "user" ? moment : moment + 60_000);
      await sql`update messages set created_at = ${at} where id = ${row.id}`;
    }
  } finally {
    await sql.end();
  }
}
