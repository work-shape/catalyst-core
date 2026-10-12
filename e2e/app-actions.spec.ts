import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// A tile of a published App reads rows through a named action: the frame asks the interface,
// the interface calls the instance with the session of whoever looks, and the instance runs
// the Connection's operation as one Operation Run with the origin `app`. A member who may use
// the App and not the Connection is told so by the platform, in their language, with no button
// to try again, and reads the rows once the right is granted. Fails without S3-42: a frame
// could make no call, and kit 1.1.0, which brings `actions.call`, did not exist. Fails without
// its fix round: the App worded the refusal itself, in English only, and kept its button.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The two people of this spec, from `tests/fixtures/e2e-app.yaml`. */
const admin = { email: "e2e-app-actions@example.test", password: "e2e-app-actions-password" };
const member = {
  email: "e2e-app-actions-member@example.test",
  password: "e2e-app-actions-member-password"
};

const host = process.env.E2E_HOST ?? "127.0.0.1";
const databaseUrl = `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const clientInstanceId = "demo-e2e";
/** The one address the suite's release config lets a Connection reach. Nothing listens there. */
const ALLOWED_URL = "https://127.0.0.1:8443/";
const ROWS = ["Alster Papier", "Hansa Kontor", "Nordwind Gastro"];

const idSchema = z.object({ id: z.string() });
const runsSchema = z.object({
  items: z.array(
    z.looseObject({
      operation: z.string(),
      status: z.string(),
      actor: z.looseObject({ id: z.string() }),
      origin: z.looseObject({ kind: z.string() })
    })
  )
});

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Writes one Connection of the suite's type `test` as the store holds it. Its operation `echo`
 * returns its input and is exposed to the bridge, so a frame's call may reach it.
 */
async function plantConnection(connection: { id: string; name: string }): Promise<void> {
  const revisionId = `cfgr_${randomUUID()}`;
  const config = {
    name: connection.name,
    displayName: "Stock system",
    description: "A fixture of the browser suite. It reaches nothing.",
    connectorType: "test",
    ownerPrincipalId: "system",
    settings: { url: ALLOWED_URL },
    authScheme: "none",
    credentialMode: "shared",
    operations: [{ name: "echo", effect: "reading", exposure: ["bridge"], enabled: true }],
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

/** The source of the App: one tile, one named action, and a button that calls it again. */
function appSource(app: { id: string; connection: string }): Record<string, string> {
  return {
    "app.yaml": `id: ${app.id}\nname: Stock rows\nkit: 1.1.0\nconnections:\n  - ${app.connection}\n`,
    // The rows are fixed in the mapping, so what the tile shows went through the Connection.
    "actions/load-rows.action.yaml": `connection: ${app.connection}
operation: echo
effect: reading
description: Reads the rows of the stock system.
input:
  mapping:
    text: "${ROWS.join("|")}"
`,
    "src/routes/__root.tsx": `import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Outlet />
    </main>
  )
});
`,
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  actions,
  AppCallError,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-app-kit";

type Loaded =
  | { state: "loading" }
  | { state: "rows"; rows: string[] }
  | { state: "refused"; message: string; retryable: boolean };

function rowsOf(result: unknown): string[] {
  const text =
    typeof result === "object" && result !== null && "text" in result ? result.text : undefined;
  return typeof text === "string" ? text.split("|") : [];
}

function Tile() {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [loads, setLoads] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    actions
      .call("load-rows")
      .then((answer) => {
        setLoaded({ state: "rows", rows: rowsOf(answer.result) });
        setLoads((count) => count + 1);
      })
      .catch((error: unknown) => {
        // The sentence is the platform's. The tile shows it as it is.
        setLoaded(
          error instanceof AppCallError
            ? { state: "refused", message: error.message, retryable: error.retryable }
            : { state: "refused", message: "The rows could not be loaded.", retryable: true }
        );
      })
      .finally(() => setBusy(false));
  }, []);
  useEffect(load, [load]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Stock rows</CardTitle>
        {loaded.state === "refused" && !loaded.retryable ? null : (
          <Button variant="outline" size="sm" loading={busy} onClick={load}>
            Refresh
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loaded.state === "refused" ? (
          <div data-testid="refusal">
            <Banner tone="warning">{loaded.message}</Banner>
          </div>
        ) : null}
        {loaded.state === "rows" ? (
          <>
            <p data-testid="loads">Loaded {loads} times</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded.rows.map((row) => (
                  <TableRow key={row}>
                    <TableCell>{row}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/")({ component: Tile });
`
  };
}

