import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pictures of the page of an agent, for a person to look at: its lead line, what shapes it
// (instructions, knowledge, tools, starter prompts) and the folded Settings, in German, light
// and dark, at 1280. It runs only with AGENT_PAGE_SHOTS=1 and writes to test-results/agent-page
// (AGENT_PAGE_SHOTS_DIR names another directory).
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const SHOTS = resolve(process.env.AGENT_PAGE_SHOTS_DIR ?? "test-results/agent-page");
const TITLE = "Vertragsprüfer";

const agentConfig = (name: string) => ({
  name,
  displayName: { de: TITLE, en: "Contract checker" },
  description: {
    de: "Prüft Verträge auf fehlende Unterschriften, Fristen und Anlagen.",
    en: "Checks contracts for missing signatures, deadlines and attachments."
  },
  welcomeMessage: {
    de: "Welchen Vertrag soll ich prüfen?",
    en: "Which contract should I check?"
  },
  modelBindingId: "primary",
  instructions: [
    "Du prüfst Verträge, die dir jemand hochlädt.",
    "",
    "1. Lies den Vertrag vollständig.",
    "2. Nenne fehlende Unterschriften, offene Fristen und fehlende Anlagen.",
    "3. Antworte kurz, in einer Liste, mit der Seite zu jedem Punkt.",
    "",
    "Wenn etwas unklar ist, frag nach, statt zu raten."
  ].join("\n"),
  initialPrompts: [
    {
      title: { de: "Vertrag prüfen", en: "Check a contract" },
      prompt: {
        de: "Prüfe den angehängten Vertrag auf fehlende Unterschriften.",
        en: "Check the attached contract for missing signatures."
      }
    },
    {
      title: { de: "Fristen auflisten", en: "List deadlines" },
      prompt: {
        de: "Welche Fristen nennt der angehängte Vertrag?",
        en: "Which deadlines does the attached contract name?"
      }
    }
  ]
});

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

/** Opens the page in German and one theme, and waits for its tools. */
async function view(page: Page, agent: string, theme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/build/agents/${agent}`);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
    window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
  }, theme);
  await page.reload();
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
  await expect(page.locator("section#tools")).toBeVisible();
  await expect(page.locator("[data-tool-loading]")).toHaveCount(0);
}

/**
 * The whole page in one picture. The content scrolls inside the page, not the window, so the
 * window is made as tall as the content first.
 */
async function picture(page: Page, label: string): Promise<void> {
  const extra = await page.locator("section#tools").evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflowY = getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        return parent.scrollHeight - parent.clientHeight;
      }
    }
    return 0;
  });
  await page.setViewportSize({ width: 1280, height: 900 + Math.max(0, extra) });
  await page.screenshot({
    path: resolve(SHOTS, `agent-page-${label}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

/** Unfolds a folded part of the page, where the page has it. */
async function unfold(page: Page, selector: string): Promise<boolean> {
  const trigger = page.locator(selector).first();
  if ((await trigger.count()) === 0) return false;
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return true;
}

test.describe("pictures of an agent's page", () => {
  test.skip(process.env.AGENT_PAGE_SHOTS !== "1", "Runs only with AGENT_PAGE_SHOTS=1.");

  test("de: the page light, dark and with Settings open", async ({ page }) => {
    test.setTimeout(180_000);
    const agent = `shots-${randomUUID().slice(0, 8)}`;
    const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${agent}`;
    await mkdir(SHOTS, { recursive: true });
    await signIn(page);
    const put = await requestWithOrigin(page, "put", agentUrl, {
      data: { expectedRevision: null, availableIn: "all", config: agentConfig(agent) }
    });
    expect(put.ok(), await put.text()).toBe(true);
    try {
      for (const theme of ["light", "dark"] as const) {
        await view(page, agent, theme);
        await picture(page, `de-${theme}`);
      }
      await view(page, agent, "light");
      if (await unfold(page, "[data-asset-settings-trigger]")) {
        await unfold(page, "[data-agent-advanced-trigger]");
        await picture(page, "de-light-settings");
      }
    } finally {
      await requestWithOrigin(page, "post", `${agentUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, agentUrl) }
      });
    }
  });
});
