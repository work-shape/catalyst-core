import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { z } from "zod";
import { apiBaseUrl, settingsPages, test } from "./chat-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { shootSurface } from "./surface-shots";
import { expect } from "./test";

// `catalyst models check` with a personal key (MODEL-CHECK-KEY): a superadmin issues a key with
// the instance level `system.view` alone under You > API keys. The scope starts unticked, a
// workspace narrows it away, and the key, exchanged for an access token as the CLI does,
// reaches `instance.infrastructure.check` and not `instance.infrastructure.get`.
//
// The key is read from the create answer into memory only: it is never printed, attached or
// shot, and it is revoked through the signed-in session at the end. A trace would record the
// answer and the page that reveals the key, so this file keeps none.

test.use({ sessionUser: "superadmin", trace: "off" });

const SYSTEM_LABEL = { en: "View the System pages", de: "Systemseiten ansehen" } as const;
const NEW_KEY_LABEL = { en: "New key", de: "Neuer Schlüssel" } as const;
const INSTANCE_LEVEL_LABEL = { en: "All workspaces", de: "Alle Arbeitsbereiche" } as const;
const API_KEYS_PATH = "/settings/you/api-keys";
/** The instance runs a manual check at most once a minute; a call inside it is told to wait. */
const MAX_CHECK_WAIT_SECONDS = 65;

const createdIdSchema = z.object({ key: z.object({ id: z.string() }) });
const createdSchema = z.object({
  key: z.object({ id: z.string(), scopes: z.array(z.string()) }),
  secret: z.string().min(1)
});
const exchangedSchema = z.object({ accessToken: z.string().min(1) });
const infrastructureSchema = z.object({ items: z.array(z.unknown()) });
const rateLimitedSchema = z.object({
  error: z.object({ details: z.object({ retryAfterSeconds: z.number() }).partial().optional() })
});
const refusalSchema = z.object({ error: z.object({ code: z.string() }) });

function newKeyDialog(page: Page): Locator {
  return page.locator("dialog[open]");
}

async function openNewKey(page: Page, locale: "en" | "de"): Promise<Locator> {
  await page.getByRole("button", { name: NEW_KEY_LABEL[locale], exact: true }).click();
  const dialog = newKeyDialog(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: SYSTEM_LABEL[locale], exact: true })
  ).toBeVisible();
  return dialog;
}

/** Sets how the interface speaks and looks; the next load reads it. */
async function chooseLocaleAndTheme(page: Page, locale: "en" | "de", theme: "light" | "dark") {
  await page.evaluate(
    ([chosenLocale, chosenTheme]) => {
      window.localStorage.setItem("vivd-catalyst:locale", chosenLocale);
      window.localStorage.setItem("vivd-catalyst:theme", chosenTheme);
    },
    [locale, theme] as const
  );
}

/**
 * Pictures of the New key form before any key exists, with the instance level ticked, at 1280
 * and 390, in English and German, light and dark. Only where `E2E_SHOTS_DIR` asks for them.
 */
async function shootNewKeyForm(page: Page): Promise<void> {
  if (!process.env.E2E_SHOTS_DIR) return;
  for (const locale of ["en", "de"] as const) {
    for (const theme of ["light", "dark"] as const) {
      await chooseLocaleAndTheme(page, locale, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(API_KEYS_PATH);
        const dialog = await openNewKey(page, locale);
        const system = dialog.getByRole("checkbox", { name: SYSTEM_LABEL[locale], exact: true });
        await system.click();
        await expect(system).toBeChecked();
        await system.scrollIntoViewIfNeeded();
        await shootSurface(
          page,
          `model-check-personal-key-new-key-${width}-${locale}-${theme}`,
          async () => {
            await expect(
              dialog.getByRole("group", { name: INSTANCE_LEVEL_LABEL[locale], exact: true })
            ).toBeInViewport();
          }
        );
      }
    }
  }
  await chooseLocaleAndTheme(page, "en", "light");
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** The workspace PickerButton, named "Limit to a workspace: <choice>". */
function workspaceButton(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: /^Limit to a workspace: /u });
}

