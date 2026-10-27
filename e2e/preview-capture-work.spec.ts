import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// The picture a run took of the preview, in the run's work (PREVIEW-SEE-2). The suite's model
// reads no images, so it is never offered `preview.capture`; the fixture stores what one run
// of it leaves, as the instance stores it: the WebP in the conversation's picture folder of the
// `files` store, its managed artifact, and the run's messages with one picture and the four
// refusals. From there on everything is the product: the row shows the picture small, read
// through the conversation's artifact content, and a click opens it in the file viewer beside
// the chat. Each refusal is a sentence in the member's language.

const member = {
  email: "e2e-preview-captures@example.test",
  password: "e2e-preview-captures-password"
};
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
/** `clientInstance.id` and the root of `infrastructure.objectStorage.files` in the suite's config. */
const clientInstanceId = "demo-e2e";
const filesRoot = resolve(".tmp/e2e/files");

const REFUSALS = [
  "preview_not_viewed",
  "capture_limit",
  "preview_personal_data",
  "capture_unavailable"
] as const;
type Refusal = (typeof REFUSALS)[number];

const SENTENCES: Record<"en" | "de", Record<Refusal, string>> = {
  en: {
    capture_limit:
      "The agent has already looked at the preview as often as it may in this run or this hour.",
    capture_unavailable:
      "The browser that had the preview open cannot take a picture of it. Safari does not allow it.",
    preview_not_viewed: "The agent could not look at the preview because it was not open.",
    preview_personal_data:
      "The preview shows data from a personal connection, so no picture of it was taken."
  },
  de: {
    capture_limit:
      "Der Agent hat die Vorschau in diesem Lauf oder in dieser Stunde schon so oft angesehen, wie er darf.",
    capture_unavailable:
      "Der Browser, in dem die Vorschau offen war, kann kein Bild davon aufnehmen. Safari erlaubt das nicht.",
    preview_not_viewed: "Der Agent konnte die Vorschau nicht ansehen, weil sie nicht geöffnet war.",
    preview_personal_data:
      "Die Vorschau zeigt Daten aus einer persönlichen Verbindung, deshalb wurde kein Bild davon aufgenommen."
  }
};

/** The English sentence the tool gives the model, which a member never reads. */
const MODEL_REASON = "Go on with the preview's report";

async function signIn(page: Page, locale: "en" | "de"): Promise<Record<string, string>> {
  const headers = { Origin: uiOrigin };
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers,
    data: { ...member, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript((chosen) => {
    if (window.top === window) window.localStorage.setItem("vivd-catalyst:locale", chosen);
  }, locale);
  return headers;
}

/** A conversation with one finished turn of the suite's model, so it is listed in the rail. */
async function listedConversation(
  page: Page,
  headers: Record<string, string>,
  title: string
): Promise<string> {
  const started = await page.request.post(`${apiOrigin}/api/v1/conversations/runs`, {
    headers,
    data: { idempotencyKey: randomUUID(), conversation: { title }, message: { text: title } }
  });
  expect(started.ok()).toBe(true);
  const id = z.object({ conversation: z.object({ id: z.string() }) }).parse(await started.json())
    .conversation.id;
  await expect
    .poll(async () => {
      const thread = await page.request.get(
        `${apiOrigin}/api/v1/conversations/${encodeURIComponent(id)}/thread`,
        { headers }
      );
      const snapshot = z
        .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
        .parse(await thread.json());
      return snapshot.activeRun === undefined && snapshot.messages.length === 2;
    })
    .toBe(true);
  return id;
}

/** A picture of a small dashboard, as the guard draws one: WebP of 1280 by 800. */
async function dashboardPicture(page: Page): Promise<Buffer> {
  const encoded = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1280, 800);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas");
    context.fillStyle = "#faf7f2";
    context.fillRect(0, 0, 1280, 800);
    context.fillStyle = "#2b2622";
    context.font = "600 44px sans-serif";
    context.fillText("Umsatz je Monat", 64, 104);
    const bars = [320, 460, 380, 560, 500, 620];
    bars.forEach((height, index) => {
      context.fillStyle = index === bars.length - 1 ? "#b4532a" : "#d9cbbd";
      context.fillRect(64 + index * 190, 720 - height, 140, height);
    });
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return Buffer.from(encoded, "base64");
}

/**
 * Adds one run to the conversation that called `preview.capture` five times: one picture, then
 * each refusal. Stored as the instance stores a picture and a tool result.
 */