async function signIn(page: Page, person: { email: string; password: string }): Promise<string> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  const me = await page.request.get(`${apiOrigin}/api/v1/me`);
  expect(me.ok()).toBe(true);
  return idSchema.parse(await me.json()).id;
}

/** The App inside the frame of the App's own screen. */
function appIn(page: Page): FrameLocator {
  return page
    .getByTestId("app-view")
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

type Variant = readonly [theme: "light" | "dark", locale: "en" | "de", width: 1440 | 390];
const VARIANTS: Variant[] = (["light", "dark"] as const).flatMap((theme) =>
  (["en", "de"] as const).flatMap((locale) =>
    ([1440, 390] as const).map((width): Variant => [theme, locale, width])
  )
);

/** Loads the screen again in a theme, a language and a width, which are read at load. */
async function show(
  page: Page,
  [theme, locale, width]: Variant,
  ready: () => Promise<void>
): Promise<void> {
  await page.evaluate(
    ([themeValue, localeValue]) => {
      window.localStorage.setItem("vivd-catalyst:theme", themeValue);
      window.localStorage.setItem("vivd-catalyst:locale", localeValue);
    },
    [theme, locale] as const
  );
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.reload();
  await ready();
}

/** Pictures of the screen in both themes and languages at both widths. */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  for (const variant of VARIANTS) {
    await show(page, variant, ready);
    await page.screenshot({
      path: join(shotsDir, `${name}-${variant.join("-")}.png`),
      animations: "disabled"
    });
  }
  await show(page, ["light", "en", 1440], ready);
}

