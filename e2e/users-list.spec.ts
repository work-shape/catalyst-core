import type { Locator, Page, TestInfo } from "@playwright/test";
import { z } from "zod";
import { shoot as shootBothWays } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Instance > Users (UXA-5a, check 40): every full name stands at 1280 and reads at 390, the
// columns that do not fit fold into the details under the name, sign-in methods live in the
// person's detail, and a person invited who never signed in reads "Invited". Every picture is
// saved under the test's output as uxa-5a-*.png, for the design review.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};

const WORDS = {
  en: {
    search: "Search users",
    selectVisible: "Select visible users",
    invited: "Invited",
    active: "Active",
    lastActive: "Last active",
    never: "Never",
    selected: (count: number) => `${count} selected`,
    clearSelection: "Clear",
    settings: "Settings",
    signInMethods: "Sign-in methods",
    linkIdentity: "Link identity",
    emailVerified: "Email verified",
    summary: /^\d+ users · /u
  },
  de: {
    search: "Benutzer suchen",
    selectVisible: "Sichtbare Benutzer auswählen",
    invited: "Eingeladen",
    active: "Aktiv",
    lastActive: "Zuletzt aktiv",
    never: "Nie",
    selected: (count: number) => `${count} ausgewählt`,
    clearSelection: "Auswahl aufheben",
    settings: "Einstellungen",
    signInMethods: "Anmeldemethoden",
    linkIdentity: "Identität verknüpfen",
    emailVerified: "E-Mail bestätigt",
    summary: /^\d+ Benutzer · /u
  }
} as const;
type Locale = keyof typeof WORDS;

const WINDOWS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 }
] as const;

/** Two people of this test's own: one invited who never signed in, one who has. */
interface People {
  stamp: string;
  invited: { id: string; name: string; email: string };
  active: { id: string; name: string; email: string };
}

const createdSchema = z.object({ id: z.string() });

async function signInViaApi(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function createPeople(page: Page, testInfo: TestInfo): Promise<People> {
  const stamp = `uxa5a-${Date.now()}-${testInfo.workerIndex}`;
  const invited = {
    name: "Annemarie Schwarzenberger-Hohenlohe",
    email: `${stamp}-invited@example.test`
  };
  const active = {
    name: "Konstantin Papadopoulos-Lindqvist",
    email: `${stamp}-active@example.test`,
    password: `${stamp}-password`
  };
  const create = async (data: object) => {
    const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/instance/users`, {
      data
    });
    expect(response.ok()).toBe(true);
    return createdSchema.parse(await response.json()).id;
  };
  const invitedId = await create({
    displayLabel: invited.name,
    email: invited.email,
    roles: ["user"]
  });
  const activeId = await create({
    displayLabel: active.name,
    email: active.email,
    roles: ["user"],
    passwordSignIn: { password: active.password }
  });
  // The second person signs in once, in a request context of its own, so the page keeps the
  // superadmin's session.
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) {
    throw new Error("The users list spec needs the interface baseURL");
  }
  const own = await page.context().browser()?.newContext();
  if (!own) {
    throw new Error("The users list spec needs a browser for a second sign-in");
  }
  const signedIn = await own.request.post(`${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: active.email, password: active.password, rememberMe: true },
    headers: { Origin: new URL(baseURL).origin }
  });
  expect(signedIn.ok()).toBe(true);
  // Signing in creates the auth session; an authenticated product request resolves the
  // person's account and records their first sign-in in Catalyst.
  const resolved = await own.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(resolved.ok()).toBe(true);
  await own.close();
  return {
    stamp,
    invited: { id: invitedId, ...invited },
    active: { id: activeId, name: active.name, email: active.email }
  };
}

