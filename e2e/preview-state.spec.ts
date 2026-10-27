import type { Locator, Page } from "@playwright/test";
import type { AppFromPageResponse } from "@work-shape/catalyst-api-contract";
import { z } from "zod";
import {
  builtPage,
  pageSource,
  pageSurface,
  savePage,
  writePageFiles
} from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// The state line of a preview names what the reader may know of it (PREVIEW-1): a Page no App
// holds is not saved yet and offers Save as app, the checkout of an App the reader may only read
// names that App and offers no save, and the checkout of an App the reader may not see names
// nothing, and the checkout of an App the reader may write names it and offers Save to draft and
// Open app. The member may write Apps in the workspace, so the missing saves are not for want of
// that right. Fails without the reader's standing: both checkouts read "not saved yet" and
// offered Save as app. The two checkouts are the instance's answer about this real Page, given
// by the test; that the instance answers them to such readers is the server's tests.

/** The admin of `tests/fixtures/e2e-users/apps.yaml`, who may write Apps in a new workspace. */
const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const APP_TITLE = "Umsatzübersicht";
const idSchema = z.object({ id: z.string() });

/** The address of `apps.get_from_page` for any Page. */
const FROM_PAGE = /\/api\/v1\/conversations\/[^/]+\/pages\/[^/]+\/app(?:\?|$)/u;

/**
 * Answers `apps.get_from_page` for every Page as the instance would to this reader. With `slow`
 * the first answer takes about a second, as a slow instance's would.
 */
async function answerFromPage(
  page: Page,
  answer: AppFromPageResponse,
  slow = false
): Promise<void> {
  await page.unroute(FROM_PAGE);
  let held = slow;
  await page.route(FROM_PAGE, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (held) {
      held = false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.fulfill({ json: answer });
  });
}

/**
 * Notes every state the preview passes through, as `standing:offered saves`, from the first
 * paint of each load, so a state shown for one frame is noted too.
 */
async function noteStates(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript((saves) => {
    if (window.top !== window) return;
    const names = new RegExp(saves, "u");
    const seen: string[] = [];
    Object.assign(window, { previewStates: seen });
    new MutationObserver(() => {
      const surface = document.querySelector('aside[data-surface-kind="page"]');
      const line = surface?.querySelector('[data-testid="preview-state"]');
      if (!surface || !line) return;
      const offered = [...surface.querySelectorAll("button")]
        .map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim())
        .filter((name) => names.test(name));
      const state = `${line.getAttribute("data-standing")}:${[...new Set(offered)].sort().join("|")}`;
      if (seen.at(-1) !== state) seen.push(state);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  }, SAVES.source);
  return async () =>
    z.array(z.string()).parse(await page.evaluate(() => Reflect.get(window, "previewStates")));
}

/** Scrolls the element of `region` that scrolls to its end; whether it got there. */
function scrollToEnd(region: Locator): Promise<boolean> {
  return region.evaluate((root) => {
    const scroller = [root, ...root.querySelectorAll("*")].find(
      (element) =>
        element.scrollHeight > element.clientHeight + 1 &&
        /auto|scroll/u.test(getComputedStyle(element).overflowY)
    );
    if (!scroller) return false;
    scroller.scrollTop = scroller.scrollHeight;
    return (
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 &&
      scroller.getBoundingClientRect().bottom <= window.innerHeight
    );
  });
}

/** Loads the conversation again, in a language, and opens the Page from its card. */
async function reopen(page: Page, locale: "en" | "de"): Promise<void> {
  await page.evaluate(
    (chosen) => window.localStorage.setItem("vivd-catalyst:locale", chosen),
    locale
  );
  await page.reload();
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: /^(?:Open|Öffnen)$/u }).click();
  await expect(pageSurface(page)).toBeVisible();
}

const SAVES =
  /^(?:Save as app|Als App speichern|Save to draft|Im Entwurf speichern|Open app|App öffnen)$/u;

