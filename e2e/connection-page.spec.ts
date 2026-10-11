import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import type { PlantedConnectionAnswers } from "@vivd-catalyst/chat-ui/build-area";
import {
  connectionDetail,
  FIXTURE_SECRET_HANDLE,
  plantedTest,
  recordedStates,
  testResult
} from "../tests/chat-ui-connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The page of one Connection, `/build/connections/<name>`. The Connection is a real asset of
// the instance, planted in the store as the release seed writes it. What the page reads beyond
// the asset (`connections.get`) and the test (`connections.test`) the instance does not answer
// yet: the spec plants those answers where the interface asks for them, the same ones the unit
// test hands the page. When the instance answers them, the planting leaves and the two steps
// that test (`ready`, then `network_denied` once the host has left `egress.allow`) read the
// instance.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl = `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const clientInstanceId = "demo-e2e";
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of every state of the page. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const widths = { 1280: 800, 1024: 768, 390: 844 } as const;
type Width = keyof typeof widths;

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/** Writes one Connection as the store holds it: the asset and its first revision. */
async function plantConnection(connection: { id: string; name: string }): Promise<void> {
  const revisionId = `cfgr_${randomUUID()}`;
  const config = {
    name: connection.name,
    displayName: "Sample business",
    description: "Revenue, customers and orders of the sample business.",
    connectorType: "mcp",
    ownerPrincipalId: "system",
    settings: { url: "https://sample-business.example.test/mcp", timeoutSeconds: 20 },
    authScheme: "bearer",
    credentialMode: "shared",
    // A reference to a credential in the Secret Store. It is no credential.
    secretHandle: FIXTURE_SECRET_HANDLE,
    operations: [
      { name: "revenue_by_month", effect: "reading", exposure: ["agent"], enabled: true }
    ],
    enabled: true,
    origin: "release"
  };
  await withSql((sql) =>
    sql.begin(async (tx) => {
      const [state] = await tx<{ version: string }[]>`
        update config_asset_state set version = version + 1, updated_at = now()
        where client_instance_id = ${clientInstanceId}
        returning version`;
      if (!state) {
        throw new Error("The instance has no config asset state");
      }
      await tx`
        insert into config_assets
          (id, client_instance_id, kind, name, scope_kind, status, active_revision_id,
           created_at, updated_at)
        values
          (${connection.id}, ${clientInstanceId}, 'connection', ${connection.name}, 'instance',
           'active', ${revisionId}, now(), now())`;
      await tx`
        insert into config_asset_revisions
          (id, client_instance_id, asset_id, revision, operation, config, global_version,
           created_at)
        values
          (${revisionId}, ${clientInstanceId}, ${connection.id}, 1, 'create',
           ${tx.json(config)}, ${state.version}, now())`;
    })
  );
}

async function removeConnection(assetId: string): Promise<void> {
  await withSql((sql) => sql`delete from config_assets where id = ${assetId}`);
}

/** Hands the interface the answers of the two calls, from the next load of the page on. */
async function plant(page: Page, answers: PlantedConnectionAnswers): Promise<void> {
  await page.addInitScript((planted) => {
    window.catalystPlantedConnections = planted;
  }, answers);
}

async function setView(
  page: Page,
  view: { locale?: "en" | "de"; theme?: "light" | "dark" }
): Promise<void> {
  await page.evaluate(({ locale, theme }) => {
    for (const [key, value] of [
      ["vivd-catalyst:locale", locale],
      ["vivd-catalyst:theme", theme]
    ] as const) {
      if (value === undefined) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    }
  }, view);
}

