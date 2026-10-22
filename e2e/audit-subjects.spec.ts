import { type Page } from "@playwright/test";
import { apiBaseUrl, reviewer, shoot, signIn } from "./inbox-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// UXA-1b3 (navigation-and-layout section 4.16): the audit page's "Betrifft" says what an event
// is about in words, an asset by its title, never by its name or id. Fails without UXA-1b3: the
// column showed the subject as the row stores it.

const skillName = "e2e-uxa1b3-audit-skill";
const skillTitle = "Prüfbericht für das Audit";
const skillPath = `${apiBaseUrl}/api/v1/assets/skill/${skillName}`;

async function putSkill(page: Page): Promise<void> {
  const answer = await requestWithOrigin(page, "put", skillPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, skillPath),
      config: {
        name: skillName,
        title: skillTitle,
        description: "Use for the audit subjects probe.",
        content: "# Steps"
      }
    }
  });
  expect(answer.ok()).toBe(true);
}

const settingsRegion = (page: Page) =>
  page.getByRole("region", { name: /^(Settings|Einstellungen)$/u });

/** The audit page with its activities opened, newest first, until the probe's event shows. */
async function openAudit(page: Page): Promise<void> {
  const settings = settingsRegion(page);
  const rows = settings.locator("button[data-audit-activity]");
  await expect(rows.first()).toBeVisible();
  const cell = settings.getByRole("cell", { name: `Skill: ${skillTitle}`, exact: true }).first();
  // The newest activities are this page's own reads and the probe's write.
  for (let index = 0; index < Math.min(4, await rows.count()); index += 1) {
    if (await cell.isVisible()) return;
    await rows.nth(index).click();
  }
}

test("the audit page says what an event is about by the asset's title, in German", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, reviewer);
  await putSkill(page);
  try {
    await page.goto("/settings/instance/audit");
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await openAudit(page);
    const settings = settingsRegion(page);
    await expect(settings.getByRole("columnheader", { name: "Betrifft" }).first()).toBeVisible();
    await expect(
      settings.getByRole("cell", { name: `Skill: ${skillTitle}`, exact: true }).first()
    ).toBeVisible();
    await expect(settings.getByText(skillName)).toHaveCount(0);
    // The correlation id stands folded under "Technische Details".
    await expect(settings.getByText(/Korrelations-ID/u)).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Technische Details" }).first()
    ).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 1300 });
    await shoot(page, "uxa-1b3-audit", () => openAudit(page));
  } finally {
    await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
    if ((await page.request.get(skillPath)).ok()) {
      await requestWithOrigin(page, "post", `${skillPath}/delete`, {
        data: { expectedRevision: await assetRevision(page, skillPath) }
      });
    }
  }
});
