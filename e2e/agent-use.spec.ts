import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";

// AGENT-USE-1: an administrator limits an agent to the people and roles given the right Use,
// on the agent's page beside "Available in", and gives the right on Instance > Access. In
// German, at 1280 wide, with the pictures of both.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
// A person of this spec's own (tests/fixtures/e2e-users/agent-use.yaml): no other spec reads them.
const normalUser = { email: "e2e-agent-use@example.test", password: "e2e-agent-use-password" };
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const agentName = "use-helper";
const assetPath = `${apiBaseUrl}/api/v1/assets/agent/${agentName}`;
const WIDE = { width: 1280, height: 800 };

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("an administrator limits an agent to holders of Use and gives the right", async ({
  page,
  instanceAgentsChange: _instanceAgentsChange
}, testInfo) => {
  test.setTimeout(90_000);
  // A seeded user is listed once the user has signed in and made a first call.
  await signInViaApi(page, normalUser);
  expect((await page.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  await signInViaApi(page, adminUser);
  const created = await requestWithOrigin(page, "put", assetPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, assetPath),
      config: {
        name: agentName,
        displayName: "Use Helper",
        modelProviderId: "local",
        instructions: "You help.",
        toolNames: []
      },
      availableIn: "all"
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const shotsDir = process.env.E2E_SHOTS_DIR ?? testInfo.outputPath("shots");
  await mkdir(shotsDir, { recursive: true });
  try {
    await page.setViewportSize(WIDE);
    await page.goto(`/build/agents/${agentName}`);
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();

    // Beside "Available in": everyone there, which every agent starts with, or only holders.
    const section = page.locator("section#agent-use");
    await expect(section.getByRole("heading", { name: "Wer ihn verwenden darf" })).toBeVisible();
    const everyone = section.getByRole("radio", { name: /^Alle dort/u });
    const granted = section.getByRole("radio", { name: /^Nur Personen und Rollen mit dem Recht/u });
    await expect(everyone).toBeChecked();
    await granted.check();
    const accessLink = section.getByRole("link", { name: "Recht unter Instanz > Zugriff geben" });
    await expect(accessLink).toHaveAttribute("href", "/settings/instance/access");
    await page.getByRole("button", { name: "Änderungen speichern", exact: true }).click();
    await expect(granted).toBeChecked();
    await expect
      .poll(async () => {
        const read: unknown = await (await page.request.get(assetPath)).json();
        return typeof read === "object" && read !== null && "agentUse" in read
          ? read.agentUse
          : undefined;
      })
      .toBe("granted");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotsDir, "agent-use-section-de-1280.png"),
      animations: "disabled"
    });

    // The right itself: Use, the agents' lowest level, on this one agent.
    await accessLink.click();
    await expect(page).toHaveURL(/\/settings\/instance\/access$/u);
    await page.getByRole("button", { name: "Neues Recht" }).click();
    const dialog = page.getByRole("dialog", { name: "Neues Recht" });
    await pick(page, dialog.getByRole("button", { name: /^Person: / }), /E2E Zz Agent Use/u);
    await dialog.getByRole("radio", { name: /^An einem Asset/u }).check();
    await dialog.getByRole("radio", { name: "Verwenden", exact: true }).check();
    await pick(page, dialog.getByRole("button", { name: /^Asset: / }), agentName);
    await expect(dialog.getByText("Mit dem Agenten chatten, wo er verfügbar ist")).toBeVisible();
    // The picture shows the chosen level, Use, with what it allows.
    await dialog.getByRole("radio", { name: "Verwenden", exact: true }).scrollIntoViewIfNeeded();
    await dialog.screenshot({
      path: join(shotsDir, "agent-use-grant-dialog-de-1280.png"),
      animations: "disabled"
    });
    await page.screenshot({
      path: join(shotsDir, "agent-use-grant-de-1280.png"),
      animations: "disabled"
    });
    await dialog.getByRole("button", { name: "Recht anlegen" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByTestId("grant-row").filter({ hasText: "Use Helper" });
    await expect(row).toContainText("E2E Zz Agent Use");
    await expect(row).toContainText("verwenden");
    await page.screenshot({
      path: join(shotsDir, "agent-use-granted-de-1280.png"),
      animations: "disabled"
    });
  } finally {
    const deleted = await requestWithOrigin(page, "post", `${assetPath}/delete`, {
      data: { expectedRevision: await assetRevision(page, assetPath) }
    });
    expect(deleted.ok()).toBe(true);
  }
});
