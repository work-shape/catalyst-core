import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Studio > Connections on an instance with the module on: the rail entry, the empty list in
// both languages, a row with its chips, and the grant of a Connection right on the Access page.
// The row is planted in the store as the release seed writes it; making one in Build is
// `connection-editor.spec.ts`.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const clientInstanceId = "demo-e2e";
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** The member the grant is written for. No other spec uses this member. */
const member = { email: "e2e-connections@example.test", password: "e2e-connections-password" };
/** Set to a directory to keep pictures of the list in both languages and both themes. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const EMPTY_EN = "No connections yet. A connection holds the access to an outside system.";
const DESCRIPTION_EN =
  "Connections give agents, apps and workflows access to outside systems. Those that come with the instance's setup are read-only here.";
const DESCRIPTION_DE =
  "Verbindungen geben Agenten, Apps und Workflows Zugang zu externen Systemen. Die aus der Einrichtung der Instanz sind hier schreibgeschützt.";
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
  let adminId = "";
  for (const user of [member, admin]) {
    const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...user, rememberMe: true }
    });
    expect(signedIn.ok()).toBe(true);
    const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
    expect(me.ok()).toBe(true);
    const answer: unknown = await me.json();
    const id =
      idOf(answer) ?? idOf(Object.getOwnPropertyDescriptor(Object(answer), "user")?.value) ?? "";
    expect(id).not.toBe("");
    if (user === member) memberId = id;
    else adminId = id;
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
      // The administrator starts a Connection here. The CLI writes none yet: no CLI entry.
      await expect(main.getByRole("button", { name: "New connection" }).first()).toBeVisible();
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
      // A row says what the Connection is, not its id: "Copy ID" on its page offers the id.
      const rowLink = page.locator(`a[href="/build/connections/${connection.name}"]`);
      const row = list.getByRole("listitem").filter({ has: rowLink });
      await expect(row).toContainText("Client records");
      await expect(row).not.toContainText(connection.name);
      // The explanation stands above the rows as it stood above the empty list.
      await expect(main.getByText(DESCRIPTION_EN, { exact: true })).toBeVisible();
      // An enabled Connection says how it is (CONN-PAGE 6): this one was never tested.
      for (const chip of ["MCP server", "Not tested"]) {
        await expect(row.getByText(chip, { exact: true })).toBeVisible();
      }
      // One chip says whose a row is, and only a workspace's: an instance Connection has none.
      await expect(row.getByText("Instance", { exact: true })).toHaveCount(0);
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
      for (const chip of ["MCP-Server", "Nicht getestet"]) {
        await expect(germanRow.getByText(chip, { exact: true })).toBeVisible();
      }
      await expect(germanRow.getByText("Instanz", { exact: true })).toHaveCount(0);
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
      // A Connection is read or used through a grant, each a level; writing and deleting stay
      // with the role. Using calls the outside system with its credentials, so View comes first
      // and never brings Use.
      const levels = dialog.getByRole("radiogroup", { name: "Level", exact: true });
      await expect(levels.getByRole("radio")).toHaveCount(2);
      await expect(levels.getByRole("radio").nth(0)).toHaveAccessibleName("View");
      await expect(levels.getByRole("radio").nth(1)).toHaveAccessibleName("Use");
      // A new Connection right is on one Connection or on the whole instance (RIGHTS-1c, D3):
      // no workspace owns a Connection.
      const where = dialog.getByRole("radiogroup", { name: "Where" });
      await expect(where.getByRole("radio")).toHaveCount(2);
      await expect(where.getByRole("radio", { name: /^Whole instance/u })).toBeVisible();
      await expect(dialog.getByRole("radio", { name: /shared workspace/u })).toHaveCount(0);
      await where.getByRole("radio", { name: /^On one connection/u }).check();
      // Each level says what it allows, and which levels it brings with it.
      await expect(
        dialog.getByText("See the connection and its status in Studio. Never its credentials.", {
          exact: true
        })
      ).toBeVisible();
      await expect(
        dialog.getByText(
          "Let agents this person builds or runs call the outside system through it. Includes view.",
          { exact: true }
        )
      ).toBeVisible();
      await levels.getByRole("radio", { name: "Use", exact: true }).check();
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

      // The row names the Connection by its title, never by its id.
      const grantRow = page.getByTestId("grant-row").filter({ hasText: "E2E Connections" });
      await expect(grantRow.locator('[data-effect="allow"]')).toHaveText(
        "may view and use the connection Client records"
      );
      await expect(grantRow).not.toContainText(connection.name);
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
        // The Connection is picked by the title the rows name it by.
        await check.getByRole("button", { name: /^Asset: /u }).click();
        await page.getByRole("option", { name: /^Client records/u }).click();
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await expect(rowOf("use")).toBeVisible();
      };
      await ask();
      // The member holds the rights to view and use this one Connection, and nothing else on it.
      await expect(rowOf("use")).toContainText("Use");
      await expect(rowOf("use")).toContainText("Allowed");
      await expect(rowOf("use")).toContainText("Given right");
      await expect(rowOf("use")).toContainText("Right on this asset");
      await expect(rowOf("read")).toContainText("Allowed");
      for (const verb of ["write", "delete"]) {
        await expect(rowOf(verb)).toContainText("Refused");
        await expect(rowOf(verb)).toContainText("No right");
      }
      await expect(page.getByTestId("check-row")).toHaveCount(4);
      // An asset belongs to its kind: another kind asks for an asset of its own again.
      const check = page.getByRole("tabpanel", { name: "Check" });
      await check.getByRole("combobox", { name: "Kind" }).selectOption("agent");
      await expect(page.getByTestId("check-row")).toHaveCount(0);
      await expect(check.getByRole("button", { name: "Asset: Choose an asset" })).toBeVisible();

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
      // The level Use brought View with it; its row is taken back, so the member holds Use alone.
      const listed = await page.request.get(
        `${apiBaseUrl}/api/v1/instance/access/grants?holderKind=user&holderId=${memberId}&action=connection.read`
      );
      expect(listed.ok()).toBe(true);
      const readRows: { items: { id: string }[] } = await listed.json();
      expect(readRows.items).toHaveLength(1);
      const revoked = await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${readRows.items[0]?.id ?? ""}`
      );
      expect(revoked.ok()).toBe(true);
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

    await test.step("a Connection right written on a workspace before NS-0 is named, refused anew and revoked", async () => {
      const workspace = { id: `cw_${randomUUID()}`, name: "Records team" };
      const grantId = `grant_${randomUUID()}`;
      try {
        await withSql(async (sql) => {
          await sql`
            insert into collaboration_workspaces
              (id, client_instance_id, kind, name, visibility, created_at, updated_at)
            values
              (${workspace.id}, ${clientInstanceId}, 'shared', ${workspace.name}, 'private',
               now(), now())`;
          // As the grant operation wrote it before NS-0.
          await sql`
            insert into permission_grants
              (id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id,
               effect, granted_by)
            values
              (${grantId}, ${clientInstanceId}, 'user', ${memberId}, 'connection.use',
               'workspace', ${workspace.id}, 'allow', ${adminId})`;
        });
        // A new one is refused: no workspace owns a Connection.
        const refused = await requestWithOrigin(
          page,
          "post",
          `${apiBaseUrl}/api/v1/instance/access/grants`,
          {
            data: {
              holderKind: "user",
              holderId: memberId,
              action: "connection.read",
              scopeKind: "workspace",
              scopeId: workspace.id
            }
          }
        );
        expect(refused.status()).toBe(422);
        expect(JSON.stringify(await refused.json())).toContain("invalid_scope");

        // The row is listed under the workspace's name, though no new right offers a workspace.
        await page.goto("/settings/instance/access");
        await page.getByRole("tab", { name: /^Rights/u }).click();
        const row = page
          .getByTestId("grant-row")
          .filter({ hasText: `connections in ${workspace.name}` });
        await expect(row).toContainText(`may use connections in ${workspace.name}`);
        await expect(row).not.toContainText(workspace.id);
        await row.getByRole("button", { name: /^Actions for the right of/u }).click();
        await page.getByRole("menuitem", { name: /^Revoke: Use connections/u }).click();
        const revokeDialog = page.getByRole("dialog", { name: "Revoke this right?" });
        await expect(revokeDialog).toContainText(workspace.name);
        await expect(revokeDialog).not.toContainText(workspace.id);
        await revokeDialog.getByRole("button", { name: "Revoke" }).click();
        await expect(revokeDialog).toHaveCount(0);
        await expect(row).toHaveCount(0);
        expect(
          await withSql((sql) => sql`select 1 from permission_grants where id = ${grantId}`)
        ).toHaveLength(0);
      } finally {
        await withSql(async (sql) => {
          await sql`delete from permission_grants where id = ${grantId}`;
          await sql`delete from collaboration_workspaces where id = ${workspace.id}`;
        });
      }
    });
  } finally {
    await memberContext.close();
    await removeConnection(connection.id);
  }
});
