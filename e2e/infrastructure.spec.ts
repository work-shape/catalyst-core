import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Instance > Infrastructure: an operator reads what the instance runs on and whether each
// provider answers. A second API runs the same instance with one more model provider whose
// endpoint refuses every connection, so the page shows a provider that answers beside one that
// does not, and its credential stays out of the page.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl = `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** The API with the failing provider listens beside the suite's own. */
const brokenApiPort = Number(new URL(apiBaseUrl).port) + 8;
const brokenApiUrl = `http://${host}:${brokenApiPort}`;
const SECRET_MARKER = "e2e-secret-marker-3b7f1d";
const localModel = "    local:\n      provider: deterministic\n";
// Nothing listens on the discard port, so the connection is refused at once.
const brokenModel =
  "    broken:\n      provider: openai-compatible\n      region: eu\n      model: unreachable-model\n" +
  "      baseUrl: http://127.0.0.1:9/v1\n      credentialSecret: E2E_BROKEN_MODEL_KEY\n";

async function signIn(page: Page, api = apiBaseUrl): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const providerRow = (page: Page, id: string) => page.locator(`[data-provider="${id}"]`);
const health = (page: Page, id: string) => providerRow(page, id).locator("[data-check]");

test("an operator reads what the instance runs on and how its last check went, in English and in German", async ({
  page
}) => {
  await signIn(page);
  await page.goto("/settings/instance/infrastructure");

  await expect(page.getByRole("heading", { name: "Infrastructure", level: 1 })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Settings pages" })
      .getByRole("button", { name: "Infrastructure" })
  ).toBeVisible();
  // The database and every configured provider have a row, grouped by what they are.
  await expect(page.locator("[data-provider]")).toHaveCount(3);
  expect(
    await page
      .locator("[data-provider]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-provider")))
  ).toEqual(["database", "models.local", "secrets"]);
  const database = providerRow(page, "database");
  await expect(database).toContainText("postgres");
  await expect(database).toContainText("DATABASE_URL");
  await expect(database).toContainText("Set");
  const model = providerRow(page, "models.local");
  await expect(model).toContainText("local");
  await expect(model).toContainText("deterministic");
  await expect(model).toContainText("Internal");
  await expect(model).toHaveAttribute("data-origin", "operator");

  // The providers are release config: the page says so and offers nothing to change.
  const main = page.getByRole("region", { name: "Settings" });
  await expect(main.locator("[data-operator-managed]")).toContainText(
    "The operator of this instance sets these in its release config."
  );
  await expect(main.getByRole("switch")).toHaveCount(0);
  await expect(main.getByRole("checkbox")).toHaveCount(0);
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(main.getByRole("table").getByRole("button")).toHaveCount(0);

  // The instance checked its providers by itself when it started. This test starts no check:
  // the minute of "Check now" belongs to the instance, and the test below uses it.
  for (const id of ["database", "models.local", "secrets"]) {
    await expect(health(page, id)).toHaveAttribute("data-check", "ok");
    await expect(health(page, id)).toContainText("Answers");
    await expect(health(page, id)).toContainText("Checked ");
  }
  await expect(main.getByRole("button", { name: "Check now" })).toBeVisible();

  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Infrastruktur", level: 1 })).toBeVisible();
  await expect(providerRow(page, "database")).toContainText("Gesetzt");
  await expect(providerRow(page, "models.local")).toContainText("Intern");
  await expect(health(page, "database")).toContainText("Antwortet");
  await expect(health(page, "database")).toContainText("Geprüft ");
  // The region's own name is German now, so these are found on the page.
  await expect(page.locator("[data-operator-managed]")).toContainText(
    "Der Betreiber dieser Instanz legt das in der Release-Konfiguration fest."
  );
  await expect(page.getByRole("button", { name: "Jetzt prüfen" })).toBeVisible();
});

