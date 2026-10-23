import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, takeTurn, test } from "./test";

// The Send email step (MAIL-3a, MAIL-3b; Events checks 141 and 142): the palette's "Send an
// e-mail" under People adds it; its Settings take two people by name and one typed address,
// mark an address outside the instance's domains before Save, take a list of addresses from an
// earlier step, a subject with a chip for the month and a text with a chip for the findings,
// and show the mail in the instance's frame under "Preview". Save writes `to`, `subject` and
// `body` in the `text` form. The suite's instance sends no mail, so a second API runs the same
// instance with outbound mail on (captured, never delivered), on the same database, and the
// interface is sent to it. Pictures go to the test's output folder: light and dark at 1280,
// light at 390.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The API with outbound mail on listens beside the suite's own. */
const mailApiPort = Number(new URL(apiBaseUrl).port) + 19;
const mailApiUrl = `http://${host}:${mailApiPort}`;

const idSchema = z.object({ id: z.string() });
const assetSchema = z.object({
  config: z.object({
    manifest: z.object({ steps: z.array(z.record(z.string(), z.unknown())) })
  })
});

async function signIn(page: Page, api: string): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function shoot(page: Page, panel: Locator, label: string): Promise<void> {
  await panel.scrollIntoViewIfNeeded();
  const path = test.info().outputPath(`evidence-mail-step-${label}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await test.info().attach(`mail-step-${label}`, { path, contentType: "image/png" });
}

test.describe("the Send email step", () => {
  test.describe.configure({ mode: "serial" });
  let mailApi: ChildProcess | undefined;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    // An API that starts makes the release Connections of the shared database equal to its
    // config. It starts when no test holds a Connection it planted there.
    const started = await takeTurn("release-connections", testInfo.project.use.baseURL);
    try {
      await startMailApi();
    } finally {
      await started();
    }
  });

  async function startMailApi(): Promise<void> {
    const onConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-mail-on.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, mailApiUrl);
    const section = /^infrastructure:\n/mu;
    expect(section.test(config)).toBe(true);
    await mkdir(dirname(onConfigPath), { recursive: true });
    await writeFile(
      onConfigPath,
      config.replace(
        section,
        [
          "infrastructure:",
          "  mail:",
          "    provider: capture",
          `    appUrl: ${process.env.E2E_UI_URL ?? `http://${host}:5273`}`,
          "    sender:",
          "      fromAddress: noreply@example.test",
          "    outbound:",
          "      enabled: true",
          "      recipientDomains:",
          "        - example.test",
          ""
        ].join("\n")
      )
    );
    mailApi = spawn(process.execPath, ["clients/demo/dist/e2e-server.js"], {
      env: {
        ...process.env,
        HOST: host,
        PORT: String(mailApiPort),
        CLIENT_CONFIG_PATH: onConfigPath,
        DATABASE_URL: databaseUrl,
        // One database, so one queue of jobs and Agent Runs: this API takes none of them.
        E2E_TAKES_NO_JOBS: "1",
        CHAT_UI_ORIGIN: process.env.E2E_UI_URL ?? `http://${host}:5273`,
        BETTER_AUTH_URL: `${mailApiUrl}/api/auth`,
        // The secret of the suite's own API: both sign the sessions of one database.
        BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
        E2E_SUPERADMIN_EMAIL: superadmin.email,
        E2E_USER_EMAIL: "e2e-user@example.test",
        CHAT_SESSION_TOKEN_SECRET: "e2e-mail-step-session-token-secret-24ch",
        CHAT_SERVER_CREDENTIAL: "e2e-mail-step-server-credential",
        SERVICE_ACCESS_TOKEN_SECRET: "e2e-mail-step-service-access-token-secret-32"
      },
      stdio: "inherit"
    });
    const started = mailApi;
    await expect
      .poll(
        async () => {
          if (started.exitCode !== null) throw new Error("The API with mail on stopped");
          try {
            return (await fetch(`${mailApiUrl}/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 }
      )
      .toBe(200);
  }

  test.afterAll(async () => {
    if (!mailApi || mailApi.exitCode !== null) return;
    const exited = new Promise((done) => mailApi?.once("exit", done));
    mailApi.kill("SIGTERM");
    await exited;
  });

  test("is added from the palette, written in its Settings and previewed in the instance's frame", async ({
    page
  }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, apiBaseUrl);
    await signIn(page, mailApiUrl);
    const suffix = randomUUID().slice(0, 8);

    const runAs = `mail-step-${suffix}-runner`;
    const principal = await requestWithOrigin(
      page,
      "post",
      `${mailApiUrl}/api/v1/instance/service-principals`,
      { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflows of a spec." } }
    );
    expect(principal.ok(), await principal.text()).toBe(true);
    const created = await requestWithOrigin(page, "post", `${mailApiUrl}/api/v1/workspaces`, {
      data: { name: `Mail step ${suffix}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const id = `mail-step-${suffix}`;
    const assetUrl = `${mailApiUrl}/api/v1/assets/workflow/${id}`;
    const stored = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: id,
          manifest: {
            id,
            name: `Monthly check ${suffix}`,
            runAs,
            inputs: {
              type: "object",
              properties: { month: { type: "string", title: "Month" } }
            },
            outputs: { type: "object" },
            steps: [
              {
                id: "start",
                name: "Start by hand",
                type: "trigger",
                triggers: [{ kind: "manual" }]
              },
              {
                id: "check",
                name: "Check the bookings",
                type: "agent",
                instructions: "Check the bookings of the month.",
                input: {},
                inputSchema: { type: "object", properties: {} },
                outputSchema: {
                  type: "object",
                  properties: {
                    findings: { type: "array", title: "Findings", items: { type: "object" } },
                    emails: {
                      type: "array",
                      title: "Client addresses",
                      items: { type: "string" }
                    }
                  }
                }
              },
              { id: "result", name: "Result", type: "output", input: {} }
            ]
          }
        }
      }
    });
    expect(stored.ok(), await stored.text()).toBe(true);

    // The interface talks to the API with outbound mail on.
    await page.route(`${apiBaseUrl}/**`, (route) =>
      route.continue({ url: route.request().url().replace(apiBaseUrl, mailApiUrl) })
    );
    await page.goto(`/w/${workspaceId}/workflows/${id}`);
    const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
    await canvas
      .getByRole("button", { name: "Add a step after “Check the bookings”", exact: true })
      .click();
    await page.getByRole("option", { name: /^Send an e-mail/u }).click();
    const opened = page
      .locator("[data-step-panel]")
      .filter({ has: page.locator("[data-mail-settings]") });
    await expect(opened.locator("[data-mail-settings]")).toBeVisible();
    const stepId = await opened.getAttribute("data-step-panel");
    expect(stepId).not.toBeNull();
    // The panel by its step, whichever tab it shows.
    const panel = page.locator(`[data-step-panel="${stepId ?? ""}"]`);
    // A new step is the instance's own sender; its address is told once the step is saved.
    await expect(panel.locator('[data-mail-field="from"]')).toContainText("This instance");

    // To: a person and a workspace by name, and one typed address.
    const to = panel.locator('[data-mail-field="to"]');
    await to.getByRole("button", { name: "Add people", exact: true }).click();
    const people = page.getByRole("listbox").getByRole("option");
    // People come first; the workspace is the one this test made.
    await people.first().click();
    await people.filter({ hasText: `Mail step ${suffix}` }).click();
    await page.keyboard.press("Escape");
    await expect(to.locator('[data-recipient="person"]')).toHaveCount(1);
    await expect(to.locator('[data-recipient="workspace"]')).toHaveCount(1);
    const typed = to.getByRole("textbox");
    await typed.fill("anna@example.test");
    await typed.press("Enter");

    // Cc: the list of addresses an earlier step gives, which takes the field alone.
    const cc = panel.locator('[data-mail-field="cc"]');
    await cc.getByRole("button", { name: "Insert a value", exact: true }).click();
    await page.getByRole("option", { name: /^Client addresses/u }).click();
    await expect(cc.locator('[data-recipient="picked"]')).toContainText("Client addresses");

    // Subject and text, each with a chip for a value of an earlier step.
    const subject = panel.locator('[data-mail-field="subject"]');
    await subject.locator("[data-template-editor]").click();
    await page.keyboard.type("Check result ");
    await subject.getByRole("button", { name: "Insert a value", exact: true }).click();
    await page.getByRole("option", { name: /^Month/u }).click();
    await expect(subject.locator('[data-template-option="start#input.month"]')).toHaveText("Month");
    const body = panel.locator('[data-mail-field="body"]');
    await body.locator("[data-template-editor]").click();
    await page.keyboard.type("Good morning,");
    await page.keyboard.press("Enter");
    await page.keyboard.type("the monthly check found these bookings:");
    await page.keyboard.press("Enter");
    await body.getByRole("button", { name: "Insert a value", exact: true }).click();
    await page.getByRole("option", { name: /^Findings/u }).click();
    await expect(body.locator('[data-template-option="check#findings"]')).toHaveText("Findings");

    // The preview: the mail in the instance's frame, each value by its name until a run.
    await body.getByRole("radio", { name: "Preview", exact: true }).click();
    const preview = body.locator("[data-mail-settings-preview]");
    await expect(preview.locator('[data-mail-row="subject"]')).toContainText(
      "Check result [Month]"
    );
    await expect(preview.locator("[data-mail-brand]")).toContainText("E2E Customer");
    await expect(preview.locator("[data-mail-body]")).toContainText("Good morning,");
    await expect(preview).toContainText("No run yet: each value shows as its name.");
    await expect(panel).not.toContainText(/mailjet/iu);

    for (const [theme, width] of [
      ["light", 1280],
      ["dark", 1280],
      ["light", 390]
    ] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      // The instance follows the system's scheme, so the panel keeps what is not saved yet.
      await page.emulateMedia({ colorScheme: theme });
      await expect(preview).toBeVisible();
      await shoot(page, preview, `settings-preview-${theme}-${String(width)}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });

    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect
      .poll(async () => {
        const response = await page.request.get(assetUrl);
        return assetSchema
          .parse(await response.json())
          .config.manifest.steps.find((step) => step.id === stepId)?.input;
      })
      .toMatchObject({
        sender: { value: "system" },
        to: {
          value: [
            { user: expect.any(String) },
            { workspace: expect.any(String) },
            { address: "anna@example.test" }
          ]
        },
        cc: { ref: { step: "check", path: "emails" } },
        subject: { text: ["Check result ", { ref: { step: "start", path: "input.month" } }] },
        body: {
          text: [
            "Good morning,\nthe monthly check found these bookings:\n",
            { ref: { step: "check", path: "findings" } }
          ]
        }
      });

    // "What it does": the sentence, the mail in the frame and where the instance may send.
    await panel.getByRole("tab", { name: "What it does", exact: true }).click();
    await expect(panel.locator("[data-step-sentence]")).toContainText(
      "Sends “Check result [Month]”"
    );
    await expect(panel).toContainText("May send to example.test");
    await expect(panel).toContainText(
      "Simulated in a test run; “Run live once” sends it to the tester only."
    );
    const node = canvas.locator(`[data-flow-id="${stepId ?? ""}"]`);
    await expect(node).toContainText("Sends an e-mail");
    await expect(node).toContainText("Check result [Month]");
    for (const [theme, width] of [
      ["light", 1280],
      ["dark", 1280],
      ["light", 390]
    ] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await expect(panel.locator("[data-step-sentence]")).toBeVisible();
      await shoot(page, panel, `what-it-does-${theme}-${String(width)}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });

    // Saved, the step knows its sender: the address in From, and an address outside the
    // instance's recipient domains is marked before Save. The transport is named nowhere.
    await panel.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(panel.locator('[data-mail-field="from"]')).toContainText("noreply@example.test");
    const typing = panel.locator('[data-mail-field="to"]').getByRole("textbox");
    await typing.fill("otto@outside.test");
    await typing.press("Enter");
    await expect(panel.locator('[data-mail-field="to"] [data-recipient-invalid]')).toContainText(
      "This instance does not send to outside.test."
    );
    await expect(panel).not.toContainText(/mailjet/iu);
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});
