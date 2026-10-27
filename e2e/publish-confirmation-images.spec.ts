import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Two interface fallbacks in the browser.
//
// The agent's App publish confirmation shows a bound Data Store that is live and still being
// updated, which the Publish waits for, though the agent names no store; a store the agent does
// not name and that is not live stays out. The suite's agent has no App publish tool: a real
// call of `e2e.confirm_note` waits for the person, and the conversation's snapshot is read as
// the App publish it stands for. The App and its review are answered as the instance answers
// them. Fails without the change: the card read no review and showed no store.
//
// An image whose content comes back as SVG bytes does not decode under the raster type the
// interface gives it. The upload is a real PNG, which the instance takes; its content is
// answered with SVG bytes. The sent message shows the file chip that opens the file. Fails
// without the change: a broken image.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const TOOL = "e2e.confirm_note";
const idSchema = z.object({ id: z.string() });
const APP = "visit-log";
/** A 1×1 PNG: an image the instance takes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c55"/></svg>';

/** Signs in and opens a new workspace of its own; answers its id. */
async function signIn(page: Page): Promise<string> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: "Visit planning" }
  });
  expect(created.ok()).toBe(true);
  const { id } = idSchema.parse(await created.json());
  await page.goto(`/w/${id}`);
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  return id;
}

/** Each waiting call of `e2e.confirm_note` in `value`, read as the agent's publish of the App. */
function asAppPublish(value: unknown, input: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.startsWith(`/tool ${TOOL}`) ? "Publish the visit log for the team" : value;
  }
  if (Array.isArray(value)) return value.map((item) => asAppPublish(item, input));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, asAppPublish(item, input)]);
  const object: Record<string, unknown> = Object.fromEntries(entries);
  if (object.toolName === TOOL) {
    object.toolName = "assets.publish";
    if ("input" in object) object.input = input;
  }
  if (object.operationId === TOOL) {
    object.operationId = "assets.publish";
    object.inputPreview = input;
  }
  return object;
}

async function answerAsAppPublish(page: Page, workspaceId: string): Promise<void> {
  // The agent names the App and its revision, and no store.
  const input = { kind: "app", name: APP, revision: 2, workspaceId };
  await page.route("**/api/v1/conversations/*/thread*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: asAppPublish(await response.json(), input) });
  });
  await page.route(`**/api/v1/assets/app/${APP}?*`, (route) =>
    route.fulfill({
      json: {
        id: "asset_visit_log",
        kind: "app",
        name: APP,
        scope: { kind: "workspace", workspaceId },
        revision: 2,
        draftRevision: 2,
        publishedRevision: 1,
        config: { title: "Visit log", manifest: {} },
        publishNarrative: {
          summary: "Visit log opens for everyone in this workspace.",
          warnings: []
        },
        appAudience: {
          selected: "workspace",
          choices: ["self", "workspace"],
          label: "Everyone in this workspace"
        },
        updatedAt: "2026-10-27T09:00:00.000Z"
      }
    })
  );
  const reviewed = (name: string, title: string, pending: boolean) => ({
    name,
    title,
    draftRevision: 3,
    publishedRevision: pending ? 2 : 3,
    pending,
    liveLevel: 2,
    minSchema: 3,
    pendingMigrations: ["add_region"],
    refusals: []
  });
  await page.route(`**/api/v1/apps/${APP}/publish-review`, (route) =>
    route.fulfill({
      json: {
        app: {
          name: APP,
          title: "Visit log",
          draftRevision: 2,
          publishedRevision: 1,
          pending: true,
          refusals: []
        },
        workflows: [],
        // A live store still being updated, and a store whose draft this publish leaves.
        dataStores: [reviewed("customers", "Customers", false), reviewed("notes", "Notes", true)],
        publishesTogether: true,
        ready: true
      }
    })
  );
}

test("the agent's App publish shows a bound store still being updated, though it names none", async ({
  page
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const workspaceId = await signIn(page);
  await answerAsAppPublish(page, workspaceId);
  await page.getByPlaceholder("Message").fill(`/tool ${TOOL} ${JSON.stringify({ text: "x" })}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("tool-decision-card")).toBeVisible();

  for (const [locale, line, label] of [
    ["en", "Data store “Customers”", "Being updated"],
    ["de", "Datenspeicher „Customers“", "Wird aktualisiert"]
  ] as const) {
    await page.evaluate(
      (chosen) => window.localStorage.setItem("vivd-catalyst:locale", chosen),
      locale
    );
    // A reload reads the waiting call from the conversation's snapshot.
    await page.reload();
    const card = page.getByTestId("tool-decision-card");
    const together = card.getByTestId("app-publish-together");
    await expect(together).toBeVisible();
    await expect(together.locator('[data-data-store="customers"]')).toContainText(line);
    await expect(together.locator('[data-data-store="customers"]')).toContainText(label);
    await expect(together.locator('[data-data-store="notes"]')).toHaveCount(0);
  }
});

/** The sent message `text` in a thread snapshot, read as one that carries "plan.png". */
function withImage(snapshot: unknown, text: string): unknown {
  const thread = z
    .object({ messages: z.array(z.record(z.string(), z.unknown())) })
    .passthrough()
    .parse(snapshot);
  const attachment = {
    fileId: "file_plan",
    attachmentId: "att_plan",
    filename: "plan.png",
    mimeType: "image/png",
    byteSize: PNG.length,
    status: "ready",
    readable: true
  };
  return {
    ...thread,
    messages: thread.messages.map((message) => {
      if (message.role !== "user" || message.text !== text) return message;
      const metadata = z.record(z.string(), z.unknown()).catch({}).parse(message.metadata);
      const runtime = z
        .record(z.string(), z.unknown())
        .catch({ version: 1, kind: "user_message" })
        .parse(metadata.agentRuntime);
      return {
        ...message,
        metadata: {
          ...metadata,
          agentRuntime: {
            ...runtime,
            attachmentManifest: { version: 1, attachments: [attachment] }
          }
        }
      };
    })
  };
}

test("an attached image whose content is SVG bytes shows as its file chip", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  // The suite's model takes no images: the sent message carries one in its snapshot, and the
  // image's content is answered as the instance would answer it.
  const text = "Here is the plan";
  await page.getByPlaceholder("Message").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/^Local agent response:/u).first()).toBeVisible();
  await page.route("**/api/v1/conversations/*/thread*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withImage(await response.json(), text) });
  });
  let content: { body: string | Buffer; contentType: string } = {
    body: SVG,
    contentType: "image/svg+xml"
  };
  await page.route("**/api/v1/conversations/*/files/file_plan/content*", (route) =>
    route.fulfill(content)
  );

  // SVG bytes: shown under a raster type, they do not decode; the file chip opens the file.
  await page.reload();
  const message = page.locator('[data-role="user"]').first();
  await expect(message.getByRole("button", { name: "Open preview for plan.png" })).toBeVisible();
  await expect(message.locator("img")).toHaveCount(0);

  // A PNG is the image itself.
  content = { body: PNG, contentType: "image/png" };
  await page.reload();
  const image = message.locator("img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  await expect(message.getByRole("button", { name: "Open preview for plan.png" })).toHaveCount(0);
});