/**
 * Opens the workspace picker and answers its options: those of the listbox in the popover its
 * button controls (`aria-controls`), never the native options of the expiry select.
 */
async function openWorkspacePicker(page: Page, dialog: Locator): Promise<Locator> {
  const button = workspaceButton(dialog);
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const panelId = await button.getAttribute("aria-controls");
  expect(panelId, "the workspace picker names its popover").toBeTruthy();
  const listbox = page.locator(`[id="${panelId}"]`).getByRole("listbox");
  await expect(listbox).toBeVisible();
  return listbox.getByRole("option");
}

/**
 * Picks one option of the open workspace picker and waits until its panel is gone, not only
 * marked closed. While the closing panel is still there, its outside-click listener answers
 * the next checkbox's click.
 */
async function pickWorkspace(dialog: Locator, option: Locator): Promise<void> {
  const panel = option.locator("xpath=ancestor::*[@role='dialog'][1]");
  await option.click();
  await expect(workspaceButton(dialog)).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
}

/**
 * Choosing a workspace narrows the key: the instance level is no longer offered and its tick
 * is gone. Everywhere offers it again, unticked. Where the person is offered no workspace,
 * there is nothing to narrow to and the picker is closed again.
 */
async function narrowingDropsInstanceLevel(page: Page, dialog: Locator): Promise<void> {
  const system = dialog.getByRole("checkbox", { name: SYSTEM_LABEL.en, exact: true });
  const instanceLevel = dialog.getByRole("group", { name: INSTANCE_LEVEL_LABEL.en, exact: true });
  await system.click();
  await expect(system).toBeChecked();

  const options = await openWorkspacePicker(page, dialog);
  const everywhere = options.filter({ hasText: /^\s*Everywhere\s*$/u });
  await expect(everywhere).toHaveCount(1);
  const workspaces = options.filter({ hasNotText: /^\s*Everywhere\s*$/u });
  if ((await workspaces.count()) === 0) {
    await pickWorkspace(dialog, everywhere);
    test.info().annotations.push({
      type: "gap",
      description: "The superadmin was offered no workspace; narrowing was not exercised."
    });
    await system.click();
    await expect(system).not.toBeChecked();
    return;
  }
  await pickWorkspace(dialog, workspaces.first());
  await expect(workspaceButton(dialog)).not.toHaveAccessibleName(
    "Limit to a workspace: Everywhere"
  );
  await expect(instanceLevel).toHaveCount(0);
  await expect(system).toHaveCount(0);

  const reopened = await openWorkspacePicker(page, dialog);
  await pickWorkspace(dialog, reopened.filter({ hasText: /^\s*Everywhere\s*$/u }));
  await expect(workspaceButton(dialog)).toHaveAccessibleName("Limit to a workspace: Everywhere");
  await expect(instanceLevel).toBeVisible();
  await expect(system).not.toBeChecked();
}

/**
 * Scrolls the Dialog's body, the one part that scrolls between its pinned head and footer, to
 * its end. The body is the key form's parent. Nothing else is scrolled: the native dialog is
 * `overflow-hidden` and also holds the overlay container, so scrolling it moves the head and
 * footer out of view.
 */
async function scrollToBottom(dialog: Locator): Promise<void> {
  const body = dialog.locator("form").locator("xpath=..");
  await expect(body).toHaveCSS("overflow-y", "auto");
  await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
}

/**
 * The CLI's exchange of the key for a short-lived access token, from a context without the
 * browser's session, so only the key speaks.
 */