async function storeCaptureRun(conversationId: string, picture: Buffer): Promise<string> {
  const artifactId = `art_${randomUUID()}`;
  const captureId = `pcap_${randomUUID()}`;
  const objectKey = `preview-captures/${conversationId}/${captureId}.webp`;
  const target = resolve(filesRoot, ...objectKey.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, picture);

  const runId = `arun_${randomUUID()}`;
  const runtime = (data: Record<string, unknown>) => ({
    agentRuntime: { version: 1, runId, ...data }
  });
  const calls = [
    {
      toolCallId: `toolcall_${randomUUID()}`,
      result: {
        status: "success",
        output: { captured: true, revision: 2, width: 1280, height: 800 },
        artifacts: [
          {
            artifactId,
            kind: "image.webp",
            filename: "preview-revision-2.webp",
            mimeType: "image/webp",
            modelVisibility: { type: "image", mimeType: "image/webp" },
            metadata: { previewCapture: true, revision: 2 }
          }
        ]
      }
    },
    ...REFUSALS.map((code) => ({
      toolCallId: `toolcall_${randomUUID()}`,
      result: {
        status: "success",
        output: { captured: false, code, reason: `${code}: ${MODEL_REASON}.` }
      }
    }))
  ];
  const rows = [
    { role: "user", text: "Wie sieht das Diagramm jetzt aus?", metadata: {} },
    {
      role: "assistant",
      text: "",
      metadata: runtime({
        kind: "assistant_tool_calls",
        toolCalls: calls.map(({ toolCallId }) => ({
          toolCallId,
          toolName: "preview.capture",
          input: {}
        }))
      })
    },
    ...calls.map(({ toolCallId, result }) => ({
      role: "tool",
      text: JSON.stringify(result.output),
      metadata: runtime({
        kind: "tool_result",
        toolCallId,
        toolName: "preview.capture",
        input: {},
        result
      })
    })),
    {
      role: "assistant",
      text: "Das Diagramm zeigt die sechs Monate, der letzte ist hervorgehoben.",
      metadata: runtime({ kind: "assistant_final", finishStatus: "completed" })
    }
  ];
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      insert into managed_artifacts (
        id, client_instance_id, conversation_id, kind, object_key, filename, mime_type,
        byte_size, checksum, metadata, status, created_at
      ) values (
        ${artifactId}, ${clientInstanceId}, ${conversationId}, 'image.webp', ${objectKey},
        ${`preview-${captureId}.webp`}, 'image/webp', ${picture.byteLength},
        ${`sha256:${createHash("sha256").update(picture).digest("hex")}`},
        ${sql.json({ source: "preview_capture", purpose: "inspection", width: 1280, height: 800 })},
        'available', now()
      )
    `;
    for (const [index, row] of rows.entries()) {
      await sql`insert into messages (id,client_instance_id,conversation_id,role,text,created_at,metadata)
        values (${`msg_${randomUUID()}`},${clientInstanceId},${conversationId},${row.role},${row.text},${new Date(Date.now() + index)},${sql.json(row.metadata)})`;
    }
  } finally {
    await sql.end();
  }
  return artifactId;
}

/** Opens the run's work of the newest answer and every group in it. */
async function openRunWork(page: Page, locale: "en" | "de"): Promise<Locator> {
  const answer = page.locator('[data-role="assistant"]').last();
  const history = answer.getByRole("button", {
    name: new RegExp(`^${locale === "de" ? "Arbeitsverlauf" : "Work history"}`, "u")
  });
  await expect(history).toBeVisible();
  if ((await history.getAttribute("aria-expanded")) !== "true") await history.click();
  const groups = answer.getByTestId("assistant-work-group-trigger");
  for (let index = 0; index < (await groups.count()); index += 1) {
    const group = groups.nth(index);
    if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
  }
  return answer;
}

function thumbnail(scope: Locator): Locator {
  return scope.getByTestId("preview-capture-thumbnail");
}

/**
 * Where `target` stands once the page's animations that end have ended and two looks a moment
 * apart agree. A slow browser is still opening the run's work when the row is first visible.
 */
async function settledBox(
  target: Locator
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  await target.evaluate((node) =>
    Promise.all(
      node.ownerDocument
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );
  let last = await target.boundingBox();
  await expect
    .poll(async () => {
      await target.page().waitForTimeout(200);
      const now = await target.boundingBox();
      const still = JSON.stringify(now) === JSON.stringify(last);
      last = now;
      return still;
    })
    .toBe(true);
  return last;
}

/** Whether the picture in `scope` decoded at the size the run took it. */
async function expectDecoded(scope: Locator): Promise<void> {
  const image = scope.locator("img").first();
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight]))
    .toEqual([1280, 800]);
}

test("the picture of the preview stands on its row in the run's work and opens larger", async ({
  page
}) => {
  test.setTimeout(90_000);
  const headers = await signIn(page, "en");
  const stamp = randomUUID().slice(0, 8);
  const otherTitle = `Other conversation ${stamp}`;
  const otherId = await listedConversation(page, headers, otherTitle);
  const captureTitle = `Revenue chart ${stamp}`;
  const conversationId = await listedConversation(page, headers, captureTitle);
  const artifactId = await storeCaptureRun(conversationId, await dashboardPicture(page));
  const content = `/api/v1/conversations/${conversationId}/artifacts/${artifactId}/content`;
  const reads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes(artifactId)) reads.push(path);
  });

  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversationId)}`);
  const answer = await openRunWork(page, "en");
  const row = answer
    .getByTestId("tool-call-card")
    .filter({ has: page.getByTestId("preview-capture-thumbnail") });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("tool-call-row")).toHaveText("Look at the preview");
  await expectDecoded(thumbnail(row));
  // The row shows it from the viewer's own address of the bytes it read.
  await expect(thumbnail(row).locator("img")).toHaveAttribute("src", /^blob:/u);
  // Only through the conversation's artifact content, and no card of its own.
  expect(new Set(reads)).toEqual(new Set([content]));
  await expect(page.getByRole("button", { name: /^Open preview for/u })).toHaveCount(0);
  await expect(page.locator('aside[data-surface-kind="file_preview"]')).toHaveCount(0);

  // Each refusal says why in a sentence, and nothing of the model's text or the code.
  for (const code of REFUSALS) {
    await expect(answer.getByText(SENTENCES.en[code], { exact: true })).toBeVisible();
  }
  await expect(answer).not.toContainText(MODEL_REASON);
  for (const code of REFUSALS) await expect(answer).not.toContainText(code);

  // A click opens it in the file viewer beside the chat.
  await thumbnail(row).click();
  const viewer = page.locator('aside[data-surface-kind="file_preview"]');
  await expect(viewer).toHaveAttribute("aria-label", "Picture of the preview");
  await expectDecoded(viewer);
  // Nothing a member reads names the revision the picture shows.
  await expect(viewer).not.toContainText("revision");
  await expect(viewer.locator('[aria-label*="revision"], [title*="revision"]')).toHaveCount(0);

  // Another conversation shows neither the viewer nor the picture; back again, it reads anew.
  // Twice, so a second switch finds nothing the first one left behind.
  const openConversation = (title: string) =>
    page
      .getByTestId("conversation-row")
      .filter({ hasText: title })
      .getByRole("button")
      .first()
      .click();
  for (let turn = 0; turn < 2; turn += 1) {
    await openConversation(otherTitle);
    await expect(page).toHaveURL(new RegExp(`/c/${otherId}$`, "u"));
    await expect(viewer).toHaveCount(0);
    await expect(thumbnail(page.locator("body"))).toHaveCount(0);
    await openConversation(captureTitle);
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`, "u"));
    const back = await openRunWork(page, "en");
    await expect(thumbnail(back)).toHaveCount(1);
    await expectDecoded(thumbnail(back));
  }

  // After a reload the row shows it again.
  await page.reload();
  await expectDecoded(thumbnail(await openRunWork(page, "en")));
});

test("the refusals of a look at the preview read in German", async ({ page }) => {
  test.setTimeout(60_000);
  const headers = await signIn(page, "de");
  const conversationId = await listedConversation(
    page,
    headers,
    `Diagramm ${randomUUID().slice(0, 8)}`
  );
  await storeCaptureRun(conversationId, await dashboardPicture(page));

  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversationId)}`);
  const answer = await openRunWork(page, "de");
  await expect(
    answer.getByTestId("tool-call-row").filter({ hasText: "Vorschau ansehen" })
  ).toHaveCount(5);
  for (const code of REFUSALS) {
    await expect(answer.getByText(SENTENCES.de[code], { exact: true })).toBeVisible();
  }
  await expect(answer).not.toContainText(MODEL_REASON);
  await expect(thumbnail(answer)).toHaveAttribute("aria-label", "Bild der Vorschau öffnen");
});

