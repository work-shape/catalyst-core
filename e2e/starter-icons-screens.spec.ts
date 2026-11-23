import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pictures of an agent's starters, for a person to look at: the empty chat with four starters
// that carry icons, with nine and with twelve (folded, and whole after "Mehr") at 1280 and at
// phone width, and the Agent page with the icon picker of a starter open, in German, light and
// dark. It runs only with STARTER_ICON_SHOTS=1
// and writes to test-results/starter-icons (STARTER_ICON_SHOTS_DIR names another directory).
// With STARTER_ICON_SHOTS_PLAIN=1 it takes only the chat with four starters and writes no icon,
// which is the picture of a release from before starters took icons.
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const SHOTS = resolve(process.env.STARTER_ICON_SHOTS_DIR ?? "test-results/starter-icons");

const STARTERS = [
  ["Woche planen", "Plane meine Woche aus diesen Terminen:", "calendar"],
  ["E-Mail beantworten", "Schreib eine freundliche Antwort auf diese E-Mail:", "mail"],
  ["Dokument zusammenfassen", "Fasse dieses Dokument in fünf Sätzen zusammen:", "file-text"],
  ["Ideen sammeln", "Sammle zehn Ideen zu diesem Thema:", "lightbulb"],
  ["Besprechung vorbereiten", "Bereite eine Tagesordnung für diese Besprechung vor:", "users"],
  ["Rechnung nachrechnen", "Rechne diese Aufstellung nach und nenne Abweichungen:", "calculator"],
  ["Vertrag prüfen", "Prüfe diesen Vertrag auf fehlende Angaben:", "file-signature"],
  ["Anfahrt beschreiben", "Beschreibe den Weg zu dieser Adresse:", "map-pin"],
  ["Text überarbeiten", "Überarbeite diesen Text, kürzer und klarer:", "pencil"],
  ["Angebote vergleichen", "Vergleiche diese beiden Angebote:", "percent"],
  ["Ziel festlegen", "Hilf mir, ein Ziel für dieses Quartal festzulegen:", "target"],
  ["Quelle finden", "Finde eine verlässliche Quelle für diese Aussage:", "search"]
] as const;

const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

async function putAgent(page: Page, name: string, displayName: string, count: number) {
  const stored = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: null,
      availableIn: "all",
      config: {
        name,
        displayName,
        description: "Hilft bei der täglichen Büroarbeit.",
        welcomeMessage: "Womit fangen wir an?",
        modelBindingId: "primary",
        instructions: "Help with everyday office work.",
        initialPrompts: STARTERS.slice(0, count).map(([title, prompt, icon]) => ({
          title,
          prompt,
          // Before starters took icons, a write with one is refused.
          ...(process.env.STARTER_ICON_SHOTS_PLAIN === "1" ? {} : { icon })
        }))
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

async function deleteAgent(page: Page, name: string): Promise<void> {
  if ((await page.request.get(agentPath(name))).ok()) {
    await requestWithOrigin(page, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(page, agentPath(name)) }
    });
  }
}

async function open(
  page: Page,
  path: string,
  theme: "light" | "dark",
  size: { width: number; height: number }
): Promise<void> {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
  }, theme);
  await page.reload();
}

/** The empty chat with one agent picked. */
async function emptyChat(
  page: Page,
  displayName: string,
  theme: "light" | "dark",
  size: { width: number; height: number }
): Promise<void> {
  await open(page, "/", theme, size);
  const agent = page
    .getByRole("region", { name: "Chat" })
    .getByRole("button", { name: /^Agent auswählen/u });
  await agent.click();
  await page.getByRole("option", { name: displayName }).click();
  await expect(agent).toHaveAccessibleName(`Agent auswählen: ${displayName}`);
  await expect(page.getByRole("group", { name: "Vorschläge für den Einstieg" })).toBeVisible();
}

const shot = (page: Page, label: string) =>
  page.screenshot({ path: resolve(SHOTS, `${label}.png`), animations: "disabled" });

test.describe("pictures of an agent's starters", () => {
  test.skip(process.env.STARTER_ICON_SHOTS !== "1", "Runs only with STARTER_ICON_SHOTS=1.");

  test("de: four, nine and twelve starters, at phone width, and the icon picker", async ({
    page,
    instanceAgentsChange: _instanceAgentsChange
  }) => {
    test.setTimeout(300_000);
    const tag = randomUUID().slice(0, 8);
    const four = { name: `shots_four_${tag}`, title: `Büroassistenz ${tag.slice(0, 4)}` };
    const nine = { name: `shots_nine_${tag}`, title: `Büroassistenz neun ${tag.slice(0, 4)}` };
    const twelve = { name: `shots_twelve_${tag}`, title: `Büroassistenz zwölf ${tag.slice(0, 4)}` };
    const wide = { width: 1280, height: 900 };
    const phone = { width: 390, height: 844 };
    await mkdir(SHOTS, { recursive: true });
    await signIn(page);
    await putAgent(page, four.name, four.title, 4);
    await putAgent(page, nine.name, nine.title, 9);
    await putAgent(page, twelve.name, twelve.title, 12);
    try {
      for (const theme of ["light", "dark"] as const) {
        await emptyChat(page, four.title, theme, wide);
        await shot(page, `chat-4-${theme}`);
        if (process.env.STARTER_ICON_SHOTS_PLAIN === "1") continue;

        for (const [label, size] of [
          ["", wide],
          ["-phone", phone]
        ] as const) {
          // Nine show whole.
          await emptyChat(page, nine.title, theme, size);
          await expect(page.getByRole("button", { name: /Text überarbeiten/u })).toBeVisible();
          await expect(page.getByRole("button", { name: "Mehr", exact: true })).toHaveCount(0);
          await shot(page, `chat-9${label}-${theme}`);

          // Twelve show nine, and the rest after "Mehr".
          await emptyChat(page, twelve.title, theme, size);
          await expect(page.getByRole("button", { name: /Angebote vergleichen/u })).toHaveCount(0);
          await shot(page, `chat-12${label}-${theme}`);
          await page.getByRole("button", { name: "Mehr", exact: true }).click();
          await expect(page.getByRole("button", { name: /Quelle finden/u })).toBeVisible();
          await page.mouse.move(0, 0);
          await shot(page, `chat-12${label}-${theme}-more`);
        }

        // Tall enough for the whole picker under its button.
        await open(page, `/build/agents/${four.name}`, theme, { width: 1280, height: 1200 });
        const picker = page.getByRole("button", { name: /^Symbol von Vorschlag 1:/u });
        await picker.scrollIntoViewIfNeeded();
        await expect(picker).toHaveAccessibleName("Symbol von Vorschlag 1: Kalender");
        await picker.click();
        await expect(page.locator('[data-icon-option="calendar"]')).toHaveAttribute(
          "aria-pressed",
          "true"
        );
        await shot(page, `agent-page-icon-picker-${theme}`);
        // Choosing another icon closes the grid and the button shows it.
        await page.locator('[data-icon-option="mail"]').click();
        await expect(picker).toHaveAccessibleName("Symbol von Vorschlag 1: E-Mail");
      }
    } finally {
      await deleteAgent(page, four.name);
      await deleteAgent(page, nine.name);
      await deleteAgent(page, twelve.name);
    }
  });
});
