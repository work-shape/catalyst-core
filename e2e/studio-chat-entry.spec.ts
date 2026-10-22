import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Studio chat entry (docs/planning/specs/studio-chat-entry.md): "Chat" stands in every page
// head, next to the page's primary action. It opens the dock from anywhere: on a list an empty
// dock with the agent that builds, which says where a new asset is created; after a close, and
// after a reload with the dock closed, the same conversation; on an asset's page a conversation
// about that asset. "New agent" opens the empty page of a new agent under every scope, and a
// chat started under "Instance" creates for the instance (section 4a). Fails
// without the change: Chat stood only after a close and was gone after a reload, and "New
// agent" opened a dialog under Instance and the dock under a workspace.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1280, height: 800 };

const idSchema = z.object({ id: z.string() });
const chatColumn = (page: Page) => page.locator("[data-dock-chat]");
const dockHead = (page: Page) => page.getByTestId("dock-head");
const chatAction = (page: Page) => page.getByTestId("dock-page-action");
const conversationOf = (page: Page) => new URL(page.url()).searchParams.get("chat");
/** The dock is shut: never opened on this page yet, or closed. */
const expectDockShut = (page: Page) => expect(chatColumn(page)).not.toBeVisible();

async function signIn(page: Page): Promise<void> {
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
  await signIn(page);
  const team = `Team ${randomUUID().slice(0, 8)}`;
  const workspaceId = await openSharedWorkspace(page, team);
  try {
    await agentsUnder(page, team);
    await expectDockShut(page);

    // With no conversation yet, Chat opens an empty dock with the agent that builds. It says
    // where a new agent is created.
    await expect(chatAction(page)).toHaveText(/^Chat/u);
    await chatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    await expect(chatColumn(page)).toContainText("What should the new agent do?");
    await expect(chatColumn(page).locator("[data-dock-creation-target]")).toHaveText(
      `New agents are created in “${team}”.`
    );
    // The page head offers no second Chat while the dock is open.
    await expect(chatAction(page)).toHaveCount(0);

    const composer = chatColumn(page).getByPlaceholder("Message");
    await composer.fill("Hello from the list");
    await composer.press("Enter");
    await expect.poll(() => conversationOf(page)).not.toBeNull();
    await expect(chatColumn(page)).toContainText("Local agent response");
    const conversation = conversationOf(page);

    // Closed, Chat brings the same conversation back.
    await dockHead(page).getByRole("button", { name: "Close chat" }).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "closed");
    await chatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    expect(conversationOf(page)).toBe(conversation);

    // So does a reload with the dock closed: the browser keeps which conversation it was.
    await dockHead(page).getByRole("button", { name: "Close chat" }).click();
    await page.reload();
    await expectDockShut(page);
    await chatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    expect(conversationOf(page)).toBe(conversation);
    await expect(chatColumn(page)).toContainText("Hello from the list");

    // ⌘J / Ctrl+J closes and opens it too.
    await page.keyboard.press("ControlOrMeta+j");
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "closed");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    expect(conversationOf(page)).toBe(conversation);

    // "New chat" in the dock's head starts an empty one for the page.
    await dockHead(page).getByRole("button", { name: "New chat" }).click();
    await expect(chatColumn(page)).toContainText("What should the new agent do?");
    expect(conversationOf(page)).not.toBe(conversation);
  } finally {
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});