test("a picture that answers late keeps its place, and the run's work scrolls to its end", async ({
  page
}) => {
  test.setTimeout(60_000);
  // A short window: the run's work is taller than the thread.
  await page.setViewportSize({ width: 390, height: 600 });
  const headers = await signIn(page, "en");
  const conversationId = await listedConversation(
    page,
    headers,
    `Late picture ${randomUUID().slice(0, 8)}`
  );
  const artifactId = await storeCaptureRun(conversationId, await dashboardPicture(page));
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => (release = done));
  await page.route(`**/artifacts/${artifactId}/content*`, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversationId)}`);
  const answer = await openRunWork(page, "en");
  const button = thumbnail(answer);
  // While the picture is on its way the frame holds its room and opens nothing.
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  // The run's work opens with an animation that moves the rows: its place is taken once it
  // stands still, so only the picture can move it.
  const waiting = await settledBox(button);
  await page.waitForTimeout(1_000);
  await expect(button).toBeDisabled();
  await expect(button.locator("img")).toHaveCount(0);
  release();
  await expectDecoded(button);
  await expect(button).toBeEnabled();
  expect(await settledBox(button)).toEqual(waiting);

  // Scrolled to the end, the last refusal stands whole above the composer.
  const thread = page.locator(".chat-thread-inset");
  await thread.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const last = answer.getByText(SENTENCES.en.capture_unavailable, { exact: true });
  await expect(last).toBeInViewport({ ratio: 1 });
  const composer = await page.getByPlaceholder("Message").boundingBox();
  const lastBox = await last.boundingBox();
  expect(lastBox && composer && lastBox.y + lastBox.height <= composer.y).toBe(true);
  // Scrolled back to the picture, it still opens the viewer.
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(page.locator('aside[data-surface-kind="file_preview"]')).toHaveAttribute(
    "aria-label",
    "Picture of the preview"
  );
});
