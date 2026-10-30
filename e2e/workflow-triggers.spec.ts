import { createHmac, randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Webhook and platform event triggers on a Workflow's Settings (EW-4): the builder turns both
// on and saves, publishes, makes the webhook's secret, which shows once, and an outside system
// that signs a request with it starts a run. Fails without the trigger rows, the webhook panel
// and the signed address.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };
const NAME = "Trigger walk";

const assetSchema = z.object({
  config: z.object({
    manifest: z.object({
      steps: z.array(z.object({ id: z.string(), triggers: z.array(z.unknown()).optional() }))
    })
  })
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("the builder sets up a webhook and a sync event, and a signed request starts a run", async ({
  page
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const id = `trigger-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const saved = await requestWithOrigin(page, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name: NAME,
          runAs,
          inputs: { type: "object", properties: { status: { type: "string" } } },
          outputs: { type: "object" },
          steps: [
            { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "result",
              name: "Result",
              type: "output",
              input: { status: { ref: { step: "start", path: "input.status" } } }
            }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Trigger walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
  const settingsPath = `/w/${workspaceId}/workflows/${id}/settings`;

  // Both triggers on, with a Knowledge Base filter left empty, and one Save.
  await page.goto(settingsPath);
  const settings = page.getByTestId("workflow-settings-page");
  const starts = settings.locator("[data-workflow-starts]");
  await starts.getByRole("switch", { name: /^By a webhook/u }).click();
  await expect(starts.locator("[data-workflow-webhook]")).toBeVisible();
  await expect(starts.locator("[data-workflow-webhook]")).toContainText(
    "The address takes requests once the workflow is published with the webhook on."
  );
  await starts.getByRole("switch", { name: /^When a Knowledge Base finishes syncing/u }).click();
  await expect(starts.locator("[data-event-knowledge-base]")).toBeVisible();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeHidden();
  // The save is a commit of the asset, which the command worker makes.
  await expect
    .poll(
      async () =>
        assetSchema.parse(await (await page.request.get(assetUrl)).json()).config.manifest.steps[0]
          ?.triggers,
      { timeout: 30_000 }
    )
    .toEqual([
      { kind: "manual" },
      { kind: "webhook" },
      { kind: "platform_event", event: "knowledge_base.sync_finished" }
    ]);

  // Published, the address takes requests once it has a secret, which shows once.
  const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
    data: { revision: await assetRevision(page, assetUrl) }
  });
  expect(published.ok(), await published.text()).toBe(true);
  await page.reload();
  const webhook = starts.locator("[data-workflow-webhook]");
  await expect(webhook).toContainText(`/api/v1/workflows/${id}/webhook`);
  await expect(webhook).toContainText("None yet: the address refuses every request");
  await webhook.getByRole("button", { name: "Make secret", exact: true }).click();
  const shown = webhook.locator("[data-webhook-secret]");
  await expect(shown).toContainText("Copy the secret now. It is not shown again");
  const secret = (await shown.locator("code").innerText()).trim();
  expect(secret.length).toBeGreaterThanOrEqual(32);
  await expect(webhook).toContainText("Set (version 1)");
  await expect(webhook.getByRole("button", { name: "Make new secret", exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("evidence-workflow-webhook.png"),
    animations: "disabled"
  });

  // An outside system signs a report with the secret and starts a run; a forged one starts none.
  const body = JSON.stringify({ status: "failed" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex")}`;
  const post = (signed: string, once: string) =>
    page.request.post(`${apiBaseUrl}/api/v1/workflows/${id}/webhook`, {
      data: body,
      headers: {
        "content-type": "application/json",
        "catalyst-webhook-timestamp": timestamp,
        "catalyst-webhook-nonce": once,
        "catalyst-webhook-signature": signed
      }
    });
  const forged = await post(`v1=${"0".repeat(64)}`, randomUUID());
  expect(forged.status()).toBe(404);
  const started = await post(signature, nonce);
  expect(started.status(), await started.text()).toBe(200);
  expect(z.object({ runId: z.string() }).parse(await started.json()).runId).toMatch(/\S/u);
});