async function exchange(keyless: APIRequestContext, secret: string): Promise<string> {
  const exchanged = await keyless.post(`${apiBaseUrl}/api/v1/auth/access-token`, {
    headers: { authorization: `Bearer ${secret}` }
  });
  // The answer holds a token: only its status is ever said.
  expect(exchanged.status(), "access token exchange status").toBe(200);
  return exchangedSchema.parse(await exchanged.json()).accessToken;
}

/** `instance.infrastructure.check`, waiting where another check ran within the minute. */
async function checkInfrastructure(keyless: APIRequestContext, token: string) {
  for (let attempt = 1; ; attempt += 1) {
    const checked = await keyless.post(`${apiBaseUrl}/api/v1/instance/infrastructure/check`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (checked.status() !== 429 || attempt >= 3) return checked;
    const wait = rateLimitedSchema.safeParse(await checked.json());
    const seconds = Math.min(
      (wait.success ? wait.data.error.details?.retryAfterSeconds : undefined) ?? 60,
      MAX_CHECK_WAIT_SECONDS
    );
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

test("a personal key with system.view alone runs the infrastructure check and nothing beside it", async ({
  page,
  playwright
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(API_KEYS_PATH);
  await chooseLocaleAndTheme(page, "en", "light");
  await shootNewKeyForm(page);

  await page.goto(API_KEYS_PATH);
  const rail = settingsPages(page);
  const apiKeysHeading = page.getByRole("heading", { name: "API keys", level: 1 });
  await expect(apiKeysHeading).toBeVisible();
  for (let round = 0; round < 2; round += 1) {
    await rail.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
    await rail.getByRole("button", { name: "API keys", exact: true }).click();
    await expect(apiKeysHeading).toBeVisible();
  }

  const dialog = await openNewKey(page, "en");
  const system = dialog.getByRole("checkbox", { name: SYSTEM_LABEL.en, exact: true });
  // Offered to a holder, never ticked in advance, and nothing else is either.
  await expect(system).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);

  await narrowingDropsInstanceLevel(page, dialog);

  await dialog.getByRole("textbox", { name: /^Name\b/u }).fill(`e2e-models-check-${Date.now()}`);
  await system.click();
  await expect(system).toBeChecked();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(1);

  // On a short screen the end of the form and Create key stay reachable.
  await page.setViewportSize({ width: 390, height: 560 });
  await scrollToBottom(dialog);
  const create = dialog.getByRole("button", { name: "Create key", exact: true });
  await expect(
    dialog.getByRole("combobox", { name: "Expires after", exact: true })
  ).toBeInViewport();
  await expect(create).toBeEnabled();
  await expect(create).toBeInViewport();

  const keyless = await playwright.request.newContext();
  let keyId: string | undefined;
  try {
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/me/api-keys"
    );
    await create.click();
    const response = await answered;
    expect(response.status(), "key creation status").toBeLessThan(300);
    expect(response.request().postDataJSON()).toMatchObject({ scopes: ["system.view"] });
    const body: unknown = await response.json();
    // The id first, so the key is revoked even where the rest of the answer is not as expected.
    keyId = createdIdSchema.parse(body).key.id;
    const created = createdSchema.parse(body);
    expect(created.key.scopes).toEqual(["system.view"]);

    const token = await exchange(keyless, created.secret);

    const checked = await checkInfrastructure(keyless, token);
    expect(checked.status(), "instance.infrastructure.check status").toBe(200);
    expect(infrastructureSchema.safeParse(await checked.json()).success).toBe(true);

    // The page's own read stays out of the key's reach.
    const read = await keyless.get(`${apiBaseUrl}/api/v1/instance/infrastructure`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(read.status(), "instance.infrastructure.get status").toBe(403);
    expect(refusalSchema.parse(await read.json()).error.code).toBe("FORBIDDEN");
  } finally {
    await keyless.dispose();
    if (keyId) {
      const revoked = await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/me/api-keys/${encodeURIComponent(keyId)}/revoke`
      );
      expect(revoked.ok(), `revoke status ${revoked.status()}`).toBe(true);
    }
  }
});
