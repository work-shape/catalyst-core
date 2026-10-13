import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Studio > Connections on an instance with the module on: the rail entry, the empty list in
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

const EMPTY_EN = "No connections yet. A connection holds the access to an outside system.";
const DESCRIPTION_EN =
  "The operator of this instance sets up its connections. They cannot be changed here.";
const DESCRIPTION_DE =
  "Der Betreiber dieser Instanz richtet ihre Verbindungen ein. Hier lassen sie sich nicht ändern.";
const EMPTY_DE =
  "Noch keine Verbindungen. Eine Verbindung hält den Zugang zu einem externen System.";

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

/** The id of a user in an answer of the instance, read without trusting its shape. */
function idOf(value: unknown): string | undefined {
  const id: unknown =
    typeof value === "object" && value !== null
      ? Object.getOwnPropertyDescriptor(value, "id")?.value
      : undefined;
  return typeof id === "string" ? id : undefined;
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
test("an administrator sees Connections in Studio and grants its rights; a read grant on one Connection opens Studio, a grant to use does not", async ({
  page,
  browser,
  accessState: _accessState,
  // The test plants a release Connection, which an API that starts meanwhile would delete.
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 180_000 : 90_000);
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_records_${randomUUID().slice(0, 8)}`
  };
  // A seeded user is listed once the user has signed in and asked who they are: the member
  // first, then the admin.
  let memberId = "";
  for (const user of [member, admin]) {
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...user, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
    expect(me.ok()).toBe(true);
    if (user === member) {
      const answer: unknown = await me.json();
      memberId =
        idOf(answer) ?? idOf(Object.getOwnPropertyDescriptor(Object(answer), "user")?.value) ?? "";
      expect(memberId).not.toBe("");
    }
  }
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await memberPage.setViewportSize({ width: 1280, height: 800 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = page.getByRole("region", { name: "Studio" });
  const list = page.getByRole("list", { name: "Connections", exact: true });

  try {
    await test.step("the entry and the empty list, in English and in German", async () => {
      await page.goto("/build/connections");
      await expect(page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Kinds in Studio" })
          .getByRole("button", { name: "Connections", exact: true })
      ).toHaveAttribute("aria-current", "true");
      await expect(main.getByText(EMPTY_EN, { exact: true })).toBeVisible();
      await expect(main.getByText(DESCRIPTION_EN, { exact: true })).toBeVisible();
      // Nothing starts a Connection here yet, and it has no CLI entry.
      await expect(main.getByRole("button", { name: /^New /u })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "More actions", exact: true })).toHaveCount(0);
      await shoot(page, "connections-empty", async () => {
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          /^(Connections|Verbindungen)$/u
        );
        await expect(
          main.getByText(/^(No connections yet|Noch keine Verbindungen)\./u)
        ).toBeVisible();
      });

      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
      await page.reload();
      await expect(page.getByRole("heading", { name: "Verbindungen", level: 1 })).toBeVisible();
      await expect(main.getByText(EMPTY_DE, { exact: true })).toBeVisible();
      await expect(main.getByText(DESCRIPTION_DE, { exact: true })).toBeVisible();
      await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
    });

    await test.step("a Connection the store holds shows as a row with its chips", async () => {
      await plantConnection(connection);
      await page.reload();
      // A row says what the Connection is, not its id: the id stands on the Connection's page.
      const rowLink = page.locator(`a[href="/build/connections/${connection.name}"]`);
      const row = list.getByRole("listitem").filter({ has: rowLink });
      await expect(row).toContainText("Client records");
      await expect(row).not.toContainText(connection.name);
      // The explanation stands above the rows as it stood above the empty list.
      await expect(main.getByText(DESCRIPTION_EN, { exact: true })).toBeVisible();
      for (const chip of ["mcp", "Instance", "Enabled"]) {
        await expect(row.getByText(chip, { exact: true })).toBeVisible();
      }
      // Where it comes from is no chip: every Connection comes from release config so far.
      await expect(row).not.toContainText("Release config");
      // The row opens the Connection's page, and the list shows nothing of the definition.
      await expect(row.getByRole("link")).toHaveAttribute(
        "href",
        `/build/connections/${connection.name}`
      );
      await expect(main).not.toContainText("secret_");
      await expect(main).not.toContainText("records.example.test");
      await shoot(page, "connections-list", async () => {
        await expect(row).toBeVisible();
      });
      if (shotsDir) {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(row).toBeVisible();
        await page.screenshot({ path: join(shotsDir, "connections-list-light-en-390.png") });
        await page.setViewportSize({ width: 1280, height: 800 });
      }

      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
      await page.reload();
      const germanRow = page
        .getByRole("list", { name: "Verbindungen", exact: true })
        .getByRole("listitem")
        .filter({ has: rowLink });
      for (const chip of ["mcp", "Instanz", "Aktiv"]) {
        await expect(germanRow.getByText(chip, { exact: true })).toBeVisible();
      }
      await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
    });

    await test.step("the Access page grants the use of the Connection", async () => {
      await page.goto("/settings/instance/access");
      await page.getByRole("tab", { name: /^Rights/u }).click();
      await page.getByRole("button", { name: "New right" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New right" });
      await dialog.getByRole("button", { name: /^Person/u }).click();
      await page.getByRole("option", { name: /E2E Connections/u }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await dialog.getByRole("radio", { name: "Connections", exact: true }).check();
      // A Connection is read or used through a grant; writing and deleting stay with the role.
      await expect(dialog.getByLabel("Read", { exact: true })).toBeVisible();
      await expect(dialog.getByLabel("Write", { exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel("Delete", { exact: true })).toHaveCount(0);
      // The three places a Connection right is written at. The form opens on the Namespace.
      await expect(dialog.getByRole("radio", { name: /^In a Namespace/u })).toBeChecked();
      await expect(dialog.getByRole("radio", { name: /^In a shared workspace/u })).toBeVisible();
      await dialog.getByRole("radio", { name: /^On one connection/u }).check();
      // Each action says what it allows.
      await expect(
        dialog.getByText("See the connection and its status in Studio. Never its credentials.", {
          exact: true
        })
      ).toBeVisible();
      await expect(
        dialog.getByText(
          "Let agents this person builds or runs call the outside system through it.",
          { exact: true }
        )
      ).toBeVisible();
      await dialog.getByLabel("Use", { exact: true }).check();
      // The Connection is chosen by its name, with its id under it.
      await dialog.getByRole("button", { name: /^Connection/u }).click();
      const option = page.getByRole("option", { name: /^Client records/u });
      await expect(option).toContainText(connection.name);
      await option.click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /^Connection/u })).toContainText(
        "Client records"
      );
      if (shotsDir) {
        await mkdir(shotsDir, { recursive: true });
        await page.screenshot({ path: join(shotsDir, "connections-grant-light-en-1280.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(shotsDir, "connections-grant-light-en-390.png") });
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      await dialog.getByRole("button", { name: "Create right" }).click();
      await expect(dialog).toBeHidden();

      const grantRow = page.getByTestId("grant-row").filter({ hasText: connection.name });
      await expect(grantRow).toContainText("E2E Connections");
      await expect(grantRow).toContainText(`Connection ${connection.name}`);
      await expect(grantRow.locator('[data-effect="allow"]')).toHaveText("Use connections");
    });

    await test.step("the Check tab answers for the Connection, with using it as an action of its own", async () => {
      const rowOf = (verb: string) =>
        page.locator(`[data-testid="check-row"][data-verb="${verb}"]`);
      /** Asks the tab what the member may do with the Connection. */
      const ask = async () => {
        await page.getByRole("tab", { name: /^(Check|Prüfen)$/u }).click();
        const check = page.getByRole("tabpanel", { name: /^(Check|Prüfen)$/u });
        await check.getByRole("button", { name: /^Person/u }).click();
        await page.getByRole("option", { name: /E2E Connections/u }).click();
        await expect(page.getByRole("listbox")).toHaveCount(0);
        // The kinds are the instance's registry: a Connection is among them with its module on.
        await check.getByRole("combobox", { name: /^(Kind|Art)$/u }).selectOption("connection");
        await check
          .getByRole("button", { name: /^(Pick an existing asset|Vorhandenes Asset wählen)$/u })
          .click();
        await page.getByRole("option", { name: connection.name, exact: true }).click();
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await expect(rowOf("use")).toBeVisible();
      };
      await ask();
      // The member holds the right to use this one Connection, and nothing else on it.
      await expect(rowOf("use")).toContainText("Use");
      await expect(rowOf("use")).toContainText("Allowed");
      await expect(rowOf("use")).toContainText("Given right");
      await expect(rowOf("use")).toContainText("Right on this asset");
      for (const verb of ["read", "write", "delete"]) {
        await expect(rowOf(verb)).toContainText("Refused");
        await expect(rowOf(verb)).toContainText("No right");
      }
      await expect(page.getByTestId("check-row")).toHaveCount(4);
      // The same name asked as an agent has no action to use, and no right at all.
      const check = page.getByRole("tabpanel", { name: "Check" });
      await check.getByRole("combobox", { name: "Kind" }).selectOption("agent");
      await check.getByRole("textbox").fill(connection.name);
      await expect(page.getByTestId("check-row")).toHaveCount(3);
      await expect(rowOf("use")).toHaveCount(0);
      await expect(rowOf("read")).toContainText("No right");

      if (shotsDir) {
        await mkdir(shotsDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(
            (value) => window.localStorage.setItem("vivd-catalyst:theme", value),
            theme
          );
          await page.reload();
          await ask();
          await page.screenshot({
            path: join(shotsDir, `access-check-connection-${theme}-en-1440.png`)
          });
        }
        await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:theme"));
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.reload();
      }
    });

    await test.step("a grant to use the Connection gives its holder no Studio entry", async () => {
      const signedIn = await requestWithOrigin(
        memberPage,
        "post",
        `${apiBaseUrl}/api/auth/sign-in/email`,
        { data: { ...member, rememberMe: true } }
      );
      expect(signedIn.ok()).toBe(true);
      await memberPage.goto("/");
      await expect(memberPage.getByPlaceholder("Message")).toBeVisible();
      await expect(memberPage.getByRole("button", { name: "Studio", exact: true })).toHaveCount(0);
      await memberPage.goto("/build/connections");
      await expect(memberPage.getByRole("region", { name: "Studio" })).toContainText(
        "Studio is not available to you."
      );
    });

    await test.step("a read grant on the one Connection shows Connections with it", async () => {
      const granted = await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/instance/access/grants`,
        {
          data: {
            holderKind: "user",
            holderId: memberId,
            action: "connection.read",
            scopeKind: "asset",
            scopeId: connection.id
          }
        }
      );
      expect(granted.ok()).toBe(true);
      await memberPage.goto("/");
      await memberPage.getByRole("button", { name: "Studio", exact: true }).click();
      await expect(memberPage).toHaveURL(/\/build\/connections$/u);
      await expect(
        memberPage.getByRole("heading", { name: "Connections", level: 1 })
      ).toBeVisible();
      // Connections is the only kind this person has a list of: no rail names another.
      await expect(memberPage.getByRole("navigation", { name: "Kinds in Studio" })).toHaveCount(0);
      const rows = memberPage
        .getByRole("list", { name: "Connections", exact: true })
        .getByRole("listitem");
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText("Client records");
      // The row is this Connection's: it leads to its page. Its id is not in the row.
      await expect(rows.getByRole("link")).toHaveAttribute(
        "href",
        `/build/connections/${connection.name}`
      );
      const memberMain = memberPage.getByRole("region", { name: "Studio" });
      await expect(memberMain.getByRole("button", { name: /^New /u })).toHaveCount(0);
      await expect(memberMain).not.toContainText("secret_");
      await expect(memberMain).not.toContainText("records.example.test");
      if (shotsDir) {
        await memberPage.screenshot({
          path: join(shotsDir, "connections-read-grant-light-en-1280.png")
        });
      }
    });
  } finally {
    await memberContext.close();
    await removeConnection(connection.id);
  }
});
