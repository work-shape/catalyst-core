import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { expect, test } from "./test";
import { apiOrigin, signIn, uiOrigin } from "./view-fixtures";

// KB-13b: a cited page of a synced document is fetched through its source. When the source
// cannot be reached, the instance answers 409 `knowledge_source_unreachable`, and the citation
// chip says so in the reader's language ("Quelle nicht erreichbar"), opens nothing, and can be
// tried again. The answer is stored as a run would store it; the open is answered by the route,
// as the fixture instance has no synced source.

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

const CONTENT = /^\/api\/v1\/knowledge-bases\/[^/]+\/documents\/[^/]+\/content$/u;

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "source-unreachable",
        reason:
          "Chromium's own log line: the test answers the open of a cited page with 409, as the " +
          "instance does for a source it cannot reach, and asserts what the chip then says.",
        matches: requestAnswered(409),
        path: CONTENT
      }
    ]
  }
});

/** A conversation whose answer cites one page of a synced Knowledge Base document. */
async function answerCiting(
  headers: Record<string, string>,
  request: import("@playwright/test").APIRequestContext
) {
  const created = await request.post(`${apiOrigin}/api/v1/conversations`, {
    headers,
    data: { title: `Citation ${randomUUID()}` }
  });
  expect(created.ok()).toBe(true);
  const conversation = z.object({ id: z.string() }).parse(await created.json());
  const runId = `arun_${randomUUID()}`;
  const rows = [
    { role: "user", text: "What does a hotel night cost?", metadata: {} },
    {
      role: "assistant",
      text: "A hotel night costs at most 145 EUR [K1].",
      metadata: {
        agentRuntime: {
          version: 1,
          runId,
          kind: "assistant_final",
          finishStatus: "completed",
          knowledgeSources: [
            {
              ref: "K1",
              knowledgeBase: "travel-policy",
              documentId: `kbdoc_${randomUUID()}`,
              fileId: `file_${randomUUID()}`,
              fileName: "reiserichtlinie.pdf",
              page: 3
            }
          ]
        }
      }
    }
  ];
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const [index, row] of rows.entries())
      await sql`insert into messages (id,client_instance_id,conversation_id,role,text,created_at,metadata)
        values (${`msg_${randomUUID()}`},'demo-e2e',${conversation.id},${row.role},${row.text},${new Date(Date.now() + index)},${sql.json(row.metadata)})`;
  } finally {
    await sql.end();
  }
  return conversation;
}

test("a cited page whose source cannot be reached says so in German and opens once it can", async ({
  page
}) => {
  const headers = await signIn(page, uiOrigin);
  const conversation = await answerCiting(headers, page.request);
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    // The tab the chip opens, by its address: headless Chromium shows no PDF in a tab.
    const opened: string[] = [];
    Object.assign(window, { opened });
    window.open = (url) => {
      opened.push(String(url));
      // A tab of its own would be a window like this one; the chip only clears its opener.
      return window;
    };
  });
  let reachable = false;
  const opened: string[] = [];
  await page.route(
    (url) => CONTENT.test(url.pathname),
    async (route) => {
      opened.push(new URL(route.request().url()).searchParams.get("conversationId") ?? "");
      await (reachable
        ? route.fulfill({
            status: 200,
            contentType: "application/pdf",
            body: "%PDF-1.4\n%%EOF\n"
          })
        : route.fulfill({
            status: 409,
            json: {
              error: {
                code: "CONFLICT",
                message: "The source of this document cannot be reached right now.",
                details: { reason: "knowledge_source_unreachable" }
              }
            }
          }));
    }
  );
  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);
  const chip = page.locator("[data-knowledge-source]");
  await expect(chip).toHaveText("reiserichtlinie.pdf, S. 3");
  await expect(page.getByText("[K1]")).toHaveCount(0);

  await chip.click();
  await expect(chip).toHaveText("reiserichtlinie.pdf, S. 3: Quelle nicht erreichbar");
  await expect(chip).toHaveAttribute("data-knowledge-source-state", "unreachable");
  expect(opened).toEqual([conversation.id]);

  // Reachable again: the same chip opens the page in a tab of its own.
  reachable = true;
  await chip.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "opened")))
    .toEqual([expect.stringMatching(/^blob:.*#page=3$/u)]);
  await expect(chip).toHaveText("reiserichtlinie.pdf, S. 3");
});