test("Chat on an asset's page opens a conversation about the asset", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const name = `chat-entry-${randomUUID().slice(0, 8)}`;
  const title = `Expense rules ${name.slice(-8)}`;
  const url = `${apiBaseUrl}/api/v1/assets/skill/${name}`;
  const stored = await requestWithOrigin(page, "put", url, {
    data: {
      expectedRevision: null,
      config: { name, title, description: "How expenses are claimed.", content: "# Expenses" }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  try {
    await page.goto(`/build/skills/${name}`);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await chatAction(page).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    await expect(dockHead(page)).toHaveAttribute("data-subject-kind", "skill");
    await expect(dockHead(page)).toContainText(`Working on: ${title}`);
    // The page stays.
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  } finally {
    await requestWithOrigin(page, "delete", url, {
      data: { expectedRevision: await assetRevision(page, url) }
    });
  }
});

test("New agent opens the empty page of a new agent under Instance and under a workspace", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const team = `Team ${randomUUID().slice(0, 8)}`;
  const workspaceId = await openSharedWorkspace(page, team);
  try {
    for (const scope of ["Instance", team]) {
      await agentsUnder(page, scope);
      await page.getByRole("button", { name: "New agent", exact: true }).first().click();
      await expect(page.getByRole("heading", { name: "New agent", level: 1 })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectDockShut(page);
      await expect(page.getByRole("textbox", { name: /^Display name/u }).first()).toHaveValue("");
      // Under the workspace the new agent starts available there.
      if (scope === team) {
        await expect(page.locator("[data-new-asset-availability]")).toContainText(team);
      }
      // "Chat" on the page opens the agent that builds the new agent. Under "Instance" its
      // conversation creates for the instance: the line says so, and the conversation keeps it.
      await chatAction(page).click();
      await expect(chatColumn(page)).toContainText("What should the new agent do?");
      await expect(chatColumn(page).locator("[data-dock-creation-target]")).toHaveText(
        scope === "Instance"
          ? "New agents are created in the instance."
          : `New agents are created in “${team}”.`
      );
      if (scope === "Instance") {
        await expect.poll(() => conversationOf(page)).not.toBeNull();
        const thread = await page.request.get(
          `${apiBaseUrl}/api/v1/conversations/${conversationOf(page) ?? ""}/thread`
        );
        expect(
          z
            .object({ conversation: z.object({ creationTarget: z.string().optional() }) })
            .parse(await thread.json()).conversation.creationTarget
        ).toBe("instance");
      }
      await dockHead(page).getByRole("button", { name: "Close chat" }).click();
      await page.getByRole("button", { name: "Back to Agents", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
    }
  } finally {
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});

test("in a narrow window Chat is its icon alone, and still opens the dock", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 768, height: 900 });
  await signIn(page);
  await page.goto("/build/agents");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Its name stays "Chat"; the head keeps one row beside it.
  await expect(chatAction(page)).toHaveAccessibleName("Chat");
  await expect(chatAction(page)).toHaveText("");
  await chatAction(page).click();
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
});

test("pictures of Studio's chat entry", async ({ page }) => {
  test.skip(!shotsDir, "Takes pictures only for E2E_SHOTS_DIR");
  test.setTimeout(300_000);
  const dir = shotsDir ?? "";
  await mkdir(dir, { recursive: true });
  await page.setViewportSize(WIDE);
  await signIn(page);
  const workspaceId = await openSharedWorkspace(page, "Team Vertrieb");
  try {
    for (const theme of ["light", "dark"] as const) {
      const shot = async (name: string) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `${name}-${theme}-de-1280.png`) });
      };
      await page.goto("/");
      await page.evaluate((value) => {
        window.localStorage.setItem("vivd-catalyst:locale", "de");
        window.localStorage.setItem("vivd-catalyst:theme", value);
        window.localStorage.removeItem("vivd-catalyst:dock-last");
      }, theme);
      await agentsUnder(page, "Team Vertrieb");
      await expect(chatAction(page)).toBeVisible();
      await shot("01-agenten-chat-im-kopf");

      await chatAction(page).click();
      await expect(chatColumn(page).locator("[data-dock-creation-target]")).toHaveText(
        "Neue Agenten entstehen in „Team Vertrieb“."
      );
      await shot("02-chat-leer-mit-ziel");
      await dockHead(page).getByRole("button", { name: "Chat schließen" }).click();

      await agentsUnder(page, "Instanz");
      await page.getByRole("button", { name: "Neuer Agent", exact: true }).first().click();
      await expect(page.getByRole("heading", { name: "Neuer Agent", level: 1 })).toBeVisible();
      await shot("03-neuer-agent-leere-seite");
      await chatAction(page).click();
      await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
      await shot("04-neuer-agent-mit-chat");
      await dockHead(page).getByRole("button", { name: "Chat schließen" }).click();
      await page.getByRole("button", { name: "Zurück zu Agenten", exact: true }).click();

      await page.getByText("Research Assistant", { exact: true }).first().click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await chatAction(page).click();
      await expect(dockHead(page)).toHaveAttribute("data-subject-kind", "agent");
      await shot("05-agent-seite-chat");
      await dockHead(page).getByRole("button", { name: "Chat schließen" }).click();

      await page.goto(`/w/${workspaceId}/workflows`);
      const newWorkflow = page.getByRole("button", { name: "Neuer Workflow", exact: true });
      if ((await newWorkflow.count()) > 0) {
        await newWorkflow.first().click();
        await page
          .getByRole("dialog")
          .locator("[data-build-with-agent-brief]")
          .fill("jeden Montag die offenen Aufgaben zusammenfasst");
        await shot("06-neuer-workflow-kurzer-dialog");
        await page.keyboard.press("Escape");
      }
    }
  } finally {
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
  }
});
