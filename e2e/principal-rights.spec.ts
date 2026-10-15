import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  ALLOWED_URL,
  plantConnection,
  removeConnection,
  removeGrantsOn,
  removeServicePrincipal,
  type PlantedConnection
} from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// What a service principal may use, on the instance's own answers: the section of the
// principal's page under Instance > API access, the dialog that gives a right, a refusal of
// the instance, and the Connection's page that lists the principal beside a person. The
// Connections are real assets, planted as the release seed writes them.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of the states of both pages, in the dark theme. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const widths = { 1440: 900, 390: 844 } as const;

async function signIn(page: Page, account: { email: string; password: string }) {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...account, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

test("a superadmin gives a service principal a Connection, is refused one that is gone, and removes the right", async ({
  page,
  accessState: _accessState,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 240_000 : 120_000);
  const planted = (displayName: string): PlantedConnection => ({
    id: `cfga_${randomUUID()}`,
    name: `e2e_${randomUUID().slice(0, 8)}`,
    displayName,
    url: ALLOWED_URL,
    authScheme: "none"
  });
  const crm = planted("Sample CRM");
  const ledger = planted("Sample ledger");
  const label = `Monthly check ${randomUUID().slice(0, 6)}`;
  let principalId: string | undefined;

  /** Pictures of what the page shows now, in the app's dark theme, at both widths. */
  const shoot = async (name: string, settle: () => Promise<void>) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    for (const width of [1440, 390] as const) {
      await page.setViewportSize({ width, height: widths[width] });
      await settle();
      await page.screenshot({ path: join(shotsDir, `${name}-dark-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: widths[1440] });
  };

  // A person who is given the same Connection, to stand beside the principal: the
  // administrator, whom every reader of the list is shown.
  await signIn(page, admin);
  const person: { id: string } = await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json();
  await page.context().clearCookies();
  await signIn(page, superadmin);
  await page.setViewportSize({ width: 1440, height: widths[1440] });
  if (shotsDir) {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:theme", "dark"));
  }

  try {
    await plantConnection(crm);
    await plantConnection(ledger);
    const created = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/service-principals`,
      { data: { displayLabel: label, permissions: ["config_assets.read"] } }
    );
    expect(created.ok()).toBe(true);
    const detail: { principal: { id: string; name: string } } = await created.json();
    principalId = detail.principal.id;
    const personRight = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: person.id,
          action: "connection.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: crm.id
        }
      }
    );
    expect(personRight.ok()).toBe(true);

    const rights = page.locator("[data-principal-rights]");
    const rows = rights.getByTestId("principal-right");
    const dialog = page.getByRole("dialog", { name: `New right for ${label}` });
    const openPrincipal = async () => {
      await page.goto(`/settings/instance/api-access?principal=${principalId}`);
      await expect(page.getByText(detail.principal.name, { exact: true })).toBeVisible();
      await expect(rights.getByRole("heading", { name: "Rights on resources" })).toBeVisible();
    };

    await test.step("the address opens the page on the principal, and the empty section says what a right is for", async () => {
      await openPrincipal();
      await expect(
        rights.getByText(
          "This service principal may not use any resource yet. A Workflow that runs as it can only call a Connection the principal was given.",
          { exact: true }
        )
      ).toBeVisible();
      await expect(rows).toHaveCount(0);
      await shoot("principal-rights-empty", async () => {
        await rights.evaluate((section) => section.scrollIntoView({ block: "start" }));
        await expect(
          rights.getByRole("button", { name: "Give this principal a Connection to use" })
        ).toBeVisible();
      });
    });

    await test.step("the dialog offers the Connections and the right the instance names, by keyboard", async () => {
      const first = rights.getByRole("button", {
        name: "Give this principal a Connection to use"
      });
      await first.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      // The one right the instance hands out for a Connection, said in words and chosen.
      await expect(dialog.getByRole("radio", { name: /May use this Connection/u })).toBeChecked();
      // Sending the form without a Connection says what is missing, and writes nothing.
      await dialog.getByRole("button", { name: "Give right" }).click();
      await expect(dialog.getByText("Choose a resource.", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: /^Connection:/u }).click();
      await expect(page.getByRole("option", { name: /Sample CRM/u })).toBeVisible();
      await expect(page.getByRole("option", { name: /Sample ledger/u })).toBeVisible();
      await shoot("principal-rights-dialog", async () => {
        await expect(page.getByRole("option", { name: /Sample CRM/u })).toBeVisible();
      });
      await page.getByRole("option", { name: /Sample CRM/u }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Give right" }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step("the row names the Connection, whom it belongs to, the right, who gave it and when", async () => {
      await expect(rows).toHaveCount(1);
      const row = rows.first();
      await expect(row).toContainText("Sample CRM");
      await expect(row).toContainText("Instance");
      await expect(row).toContainText("May use this Connection");
      await expect(row).toContainText(/Given by .+ on \d/u);
      await expect(
        row.getByRole("button", { name: "Remove the right on Sample CRM" })
      ).toBeVisible();
      await shoot("principal-rights-listed", async () => {
        await rights.evaluate((section) => section.scrollIntoView({ block: "start" }));
        await expect(rows).toHaveCount(1);
      });
    });

    await test.step("a Connection that was deleted meanwhile is refused in a sentence that says what to do", async () => {
      await rights.getByRole("button", { name: "Add right" }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /^Connection:/u }).click();
      // The Connection the principal holds already is not offered a second time.
      await expect(page.getByRole("option", { name: /Sample CRM/u })).toHaveCount(0);
      await page.getByRole("option", { name: /Sample ledger/u }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await removeConnection(ledger.id);
      await dialog.getByRole("button", { name: "Give right" }).click();
      const refusal = dialog.locator('[data-right-refusal="invalidScope"]');
      await expect(refusal).toHaveText(
        "This resource no longer exists or is of another kind. Close this dialog, reload the page and choose the resource again."
      );
      await shoot("principal-rights-refusal", async () => {
        await expect(refusal).toBeVisible();
      });
      // Escape closes the dialog, and nothing was written.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(rows).toHaveCount(1);
    });

    await test.step("the Connection's page lists the principal beside the person, told apart, and links to it", async () => {
      await page.goto(`/build/connections/${crm.name}`);
      const access = page.locator("#access");
      await expect(access.getByRole("heading", { name: "Who may use it" })).toBeVisible();
      const holders = access.getByRole("list", { name: "Who may use it" });
      const personRow = holders.locator('[data-holder-kind="person"]');
      const service = holders.locator('[data-holder-kind="service_principal"]');
      await expect(personRow).toHaveCount(1);
      await expect(personRow).toContainText(admin.email);
      await expect(personRow.getByRole("link")).toHaveCount(0);
      await expect(service).toHaveCount(1);
      await expect(service).toContainText(label);
      await expect(service).toContainText("Service principal");
      await expect(service).toContainText(detail.principal.name);
      await shoot("connection-who-may-use-it", async () => {
        await access.scrollIntoViewIfNeeded();
        await expect(service).toBeVisible();
      });
      await service.getByRole("link").click();
      await expect(page).toHaveURL(
        new RegExp(`/settings/instance/api-access\\?principal=${principalId}$`, "u")
      );
      await expect(page.getByText(detail.principal.name, { exact: true })).toBeVisible();
      await expect(rows).toHaveCount(1);
    });

    await test.step("removing the right asks first, and the section is empty again", async () => {
      await rows.first().getByRole("button", { name: "Remove the right on Sample CRM" }).click();
      const confirm = page.getByRole("dialog", { name: "Remove this right?" });
      await expect(confirm).toContainText(`${label} can no longer use Sample CRM, at once.`);
      await confirm.getByRole("button", { name: "Remove" }).click();
      await expect(confirm).toHaveCount(0);
      await expect(rows).toHaveCount(0);
      await expect(
        rights.getByRole("button", { name: "Give this principal a Connection to use" })
      ).toBeVisible();
    });

    await test.step("an administrator, who manages service principals, sees the person and the principal", async () => {
      // The right is back, so there is a principal's row the list could show.
      const given = await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/instance/access/grants`,
        {
          data: {
            holderKind: "service_principal",
            holderId: principalId,
            action: "connection.use",
            effect: "allow",
            scopeKind: "asset",
            scopeId: crm.id
          }
        }
      );
      expect(given.ok()).toBe(true);
      await page.context().clearCookies();
      await signIn(page, admin);
      await page.goto(`/build/connections/${crm.name}`);
      await expect(page.getByRole("heading", { name: "Sample CRM", level: 1 })).toBeVisible();
      const access = page.locator("#access");
      await expect(access.getByRole("heading", { name: "Who may use it" })).toBeVisible();
      await expect(access.locator('[data-holder-kind="person"]')).toHaveCount(1);
      // RIGHTS-1a: the role holds `service_principals.manage`, so the list shows principals.
      await expect(access.locator('[data-holder-kind="service_principal"]')).toHaveCount(1);
      await expect(access.getByText(label).first()).toBeVisible();
    });
  } finally {
    if (principalId !== undefined) {
      await removeServicePrincipal(principalId);
    }
    await removeGrantsOn(crm.id);
    await removeConnection(crm.id);
    await removeConnection(ledger.id);
  }
});