test("the state line of a preview names what the reader may know, and offers a save only to whoever may make it", async ({
  page
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Preview reader" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  const states = await noteStates(page);
  await page.goto(`/w/${workspaceId}`);
  await writePageFiles(page, pageSource("Revenue overview"));
  await savePage(page);
  const surface = pageSurface(page);
  const line = surface.getByTestId("preview-state");
  const saves = surface.getByRole("button", { name: SAVES });

  // A Page no App holds, as the instance answers it: not saved yet, and Save as app.
  await expect(line).toHaveAttribute("data-standing", "unsaved");
  await expect(line).toHaveText("Preview · not saved yet");
  await expect(surface.getByRole("button", { name: "Save as app", exact: true })).toBeVisible();

  // The checkout of an App the reader may write: the App's name, Open app and Save to draft. The
  // first answer is slow: until it comes the line holds its room and offers nothing, and it never
  // reads "not saved yet" on the way.
  const app = {
    name: "umsatz",
    title: APP_TITLE,
    workspaceId,
    draftRevision: 1,
    draftFromPage: true
  };
  await answerFromPage(page, { preview: { kind: "app", title: APP_TITLE }, app }, true);
  for (const [locale, text, openApp, saveToDraft] of [
    [
      "en",
      `Preview of “${APP_TITLE}” · data stores and workflows run only in the app`,
      "Open app",
      "Save to draft"
    ],
    [
      "de",
      `Vorschau von „${APP_TITLE}“ · Datenspeicher und Workflows laufen nur in der App`,
      "App öffnen",
      "Im Entwurf speichern"
    ]
  ] as const) {
    await reopen(page, locale);
    if (locale === "en") {
      await expect(line).toHaveAttribute("data-standing", "unknown");
      await expect(saves).toHaveCount(0);
    }
    await expect(line).toHaveAttribute("data-standing", "app");
    await expect(line).toHaveText(text);
    await expect(surface.getByRole("button", { name: openApp, exact: true })).toBeVisible();
    await expect(surface.getByRole("button", { name: saveToDraft, exact: true })).toBeVisible();
    await expect(saves).toHaveCount(2);
    if (locale === "en") {
      const seen = await states();
      expect(seen[0]).toBe("unknown:");
      expect(seen.filter((state) => state.startsWith("unknown:"))).toEqual(["unknown:"]);
      expect(seen.filter((state) => state.startsWith("unsaved:"))).toEqual([]);
      expect(seen.at(-1)).toBe("app:Open app|Save to draft");
    }
  }

  // Preview and Files, twice: the line and the saves stay, and the preview keeps its Page.
  await reopen(page, "en");
  const heading = builtPage(page).getByRole("heading", { name: "Revenue overview" });
  await expect(heading).toBeVisible();
  for (let round = 0; round < 2; round += 1) {
    await surface.getByRole("radio", { name: "Files" }).click();
    await expect(surface.getByRole("navigation", { name: "Source files" })).toBeVisible();
    await expect(line).toHaveAttribute("data-standing", "app");
    await expect(saves).toHaveCount(2);
    await surface.getByRole("radio", { name: "Preview" }).click();
    await expect(heading).toBeVisible();
    await expect(line).toHaveAttribute("data-standing", "app");
    await expect(saves).toHaveCount(2);
  }

  // On a short screen the longest file reads to its end, and the line stays above it.
  await page.setViewportSize({ width: 1280, height: 480 });
  await surface.getByRole("radio", { name: "Files" }).click();
  await surface
    .getByRole("navigation", { name: "Source files" })
    .getByText("src/routes/data.tsx")
    .click();
  const source = surface.getByRole("region", { name: "src/routes/data.tsx" });
  await expect(source).toContainText("createFileRoute");
  expect(await scrollToEnd(source)).toBe(true);
  await expect(line).toBeInViewport({ ratio: 1 });
  await surface.getByRole("radio", { name: "Preview" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // The checkout of an App the reader may read and not write: the App's name, and no save.
  await answerFromPage(page, { preview: { kind: "app", title: APP_TITLE }, app: null });
  for (const [locale, text] of [
    ["en", `Preview of “${APP_TITLE}” · data stores and workflows run only in the app`],
    ["de", `Vorschau von „${APP_TITLE}“ · Datenspeicher und Workflows laufen nur in der App`]
  ] as const) {
    await reopen(page, locale);
    await expect(line).toHaveAttribute("data-standing", "app");
    await expect(line).toHaveText(text);
    await expect(saves).toHaveCount(0);
  }

  // The same at a phone's width and in dark: the preview covers the conversation, the line wraps
  // whole inside the screen, takes the dark theme, and still offers no save.
  const lightBackground = await line.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await reopen(page, "en");
  await expect(page.locator("html")).toHaveAttribute("data-vivd-theme", "dark");
  await expect(surface).toHaveAttribute("data-surface-mode", "covering");
  await expect(line).toHaveAttribute("data-standing", "app");
  await expect(line).toHaveText(
    `Preview of “${APP_TITLE}” · data stores and workflows run only in the app`
  );
  await expect(line).toBeInViewport({ ratio: 1 });
  expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await line.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    lightBackground
  );
  await expect(saves).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });

  // The checkout of an App the reader may not see: a preview, no name, and no save.
  await answerFromPage(page, { preview: { kind: "neutral" }, app: null });
  for (const [locale, text] of [
    ["en", "Preview"],
    ["de", "Vorschau"]
  ] as const) {
    await reopen(page, locale);
    await expect(line).toHaveAttribute("data-standing", "neutral");
    await expect(line).toHaveText(text);
    await expect(saves).toHaveCount(0);
    await expect(page.getByText(APP_TITLE)).toHaveCount(0);
  }
});
