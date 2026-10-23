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
  config: z.object({
    manifest: z.object({
      inputs: z.unknown().optional(),
      steps: z.array(z.record(z.string(), z.unknown()))
    })
  }),
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

  // WF-EDIT-5c: a start field is named by its title; its key comes from the title while the
  // field is new, shows only as a detail, and stays once saved, as the steps read it by it.
  const asks = form.locator("[data-workflow-inputs]");
  await asks.getByRole("button", { name: "Add field", exact: true }).click();
  const month = asks.locator("[data-field-id]").last();
  await month.getByLabel("Title", { exact: true }).fill("Billing month");
  await expect(month.locator("[data-field-key]")).toContainText("billing_month");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await readAsset(page, id)).config.manifest.inputs)
    .toEqual({
      type: "object",
      properties: { billing_month: { type: "string", title: "Billing month" } },
      additionalProperties: false
    });
  await month.getByLabel("Title", { exact: true }).fill("Month of the bookings");
  await expect(month.locator("[data-field-key]")).toContainText("billing_month");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();

  // The canvas's trigger says the zone as the field does, never by its id.
  await page
    .getByRole("navigation", { name: "Views of the workflow" })
    .getByRole("link", { name: "Workflow", exact: true })
    .click();
  const trigger = page
    .getByTestId("workflow-page")
    .getByTestId("workflow-canvas")
    .locator('[data-flow-id="start"]');
  await expect(trigger).toContainText("(Berlin time)");
  await expect(trigger).not.toContainText(ZONE);
});

