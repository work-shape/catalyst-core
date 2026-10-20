import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { connectionDetail, recordedStates } from "../tests/chat-ui-connection-fixtures";
import {
  ALLOWED_URL,
  plantConnection,
  removeConnection,
  type PlantedConnection
} from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The page of one Connection, `/build/connections/<name>`, on the instance's own answers. The
// Connections are real assets of the instance, planted in the store as the release seed writes
// them, of the suite's Connector type `test`, which contacts nothing. What the type and the
// instance bring about is read from the instance: a Connection nobody tested, a test that
// answers ready, one the egress list refuses and one without its credential. The type's test
// always answers ready, so the states it cannot bring about (unauthorized, unavailable, an
// unnamed failure, an unreadable credential, a refused test, a failed read) are shown with the
// instance's answer replaced on its way to the page.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of every state of the page. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const widths = { 1280: 800, 1024: 768, 390: 844 } as const;
type Width = keyof typeof widths;

/** What stands in for an answer of the instance: a state, or the code of a refusal. */
type Refusal = "FORBIDDEN" | "INTERNAL";
/** The call was accepted and waits for somebody's approval: nothing ran. */
type Held = "HELD";
const REFUSAL_STATUS: Record<Refusal, number> = { FORBIDDEN: 403, INTERNAL: 500 };

interface ReplacedAnswers {
  /** Replaces what `connections.get` answers. */
  detail?: ConnectionDetail | Refusal;
  /** Refuses `connections.test`, or holds its real answer back for this long. */
  test?: Refusal | Held | { delayMs: number };
}

function refusalBody(code: Refusal) {
  return { error: { code, message: `The suite answered ${code}` } };
}

/**
 * Replaces answers of the instance for one Connection on their way to the page, until the
 * returned function is called. The call still reaches the instance, so the replaced answer
 * keeps the instance's headers.
 */