test.describe("with a provider that does not answer", () => {
  // The second API starts inside the first test's time.
  test.describe.configure({ timeout: 90_000 });
  let brokenApi: ChildProcess | undefined;

  test.beforeAll(async () => {
    // The suite's own config with one more model provider, served by a second API process.
    const brokenConfigPath = resolve(dirname(resolve(configPath)), "e2e-app-broken-provider.yaml");
    const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, brokenApiUrl);
    expect(config).toContain(localModel);
    await mkdir(dirname(brokenConfigPath), { recursive: true });
    await writeFile(brokenConfigPath, config.replace(localModel, `${localModel}${brokenModel}`));
    brokenApi = spawn(process.execPath, ["clients/demo/dist/server.js"], {
      env: {
        ...process.env,
        HOST: host,
        PORT: String(brokenApiPort),
        CLIENT_CONFIG_PATH: brokenConfigPath,
        DATABASE_URL: databaseUrl,
        CHAT_UI_ORIGIN: process.env.E2E_UI_URL ?? `http://${host}:5273`,
        BETTER_AUTH_URL: `${brokenApiUrl}/api/auth`,
        // The secret of the suite's own API: both sign the sessions of one database.
        BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
        E2E_SUPERADMIN_EMAIL: superadmin.email,
        E2E_USER_EMAIL: "e2e-user@example.test",
        // Its own values for what the config asks every API to have. No test here uses them.
        CHAT_SESSION_TOKEN_SECRET: "e2e-infrastructure-session-token-secret-24-chars",
        CHAT_SERVER_CREDENTIAL: "e2e-infrastructure-server-credential",
        SERVICE_ACCESS_TOKEN_SECRET: "e2e-infrastructure-service-access-token-secret-32",
        // The credential of the provider that does not answer. It must never reach the page.
        E2E_BROKEN_MODEL_KEY: SECRET_MARKER
      },
      stdio: "inherit"
    });
    const started = brokenApi;
    await expect
      .poll(
        async () => {
          if (started.exitCode !== null)
            throw new Error("The API with the failing provider stopped");
          try {
            return (await fetch(`${brokenApiUrl}/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 }
      )
      .toBe(200);
  });

  test.afterAll(async () => {
    if (!brokenApi || brokenApi.exitCode !== null) return;
    const exited = new Promise((done) => brokenApi?.once("exit", done));
    brokenApi.kill("SIGTERM");
    await exited;
  });

  test("the page shows which provider answers and which does not, and no secret", async ({
    page
  }) => {
    // The same interface in front of the API that runs the instance with the failing provider.
    await signIn(page, brokenApiUrl);
    await page.route(`${apiBaseUrl}/**`, (route) =>
      route.continue({ url: route.request().url().replace(apiBaseUrl, brokenApiUrl) })
    );
    await page.goto("/settings/instance/infrastructure");
    const main = page.getByRole("region", { name: "Settings" });
    await expect(page.locator("[data-provider]")).toHaveCount(4);

    const broken = providerRow(page, "models.broken");
    // What may be shown of its config: the host, the region and the name of its secret.
    await expect(broken).toContainText("openai-compatible");
    await expect(broken).toContainText("EU");
    await expect(broken).toContainText("127.0.0.1:9");
    await expect(broken).toContainText("E2E_BROKEN_MODEL_KEY");
    await expect(broken).toContainText("Set");

    // "Check now" asks every provider of this API and the time of the check moves.
    const before = await health(page, "database").getAttribute("data-checked-at");
    await main.getByRole("button", { name: "Check now" }).click();
    await expect
      .poll(async () => {
        const checkedAt = await health(page, "database").getAttribute("data-checked-at");
        return checkedAt !== null && checkedAt !== before;
      })
      .toBe(true);
    // The instance runs it once a minute: the page says from when, and the button waits.
    await expect(main.locator("[data-check-wait]")).toContainText("The next check can start at");
    await expect(main.getByRole("button", { name: "Check now" })).toBeDisabled();
    await expect(health(page, "models.broken")).toHaveAttribute("data-check", "failed");
    await expect(health(page, "models.broken")).toContainText("Does not answer");
    // A class and a sentence of the product, not what the connection reported.
    await expect(health(page, "models.broken").locator("[data-error-class]")).toHaveAttribute(
      "data-error-class",
      "unreachable"
    );
    await expect(health(page, "models.broken")).toContainText("The provider could not be reached.");
    await expect(health(page, "models.local")).toHaveAttribute("data-check", "ok");
    await expect(health(page, "models.local")).toContainText("Answers");
    await expect(health(page, "database")).toHaveAttribute("data-check", "ok");

    // Neither the page nor the answer behind it holds the credential or the connection string.
    const answer = await page.request.get(`${brokenApiUrl}/api/v1/instance/infrastructure`);
    expect(answer.ok()).toBe(true);
    for (const text of [await page.locator("body").innerText(), await answer.text()]) {
      expect(text).toContain("E2E_BROKEN_MODEL_KEY");
      expect(text).not.toContain(SECRET_MARKER);
      expect(text).not.toContain("postgres://");
      expect(text).not.toContain("agent_chat");
      expect(text).not.toContain("ECONNREFUSED");
    }

    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await expect(health(page, "models.broken")).toContainText("Antwortet nicht");
    await expect(health(page, "models.broken")).toContainText("Der Anbieter war nicht erreichbar.");
    await expect(health(page, "models.local")).toContainText("Antwortet");
    await expect(page.getByRole("button", { name: "Jetzt prüfen" })).toBeDisabled();
  });
});
