import { randomUUID } from "node:crypto";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// UXA-4, the agent page as one form: the model section says what reasoning effort changes and
// why a default model cannot be changed, and an agent has one mark on the Agents page, in Studio
// and in the dock. Each test writes an agent of its own and deletes it by name. Every run keeps
// pictures of what changed, 1280 and 390 wide, in English and German, light and dark, as
// `uxa-4-*.png` in the test's output folder.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Reads and writes every agent of the instance, its models included. */
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** Writes every agent of the instance; the admin role does not change an agent's models. */
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;
const chatColumn = (page: Page) => page.locator("[data-dock-chat]");

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

/** Stores an agent on the default model of the suite, over whatever an earlier run left. */
async function putAgent(page: Page, name: string, displayName: string): Promise<void> {
  const stored = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      availableIn: "all",
      config: {
        name,
        displayName,
        description: "Checks contracts for missing signatures.",
        modelBindingId: "primary",
        instructions: "A probe of the agent page tests."
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

/** Deletes an agent if it is there. What a test leaves behind must not meet the next run. */
async function deleteAgent(page: Page, name: string): Promise<void> {
  const found = await page.request.get(agentPath(name));
  if (found.ok()) {
    await requestWithOrigin(page, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(page, agentPath(name)) }
    });
  }
}

/** What a reader sees of a mark: the glyph in it, its fill, its corners and its size. */
async function markOf(mark: Locator) {
  await expect(mark).toBeVisible();
  await expect(mark.locator("svg.lucide-bot")).toBeVisible();
  return mark.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      kind: element.getAttribute("data-kind"),
      glyph: element.querySelector("svg")?.innerHTML,
      fill: `${style.backgroundColor} ${style.backgroundImage}`,
      corners: style.borderRadius,
      size: element.getBoundingClientRect().width
    };
  });
}

/**
 * Pictures of one screen at 1280 and 390 pixels, in English and German, light and dark. The
 * language and the theme are read when the interface loads, so `open` loads the screen anew
 * for each and answers what to bring into view. The page is left light, in English, at 1280.
 */
async function shoot(
  page: Page,
  testInfo: TestInfo,
  surface: string,
  open: () => Promise<Locator>
): Promise<void> {
  const show = async (size: typeof WIDE, locale: string, theme: string) => {
    await page.evaluate(
      ([localeValue, themeValue]) => {
        window.localStorage.setItem("vivd-catalyst:locale", localeValue);
        window.localStorage.setItem("vivd-catalyst:theme", themeValue);
      },
      [locale, theme] as const
    );
    await page.setViewportSize(size);
    return open();
  };
  for (const size of [WIDE, PHONE]) {
    for (const locale of ["en", "de"]) {
      for (const theme of ["light", "dark"]) {
        const target = await show(size, locale, theme);
        await target.scrollIntoViewIfNeeded();
        const path = testInfo.outputPath(`uxa-4-${surface}-${size.width}-${locale}-${theme}.png`);
        await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach(`uxa-4-${surface}-${size.width}-${locale}-${theme}`, {
          path,
          contentType: "image/png"
        });
      }
    }
  }
  await show(WIDE, "en", "light");
}

// Fails without one mark: the Agents page drew the agent glyph, Studio's list the initials of
// the name, and the agent chip of the conversation a glyph on a fill of its own.
test("an agent has the same mark on the Agents page, in Studio and in the dock", async ({
  page,
  // The test stores an agent, which every workspace offers while it lives.
  instanceAgentsChange: _instanceAgentsChange
}, testInfo) => {
  test.setTimeout(300_000);
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_uxa4_mark_${tag}`;
  const displayName = `Contract check ${tag}`;
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  await putAgent(page, name, displayName);
  try {
    await page.goto("/");
    await expect(page).toHaveURL(/\/w\/[^/]+/u);
    const workspace = /\/w\/([^/?]+)/u.exec(page.url())?.[1] ?? "";

    const openAgents = async () => {
      await page.goto(`/w/${workspace}/agents`);
      return page
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name: displayName, exact: true }) });
    };
    const openStudio = async () => {
      await page.goto("/build/agents");
      return page.getByRole("listitem").filter({ hasText: displayName });
    };
    // A link to a conversation nobody has opens the dock empty, with the agent picker on its
    // start page; the person picks the agent there.
    const openDock = async () => {
      await page.goto(`/w/${workspace}/agents?chat=e2e_uxa4_missing_${tag}`);
      await expect(page).toHaveURL(new RegExp(`/w/${workspace}/agents$`, "u"));
      await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
      const chip = chatColumn(page).getByRole("button", {
        name: /^(Select agent|Agent auswählen): /u
      });
      if ((await chip.getAttribute("title")) !== displayName) {
        await chip.click();
        await page.getByRole("option", { name: displayName }).click();
      }
      await expect(chip).toHaveAttribute("title", displayName);
      return chip;
    };

    const onAgents = await markOf((await openAgents()).locator('[data-kind="agent"]'));
    const inStudio = await markOf((await openStudio()).locator('[data-kind="agent"]'));
    const inDock = await markOf((await openDock()).locator('[data-kind="agent"]').first());
    expect(onAgents.kind).toBe("agent");
    expect(inStudio).toEqual(onAgents);
    expect(inDock).toEqual(onAgents);

    await shoot(page, testInfo, "agents", openAgents);
    await shoot(page, testInfo, "studio", openStudio);
    await shoot(page, testInfo, "dock", openDock);
  } finally {
    await deleteAgent(page, name);
  }
});

// Fails without the sentences: the section explained reasoning effort in terms of model
// bindings, and a default model locked for the reader gave no reason.
test("the model section says what reasoning effort does and why the model is fixed", async ({
  page,
  instanceAgentsChange: _instanceAgentsChange
}, testInfo) => {
  test.setTimeout(300_000);
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_uxa4_model_${tag}`;
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  await putAgent(page, name, `Model probe ${tag}`);
  const effort = {
    en: "Reasoning effort is how long the model thinks before it answers; more helps with hard questions but takes longer.",
    de: "Der Denkaufwand bestimmt, wie lange das Modell vor der Antwort nachdenkt; mehr hilft bei schwierigen Fragen, dauert aber länger."
  };
  const fixed = { en: "Set by your instance.", de: "Von deiner Instanz festgelegt." };
  const openModel = async () => {
    await page.goto(`/build/agents/${name}`);
    const model = page.locator("section#model");
    await expect(model.getByRole("combobox").first()).toBeVisible();
    return model;
  };
  try {
    // Who may change the models reads the sentence on effort and no reason for a lock.
    const writable = await openModel();
    await expect(writable).toContainText(effort.en);
    await expect(writable).not.toContainText(fixed.en);
    await expect(writable.getByRole("combobox").first()).toBeEnabled();

    // Who may change the agent and not its models reads why the model stays as it is.
    await page.context().clearCookies();
    await signIn(page, admin);
    for (const locale of ["en", "de"] as const) {
      await page.evaluate(
        (value) => window.localStorage.setItem("vivd-catalyst:locale", value),
        locale
      );
      const model = await openModel();
      await expect(model).toContainText(effort[locale]);
      await expect(model).toContainText(fixed[locale]);
      await expect(model.getByRole("combobox").first()).toBeDisabled();
    }
    await shoot(page, testInfo, "model-section", openModel);
  } finally {
    await page.context().clearCookies();
    await signIn(page, superadmin);
    await deleteAgent(page, name);
  }
});