async function replaceAnswers(
  page: Page,
  name: string,
  answers: ReplacedAnswers
): Promise<() => Promise<void>> {
  const detailUrl = `**/api/v1/connections/${name}`;
  const testUrl = `**/api/v1/connections/${name}/test`;
  const { detail, test: tested } = answers;
  if (detail !== undefined) {
    await page.route(detailUrl, async (route) => {
      const response = await route.fetch();
      await (typeof detail === "string"
        ? route.fulfill({ response, status: REFUSAL_STATUS[detail], json: refusalBody(detail) })
        : route.fulfill({ response, status: 200, json: detail }));
    });
  }
  if (tested !== undefined) {
    await page.route(testUrl, async (route) => {
      if (tested === "HELD") {
        // The instance's answer to a call it holds for an approval: 202 with the run that waits.
        // The test itself is not sent on, so nothing runs and nothing is recorded.
        const now = new Date().toISOString();
        await route.fulfill({
          status: 202,
          headers: {
            "access-control-allow-origin": new URL(page.url()).origin,
            "access-control-allow-credentials": "true"
          },
          json: {
            id: "oprun_e2e_held",
            operation: "connections.test",
            effect: "changing",
            status: "pending_approval",
            actor: { kind: "user", id: "e2e-admin", label: "E2E Admin" },
            origin: { kind: "user" },
            target: "live",
            approvalRequestId: "apr_e2e_held",
            inputHash: "e2e",
            attempt: 1,
            correlationId: "e2e",
            createdAt: now,
            href: "/api/v1/operation-runs/oprun_e2e_held"
          }
        });
        return;
      }
      if (typeof tested === "string") {
        const response = await route.fetch();
        await route.fulfill({
          response,
          status: REFUSAL_STATUS[tested],
          json: refusalBody(tested)
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, tested.delayMs));
      await route.continue();
    });
  }
  return async () => {
    await page.unroute(detailUrl);
    await page.unroute(testUrl);
  };
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

// The test plants Connections: it takes its turn with the spec that asserts the empty list.
// They are of origin `release` and no release config names them, so an API process that starts
// meanwhile deletes them, and the page then answers that there is no such Connection. The
// specs that start an API wait for the turn this test holds while its Connections are there.
test("a Connection's page shows its definition, its state in every case and the test, and writes nothing", async ({
  page,
  accessState: _accessState,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 480_000 : 180_000);
  const planted = (
    displayName: string,
    url: string,
    authScheme: PlantedConnection["authScheme"]
  ): PlantedConnection => ({
    id: `cfga_${randomUUID()}`,
    name: `e2e_${randomUUID().slice(0, 8)}`,
    displayName,
    url,
    authScheme
  });
  /** Its address is in the suite's `egress.allow`. */
  const reachable = planted("Sample business", ALLOWED_URL, "none");
  /** Its address is in no entry of `egress.allow`. */
  const walled = planted("Walled business", "https://walled.example.test/", "none");
  /** It sends a credential and none is stored. */
  const keyless = planted("Keyless business", ALLOWED_URL, "bearer");
  const connections = [reachable, walled, keyless];
  const addressOf = (connection: PlantedConnection) => `/build/connections/${connection.name}`;

  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: widths[1280] });
  const main = page.getByRole("region", { name: "Studio" });
  const health = main.locator("[data-connection-health]");
  // The one button of the Status section. While a test runs it shows a spinner and no name.
  const testButton = main.locator("#status button");

  /** The page of a Connection, in the given language. */
  const open = async (
    connection: PlantedConnection,
    view: { locale?: "en" | "de"; theme?: "light" | "dark" } = {}
  ) => {
    await setView(page, view);
    await page.goto(addressOf(connection));
    await expect(
      page.getByRole("heading", { name: connection.displayName, level: 1 })
    ).toBeVisible();
  };

  /** Pictures of what the page of a Connection shows now. `full` takes every width, language and theme. */
  const shoot = async (name: string, connection: PlantedConnection, full = false) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    const views: [Width, "en" | "de", "light" | "dark"][] = full
      ? ([1280, 1024, 390] as const).flatMap((width) =>
          (["en", "de"] as const).flatMap((locale) =>
            (["light", "dark"] as const).map((theme): [Width, "en" | "de", "light" | "dark"] => [
              width,
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
      await open(connection, { locale, theme });
      await expect(health.or(main.getByRole("alert"))).toBeVisible();
      await page.screenshot({
        path: join(shotsDir, `connection-${name}-${theme}-${locale}-${width}.png`)
      });
    }
    if (full) {
      // The whole page in one picture, for the sections below the fold.
      await page.setViewportSize({ width: 1280, height: 1700 });
      await open(connection, { locale: "en", theme: "light" });
      await expect(health).toBeVisible();
      await page.screenshot({ path: join(shotsDir, `connection-${name}-whole-light-en-1280.png`) });
      await page.setViewportSize({ width: 390, height: 2600 });
      await open(connection, { locale: "de", theme: "light" });
      await expect(health).toBeVisible();
      await page.screenshot({ path: join(shotsDir, `connection-${name}-whole-light-de-390.png`) });
    }
    await page.setViewportSize({ width: 1280, height: widths[1280] });
    await setView(page, {});
  };

  /** The page of a Connection with answers of the instance replaced. */
  const replaced = async (
    answers: ReplacedAnswers,
    run: () => Promise<void>,
    connection = reachable
  ) => {
    const restore = await replaceAnswers(page, connection.name, answers);
    try {
      await run();
    } finally {
      await restore();
    }
  };

  try {
    for (const connection of connections) {
      await plantConnection(connection);
    }

    await test.step("a row of the list opens the page: header, settings, and nothing to edit", async () => {
      await page.goto("/build/connections");
      await page
        .getByRole("list", { name: "Connections", exact: true })
        .getByRole("link", { name: /Sample business/u })
        .click();
      await expect(page).toHaveURL(new RegExp(`${addressOf(reachable)}$`, "u"));
      await expect(page.getByRole("heading", { name: "Sample business", level: 1 })).toBeVisible();
      await expect(
        main.getByText(
          "This connection is defined in the release config. The operator changes it there; it cannot be changed here.",
          {
            exact: true
          }
        )
      ).toBeVisible();
      await expect(main.getByText("Instance", { exact: true })).toBeVisible();
      // Its id is behind "Copy ID" in the head's menu, never on the page.
      await expect(main.getByText(reachable.name, { exact: true })).toHaveCount(0);
      await expect(main.getByText(ALLOWED_URL)).toBeVisible();
      // A Connection that sends no credential has none to set, and no account anybody shares.
      await expect(main.locator("[data-connection-credential]")).toHaveAttribute(
        "data-connection-credential",
        "none_needed"
      );
      await expect(main.getByText("None needed", { exact: true })).toBeVisible();
      await expect(
        main.getByText("The outside system asks for no credential.", { exact: true })
      ).toBeVisible();
      await expect(main.locator("[data-connection-shared]")).toHaveCount(0);
      // The page writes nothing. Its history is read, its menu offers the id and no Delete, and
      // a copy is where an edit starts.
      await expect(main.getByRole("textbox")).toHaveCount(0);
      await expect(main.getByRole("button", { name: /^(Save|Edit)/u })).toHaveCount(0);
      await main.getByRole("button", { name: "More actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Copy ID" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();
      await expect(main.getByRole("button", { name: "History" })).toBeVisible();
      await expect(main.getByRole("button", { name: "Copy to edit" })).toBeVisible();
      // The operations as the instance judges them against the Connector type.
      const operation = (name: string) => main.locator(`[data-connection-operation="${name}"]`);
      await expect(operation("echo")).toContainText("Reading");
      await expect(operation("echo")).toContainText("Agents");
      await expect(operation("echo")).toContainText("Ready");
      await expect(operation("echo")).toContainText("Returns its input.");
      await expect(operation("record")).toContainText("Changing");
      await expect(operation("record")).toContainText("Nobody can call it");
      await expect(operation("record")).toContainText("Needs review");
      await expect(operation("record")).toContainText("New fingerprint:");
      await expect(operation("removed")).toContainText("Unknown");
      await expect(operation("echo_off")).toContainText("Disabled");
      await expect(
        main.getByText("Nothing you can see uses this connection.", { exact: true })
      ).toBeVisible();
      // The way back is the list.
      await main.getByRole("button", { name: "Back to Connections" }).click();
      await expect(page).toHaveURL(/\/build\/connections$/u);
    });

    await test.step("a Connection nobody tested says so; the test runs and answers ready", async () => {
      await open(reachable);
      await expect(health).toHaveAttribute("data-connection-health", "never_tested");
      await expect(health).toContainText("This connection has not been tested yet.");
      await shoot("never-tested", reachable, true);
      // The answer of the instance is held back a moment, so the running test can be seen.
      await replaced({ test: { delayMs: 1500 } }, async () => {
        await open(reachable);
        await testButton.click();
        await expect(health).toHaveAttribute("data-connection-health", "testing");
        await expect(health).toContainText("The instance is asking the outside system.");
        await expect(testButton).toBeDisabled();
        await expect(health).toHaveAttribute("data-connection-health", "ready");
      });
      await expect(health).toContainText("The outside system answered the test.");
      await expect(health).toContainText("Last tested ");
      await expect(testButton).toHaveText("Test connection");
      // What the test found is what the instance recorded: the page says it again after a reload.
      await open(reachable);
      await expect(health).toHaveAttribute("data-connection-health", "ready");
      await expect(health).toContainText("Last tested ");
      await shoot("ready", reachable, true);
    });

    await test.step("a test the egress list refuses answers network denied", async () => {
      await open(walled);
      await expect(health).toHaveAttribute("data-connection-health", "never_tested");
      await testButton.click();
      await expect(health).toHaveAttribute("data-connection-health", "network_denied");
      await expect(health).toContainText(
        "The instance may not reach this address. Its host is not among the outside addresses the operator allowed."
      );
      await expect(health).toContainText("The operator lets the instance reach this host");
      await open(walled);
      await expect(health).toHaveAttribute("data-connection-health", "network_denied");
      await shoot("network-denied", walled);
    });

    await test.step("a Connection without its credential says so after the test", async () => {
      await open(keyless);
      // The definition names a handle of the Secret Store. The page shows nothing of it.
      await expect(main).not.toContainText("secret_");
      await expect(main.getByText("Not set", { exact: true })).toBeVisible();
      await expect(main.getByText("One shared account", { exact: true })).toBeVisible();
      await testButton.click();
      await expect(health).toHaveAttribute("data-connection-health", "not_configured");
      await expect(health).toContainText("The credential of this connection is missing.");
      await expect(health).toContainText("Then test again.");
      await open(keyless);
      await expect(health).toHaveAttribute("data-connection-health", "not_configured");
      await shoot("not-configured", keyless);
    });

    await test.step("the main states in German", async () => {
      await open(walled, { locale: "de" });
      await expect(
        main.getByText(
          "Diese Verbindung ist in der Release-Konfiguration festgelegt. Der Betreiber ändert sie dort; hier lässt sie sich nicht ändern.",
          { exact: true }
        )
      ).toBeVisible();
      await expect(health).toContainText("Die Instanz darf diese Adresse nicht erreichen.");
      await testButton.click();
      await expect(health).toContainText("Die Instanz darf diese Adresse nicht erreichen.");
      await open(reachable, { locale: "de" });
      await expect(health).toContainText("Das externe System hat auf den Test geantwortet.");
      await setView(page, {});
    });

    await test.step("the states the suite's Connector type cannot bring about, each with its sentences", async () => {
      // On the Connection that sends a credential: the page shows whether it is there.
      const recorded = (state: Partial<ConnectionDetail>) => ({
        detail: connectionDetail(keyless.name, state)
      });
      await replaced(
        recorded(recordedStates.unauthorized),
        async () => {
          await open(keyless);
          await expect(health).toHaveAttribute("data-connection-health", "unauthorized");
          await expect(health).toContainText("The outside system refused the credential.");
          await expect(health).toContainText("The operator sets a new credential");
          // The answer of `connections.get` in full: every status of an operation, and who uses it.
          await expect(main.locator('[data-connection-operation="list_customers"]')).toContainText(
            "Awaiting discovery"
          );
          await expect(
            main
              .getByRole("list", { name: "Used by" })
              .getByRole("link", { name: /Workflow Assistant/u })
          ).toHaveAttribute("href", "/build/agents/workflow_assistant");
          await shoot("unauthorized", keyless);
        },
        keyless
      );
      await replaced(
        recorded(recordedStates.unavailable),
        async () => {
          await open(keyless);
          await expect(health).toContainText("The outside system did not answer the test.");
          await shoot("unavailable", keyless);
        },
        keyless
      );
      await replaced(
        recorded(recordedStates.failedUnnamed),
        async () => {
          await open(keyless);
          await expect(health).toHaveAttribute("data-connection-health", "failed");
          await expect(health).toContainText("Test again. If it fails again, ask the operator.");
          await shoot("failed-unnamed", keyless);
        },
        keyless
      );
      await replaced(
        recorded(recordedStates.secretUnreadable),
        async () => {
          await open(keyless);
          await expect(health).toHaveAttribute("data-connection-health", "secret_unreadable");
          await expect(health).toContainText("the instance cannot read it");
          await expect(health).toContainText("The operator restores the Secret Store key");
          await expect(main.getByText("Unreadable", { exact: true })).toBeVisible();
          await shoot("secret-unreadable", keyless);
        },
        keyless
      );
    });

    await test.step("a refused test says so, and a state that cannot be read offers a retry", async () => {
      await replaced({ test: "FORBIDDEN" }, async () => {
        await open(reachable);
        await testButton.click();
        await expect(
          main.getByText("You may not test this connection. You can read it.", { exact: true })
        ).toBeVisible();
      });
      await replaced({ test: "HELD" }, async () => {
        const held = main.locator("[data-connection-test-held]");
        await open(reachable);
        await testButton.click();
        await expect(held).toHaveText(
          "The test waits for approval in the Inbox. It has not run yet."
        );
        // Nothing ran: the state is the one recorded before.
        await expect(health).toHaveAttribute("data-connection-health", "ready");
        if (shotsDir) {
          for (const [width, locale, theme] of [
            [1280, "en", "light"],
            [390, "de", "dark"]
          ] as const) {
            await page.setViewportSize({ width, height: widths[width] });
            await open(reachable, { locale, theme });
            await testButton.click();
            await expect(held).toBeVisible();
            await page.screenshot({
              path: join(shotsDir, `connection-test-held-${theme}-${locale}-${width}.png`)
            });
          }
          await page.setViewportSize({ width: 1280, height: widths[1280] });
          await setView(page, {});
        }
      });
      await replaced({ detail: "INTERNAL" }, async () => {
        await open(reachable);
        await expect(main.getByRole("alert")).toBeVisible();
        await expect(main.getByRole("button", { name: "Try again" })).toBeVisible();
        // The definition is still on the page; what was not read is not shown as empty.
        await expect(main.getByText(ALLOWED_URL)).toBeVisible();
        await expect(health).toHaveCount(0);
        await expect(main.getByRole("button", { name: "Test connection" })).toHaveCount(0);
        await shoot("status-unreadable", reachable);
      });
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
      // Per-asset rights also describe this reader; the signed-in admin's real asset answer
      // must not keep advertising write while the context above describes a read-only reader.
      const readAsset = (url: URL) =>
        url.pathname === `/api/v1/assets/connection/${reachable.name}`;
      await page.route(readAsset, async (route) => {
        const response = await route.fetch();
        const body: unknown = await response.json();
        await route.fulfill({ response, json: { ...Object(body), allowed: ["read"] } });
      });
      await open(reachable);
      await expect(health).toHaveAttribute("data-connection-health", "ready");
      await expect(testButton).toHaveCount(0);
      await expect(
        main.getByText(
          "You can read this connection. Testing it needs the right to change connections on the instance.",
          { exact: true }
        )
      ).toBeVisible();
      await shoot("read-not-test", reachable);
      await page.unroute(readAsset);
      await page.unroute("**/api/v1/context");
    });

    await test.step("pictures of a running test", async () => {
      if (!shotsDir) return;
      await replaced({ test: { delayMs: 4000 } }, async () => {
        for (const [width, locale, theme] of [
          [1280, "en", "light"],
          [390, "de", "dark"]
        ] as const) {
          await page.setViewportSize({ width, height: widths[width] });
          await open(reachable, { locale, theme });
          await testButton.click();
          await expect(health).toHaveAttribute("data-connection-health", "testing");
          await page.screenshot({
            path: join(shotsDir, `connection-testing-${theme}-${locale}-${width}.png`)
          });
          await expect(health).toHaveAttribute("data-connection-health", "ready");
        }
      });
      await page.setViewportSize({ width: 1280, height: widths[1280] });
      await setView(page, {});
    });
  } finally {
    for (const connection of connections) {
      await removeConnection(connection.id);
    }
  }
});
