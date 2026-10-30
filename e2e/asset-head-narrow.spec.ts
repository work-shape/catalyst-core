import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The head of an asset page keeps its actions on the screen in a phone's width: what has no room
// beside the name stands in the "…" menu, and no control reaches past the window. Checked on a
// skill, whose Replace and History fold, and on an agent with a draft, whose Publish stays.

const shotsDir = process.env.E2E_SHOTS_DIR;

/** Every control of the page head lies inside the window, and the page does not scroll sideways. */
async function expectHeadInWindow(page: Page, width: number): Promise<void> {
  const head = page.locator("[data-page-head]");
  await expect(head).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const controls = [
          ...document.querySelectorAll("[data-page-head] button, [data-page-head] a")
        ];
        return {
          widest: Math.max(0, ...controls.map((control) => control.getBoundingClientRect().right)),
          page: document.documentElement.scrollWidth
        };
      })
    )
    .toEqual({ widest: expect.any(Number), page: width });
  const { widest } = await page.evaluate(() => ({
    widest: Math.max(
      0,
      ...[...document.querySelectorAll("[data-page-head] button, [data-page-head] a")].map(
        (control) => control.getBoundingClientRect().right
      )
    )
  }));
  expect(widest).toBeLessThanOrEqual(width);
}

async function shoot(page: Page, name: string, named = false): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, named ? `${name}-de.png` : `${name}-de-390.png`),
    animations: "disabled"
  });
}

test("the head of a skill and of an agent with a draft keeps its actions in the window at 390 px", async ({
  page
}) => {
  await signIn(page, reviewer);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const skill = `head_narrow_${tag}`;
  const made = await requestWithOrigin(page, "put", `${apiBaseUrl}/api/v1/assets/skill/${skill}`, {
    data: {
      expectedRevision: null,
      config: {
        name: skill,
        title: `Angebotsprüfung ${tag}`,
        description: "Meine Schritte.",
        content: "# Schritte\n"
      }
    }
  });
  expect(made.ok(), await made.text()).toBe(true);

  const agent = `head_narrow_agent_${tag}`;
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${agent}`;
  const config = (instructions: string) => ({
    name: agent,
    displayName: "Vertragsprüfung mit einem langen Namen",
    description: "Prüft Verträge.",
    modelBindingId: "primary",
    instructions
  });
  const live = await requestWithOrigin(page, "put", agentUrl, {
    data: { expectedRevision: null, availableIn: "all", config: config("eins") }
  });
  expect(live.ok(), await live.text()).toBe(true);
  const { revision } = z
    .object({ revision: z.number() })
    .parse(await (await page.request.get(agentUrl)).json());
  // A second save writes the agent's draft: the head then carries Publish.
  const draft = await requestWithOrigin(page, "put", agentUrl, {
    data: { expectedRevision: revision, expectedDraftRevision: null, config: config("zwei") }
  });
  expect(draft.ok(), await draft.text()).toBe(true);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/build/skills/${skill}`);
    await expect(page.getByRole("heading", { name: `Angebotsprüfung ${tag}` })).toBeVisible();
    await expectHeadInWindow(page, width);
    // Neither action fits beside the name: both stand in the "…" menu.
    await expect(page.getByRole("button", { name: "Verlauf", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Weitere Aktionen" }).first().click();
    await expect(page.getByRole("menuitem", { name: "Verlauf" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Aus Ordner ersetzen" })).toBeVisible();
    if (width === 390) {
      await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
      await shoot(page, "head-skill-menu");
    }
    await page.keyboard.press("Escape");

    await page.goto(`/build/agents/${agent}`);
    await expect(page.getByRole("button", { name: "Veröffentlichen" })).toBeVisible();
    // The state stays beside the name however narrow the window.
    await expect(page.locator('[data-asset-status="draft"]')).toBeInViewport();
    await expectHeadInWindow(page, width);
    if (width === 390) await shoot(page, "head-agent-draft");
  }

  // The head says each thing once: one state after the name, one muted line under it, Publish
  // as its one primary button and every other action in "…". The description, the chips and
  // the draft banner are gone; the text's live version shows in its own box.
  const head = page.locator("[data-page-head]");
  const instructions = page.locator("section#instructions");
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [390, 1440]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/build/agents/${agent}`);
      await expect(head.locator('[data-asset-status="draft"]')).toHaveText("Entwurf · nicht live");
      await expect(head.locator("[data-asset-status]")).toHaveCount(1);
      await expect(head.locator("[data-asset-place]")).toHaveText(/ · für alle$/u);
      await expect(head).not.toContainText("Prüft Verträge.");
      await expect(head.locator('[data-slot="page-header-chips"]')).toHaveCount(0);
      await expect(page.locator('[data-agent-draft="pending"]')).toHaveCount(0);
      await expect(head.getByRole("button", { name: "Verlauf", exact: true })).toHaveCount(0);
      await expect(head.getByRole("button", { name: "Ausprobieren", exact: true })).toHaveCount(0);
      await expect(instructions).toContainText("Weicht an einer Stelle von Live ab");
      await shoot(page, `head-agent-${scheme}-${String(width)}`, true);

      // The state's popover names the draft and the live version, and leads to the changes.
      await head.locator('[data-asset-status="draft"]').click();
      const sentence = page.locator("[data-asset-status-sentence]");
      await expect(sentence).toContainText(
        /^Entwurfsversion \d+ von .+\. Live ist Version \d+\.$/u
      );
      await shoot(page, `head-agent-status-${scheme}-${String(width)}`, true);
      await page.getByRole("button", { name: "Unterschiede ansehen", exact: true }).click();
      await expect(sentence).toHaveCount(0);
      await expect(instructions.locator("[data-versioned-text-changes]")).toBeVisible();
      await expect(instructions.getByRole("radio", { name: "Unterschiede" })).toBeChecked();
      await shoot(page, `head-agent-changes-${scheme}-${String(width)}`, true);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });

  // "Chat" and "Try" are one: beside an agent with a draft, Chat opens Try, which runs the draft.
  await page.goto(`/build/agents/${agent}`);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByTestId("dock-tabs").getByRole("tab", { name: "Ausprobieren", exact: true })
  ).toHaveAttribute("aria-selected", "true");
});
