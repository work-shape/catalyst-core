import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// A Workflow that declares inputs is started from a form made from them: a member who may
// start it fills the form from the card of the list, is refused in the form what the inputs
// refuse and under the field what the instance refuses, and watches the run end as done. Once
// the right to start is taken back, neither the card nor the page offers a start. The Workflow
// is one of this spec's own. Fails without the form: a Workflow with inputs offered no start.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The member who starts the Workflow, from `tests/fixtures/e2e-users/workflow-start-form.yaml`. No other spec uses it. */
const member = {
  email: "e2e-workflow-start@example.test",
  password: "e2e-workflow-start-password"
};
const WIDE = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
const runSchema = z.object({
  status: z.string(),
  outputPreview: z.object({ text: z.string() }).optional()
});

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A page of its own session, watched for page errors like the test's own. */
async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  user: { email: string; password: string }
): Promise<Page> {
  const context = await browser.newContext({ viewport: WIDE });
  await watch(context);
  const page = await context.newPage();
  await signIn(page, user);
  return page;
}

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

/**
 * Saves and publishes the Workflow: it returns the client and the number of bookings it was
 * started with. `mostBookings` is the largest number its inputs accept.
 */
async function publish(
  root: Page,
  input: { id: string; name: string; runAs: string; mostBookings: number }
): Promise<void> {
  const { id } = input;
  const start = (path: string) => ({ ref: { step: "start", path } });
  const exists = (await root.request.get(assetUrlOf(id))).ok();
  const saved = await requestWithOrigin(root, "put", assetUrlOf(id), {
    data: {
      expectedRevision: exists ? await assetRevision(root, assetUrlOf(id)) : null,
      config: {
        name: id,
        manifest: {
          id,
          name: input.name,
          description: "Checks the bookings of one client.",
          runAs: input.runAs,
          inputs: {
            type: "object",
            additionalProperties: false,
            properties: {
              client: {
                type: "string",
                title: "Client",
                description: "Whose bookings to check.",
                minLength: 2
              },
              month: { type: "string", format: "date", title: "First day" },
              limit: {
                type: "integer",
                title: "Most bookings",
                minimum: 1,
                maximum: input.mostBookings,
                default: input.mostBookings
              },
              urgent: { type: "boolean", title: "Urgent" },
              region: { type: "string", title: "Region", enum: ["north", "south"] }
            },
            required: ["client", "month", "region"]
          },
          outputs: {
            type: "object",
            properties: { client: { type: "string" }, limit: { type: "integer" } },
            required: ["client", "limit"]
          },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "result",
              name: "Result",
              type: "output",
              input: { client: start("input.client"), limit: start("input.limit") }
            }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const revision = await assetRevision(root, assetUrlOf(id));
  const published = await requestWithOrigin(root, "post", `${assetUrlOf(id)}/publish`, {
    data: { revision }
  });
  expect(published.ok(), await published.text()).toBe(true);
}

/** Gives the member a right on the one Workflow. Answers the id of the grant. */
async function grant(root: Page, memberId: string, assetId: string, action: string) {
  const granted = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/access/grants`,
    {
      data: {
        holderKind: "user",
        holderId: memberId,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: assetId
      }
    }
  );
  expect(granted.ok(), await granted.text()).toBe(true);
  return idSchema.parse(await granted.json()).id;
}

const VARIANTS = (["light", "dark"] as const).flatMap((theme) =>
  (["en", "de"] as const).flatMap((locale) =>
    ([1440, 390] as const).map((width) => [theme, locale, width] as const)
  )
);

/** Pictures of the form as a start left empty leaves it, in both themes and languages. */
async function shootForm(page: Page, open: () => Promise<Locator>): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  for (const [theme, locale, width] of VARIANTS) {
    await page.evaluate(
      ([themeValue, localeValue]) => {
        window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      },
      [theme, locale] as const
    );
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.reload();
    const dialog = await open();
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.getByRole("alert").first()).toBeVisible();
    await page.screenshot({
      path: join(shotsDir, `workflow-start-form-${theme}-${locale}-${String(width)}.png`),
      animations: "disabled"
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:theme", "light");
    window.localStorage.setItem("vivd-catalyst:locale", "en");
  });
  await page.setViewportSize(WIDE);
  await page.reload();
}

test("a member starts a Workflow with inputs from its form and sees the run end; a reader sees no start", async ({
  page,
  browser,
  pageErrors,
  accessState: _accessState
}) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  const suffix = randomUUID().slice(0, 8);
  const id = `start-form-${suffix}`;
  const name = `Booking check ${suffix}`;
  const runAs = `${id}-runner`;
  const root = await sessionOf(browser, pageErrors.watch, superadmin);

  // The Workflow's account, the Workflow, and a workspace the member stands in: a Workflow
  // belongs to none, and its pages have the address of the open one.
  const principal = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  await publish(root, { id, name, runAs, mostBookings: 10 });
  const created = await requestWithOrigin(root, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Start form ${suffix}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  await page.setViewportSize(WIDE);
  await signIn(page, member);
  const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  const memberId = idSchema.parse(await me.json()).id;
  const added = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const assetId = idSchema.parse(await (await root.request.get(assetUrlOf(id))).json()).id;
  const grants = [
    await grant(root, memberId, assetId, "workflow.read"),
    await grant(root, memberId, assetId, "workflow.use")
  ];

  try {
    // The Workflow's page says in its head whom every run acts as: the account's label.
    await page.goto(`/w/${workspaceId}/workflows/${id}`);
    await expect(page.getByTestId("workflow-page").getByText(`Runs as ${runAs}`)).toBeVisible();
    await page.goto(`/w/${workspaceId}/workflows`);
    const card = page.getByRole("listitem").filter({ hasText: name });
    const dialog = page.getByRole("dialog", { name: `Start “${name}” now?` });
    // Start now stands above the card that opens the Workflow, and keeps its own action.
    const openForm = async () => {
      await card.getByRole("button", { name: "Start now", exact: true }).click();
      await expect(dialog).toBeVisible();
      return dialog;
    };
    // The pictures are taken in both languages, so the card's start is found in either.
    await shootForm(page, async () => {
      await card.getByRole("button", { name: /^(?:Start now|Jetzt starten)$/u }).click();
      const shown = page.getByRole("dialog");
      await expect(shown).toBeVisible();
      return shown;
    });
    await openForm();
    await expect(dialog).toContainText("Fill in what this run starts with.");
    await expect(dialog).toContainText("Whose bookings to check.");
    const client = dialog.getByRole("textbox", { name: /^Client/u });
    const month = dialog.getByLabel(/^First day/u);
    const limit = dialog.getByRole("spinbutton", { name: /^Most bookings/u });
    const region = dialog.getByRole("combobox", { name: /^Region/u });
    const urgent = dialog.getByRole("switch", { name: /^Urgent/u });
    const start = dialog.getByRole("button", { name: "Start", exact: true });
    // The default stands in its field.
    await expect(limit).toHaveValue("10");

    // A start without the required values is refused in the form, each under its field.
    await start.click();
    await expect(dialog.getByText("Enter a value.", { exact: true })).toHaveCount(2);
    await expect(dialog.getByText("Choose one.", { exact: true })).toBeVisible();
    await expect(client).toHaveAttribute("aria-invalid", "true");

    // What the inputs refuse is refused in the form, in the reader's words.
    await client.fill("N");
    await month.fill("2026-09-01");
    await region.selectOption("north");
    await limit.fill("11");
    await urgent.click();
    await start.click();
    await expect(dialog.getByText("Enter at least 2 characters.", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Enter 10 or less.", { exact: true })).toBeVisible();
    await client.fill("Nordlicht");
    await limit.fill("5");

    // The Workflow is published again with a smaller limit while the form is open: the value
    // passes the form and not the instance, which names the field it refuses.
    await publish(root, { id, name, runAs, mostBookings: 3 });
    await start.click();
    await expect(dialog).toContainText("The instance did not accept these values.");
    await expect(dialog.getByText("must be <= 3", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await limit.fill("2");
    // A changed value is the reader's again.
    await expect(dialog.getByText("must be <= 3", { exact: true })).toHaveCount(0);

    // The start opens the new run, which ends as done with what the form gave.
    await start.click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/workflows/${id}/runs/[^/]+$`, "u"));
    const runPage = page.getByTestId("workflow-run-page");
    await expect(runPage.getByText("Done", { exact: true }).first()).toBeVisible({
      timeout: 30_000
    });
    const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const run = runSchema.parse(
      await (await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`)).json()
    );
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
      client: "Nordlicht",
      limit: 2
    });

    // The right to start taken back: the member reads the Workflow and is offered no start.
    const revoked = await requestWithOrigin(
      root,
      "delete",
      `${apiBaseUrl}/api/v1/instance/access/grants/${grants.pop() ?? ""}`
    );
    expect(revoked.ok(), await revoked.text()).toBe(true);
    await page.goto(`/w/${workspaceId}/workflows`);
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Start now", exact: true })).toHaveCount(0);
    // The whole card opens the Workflow: a click on its name lands on Open, whose area lies
    // over it.
    await expect(card.getByRole("link", { name: `Open ${name}`, exact: true })).toHaveCount(1);
    await card.getByRole("heading", { name, exact: true }).click({ force: true });
    const workflowPage = page.getByTestId("workflow-page");
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(workflowPage.getByRole("button", { name: "Start now", exact: true })).toHaveCount(
      0
    );
  } finally {
    for (const grantId of grants) {
      await requestWithOrigin(
        root,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grantId}`
      );
    }
    await root.context().close();
  }
});

