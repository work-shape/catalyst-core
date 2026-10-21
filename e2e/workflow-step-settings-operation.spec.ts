import { randomUUID } from "node:crypto";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { ALLOWED_URL, plantConnection, removeConnection } from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The Settings of an operation step (workflow-canvas 9.4, Events check 126): the instance
// lists, over `operations.list_callable`, the operations a step may call with their titles and
// sources; picking "Load the bookings" in a step's Settings writes its operation, and the form
// shows one row per field of its input schema, a required one holding the save back until it
// has a value. Fails without WF-EDIT-3: there was no such listing, and the step was the
// agent's to change.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
const listingSchema = z.object({
  operations: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      effect: z.string(),
      source: z.object({ kind: z.string(), title: z.string().optional() }),
      inputSchema: z.record(z.string(), z.unknown()).optional()
    })
  )
});
const assetSchema = z.object({
  config: z.object({
    manifest: z.object({ steps: z.array(z.record(z.string(), z.unknown())) })
  })
});

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

async function openSettings(page: Page, step: string): Promise<Locator> {
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  await canvas.locator(`[data-flow-id="${step}"]`).click();
  const panel = page.locator(`[data-step-panel="${step}"]`);
  await panel.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(panel.locator(`[data-step-settings="${step}"]`)).toBeVisible();
  return panel;
}

test("an operation step's Settings pick an action the person may call and write its input", async ({
  page,
  // It plants a Connection no release config names.
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  page.setDefaultTimeout(30_000);
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const suffix = randomUUID().slice(0, 8);
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_${suffix}`,
    displayName: "Exampledata",
    url: ALLOWED_URL,
    authScheme: "none" as const,
    operations: [
      {
        name: "echo",
        effect: "reading" as const,
        exposure: ["workflow"],
        enabled: true,
        title: "Load the bookings"
      },
      {
        name: "record",
        effect: "changing" as const,
        exposure: ["workflow"],
        enabled: true,
        title: "Write the booking"
      }
    ]
  };
  const load = `connection.${connection.name}.echo`;
  try {
    await plantConnection(connection);
    // The listing the picker reads: titles and the source, as the person may call them.
    const listed = listingSchema.parse(
      await (
        await page.request.get(
          `${apiBaseUrl}/api/v1/operations/callable?prefix=${encodeURIComponent(`connection.${connection.name}.`)}`
        )
      ).json()
    );
    expect(listed.operations.map(({ name, title, source }) => [name, title, source])).toEqual([
      [load, "Load the bookings", { kind: "connection", title: "Exampledata" }],
      [
        `connection.${connection.name}.record`,
        "Write the booking",
        { kind: "connection", title: "Exampledata" }
      ]
    ]);
    const fields = Object.keys(
      z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .parse(listed.operations[0]?.inputSchema).properties
    );

    const runAs = `settings-operation-${suffix}-runner`;
    const principal = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/service-principals`,
      { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflows of a spec." } }
    );
    expect(principal.ok(), await principal.text()).toBe(true);
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Settings operation ${suffix}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const id = `settings-operation-${suffix}`;
    const stored = await requestWithOrigin(page, "put", assetUrlOf(id), {
      data: {
        expectedRevision: null,
        config: {
          name: id,
          manifest: {
            id,
            name: `Bookings ${suffix}`,
            runAs,
            inputs: { type: "object", additionalProperties: false },
            outputs: { type: "object" },
            steps: [
              {
                id: "start",
                name: "Start by hand",
                type: "trigger",
                triggers: [{ kind: "manual" }]
              },
              {
                id: "load",
                name: "Load",
                type: "operation",
                operation: `connection.${connection.name}.record`,
                input: { text: { value: "all" } }
              },
              { id: "result", name: "Result", type: "output", input: {} }
            ]
          }
        }
      }
    });
    expect(stored.ok(), await stored.text()).toBe(true);

    await page.goto(`/w/${workspaceId}/workflows/${id}`);
    const panel = await openSettings(page, "load");
    await panel.getByRole("button", { name: /^Action/u }).click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: /^Load the bookings/u })
      .click();
    // One row per field of the operation's input; the required one waits for a value.
    await expect(panel.locator("[data-input-field]")).toHaveCount(fields.length);
    const text = panel.locator('[data-input-field="text"]').getByRole("textbox");
    await text.fill("");
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await text.fill("this month");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get(assetUrlOf(id));
        return assetSchema.parse(await response.json()).config.manifest.steps[1];
      })
      .toEqual({
        id: "load",
        name: "Load",
        type: "operation",
        operation: load,
        input: { text: { value: "this month" } }
      });
  } finally {
    await removeConnection(connection.id);
  }
});
