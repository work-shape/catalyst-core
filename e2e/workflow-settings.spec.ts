import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The Settings tab of a Workflow (workflow-canvas 9.7, Events check 128): its builder sets
// "every weekday at 07:30, Berlin time" without writing cron. The Save is one revision of the
// draft whose trigger holds the cron and the zone, the published revision stays until the
// publish, and after it the trigger's next due time is the next weekday at 07:30 in Berlin.
// Fails without WF-EDIT-5: a Workflow had no Settings tab, and a schedule was the agent's.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };
const NAME = "Morning bookings";
const ZONE = "Europe/Berlin";

const idSchema = z.object({ id: z.string() });
const assetSchema = z.object({
  revision: z.number(),
  publishedRevision: z.number().nullable().optional(),
  config: z.object({ manifest: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }) }),
  stepFacts: z
    .record(
      z.string(),
      z.object({ timeZone: z.string().optional(), nextDueAt: z.string().optional() })
    )
    .optional()
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

async function readAsset(page: Page, id: string) {
  const response = await page.request.get(assetUrlOf(id));
  expect(response.ok()).toBe(true);
  return assetSchema.parse(await response.json());
}

/** The weekday (1 Monday to 7 Sunday) and the time of day of an instant in Berlin. */
function inBerlin(at: string): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday")) + 1;
  return { weekday, time: `${part("hour")}:${part("minute")}` };
}

test("a Workflow's Settings set every weekday at 07:30 Berlin time, due after the publish", async ({
  page
}) => {
  test.setTimeout(180_000);
  const id = `settings-schedule-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const manifest = {
    id,
    name: NAME,
    runAs,
    inputs: { type: "object", additionalProperties: false },
    outputs: { type: "object", properties: { done: { type: "integer" } }, required: ["done"] },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
    ]
  };
  const stored = await requestWithOrigin(page, "put", assetUrlOf(id), {
    data: { expectedRevision: null, config: { name: id, manifest } }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  const first = await assetRevision(page, assetUrlOf(id));
  const published = await requestWithOrigin(page, "post", `${assetUrlOf(id)}/publish`, {
    data: { revision: first }
  });
  expect(published.ok(), await published.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Settings schedule ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  // The Settings are a tab of the Workflow, beside its canvas.
  await page.goto(`/w/${workspaceId}/workflows/${id}`);
  await page
    .getByRole("navigation", { name: "Views of the workflow" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}/settings$`, "u"));
  const settings = page.getByTestId("workflow-settings-page");
  const form = settings.locator("[data-workflow-settings]");
  await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(NAME);

  // Check 128: on a schedule, every weekday (the first offered), at 07:30, Berlin time.
  await form.getByRole("switch", { name: "On a schedule" }).click();
  const schedule = form.locator('[data-slot="schedule-field"]');
  await expect(schedule.getByLabel("Repeats", { exact: true })).toHaveValue("weekday");
  await schedule.getByLabel("At", { exact: true }).fill("07:30");
  const zone = schedule.getByRole("button", { name: /^Time zone: / });
  await zone.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Berlin");
  await page.keyboard.press("Enter");
  await expect(zone).toHaveAccessibleName("Time zone: Berlin time");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  // One revision of the draft holds the trigger; the published revision is still the first.
  await expect.poll(async () => (await readAsset(page, id)).revision).toBe(first + 1);
  const draft = await readAsset(page, id);
  expect(draft.publishedRevision).toBe(first);
  expect(draft.config.manifest.steps[0]?.triggers).toEqual([
    { kind: "manual" },
    { kind: "schedule", cron: "30 7 * * 1-5", timeZone: ZONE }
  ]);

  // The publish makes it the schedule that runs: the next due time is a weekday at 07:30.
  const bar = settings.locator("[data-workflow-draft]");
  await bar.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = page.getByRole("dialog", { name: `Publish “${NAME}”?` });
  await publish.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publish).toBeHidden();
  await expect(bar).toHaveCount(0);
  const live = await readAsset(page, id);
  expect(live.publishedRevision).toBe(first + 1);
  const due = live.stepFacts?.start;
  expect(due?.timeZone).toBe(ZONE);
  const next = due?.nextDueAt ?? "";
  expect(Date.parse(next)).toBeGreaterThan(Date.now());
  expect(Date.parse(next) - Date.now()).toBeLessThan(4 * 24 * 60 * 60 * 1000);
  const berlin = inBerlin(next);
  expect(berlin.time).toBe("07:30");
  expect(berlin.weekday).toBeLessThanOrEqual(5);

  // The page shows it as set: the field reads the published schedule back.
  await page.reload();
  await expect(schedule.getByLabel("At", { exact: true })).toHaveValue("07:30");
});