// The test plants a Connection and writes a grant: it takes its turn with the tests that count
// grants, and with the specs that start an API, which would delete a planted Connection.
test("a tile of a published App reads rows through a named action with the viewer's rights", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  accessState: _accessState,
  releaseConnections: _releaseConnections
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run names its
  // App after the attempt.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appId = attempt === 0 ? "stock-rows" : `stock-rows-${attempt}`;
  const connection = { id: `cfga_${randomUUID()}`, name: `e2e_stock_${randomUUID().slice(0, 8)}` };
  const operation = `app.${appId}.load-rows`;
  test.setTimeout(shotsDir ? 420_000 : 180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  await signIn(page, admin);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(30_000);
  const memberId = await signIn(memberPage, member);

  /** The runs of the action, newest first, as the administrator is shown them. */
  const runs = async () => {
    const answer = await page.request.get(
      `${apiOrigin}/api/v1/operations/runs?operation=${encodeURIComponent(operation)}`
    );
    expect(answer.ok(), await answer.text()).toBe(true);
    return runsSchema.parse(await answer.json()).items;
  };

  await plantConnection(connection);
  try {
    // The workspace of the spec, its member, and the App, written and published by the admin.
    const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
      data: { name: `Stock team ${attempt}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);
    const appUrl = `${apiOrigin}/api/v1/assets/app/${appId}`;
    const written = await requestWithOrigin(page, "put", appUrl, {
      data: {
        workspaceId,
        files: Object.entries(appSource({ id: appId, connection: connection.name })).map(
          ([path, text]) => ({ path, text })
        )
      },
      timeout: 90_000
    });
    expect(written.ok(), await written.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${appUrl}/publish`, {
      data: { workspaceId, revision: 1 }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const appPath = `/w/${workspaceId}/apps/${appId}`;

    // The administrator may use the Connection through the role: the tile shows its rows.
    await page.goto(appPath);
    const tile = appIn(page);
    const rowsShown = async () => {
      for (const row of ROWS) {
        await expect(appIn(page).getByRole("cell", { name: row })).toBeVisible();
      }
    };
    await rowsShown();
    await expect(tile.getByTestId("loads")).toHaveText("Loaded 1 times");
    await expect.poll(async () => (await runs()).length).toBe(1);

    // Refresh is one more call and one more run, and nothing else.
    await tile.getByRole("button", { name: "Refresh" }).click();
    await expect(tile.getByTestId("loads")).toHaveText("Loaded 2 times");
    await expect.poll(async () => (await runs()).length).toBe(2);
    for (const run of await runs()) {
      expect(run).toMatchObject({ operation, status: "done", origin: { kind: "app" } });
    }
    await shoot(page, "app-action-tile", rowsShown);

    // The member may use the App and not the Connection. The platform says so in the member's
    // language and names no Connection, since the member may not read it. Trying again cannot
    // help, so the tile offers no button for it.
    const UNNAMED = {
      en: "You may not use a connection this app needs, so this cannot load. Trying again will not help. An administrator can give you the right under Settings > Instance > Access.",
      de: "Du darfst eine Verbindung nicht nutzen, die diese App braucht, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht. Ein Administrator kann dir das Recht unter Einstellungen > Instanz > Zugriff geben."
    };
    const refusal = appIn(memberPage).getByTestId("refusal");
    const refused = async () => {
      await expect(refusal).toBeVisible();
      await expect(appIn(memberPage).getByRole("button", { name: "Refresh" })).toHaveCount(0);
    };
    await memberPage.goto(appPath);
    await refused();
    await expect(refusal).toHaveText(UNNAMED.en);
    await expect(appIn(memberPage).getByRole("cell")).toHaveCount(0);
    await expect
      .poll(async () =>
        (await runs()).some((run) => run.actor.id === memberId && run.status === "denied")
      )
      .toBe(true);
    await show(memberPage, ["light", "de", 1440], refused);
    await expect(refusal).toHaveText(UNNAMED.de);
    await show(memberPage, ["light", "en", 1440], refused);
    await shoot(memberPage, "app-action-tile-refused-unnamed", refused);

    // A member who may read the Connection and not use it is told which one, by its label.
    const grant = (action: string) =>
      requestWithOrigin(page, "post", `${apiOrigin}/api/v1/instance/access/grants`, {
        data: {
          holderKind: "user",
          holderId: memberId,
          action,
          scopeKind: "asset",
          scopeId: connection.id
        }
      });
    const readable = await grant("connection.read");
    expect(readable.ok(), await readable.text()).toBe(true);
    await memberPage.reload();
    await refused();
    await expect(refusal).toHaveText(
      "You may not use the connection Stock system, so this cannot load. Trying again will not help. An administrator can give you the right under Settings > Instance > Access."
    );
    await show(memberPage, ["light", "de", 1440], refused);
    await expect(refusal).toHaveText(
      "Du darfst die Verbindung Stock system nicht nutzen, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht. Ein Administrator kann dir das Recht unter Einstellungen > Instanz > Zugriff geben."
    );
    await show(memberPage, ["light", "en", 1440], refused);
    await shoot(memberPage, "app-action-tile-refused", refused);

    // With the right on the Connection the same tile shows the member the rows.
    const granted = await grant("connection.use");
    expect(granted.ok(), await granted.text()).toBe(true);
    await memberPage.reload();
    for (const row of ROWS) {
      await expect(appIn(memberPage).getByRole("cell", { name: row })).toBeVisible();
    }
    await expect
      .poll(async () =>
        (await runs()).some((run) => run.actor.id === memberId && run.status === "done")
      )
      .toBe(true);
    // Nobody is shown the address the frame is served from.
    await expect(memberPage.locator("body")).not.toContainText("app-content");
  } finally {
    await memberContext.close();
    await removeConnection(connection.id);
  }
});
