import type { Page, Route, TestInfo } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";
import { requestAnswered } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "workflow-or-agent-that-is-not-there",
        reason:
          "Chromium's own log line: the tests open the address of a Workflow and of an agent that " +
          "do not exist, the instance answers 404 and the page shows the not-found state.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/assets\/(?:workflow\/e2e-missing-workflow|agent\/e2e_missing_agent)$/u,
        tests: [
          "a Workflow that is not there waits for the answer, then says so and leads to the list",
          "an agent's address without an agent waits for the answer, then says so without the id",
          "pictures of the not-found state on each surface, wide and narrow, light and dark, in both languages"
        ]
      }
    ]
  }
});

/** Ids nobody creates: the instance answers 404 for each, as it does for a deleted one. */
const MISSING_WORKFLOW = "e2e-missing-workflow";
const MISSING_AGENT = "e2e_missing_agent";

const idSchema = z.object({ id: z.string() });
const locales = ["en", "de"] as const;
const themes = ["light", "dark"] as const;
const widths = [1280, 390] as const;
type Locale = (typeof locales)[number];

const words = {
  en: {
    route: "There is no page at this address.",
    toChat: "To chat",
    workflow: "There is no workflow at this address.",
    toWorkflows: "Back to Workflows",
    agent: "There is no agent at this address.",
    toAgents: "Back to Agents"
  },
  de: {
    route: "Unter dieser Adresse gibt es keine Seite.",
    toChat: "Zum Chat",
    workflow: "Unter dieser Adresse gibt es keinen Workflow.",
    toWorkflows: "Zurück zu Workflows",
    agent: "Unter dieser Adresse gibt es keinen Agenten.",
    toAgents: "Zurück zu Agenten"
  }
} satisfies Record<Locale, Record<string, string>>;

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
}

async function createWorkspace(page: Page): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Not found" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

/**
 * Holds the first read of `path` until `release` is called, then lets the instance answer it.
 * `held` settles once the page has asked, so a check made after it sees the page waiting.
 */
async function holdRead(page: Page, path: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached = () => {};
  const held = new Promise<void>((resolve) => (reached = resolve));
  let first = true;
  await page.route(
    (url) => url.pathname === path,
    async (route: Route) => {
      if (first) {
        first = false;
        reached();
        await released;
      }
      await route.continue();
    }
  );
  return { held, release };
}

