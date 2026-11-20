import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { capabilitiesSchema } from "@work-shape/catalyst-api-contract";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Studio's "Fähigkeiten" page (TOOLS-2; navigation-and-layout.md, section 4.3, check 35): an
// instance admin sees a module that is off, marked so; a builder without the admin role does not;
// and each package lists the agents that use it as links that open their pages. The group
// "Eigene Werkzeuge" is the one place Studio lists a tool added without a release (TOOL-1): the
// rail has no item for them, and the address of their former list opens this page.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const builder = {
  email: "e2e-capabilities-builder@example.test",
  password: "e2e-capabilities-builder-password"
};
const OFF_MARKER = "Auf dieser Instanz nicht aktiv, Workshape fragen";

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...who, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
  });
}

async function packagesOf(page: Page) {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/context/capabilities`);
  expect(response.ok(), await response.text()).toBe(true);
  return capabilitiesSchema.parse(await response.json()).packages;
}

/**
 * The page in German, light and dark, where `E2E_SHOTS_DIR` names a folder: loaded again in
 * each mode, with the row of `open` folded out.
 */
async function shoot(page: Page, name: string, open?: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.reload();
    const list = page.locator("[data-capabilities]");
    await expect(list.locator("[data-capability-package]").first()).toBeVisible();
    if (open !== undefined) {
      const row = list.locator(`[data-capability-package="${open}"]`);
      await row.getByRole("button").first().click();
      await expect(row.getByRole("group")).toBeVisible();
    }
    await page.screenshot({
      path: join(shotsDir, `capabilities-${name}-de-${mode}.png`),
      animations: "disabled"
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
}

test("an instance admin sees a module that is off, and an agent link opens its page", async ({
  page
}) => {
  test.setTimeout(90_000);
  // Tall enough for the folded-out group in the pictures.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await signIn(page, admin);
  const packages = await packagesOf(page);
  const off = packages.filter((item) => !item.enabled);
  expect(off.length, JSON.stringify(packages)).toBeGreaterThan(0);

  await page.goto("/build/capabilities");
  await expect(page.getByRole("heading", { name: "Fähigkeiten" })).toBeVisible();
  const list = page.locator("[data-capabilities]");
  await expect(list.locator("[data-capability-package]").first()).toBeVisible();
  await expect(list.locator('[data-capability-package="general"]')).toContainText("Allgemein");
  await expect(list.locator("[data-capability-off]").first()).toHaveText(OFF_MARKER);
  await expect(list.locator('[data-capability-enabled="false"]')).toHaveCount(off.length);
  await shoot(page, "admin");
  await shoot(page, "admin-off", `module:${off[0]?.module ?? ""}`);

  // The general block folded out, with its skills, its tools and the agents that use them.
  const used = packages.find((item) => item.enabled && item.agents.length > 0);
  expect(used, JSON.stringify(packages)).toBeDefined();
  if (!used) return;
  const key = used.kind === "module" ? `module:${used.module ?? ""}` : used.kind;
  const row = list.locator(`[data-capability-package="${key}"]`);
  await row.getByRole("button").first().click();
  const agent = row.locator(`[data-capability-agent="${used.agents[0]?.name ?? ""}"]`);
  await expect(agent).toBeVisible();

  await agent.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/build/agents/${used.agents[0]?.name ?? ""}$`, "u"));
});

test("a builder without the admin role sees no module that is off", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  const { id: builderId }: { id: string } = await me.json();
  const rootContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const root = await rootContext.newPage();
  await signIn(root, superadmin);
  // A builder of one workspace: Studio opens, and the page answers, without the admin role.
  const created = await requestWithOrigin(root, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Capabilities ${randomUUID().slice(0, 8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: workspaceId }: { id: string } = await created.json();
  const granted = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/access/grants`,
    {
      data: {
        holderKind: "user",
        holderId: builderId,
        action: "builder",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: workspaceId
      }
    }
  );
  expect(granted.ok(), await granted.text()).toBe(true);
  const grant: { id: string } = await granted.json();
  try {
    const packages = await packagesOf(page);
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.every((item) => item.enabled)).toBe(true);

    await page.goto("/build/capabilities");
    await expect(page.getByRole("heading", { name: "Fähigkeiten" })).toBeVisible();
    const list = page.locator("[data-capabilities]");
    await expect(list.locator("[data-capability-package]")).toHaveCount(packages.length);
    await expect(list.locator("[data-capability-off]")).toHaveCount(0);
    await expect(page.getByText(OFF_MARKER)).toHaveCount(0);
    await shoot(page, "builder");
  } finally {
    await requestWithOrigin(
      root,
      "delete",
      `${apiBaseUrl}/api/v1/instance/access/grants/${grant.id}`
    );
    await rootContext.close();
  }
});

test("a tool added without a release is listed under the own tools, which the rail has no item for", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, admin);
  const name = `open_items_${randomUUID().slice(0, 8)}`;
  const toolPath = `${apiBaseUrl}/api/v1/assets/tool/${name}`;
  const put = await requestWithOrigin(page, "put", toolPath, {
    data: {
      expectedRevision: null,
      config: {
        name,
        type: "result",
        title: { en: "Open items", de: "Offene Posten" },
        summary: {
          en: "Lists a customer's open items.",
          de: "Listet die offenen Posten eines Kunden."
        },
        description: "Call with the customer's open items.",
        input: { type: "object" },
        result: { kind: "generic.table", title: "Open items" }
      }
    }
  });
  expect(put.ok(), await put.text()).toBe(true);
  const { revision }: { revision: number } = await put.json();
  try {
    // The address of the former list opens Fähigkeiten.
    await page.goto("/build/tools");
    await expect(page).toHaveURL(/\/build\/capabilities$/u);
    await expect(page.getByRole("heading", { name: "Fähigkeiten" })).toBeVisible();
    const rail = page.getByRole("navigation", { name: "Arten im Studio" });
    await expect(rail.getByText("Fähigkeiten", { exact: true })).toBeVisible();
    await expect(rail.getByText("Werkzeuge", { exact: true })).toHaveCount(0);

    const own = page.locator('[data-capabilities] [data-capability-package="own"]');
    await expect(own).toContainText("Eigene Werkzeuge");
    await own.getByRole("button").first().click();
    const tool = own.locator(`[data-capability-tool-asset="${name}"]`);
    await expect(tool).toContainText("Offene Posten");
    await expect(tool).toContainText("Listet die offenen Posten eines Kunden.");
    await expect(tool).toContainText("generic.table");
    await expect(own.locator("[data-capability-tool-assets]")).toContainText(
      "berechnet etwas oder ruft eine Verbindung auf"
    );
    await shoot(page, "own-tools", "own");
  } finally {
    await requestWithOrigin(page, "post", `${toolPath}/delete`, {
      data: { expectedRevision: revision }
    });
  }
});
