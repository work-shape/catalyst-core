import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { removeServicePrincipal } from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** The one column the conversation lives in, on the chat route and in the dock. */
const chatColumn = (page: Page) => page.locator("[data-dock-chat]");

// The model picker's panels open beside its menu. In the dock beside a Workflow's canvas the
// model panel opened into the canvas and was cut off at the dock's edge: only its icons and
// the first letters of the model's name showed.
test("the model picker's panels show whole in the dock beside a Workflow canvas and in the full chat", async ({
  page,
  accessState: _accessState
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await offerModelChoice(page);
  await page.goto("/");
  await signIn(page, superadmin);
  const id = `e2e-picker-${randomUUID().slice(0, 8)}`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  const created = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { displayLabel: "Picker automation", permissions: ["config_assets.read"] } }
  );
  expect(created.ok()).toBe(true);
  const { principal }: { principal: { id: string; name: string } } = await created.json();
  try {
    const saved = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: id,
          manifest: {
            id,
            name: "Picker beside a canvas",
            runAs: principal.name,
            inputs: { type: "object", additionalProperties: false },
            outputs: {
              type: "object",
              properties: { done: { type: "integer" } },
              required: ["done"]
            },
            steps: [
              { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
              { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
            ]
          }
        }
      }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const conversation = await createListedConversation(page, `Picker ${id}`, `Opening ${id}`);
    const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);

    await page.goto(`/w/${workspace}/workflows/${id}?chat=${conversation.id}`);
    await expect(page.getByTestId("workflow-page")).toBeVisible();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    await expectPanelsShowWhole(page, "dock-beside-workflow");

    await chatColumn(page)
      .locator("header")
      .first()
      .getByRole("button", { name: "Open as full chat" })
      .click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "main");
    await expectPanelsShowWhole(page, "full-chat");
  } finally {
    await requestWithOrigin(page, "post", `${assetUrl}/delete`, { data: { expectedRevision: 1 } });
    await removeServicePrincipal(principal.id);
  }
});

/**
 * The suite's instance has one model with a fixed effort, so the composer shows no picker.
 * Every agent the interface reads is given a second model with a long name, and efforts to
 * choose from, as an operated instance offers them.
 */
async function offerModelChoice(page: Page): Promise<void> {
  const agentSchema = z.looseObject({ selectableModels: z.array(z.looseObject({})) });
  const withChoice = (agent: unknown) => {
    const parsed = agentSchema.safeParse(agent);
    if (!parsed.success) {
      return agent;
    }
    const [own] = parsed.data.selectableModels;
    return {
      ...parsed.data,
      selectableModels: [
        {
          ...own,
          reasoningEffort: "medium",
          selectableReasoningEfforts: ["low", "medium", "high"]
        },
        {
          bindingId: "e2e-picker-second",
          model: "gpt-5.1-codex-max-preview",
          label: "GPT-5.1 Codex Max Preview",
          reasoningEffort: "medium",
          selectableReasoningEfforts: ["low", "medium", "high"]
        }
      ]
    };
  };
  const listsSchema = z.looseObject({
    agents: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional()
  });
  await page.route(/\/api\/v1\/(?:instance\/config|.*agents)/u, async (route) => {
    if (route.request().method() !== "GET") {
      return route.fallback();
    }
    const response = await route.fetch();
    const body = listsSchema.safeParse(await response.json().catch(() => undefined));
    if (!body.success) {
      return route.fulfill({ response });
    }
    return route.fulfill({
      response,
      json: {
        ...body.data,
        ...(body.data.agents ? { agents: body.data.agents.map(withChoice) } : {}),
        ...(body.data.items ? { items: body.data.items.map(withChoice) } : {})
      }
    });
  });
}

/** Opens the picker, then each of its panels, and finds every panel whole on top of the page. */
async function expectPanelsShowWhole(page: Page, shot: string): Promise<void> {
  await chatColumn(page).getByRole("button", { name: "Select model" }).click();
  const picker = page.getByRole("dialog", { name: "Select model" });
  await expect(picker).toBeVisible();

  await picker.getByRole("button", { name: /^Model/u }).click();
  const models = picker.getByRole("listbox", { name: "Select model" });
  await expect(models).toBeVisible();
  // It settles once it has been placed and has come in.
  await expect.poll(() => uncoveredShare(models)).toBe(1);
  await screenshot(page, `${shot}-model`);

  await picker.getByRole("button", { name: /^Reasoning/u }).click();
  const effort = picker.getByRole("slider", { name: "Reasoning" });
  await expect(effort).toBeVisible();
  // It settles once it has been placed and has come in.
  await expect.poll(() => uncoveredShare(effort)).toBe(1);
  await screenshot(page, `${shot}-reasoning`);

  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
}

/**
 * The share of points across the element, near its corners and in its middle, where the
 * element itself is what the browser hits: 1 when it lies whole inside the window and nothing
 * clips or covers it. The points keep inside the rounding of the surface's corners.
 */
async function uncoveredShare(element: Locator): Promise<number> {
  return element.evaluate((target) => {
    const box = target.getBoundingClientRect();
    const inset = 8;
    const xs = [box.left + inset, (box.left + box.right) / 2, box.right - inset];
    const ys = [box.top + inset, (box.top + box.bottom) / 2, box.bottom - inset];
    const points = xs.flatMap((x) => ys.map((y) => ({ x, y })));
    const hits = points.filter(({ x, y }) => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return false;
      }
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === target || target.contains(hit));
    });
    return hits.length / points.length;
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) {
    return;
  }
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `model-picker-${name}.png`), animations: "disabled" });
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