// WF-EDIT-5b: the "By another workflow" switch names the Workflows whose steps call this one,
// a draft's call included, each a link that opens the caller in the workspace that owns it; the
// instance's own opens in the workspace open now. Fails without WF-EDIT-5b: no caller was named.
test("a Workflow's Settings name the Workflows that call it, each a link to it", async ({
  page
}) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const child = `settings-child-${suffix}`;
  const fromInstance = `settings-caller-${suffix}`;
  const fromWorkspace = `settings-ws-caller-${suffix}`;
  const runAs = `${child}-runner`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflows of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const workspace = async (name: string) => {
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name }
    });
    expect(created.ok(), await created.text()).toBe(true);
    return idSchema.parse(await created.json()).id;
  };
  const open = await workspace(`Settings callers ${suffix}`);
  const owner = await workspace(`Settings caller owner ${suffix}`);
  const result = { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } };
  const outputs = {
    type: "object",
    properties: { done: { type: "integer" } },
    required: ["done"]
  };
  const store = async (id: string, name: string, steps: unknown[], workspaceId?: string) => {
    const stored = await requestWithOrigin(page, "put", assetUrlOf(id), {
      data: {
        expectedRevision: null,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        config: {
          name: id,
          manifest: {
            id,
            name,
            runAs,
            inputs: { type: "object", additionalProperties: false },
            outputs,
            steps
          }
        }
      }
    });
    expect(stored.ok(), await stored.text()).toBe(true);
  };
  const calling = () => [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "call", name: "Call", type: "workflow", workflow: child, input: {} },
    result
  ];

  // The child starts by another workflow; one caller of the instance and one of a workspace
  // call it from their drafts.
  await store(child, "Child bookings", [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "parent" }] },
    result
  ]);
  const published = await requestWithOrigin(page, "post", `${assetUrlOf(child)}/publish`, {
    data: { revision: await assetRevision(page, assetUrlOf(child)) }
  });
  expect(published.ok(), await published.text()).toBe(true);
  await store(fromInstance, "Instance month end", calling());
  await store(fromWorkspace, "Workspace month end", calling(), owner);

  await page.goto(`/w/${open}/workflows/${child}/settings`);
  const form = page.getByTestId("workflow-settings-page").locator("[data-workflow-settings]");
  await expect(form.getByRole("switch", { name: "By another workflow" })).toBeChecked();
  const callers = form.locator("[data-workflow-callers]");
  await expect(callers).toContainText("Called by");
  await expect(callers.getByRole("link", { name: "Instance month end" })).toHaveAttribute(
    "href",
    `/w/${open}/workflows/${fromInstance}`
  );
  const workspaceCaller = callers.getByRole("link", { name: "Workspace month end" });
  await expect(workspaceCaller).toHaveAttribute("href", `/w/${owner}/workflows/${fromWorkspace}`);

  // The link opens the caller in the workspace that owns it.
  await workspaceCaller.click();
  await expect(page).toHaveURL(new RegExp(`/w/${owner}/workflows/${fromWorkspace}$`, "u"));
  await expect(page.getByTestId("workflow-page")).toContainText("Workspace month end");

  // In German.
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.goto(`/w/${open}/workflows/${child}/settings`);
  await expect(form.getByRole("switch", { name: "Durch einen anderen Workflow" })).toBeChecked();
  await expect(callers).toContainText("Aufgerufen von");
  await expect(callers.getByRole("link", { name: "Instance month end" })).toHaveAttribute(
    "href",
    `/w/${open}/workflows/${fromInstance}`
  );

  // In a short window and at phone width, light and dark, in both languages: the callers are
  // reached by scrolling to the end, and stay named after switching to the canvas and back.
  const views = [
    { locale: "en", theme: "light", size: { width: 1440, height: 480 } },
    { locale: "en", theme: "dark", size: { width: 390, height: 844 } },
    { locale: "de", theme: "dark", size: { width: 1440, height: 480 } },
    { locale: "de", theme: "light", size: { width: 390, height: 844 } }
  ] as const;
  for (const view of views) {
    const words =
      view.locale === "en"
        ? { tabs: "Views of the workflow", settings: "Settings", calledBy: "Called by" }
        : {
            tabs: "Ansichten des Workflows",
            settings: "Einstellungen",
            calledBy: "Aufgerufen von"
          };
    await page.setViewportSize(view.size);
    await page.emulateMedia({ colorScheme: view.theme });
    await page.evaluate(({ locale, theme }) => {
      window.localStorage.setItem("vivd-catalyst:locale", locale);
      window.localStorage.setItem("vivd-catalyst:theme", theme);
    }, view);
    await page.goto(`/w/${open}/workflows/${child}/settings`);
    await expect
      .poll(() =>
        page
          .locator("main")
          .first()
          .evaluate((element) => element.classList.contains("dark"))
      )
      .toBe(view.theme === "dark");
    await expect(callers).toContainText(words.calledBy);

    // Scroll to the end of the Settings the way a reader does, then back up to the callers,
    // which follow the parent switch above the start fields.
    await form.hover();
    await page.mouse.wheel(0, 10_000);
    await expect(form.locator("[data-workflow-facts]")).toBeInViewport();
    await expect(async () => {
      await page.mouse.wheel(0, -200);
      await expect(callers).toBeInViewport({ ratio: 1, timeout: 500 });
    }).toPass();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);

    const tabs = page.getByRole("navigation", { name: words.tabs });
    for (let round = 0; round < 2; round += 1) {
      await tabs.getByRole("link", { name: "Workflow", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${open}/workflows/${child}$`, "u"));
      await tabs.getByRole("link", { name: words.settings, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/workflows/${child}/settings$`, "u"));
      await expect(callers.getByRole("link")).toHaveCount(2);
    }
    // Still both, a second on: no later read drops them.
    await page.waitForTimeout(1_000);
    await expect(callers).toContainText(words.calledBy);
    await expect(callers.getByRole("link", { name: "Instance month end" })).toHaveAttribute(
      "href",
      `/w/${open}/workflows/${fromInstance}`
    );
    await expect(callers.getByRole("link", { name: "Workspace month end" })).toHaveAttribute(
      "href",
      `/w/${owner}/workflows/${fromWorkspace}`
    );
  }
});