function notFound(page: Page) {
  return page.locator("[data-not-found]");
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("an unknown address says so where it was typed and leads to the chat", async ({ page }) => {
  await signIn(page);
  // A Workflow's address names its workspace: without it there is no such page.
  await page.goto("/workflows/unknown");
  const sentence = notFound(page).getByRole("heading", { level: 1 });
  await expect(sentence).toHaveText(words.en.route);
  // The area puts the focus on the sentence, the page's title, without a focus ring.
  await expect(sentence).toBeFocused();
  await expect(sentence).toHaveCSS("outline-style", "none");
  // The address stays as it was typed; nothing leads it to the chat by itself.
  await expect(page).toHaveURL(/\/workflows\/unknown$/u);

  await notFound(page).getByRole("button", { name: words.en.toChat, exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(notFound(page)).toHaveCount(0);

  // Back returns to the address and to what it says.
  await page.goBack();
  await expect(page).toHaveURL(/\/workflows\/unknown$/u);
  await expect(notFound(page).getByRole("heading", { level: 1 })).toHaveText(words.en.route);
});

test("a Workflow that is not there waits for the answer, then says so and leads to the list", async ({
  page
}) => {
  await signIn(page);
  const workspaceId = await createWorkspace(page);
  const read = await holdRead(page, `/api/v1/assets/workflow/${MISSING_WORKFLOW}`);
  await page.goto(`/w/${workspaceId}/workflows/${MISSING_WORKFLOW}`);
  await read.held;

  // Waiting is not missing: the head stands with its placeholder and no sentence yet.
  const workflowPage = page.getByTestId("workflow-page");
  await expect(workflowPage.locator('header[data-variant="detail"]')).toHaveCount(1);
  await expect(notFound(page)).toHaveCount(0);

  // The instance's own refusal of the read is what turns the page into the not-found state.
  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/v1/assets/workflow/${MISSING_WORKFLOW}`
  );
  read.release();
  expect((await answered).status()).toBe(404);
  await expect(notFound(page).getByRole("heading", { level: 1 })).toHaveText(words.en.workflow);
  await expect(notFound(page).getByRole("heading", { level: 1 })).toBeFocused();
  await expect(notFound(page).getByRole("heading", { level: 1 })).toHaveCSS(
    "outline-style",
    "none"
  );
  await expect(workflowPage.locator('header[data-variant="detail"]')).toHaveCount(0);
  await expect(page.getByText(MISSING_WORKFLOW)).toHaveCount(0);

  await notFound(page).getByRole("link", { name: words.en.toWorkflows, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/workflows$`, "u"));
  await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
  await expect(notFound(page)).toHaveCount(0);
});

test("an agent's address without an agent waits for the answer, then says so without the id", async ({
  page
}) => {
  await signIn(page);
  const read = await holdRead(page, `/api/v1/assets/agent/${MISSING_AGENT}`);
  await page.goto(`/build/agents/${MISSING_AGENT}`);
  await read.held;
  await expect(notFound(page)).toHaveCount(0);

  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/v1/assets/agent/${MISSING_AGENT}`
  );
  read.release();
  expect((await answered).status()).toBe(404);
  await expect(notFound(page).getByRole("heading", { level: 1 })).toHaveText(words.en.agent);
  // The page has one title, the sentence, and never the id of the address.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByText(MISSING_AGENT)).toHaveCount(0);

  await notFound(page).getByRole("link", { name: words.en.toAgents, exact: true }).click();
  await expect(page).toHaveURL(/\/build\/agents$/u);
  await expect(notFound(page)).toHaveCount(0);
});

/** Attaches a picture of the window to the test's report, where the review reads it. */
async function attachShot(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(`uxa-6a/${name}.png`, {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png"
  });
}

test("pictures of the not-found state on each surface, wide and narrow, light and dark, in both languages", async ({
  page
}, testInfo) => {
  test.setTimeout(300_000);
  await signIn(page);
  const workspaceId = await createWorkspace(page);
  const surfaces = [
    {
      name: "route",
      path: "/workflows/unknown",
      sentence: "route",
      action: "toChat",
      role: "button"
    },
    {
      name: "workflow",
      path: `/w/${workspaceId}/workflows/${MISSING_WORKFLOW}`,
      sentence: "workflow",
      action: "toWorkflows",
      role: "link"
    },
    {
      name: "agent",
      path: `/build/agents/${MISSING_AGENT}`,
      sentence: "agent",
      action: "toAgents",
      role: "link"
    }
  ] as const;
  await page.goto("/");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 640 });
    for (const locale of locales) {
      for (const theme of themes) {
        await page.evaluate(
          ([chosenLocale, chosenTheme]) => {
            localStorage.setItem("vivd-catalyst:locale", chosenLocale);
            localStorage.setItem("vivd-catalyst:theme", chosenTheme);
          },
          [locale, theme] as const
        );
        for (const surface of surfaces) {
          await page.goto(surface.path);
          const state = notFound(page);
          await expect(state.getByRole("heading", { level: 1 })).toHaveText(
            words[locale][surface.sentence]
          );
          // The one step is in the window, whole, at every width.
          await expect(
            state.getByRole(surface.role, { name: words[locale][surface.action], exact: true })
          ).toBeInViewport({ ratio: 1 });
          await expect(page.locator("html")).toHaveAttribute("data-vivd-theme", theme);
          await attachShot(testInfo, page, `${surface.name}-${String(width)}-${theme}-${locale}`);
        }
      }
    }
  }
});

test("the library's not-found sample in the gallery, wide and narrow, light and dark, in both languages", async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.goto("/ui-library");
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name: "Feedback", exact: true })
    .click();
  const sample = page.locator('[data-gallery-entry="NotFound"]');
  // The gallery's own switches: the first group is the mode, the second the language.
  const switches = page.locator("[data-ui-gallery] header [role=group]");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 640 });
    for (const locale of locales) {
      await switches
        .nth(1)
        .getByRole("button", { name: locale.toUpperCase(), exact: true })
        .click();
      for (const theme of themes) {
        const mode = switches
          .nth(0)
          .getByRole("button")
          .nth(theme === "light" ? 0 : 1);
        await mode.click();
        await expect(mode).toHaveAttribute("aria-pressed", "true");
        await expect(sample.getByRole("heading", { level: 1 })).toHaveText(words[locale].agent);
        await sample.scrollIntoViewIfNeeded();
        await expect(sample.getByRole("button", { name: words[locale].toAgents })).toBeInViewport({
          ratio: 1
        });
        await attachShot(testInfo, page, `gallery-${String(width)}-${theme}-${locale}`);
      }
    }
  }
});