async function deletePeople(page: Page, people: People | undefined): Promise<void> {
  for (const id of [people?.invited.id, people?.active.id]) {
    if (id) {
      await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/instance/users/${id}`);
    }
  }
}

async function openList(
  page: Page,
  people: People,
  { locale, theme }: { locale: Locale; theme: "light" | "dark" }
): Promise<void> {
  await page.goto("/settings/instance/users");
  await page.evaluate(
    ({ locale, theme }) => {
      localStorage.setItem("vivd-catalyst:locale", locale);
      localStorage.setItem("vivd-catalyst:theme", theme);
    },
    { locale, theme }
  );
  await page.reload();
  await page.getByRole("searchbox", { name: WORDS[locale].search, exact: true }).fill(people.stamp);
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(2);
}

const usersTable = (page: Page) => page.locator('[data-slot="table-box"] table');
const rowOf = (page: Page, email: string) =>
  usersTable(page).locator("tbody tr").filter({ hasText: email });
const visibleText = (scope: Locator, text: string) =>
  scope.getByText(text, { exact: true }).filter({ visible: true });

/** The labels of the columns folded now, in column order. */
async function foldedHeads(page: Page): Promise<string[]> {
  return usersTable(page).locator("th[data-folded]").allTextContents();
}

/** The full name stands inside its cell and the window, cut nowhere, on one line if `oneLine`. */
async function expectFullName(row: Locator, name: string, width: number, oneLine: boolean) {
  const label = row.getByText(name, { exact: true });
  const fit = await label.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const cell = node.closest("td")?.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
    return {
      left: box.left,
      right: box.right,
      insideCell: cell !== undefined && box.left >= cell.left && box.right <= cell.right + 0.5,
      uncut: node.scrollWidth <= node.clientWidth,
      lines: Math.round(box.height / lineHeight)
    };
  });
  expect.soft(fit.left, `${name} at ${width}: starts in the window`).toBeGreaterThanOrEqual(0);
  expect.soft(fit.right, `${name} at ${width}: ends in the window`).toBeLessThanOrEqual(width);
  expect.soft(fit.insideCell, `${name} at ${width}: inside its cell`).toBe(true);
  expect.soft(fit.uncut, `${name} at ${width}: not cut`).toBe(true);
  if (oneLine) {
    expect.soft(fit.lines, `${name} at ${width}: on one line`).toBe(1);
  }
}

async function expectNoSidewaysScroll(page: Page, at: string): Promise<void> {
  const widths = await page.evaluate(() => {
    const box = document.querySelector('[data-slot="table-box"]');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      table: box ? box.scrollWidth - box.clientWidth : 0
    };
  });
  expect.soft(widths, `${at}: nothing scrolls sideways`).toEqual({ page: 0, table: 0 });
}

/** A picture with what differs between runs masked: the counts of all users and the times. */
async function shoot(page: Page, testInfo: TestInfo, name: string, people: People) {
  await page.screenshot({
    path: testInfo.outputPath(`uxa-5a-${name}.png`),
    animations: "disabled",
    mask: [
      page.getByText(WORDS.en.summary),
      page.getByText(WORDS.de.summary),
      page.getByText(new RegExp(people.stamp, "u")),
      page.getByRole("searchbox"),
      rowOf(page, people.active.email).locator("td").nth(4),
      rowOf(page, people.active.email).locator("dd").last()
    ]
  });
}

test("Instance > Users keeps every full name, folds the rest under it and shows who is invited", async ({
  page
}, testInfo) => {
  test.setTimeout(240_000);
  await signInViaApi(page);
  let people: People | undefined;
  try {
    people = await createPeople(page, testInfo);
    for (const locale of ["en", "de"] as const) {
      const words = WORDS[locale];
      for (const theme of ["light", "dark"] as const) {
        for (const window of WINDOWS) {
          const at = `${locale} ${theme} ${window.width}`;
          await page.setViewportSize(window);
          await openList(page, people, { locale, theme });
          const invited = rowOf(page, people.invited.email);
          const active = rowOf(page, people.active.email);

          await expectFullName(invited, people.invited.name, window.width, window.width >= 1280);
          await expectFullName(active, people.active.name, window.width, window.width >= 1280);
          await expectNoSidewaysScroll(page, at);
          await expect(visibleText(invited, words.invited)).toHaveCount(1);
          await expect(visibleText(active, words.active)).toHaveCount(1);
          await expect(visibleText(invited, words.active)).toHaveCount(0);
          // No column of sign-in methods; they live in the detail.
          await expect(
            usersTable(page).locator("th", { hasText: words.signInMethods })
          ).toHaveCount(0);

          // Every folded column's value stands in the details under the name, with its label.
          const folded = await foldedHeads(page);
          if (window.width < 1280) {
            expect
              .soft(folded, `${at}: the least important column folds first`)
              .toContain(words.lastActive);
          }
          const details = invited.locator('[data-slot="table-row-detail"]');
          if (folded.length > 0) {
            await expect(details).toBeVisible();
            for (const label of folded) {
              await expect(details.locator("dt", { hasText: label })).toBeVisible();
            }
          } else {
            await expect(details).toHaveCount(0);
          }
          await expect(visibleText(invited, words.never)).toHaveCount(1);
          await shoot(page, testInfo, `list-${window.width}-${theme}-${locale}`, people);

          // The detail: the status, the sign-in methods and the library's checkbox.
          await invited.getByText(people.invited.name, { exact: true }).click();
          await expect(page.getByRole("heading", { name: words.signInMethods })).toBeVisible();
          const settings = page.getByRole("region", { name: words.settings });
          await expect(visibleText(settings, words.invited)).toHaveCount(1);
          // The detail names the person, never by the account's id.
          await expect(settings.getByText(people.invited.id)).toHaveCount(0);
          await settings.getByRole("button", { name: words.linkIdentity, exact: true }).click();
          const verified = page.getByRole("checkbox", { name: words.emailVerified });
          await expect(verified).toHaveAttribute("aria-checked", "false");
          await verified.click();
          await expect(verified).toHaveAttribute("aria-checked", "true");
          await verified.scrollIntoViewIfNeeded();
          await expectNoSidewaysScroll(page, `${at} detail`);
          await shoot(page, testInfo, `detail-${window.width}-${theme}-${locale}`, people);
        }
      }
    }
  } finally {
    await deletePeople(page, people);
  }
});

test("the users list folds as its window narrows and unfolds as it widens, and selects and opens rows", async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  await signInViaApi(page);
  let people: People | undefined;
  try {
    people = await createPeople(page, testInfo);
    const words = WORDS.en;
    await page.setViewportSize(WINDOWS[0]);
    await openList(page, people, { locale: "en", theme: "light" });
    const wide = await foldedHeads(page);
    expect(wide).not.toContain("Status");

    // The same table, never reloaded: the box narrows, the table folds; it widens, it unfolds.
    await page.setViewportSize(WINDOWS[1]);
    await expect.poll(() => foldedHeads(page)).toContain(words.lastActive);
    const narrow = await foldedHeads(page);
    expect(narrow.length).toBeGreaterThan(wide.length);
    const invited = rowOf(page, people.invited.email);
    await expect(invited.locator('[data-slot="table-row-detail"]')).toContainText(words.never);
    await expectFullName(invited, people.invited.name, WINDOWS[1].width, false);
    await expectNoSidewaysScroll(page, "narrowed");

    // Selection works on the folded rows: one row, then the page through the mixed box.
    const all = page.getByRole("checkbox", { name: words.selectVisible });
    await invited.getByRole("checkbox").click();
    await expect(page.getByText(words.selected(1), { exact: true })).toBeVisible();
    await expect(all).toHaveAttribute("aria-checked", "mixed");
    await all.click();
    await expect(page.getByText(words.selected(2), { exact: true })).toBeVisible();
    await expect(all).toHaveAttribute("aria-checked", "true");
    await shoot(page, testInfo, "list-390-selected", people);
    await page.getByRole("button", { name: words.clearSelection }).click();
    await expect(all).toHaveAttribute("aria-checked", "false");

    await page.setViewportSize(WINDOWS[0]);
    await expect.poll(() => foldedHeads(page)).toEqual(wide);
    await expect(usersTable(page).locator("th", { hasText: "Status" })).toBeVisible();
    await expectFullName(invited, people.invited.name, WINDOWS[0].width, true);

    // A folded value opens the row like any other part of it.
    await page.setViewportSize(WINDOWS[1]);
    await expect.poll(() => foldedHeads(page)).toEqual(narrow);
    await invited.locator('[data-slot="table-row-detail"] dd').first().click();
    await expect(page.getByRole("heading", { name: words.signInMethods })).toBeVisible();
  } finally {
    await deletePeople(page, people);
  }
});

const GALLERY_WORDS = {
  en: { mode: "Mode", light: "Light", dark: "Dark" },
  de: { mode: "Modus", light: "Hell", dark: "Dunkel" }
} as const;

test("the library's table sample folds into its rows' details as its window narrows", async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  await signInViaApi(page);
  await page.setViewportSize(WINDOWS[0]);
  await page.goto("/ui-library");
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name: "Data", exact: true })
    .click();
  const sample = page.locator('[data-gallery-sample="filter-table"]').first();
  for (const window of WINDOWS) {
    // The same sample, never reloaded, so the narrow pictures also prove the table refits.
    await page.setViewportSize(window);
    for (const locale of ["en", "de"] as const) {
      const words = GALLERY_WORDS[locale];
      await page
        .getByRole("group", { name: /^(Language|Sprache)$/u })
        .getByRole("button", { name: locale.toUpperCase(), exact: true })
        .click();
      for (const theme of ["light", "dark"] as const) {
        const at = `gallery ${window.width} ${theme} ${locale}`;
        const mode = page
          .getByRole("group", { name: words.mode, exact: true })
          .getByRole("button", { name: words[theme], exact: true });
        await mode.click();
        await expect(mode).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(`[data-gallery-mode="${theme}"]`).first()).toBeVisible();
        await sample.scrollIntoViewIfNeeded();
        if (window.width < 1280) {
          await expect(sample.locator("th[data-folded]").first()).toBeAttached();
          await expect(sample.locator('[data-slot="table-row-detail"]').first()).toBeVisible();
        }
        expect
          .soft(
            await sample
              .locator('[data-slot="table-box"]')
              .evaluate((node) => node.scrollWidth - node.clientWidth),
            `${at}: the sample scrolls sideways`
          )
          .toBe(0);
        await sample.screenshot({
          path: testInfo.outputPath(`uxa-5a-gallery-table-${window.width}-${theme}-${locale}.png`),
          animations: "disabled"
        });
      }
    }
  }
});

test("the new user form's sign-in choices toggle by Space and by a click on their label", async ({
  page
}) => {
  await signInViaApi(page);
  await page.goto("/settings/instance/users");
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New user" });
  const invite = dialog.getByRole("checkbox", {
    name: "Email an invitation to set a password",
    exact: true
  });
  const passwordSignIn = dialog.getByRole("checkbox", {
    name: "Create password sign-in",
    exact: true
  });
  const initialPassword = dialog.getByText("Initial password", { exact: true });
  // An instance that sends invitations offers that choice first, and on.
  if ((await invite.count()) > 0) {
    await expect(invite).toBeChecked();
    await invite.focus();
    await page.keyboard.press("Space");
    await expect(invite).not.toBeChecked();
  }

  const wasChecked = await passwordSignIn.isChecked();
  await passwordSignIn.focus();
  await page.keyboard.press("Space");
  await expect(passwordSignIn).toBeChecked({ checked: !wasChecked });
  await expect(passwordSignIn).toBeFocused();

  await dialog.getByText("Create password sign-in", { exact: true }).click();
  await expect(passwordSignIn).toBeChecked({ checked: wasChecked });
  await expect(initialPassword).toBeVisible({ visible: wasChecked });

  await shootBothWays(
    page,
    "ui-lib-1-user-create",
    async () => {
      await page.getByRole("button", { name: /^(New user|Neuer Benutzer)$/u }).click();
      await expect(page.getByRole("dialog").getByRole("checkbox").first()).toBeVisible();
    },
    [1280, 390]
  );
});
