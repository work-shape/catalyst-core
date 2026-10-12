import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ALLOWED_URL, plantConnection, removeConnection } from "./connection-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The Tools section of an agent's page in Build, with the tools of Connections. The Connection
// is a real asset of the instance of the suite's Connector type `test`, which contacts nothing.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Set to a directory to keep pictures of the section. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

/** A field of an answer of the instance, read without trusting its shape. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

/** Deletes an agent if it is there. What a test leaves behind must not meet the next run. */
async function deleteAgent(admin: Page, name: string): Promise<void> {
  const found = await admin.request.get(agentPath(name));
  if (found.ok()) {
    await requestWithOrigin(admin, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(admin, agentPath(name)) }
    });
  }
}

// Fails without the change: the Tools section offered the release's tools alone, so no agent
// could be given an operation of a Connection on its page.
test("an operation of a Connection is ticked on an agent, saved and still ticked after a reload", async ({
  page,
  // The test stores an agent; the turn on the agents holds the one on the Namespaces.
  instanceAgentsChange: _instanceAgentsChange,
  // It plants a Connection no release config names.
  releaseConnections: _releaseConnections
}) => {
  const name = "e2e_connection_tools_probe";
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_${randomUUID().slice(0, 8)}`,
    displayName: "Sample business",
    url: ALLOWED_URL,
    authScheme: "none" as const
  };
  const echo = `connection.${connection.name}.echo`;
  // A tool of a Connection that does not exist: the agent holds it and nothing offers it.
  const gone = "connection.e2e_gone.lookup";
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await deleteAgent(page, name);
  await plantConnection(connection);
  try {
    const created = await requestWithOrigin(page, "put", agentPath(name), {
      data: {
        expectedRevision: await assetBaseRevision(page, agentPath(name)),
        config: {
          name,
          displayName: "Connection Tools Probe",
          modelProviderId: "local",
          instructions: "A probe of the Build tests.",
          toolNames: [gone]
        }
      }
    });
    expect(created.ok()).toBe(true);
    await page.setViewportSize(WIDE);
    await page.goto(`/build/agents/${name}`);
    const tools = page.locator("#tools");
    const group = tools.locator(`[data-connection-tools="${connection.name}"]`);
    await expect(group).toContainText("Sample business");
    await expect(group).toContainText("0 of 1 selected");
    // Only what agents may call and is on and ready is offered: of the four operations, one.
    await expect(group.getByRole("checkbox")).toHaveCount(1);
    const box = group.getByRole("checkbox", { name: /^echo/u });
    await expect(box).not.toBeChecked();
    await expect(group).toContainText("Returns its input.");
    await expect(group).toContainText("Reading");
    // The name nothing offers stays, marked.
    const unavailable = tools.locator(`[data-unavailable-option="${gone}"]`);
    await expect(unavailable).toContainText(gone);
    // It stands in a group of its own, after the Connections.
    const unavailableGroup = tools.getByRole("group", { name: "No longer available", exact: true });
    await expect(unavailableGroup.locator(`[data-unavailable-option="${gone}"]`)).toBeVisible();
    await expect(unavailableGroup).toContainText(
      "These tools are no longer offered to this agent. The agent keeps each one until you remove it."
    );
    await expect(tools.getByRole("group", { name: "Instance tools", exact: true })).toContainText(
      "Tools this instance provides itself."
    );

    await box.click();
    await expect(group).toContainText("1 of 1 selected");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/v1/assets/agent/${name}`
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saved).status()).toBe(200);
    // The instance holds both names: the ticked one and the one nothing offers.
    expect(
      field(field(await (await page.request.get(agentPath(name))).json(), "config"), "toolNames")
    ).toEqual([gone, echo]);

    await page.reload();
    await expect(box).toBeChecked();
    await expect(unavailable).toBeVisible();
    await expectNoSidewaysScroll(page);

    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      for (const [locale, size, width] of [
        ["en", { width: 1440, height: 900 }, 1440],
        ["de", NARROW, 390]
      ] as const) {
        for (const mode of ["light", "dark"] as const) {
          await page.evaluate(
            (chosen) => window.localStorage.setItem("vivd-catalyst:locale", chosen),
            locale
          );
          await page.emulateMedia({ colorScheme: mode });
          await page.setViewportSize(size);
          await page.reload();
          await expect(box).toBeChecked();
          await box.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(shotsDir, `agent-connection-tools-${mode}-${locale}-${width}.png`),
            animations: "disabled"
          });
          await tools.screenshot({
            path: join(shotsDir, `agent-connection-tools-section-${mode}-${locale}-${width}.png`),
            animations: "disabled"
          });
          await unavailable.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(
              shotsDir,
              `agent-connection-tools-unavailable-${mode}-${locale}-${width}.png`
            ),
            animations: "disabled"
          });
          await expectNoSidewaysScroll(page);
        }
      }
    }
  } finally {
    await deleteAgent(page, name);
    await removeConnection(connection.id);
  }
});
