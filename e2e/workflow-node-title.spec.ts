import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A canvas node's title keeps its width when the step is not saved (WF-EDIT-5c review): the
// "Not saved" tag stands on a line of its own under the type, and the title wraps between its
// words only. At 73 % with the step's panel open, "Belege prüfen" was squeezed beside the tag
// into "Bele ge prüf en". Fails without the fix: the tag stood beside the title, and the title
// broke inside its words.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const SIZE = { width: 1280, height: 900 };
const idSchema = z.object({ id: z.string() });

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("an unsaved step's title wraps between its words, with the tag on a line of its own", async ({
  page
}) => {
  test.setTimeout(120_000);
  const id = `node-title-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  await page.setViewportSize(SIZE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Node title ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const stored = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/workflow/${id}`,
    {
      data: {
        expectedRevision: null,
        config: {
          name: id,
          manifest: {
            id,
            name: "Receipts",
            runAs,
            inputs: { type: "object", additionalProperties: false },
            outputs: { type: "object", properties: { finding: { type: "string" } } },
            steps: [
              { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
              {
                id: "check",
                name: "Belege prüfen",
                type: "agent",
                instructions: "Check the receipts.",
                input: {},
                inputSchema: { type: "object", properties: {} },
                outputSchema: { type: "object", properties: { finding: { type: "string" } } }
              },
              {
                id: "result",
                name: "Result",
                type: "output",
                input: { finding: { ref: { step: "check", path: "finding" } } }
              }
            ]
          }
        }
      }
    }
  );
  expect(stored.ok(), await stored.text()).toBe(true);

  await page.goto(`/w/${workspaceId}/workflows/${id}`);
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  const node = canvas.locator('[data-flow-id="check"]');
  await node.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator('[data-step-panel="check"]');
  await panel.getByRole("tab", { name: "Settings", exact: true }).click();
  await panel.getByLabel("Instructions").fill("Check every receipt of the month.");
  const tag = node.locator('[data-slot="flow-change"]');
  await expect(tag).toHaveText("Not saved");
  // The view the squeeze was seen in: three steps fitted beside the open panel.
  await expect(canvas.locator('[data-slot="flow-zoom"]')).toHaveText("73 %");

  const title = node.locator('[data-slot="flow-title"]');
  const tagBox = await tag.boundingBox();
  const titleBox = await title.boundingBox();
  expect(tagBox !== null && titleBox !== null).toBe(true);
  // On a line of its own above the title, not beside it.
  expect((tagBox?.y ?? 0) + (tagBox?.height ?? 0)).toBeLessThanOrEqual((titleBox?.y ?? 0) + 1);
  // Each word of the title lies on one line: no word is broken.
  const lines = await title.evaluate((element) => {
    const text = element.firstChild;
    if (text === null || text.nodeType !== Node.TEXT_NODE) return [];
    const content = text.textContent ?? "";
    const words = [...content.matchAll(/\S+/gu)];
    return words.map((word) => {
      const range = document.createRange();
      range.setStart(text, word.index);
      range.setEnd(text, word.index + word[0].length);
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      return { word: word[0], lines: tops.size };
    });
  });
  expect(lines).toEqual([
    { word: "Belege", lines: 1 },
    { word: "prüfen", lines: 1 }
  ]);
});
