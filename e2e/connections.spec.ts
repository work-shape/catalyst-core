import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Build > Connections on an instance with the module on: the rail entry, the empty list in
// both languages, a row with its chips, and the grant of a Connection right on the Access page.
// No operation writes a Connection yet, so the row is planted in the store, as the release
// seed will write it.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl = `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const clientInstanceId = "demo-e2e";
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** The member the grant is written for. No other spec uses this member. */
const member = { email: "e2e-connections@example.test", password: "e2e-connections-password" };
/** Set to a directory to keep pictures of the list in both languages and both themes. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const EMPTY_EN =
  "No connections. A connection holds the access to an outside system; agents, apps and workflows use it.";
const EMPTY_DE =
  "Keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System; Agenten, Apps und Workflows nutzen sie.";

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
    displayName: "Client records",
    description: "The client records of the outside system.",
    connectorType: "mcp",
    ownerPrincipalId: "system",
    settings: { url: "https://records.example.test/mcp" },
    authScheme: "bearer",
    credentialMode: "shared",
    // A reference to a credential in the Secret Store. It is no credential.
    secretHandle: `secret_${randomUUID()}`,
    operations: [{ name: "list_clients", effect: "reading", exposure: ["agent"], enabled: true }],
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
  await withSql(async (sql) => {
    await sql`delete from permission_grants where scope_id = ${assetId}`;
    await sql`delete from config_assets where id = ${assetId}`;
  });
}

/** The same view in both languages and both themes, 1280 wide. */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const locale of ["en", "de"] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        ([localeValue, themeValue]) => {
          window.localStorage.setItem("vivd-catalyst:locale", localeValue);
          window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        },
        [locale, theme] as const
      );
      await page.reload();
      await ready();
      await page.screenshot({ path: join(shotsDir, `${name}-${theme}-${locale}-1280.png`) });
    }
  }
  await page.evaluate(() => {
    window.localStorage.removeItem("vivd-catalyst:locale");
    window.localStorage.removeItem("vivd-catalyst:theme");
  });
  await page.reload();
  await ready();
}

// The test writes a grant: it takes its turn with the other tests that write or count grants.
test("an administrator sees Connections in Build, a planted Connection with its chips, and grants its use", async ({
  page,
  accessState: _accessState
}) => {
  test.setTimeout(shotsDir ? 180_000 : 90_000);
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_records_${randomUUID().slice(0, 8)}`
  };
  // A seeded user is listed once the user has signed in and asked who they are: the member
  // first, then the admin.
  for (const user of [member, admin]) {
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...user, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    expect((await page.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = page.getByRole("region", { name: /^(Build|Bauen)$/u });
  const list = page.getByRole("list", { name: "Connections", exact: true });

  try {
    await test.step("the entry and the empty list, in English and in German", async () => {
      await page.goto("/build/connections");
      await expect(page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Kinds in Build" })
          .getByRole("button", { name: "Connections", exact: true })
      ).toHaveAttribute("aria-current", "true");
      await expect(main.getByText(EMPTY_EN, { exact: true })).toBeVisible();
      // Nothing starts a Connection here yet, and it has no CLI entry.
      await expect(main.getByRole("button", { name: /^New /u })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "More actions", exact: true })).toHaveCount(0);
      await shoot(page, "connections-empty", async () => {
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          /^(Connections|Verbindungen)$/u
        );
        await expect(main.getByText(/^(No connections|Keine Verbindungen)\./u)).toBeVisible();
      });

      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
      await page.reload();
      await expect(page.getByRole("heading", { name: "Verbindungen", level: 1 })).toBeVisible();
      await expect(main.getByText(EMPTY_DE, { exact: true })).toBeVisible();
      await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
    });

    await test.step("a Connection the store holds shows as a row with its chips", async () => {
      await plantConnection(connection);
      await page.reload();
      const row = list.getByRole("listitem").filter({ hasText: connection.name });
      await expect(row).toContainText("Client records");
      for (const chip of ["mcp", "Instance", "Release config", "Enabled"]) {
        await expect(row.getByText(chip, { exact: true })).toBeVisible();
      }
      // The row opens nothing, and the page shows nothing of the definition.
      await expect(list.getByRole("link")).toHaveCount(0);
      await expect(main).not.toContainText("secret_");
      await expect(main).not.toContainText("records.example.test");
      await shoot(page, "connections-list", async () => {
        await expect(page.getByText(connection.name, { exact: true })).toBeVisible();
      });

      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
      await page.reload();
      const germanRow = page
        .getByRole("list", { name: "Verbindungen", exact: true })
        .getByRole("listitem")
        .filter({ hasText: connection.name });
      for (const chip of ["mcp", "Instanz", "Release-Konfiguration", "Aktiv"]) {
        await expect(germanRow.getByText(chip, { exact: true })).toBeVisible();
      }
      await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
    });

    await test.step("the Access page grants the use of the Connection", async () => {
      await page.goto("/settings/instance/access");
      await page.getByRole("tab", { name: /^Grants/u }).click();
      await page.getByRole("button", { name: "New grant" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New grant" });
      await dialog.getByRole("button", { name: /^Person/u }).click();
      await page.getByRole("option", { name: /E2E Connections/u }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await dialog.getByRole("radio", { name: "Connections", exact: true }).check();
      // A Connection is read or used through a grant; writing and deleting stay with the role.
      await expect(dialog.getByLabel("Read", { exact: true })).toBeVisible();
      await expect(dialog.getByLabel("Write", { exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel("Delete", { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("radio", { name: /^In a Namespace/u })).toHaveCount(0);
      await expect(dialog.getByRole("radio", { name: /^In a shared workspace/u })).toBeVisible();
      await expect(dialog.getByRole("radio", { name: /^On one connection/u })).toBeChecked();
      await dialog.getByLabel("Use", { exact: true }).check();
      await dialog.getByRole("button", { name: /^Connection/u }).click();
      await page.getByRole("option", { name: new RegExp(connection.name, "u") }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      if (shotsDir) {
        await mkdir(shotsDir, { recursive: true });
        await page.screenshot({ path: join(shotsDir, "connections-grant-light-en-1280.png") });
      }
      await dialog.getByRole("button", { name: "Create grant" }).click();
      await expect(dialog).toBeHidden();

      const grantRow = page.getByTestId("grant-row").filter({ hasText: connection.name });
      await expect(grantRow).toContainText("E2E Connections");
      await expect(grantRow).toContainText(`Connection ${connection.name}`);
      await expect(grantRow.locator('[data-effect="allow"]')).toHaveText("Use connections");
    });
  } finally {
    await removeConnection(connection.id);
  }
});