test("the Workflow head keeps both actions inside 390 and 1280 in English and German", async ({
  page
}) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const id = `head-layout-${suffix}`;
  const name = "Monthly booking check";
  const runAs = `${id}-runner`;
  await signIn(page, superadmin);
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    {
      data: { name: runAs, displayLabel: "Booking checks" }
    }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  await publish(page, { id, name, runAs, mostBookings: 10 });
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Head layout ${suffix}` }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  for (const locale of ["en", "de"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/w/${workspaceId}/workflows/${id}`);
      await page.evaluate((value) => localStorage.setItem("vivd-catalyst:locale", value), locale);
      await page.reload();
      const head = page
        .locator("[data-page-head]")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(head).toBeVisible();
      const start = head.getByRole("button", {
        name: locale === "de" ? "Jetzt starten" : "Start now",
        exact: true
      });
      await expect(start).toBeVisible();
      if (shotsDir) {
        await mkdir(shotsDir, { recursive: true });
        await page.screenshot({
          path: join(shotsDir, `workflow-head-${width}-${locale}.png`),
          animations: "disabled"
        });
      }
      const boxes = await head.locator("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return { left: box.left, right: box.right, cut: button.scrollWidth > button.clientWidth };
        })
      );
      expect
        .soft(
          boxes.filter((box) => box.left < 0 || box.right > width || box.cut),
          `${locale} ${width}`
        )
        .toEqual([]);
    }
  }
});