// The test plants a Connection: it takes its turn with the spec that asserts the empty list.
test("a Connection's page shows its definition, its state in every case and the test, and writes nothing", async ({
  page,
  accessState: _accessState
}) => {
  test.setTimeout(shotsDir ? 420_000 : 150_000);
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_sample_${randomUUID().slice(0, 8)}`
  };
  const address = `/build/connections/${connection.name}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: widths[1280] });
  const main = page.getByRole("region", { name: /^(Build|Bauen)$/u });
  const health = main.locator("[data-connection-health]");
  // The one button of the Status section. While a test runs it shows a spinner and no name.
  const testButton = main.locator("#status").getByRole("button");
  const heading = page.getByRole("heading", { name: "Sample business", level: 1 });

  /** The page with the given answers, in the given language. */
  const open = async (
    answers: PlantedConnectionAnswers,
    view: { locale?: "en" | "de"; theme?: "light" | "dark" } = {}
  ) => {
    await plant(page, answers);
    await setView(page, view);
    await page.goto(address);
    await expect(heading).toBeVisible();
  };

  /** Pictures of what the page shows now. `full` takes every width, language and theme. */
  const shoot = async (name: string, answers: PlantedConnectionAnswers, full = false) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    const views: [Width, "en" | "de", "light" | "dark"][] = full
      ? [1280, 1024, 390].flatMap((width) =>
          (["en", "de"] as const).flatMap((locale) =>
            (["light", "dark"] as const).map((theme): [Width, "en" | "de", "light" | "dark"] => [
              width === 1280 ? 1280 : width === 1024 ? 1024 : 390,
              locale,
              theme
            ])
          )
        )
      : [
          [1280, "en", "light"],
          [390, "de", "dark"]
        ];
    for (const [width, locale, theme] of views) {
      await page.setViewportSize({ width, height: widths[width] });
      await open(answers, { locale, theme });
      await expect(health.or(main.getByRole("alert"))).toBeVisible();
      await page.screenshot({
        path: join(shotsDir, `connection-${name}-${theme}-${locale}-${width}.png`)
      });
    }
    if (full) {
      // The whole page in one picture, for the sections below the fold.
      await page.setViewportSize({ width: 1280, height: 1700 });
      await open(answers, { locale: "en", theme: "light" });
      await expect(health).toBeVisible();
      await page.screenshot({ path: join(shotsDir, `connection-${name}-whole-light-en-1280.png`) });
      await page.setViewportSize({ width: 390, height: 2600 });
      await open(answers, { locale: "de", theme: "light" });
      await expect(health).toBeVisible();
      await page.screenshot({ path: join(shotsDir, `connection-${name}-whole-light-de-390.png`) });
    }
    await page.setViewportSize({ width: 1280, height: widths[1280] });
    await setView(page, {});
  };

  try {
    await plantConnection(connection);
    const neverTested: PlantedConnectionAnswers = { detail: connectionDetail(connection.name) };

    await test.step("a row of the list opens the page: header, settings, and nothing to edit", async () => {
      await plant(page, neverTested);
      await page.goto("/build/connections");
      await page
        .getByRole("list", { name: "Connections", exact: true })
        .getByRole("link", { name: /Sample business/u })
        .click();
      await expect(page).toHaveURL(new RegExp(`${address}$`, "u"));
      await expect(heading).toBeVisible();
      await expect(main.getByText("Defined in release config", { exact: true })).toBeVisible();
      await expect(main.getByText("Instance", { exact: true })).toBeVisible();
      await expect(main.getByText(connection.name, { exact: true })).toBeVisible();
      await expect(main.getByText("https://sample-business.example.test/mcp")).toBeVisible();
      await expect(main.getByText("Set, version 2", { exact: true })).toBeVisible();
      await expect(main.getByText("One shared account", { exact: true })).toBeVisible();
      // The page writes nothing and shows nothing of the credential, not even its handle.
      await expect(main.getByRole("textbox")).toHaveCount(0);
      await expect(main.getByRole("button", { name: /^(History|Save|More actions)/u })).toHaveCount(
        0
      );
      await expect(main).not.toContainText("secret_");
      // The operations and the agents that carry them.
      const operation = main.locator('[data-connection-operation="update_customer"]');
      await expect(operation).toContainText("Changing");
      await expect(operation).toContainText("Nobody can call it");
      await expect(operation).toContainText("Needs review");
      await expect(
        main
          .getByRole("list", { name: "Used by" })
          .getByRole("link", { name: /Workflow Assistant/u })
      ).toHaveAttribute("href", "/build/agents/workflow_assistant");
      // The way back is the list.
      await main.getByRole("button", { name: "Back to Connections" }).click();
      await expect(page).toHaveURL(/\/build\/connections$/u);
    });

    await test.step("a Connection nobody tested says so; the test runs and answers ready", async () => {
      await open({
        ...plantedTest(connection.name, "ready", recordedStates.ready),
        testDelayMs: 1500
      });
      await expect(health).toHaveAttribute("data-connection-health", "never_tested");
      await expect(health).toContainText("This connection has not been tested yet.");
      await testButton.click();
      await expect(health).toHaveAttribute("data-connection-health", "testing");
      await expect(health).toContainText("The instance is asking the outside system.");
      await expect(testButton).toBeDisabled();
      await expect(health).toHaveAttribute("data-connection-health", "ready");
      await expect(health).toContainText("The outside system answered the test.");
      await expect(health).toContainText("Last tested ");
      await expect(testButton).toHaveText("Test connection");
    });

    await test.step("a test the egress list refuses answers network denied", async () => {
      await open(plantedTest(connection.name, "network_denied", recordedStates.networkDenied));
      await testButton.click();
      await expect(health).toHaveAttribute("data-connection-health", "network_denied");
      await expect(health).toContainText(
        "The instance may not reach this address. Its host is not in the list of allowed outside addresses in release config (egress.allow)."
      );
      // What the test found is what the instance recorded: the page says it again after a reload.
      await open({ detail: connectionDetail(connection.name, recordedStates.networkDenied) });
      await expect(health).toHaveAttribute("data-connection-health", "network_denied");
    });

    await test.step("unauthorized and unavailable, each with its sentence", async () => {
      await open(plantedTest(connection.name, "unauthorized", recordedStates.unauthorized));
      await testButton.click();
      await expect(health).toContainText("The outside system refused the credential.");
      await open(plantedTest(connection.name, "unavailable", recordedStates.unavailable));
      await testButton.click();
      await expect(health).toContainText("The outside system did not answer the test.");
    });

    await test.step("a missing and an unreadable credential", async () => {
      await open({ detail: connectionDetail(connection.name, recordedStates.notConfigured) });
      await expect(health).toHaveAttribute("data-connection-health", "not_configured");
      await expect(health).toContainText("The credential of this connection is missing.");
      await expect(main.getByText("Not set", { exact: true })).toBeVisible();
      await open({ detail: connectionDetail(connection.name, recordedStates.secretUnreadable) });
      await expect(health).toHaveAttribute("data-connection-health", "secret_unreadable");
      await expect(health).toContainText("the instance cannot read it");
      await expect(main.getByText("Unreadable", { exact: true })).toBeVisible();
    });

    await test.step("the main states in German", async () => {
      await open(
        { ...plantedTest(connection.name, "network_denied", recordedStates.networkDenied) },
        { locale: "de" }
      );
      await expect(
        main.getByText("In Release-Konfiguration definiert", { exact: true })
      ).toBeVisible();
      await expect(health).toContainText("Diese Verbindung wurde noch nicht getestet.");
      await testButton.click();
      await expect(health).toContainText("Die Instanz darf diese Adresse nicht erreichen.");
      await open(
        { detail: connectionDetail(connection.name, recordedStates.ready) },
        { locale: "de" }
      );
      await expect(health).toContainText("Das externe System hat auf den Test geantwortet.");
      await setView(page, {});
    });

    await test.step("a refused test says so, and a state that cannot be read offers a retry", async () => {
      await open({ ...neverTested, test: "FORBIDDEN" });
      await testButton.click();
      await expect(
        main.getByText("You may not test this connection. You can read it.", { exact: true })
      ).toBeVisible();
      await open({ detail: "INTERNAL" });
      await expect(main.getByRole("alert")).toBeVisible();
      await expect(main.getByRole("button", { name: "Try again" })).toBeVisible();
      // The definition is still on the page; what was not read is not shown as empty.
      await expect(main.getByText("https://sample-business.example.test/mcp")).toBeVisible();
      await expect(health).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Test connection" })).toHaveCount(0);
    });

    await test.step("a person who may read and not test sees the state and no button", async () => {
      // The instance names what the reader holds on Connections as a whole. Here it is answered
      // without the right that tests one.
      await page.route("**/api/v1/context", async (route) => {
        const response = await route.fetch();
        const body: unknown = await response.json();
        const actions: unknown =
          typeof body === "object" && body !== null && "actions" in body ? body.actions : [];
        await route.fulfill({
          response,
          json: {
            ...Object(body),
            actions: Array.isArray(actions)
              ? actions.filter((action) => action !== "connection.write")
              : []
          }
        });
      });
      const answers = { detail: connectionDetail(connection.name, recordedStates.ready) };
      await open(answers);
      await expect(health).toHaveAttribute("data-connection-health", "ready");
      await expect(testButton).toHaveCount(0);
      await expect(
        main.getByText(
          "You can read this connection. Testing it needs the right to change connections on the instance.",
          { exact: true }
        )
      ).toBeVisible();
      await shoot("read-not-test", answers);
      await page.unroute("**/api/v1/context");
    });

    await test.step("pictures of every state", async () => {
      if (!shotsDir) return;
      await shoot("never-tested", neverTested, true);
      await shoot(
        "ready",
        { detail: connectionDetail(connection.name, recordedStates.ready) },
        true
      );
      for (const [name, recorded] of [
        ["unauthorized", recordedStates.unauthorized],
        ["network-denied", recordedStates.networkDenied],
        ["unavailable", recordedStates.unavailable],
        ["not-configured", recordedStates.notConfigured],
        ["secret-unreadable", recordedStates.secretUnreadable]
      ] as const) {
        await shoot(name, { detail: connectionDetail(connection.name, recorded) });
      }
      await shoot("status-unreadable", { detail: "INTERNAL" });
      // A running test, held long enough for the picture.
      for (const [width, locale, theme] of [
        [1280, "en", "light"],
        [390, "de", "dark"]
      ] as const) {
        await page.setViewportSize({ width, height: widths[width] });
        await open(
          { ...neverTested, test: testResult("ready"), testDelayMs: 4000 },
          { locale, theme }
        );
        await testButton.click();
        await expect(health).toHaveAttribute("data-connection-health", "testing");
        await page.screenshot({
          path: join(shotsDir, `connection-testing-${theme}-${locale}-${width}.png`)
        });
        await expect(health).toHaveAttribute("data-connection-health", "ready");
      }
      await page.setViewportSize({ width: 1280, height: widths[1280] });
      await setView(page, {});
    });
  } finally {
    await removeConnection(connection.id);
  }
});
