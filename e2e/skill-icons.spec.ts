import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of the Skills row, its chooser and the Skills list go. Unset, none is taken. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };
const NOTE = "A skill is instructions the agent follows. It adds no tools.";
const skillPath = (name: string) => `${apiBaseUrl}/api/v1/assets/skill/${name}`;

/**
 * Skills of this spec's own. Each is a custom skill, also the one named like a skill the
 * platform ships. The last has no summary.
 */
const skills = [
  {
    name: "ti2-spreadsheets",
    title: "Spreadsheets",
    summary:
      "Knows how to build a spreadsheet that calculates, and to check it before handing it over."
  },
  {
    name: "ti2-documents",
    title: "Documents",
    summary: "Knows how to lay out a Word document and check it page by page."
  },
  {
    name: "ti2-presentations",
    title: "Presentations",
    summary: "Knows how to build a deck and check every slide."
  },
  {
    name: "pdf",
    title: "PDF",
    summary: "Knows how to read, fill and assemble PDFs, and to verify the result."
  },
  {
    name: "ti2-plain-language",
    title: "Plain language",
    summary: "Knows how to write short, easy sentences in German and English."
  },
  { name: "ti2-house-style", title: "House style", summary: undefined }
] as const;

async function signInViaApi(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function deleteSkill(admin: Page, name: string): Promise<void> {
  const found = await admin.request.get(skillPath(name));
  if (found.ok()) {
    await requestWithOrigin(admin, "post", `${skillPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(admin, skillPath(name)) }
    });
  }
}

async function putSkill(admin: Page, skill: (typeof skills)[number]): Promise<void> {
  const answer = await requestWithOrigin(admin, "put", skillPath(skill.name), {
    data: {
      expectedRevision: await assetBaseRevision(admin, skillPath(skill.name)),
      config: {
        name: skill.name,
        title: skill.title,
        description: `Use for ${skill.title}. Written for the agent, shown to nobody in a list.`,
        ...(skill.summary === undefined ? {} : { summary: skill.summary }),
        content: "# Steps"
      }
    }
  });
  expect(answer.ok()).toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  }
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

for (const theme of ["dark", "light"] as const) {
  test(`skills say what an agent knows how to do, in the agent editor and the Skills list (${theme})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(
      (chosen) => window.localStorage.setItem("vivd-catalyst:theme", chosen),
      theme
    );
    await signInViaApi(page);
    for (const skill of skills) {
      await deleteSkill(page, skill.name);
      await putSkill(page, skill);
    }
    try {
      await page.setViewportSize(WIDE);
      // The agent is only read: what is chosen below stays in the form and is never saved.
      await page.goto("/build/agents/application_assistant#skills");
      const section = page.locator("section#skills");
      await section.getByRole("button", { name: "Skills: Choose skills" }).click();
      const picker = page.getByRole("dialog");
      await expect(picker).toHaveAccessibleDescription(NOTE);
      await expect(picker.getByText(NOTE)).toBeVisible();

      // Each row says the skill's sentence for people, and neither its id nor the agent's text.
      for (const skill of skills) {
        const option = picker.getByRole("option", { name: skill.title, exact: false }).first();
        await expect(option).toBeVisible();
        if (skill.summary !== undefined) {
          await expect(option).toContainText(skill.summary);
        }
        await expect(option).not.toContainText(skill.name === "pdf" ? "Use for" : skill.name);
        await expect(option).not.toContainText("Written for the agent");
        // Every skill here is a custom one: the generic icon, hidden beside the title.
        const icon = option.locator("[data-skill-icon]");
        await expect(icon).toHaveAttribute("data-skill-icon", "generic");
        await expect(icon).toHaveAttribute("aria-hidden", "true");
        await expect(option.locator("[data-file-type]")).toHaveCount(0);
      }
      // A skill without a summary shows its title alone.
      await expect(picker.getByRole("option", { name: "House style" })).toHaveText("House style");

      // The id is not shown and still finds the skill.
      const search = picker.getByRole("combobox");
      await search.fill("ti2-house");
      await expect(picker.getByRole("option")).toHaveCount(1);
      await expect(picker.getByRole("option", { name: "House style" })).toBeVisible();
      await search.fill("");

      // Choosing adds a chip with the skill's icon; the chooser stays open.
      for (const title of ["Spreadsheets", "Documents", "Presentations", "PDF"]) {
        await picker.getByRole("option", { name: title }).first().click();
      }
      const chips = section.getByRole("list", { name: "Skills" }).getByRole("listitem");
      await expect(chips).toHaveCount(4);
      await expect(chips.locator('[data-skill-icon="generic"]')).toHaveCount(4);
      await expect(chips.filter({ hasText: "PDF" }).locator("[data-file-type]")).toHaveCount(0);
      await expect(picker).toBeVisible();

      // Reopened with the row at the top of the page, the chooser has the room below it.
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await section.evaluate((row) => {
        // Clear of the page's header, which lies over the top of what scrolls.
        row.style.scrollMarginTop = "6rem";
        row.scrollIntoView({ block: "start" });
      });
      await section.getByRole("button", { name: "Skills: Choose skills" }).click();
      await expect(picker.getByText(NOTE)).toBeVisible();
      await expect(chips).toHaveCount(4);
      await shot(page, `agent-skills-${theme}-1440`);

      // In a narrow window the chooser fits the window.
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await page.setViewportSize(NARROW);
      await section.getByRole("button", { name: "Skills: Choose skills" }).click();
      await expect(picker.getByText(NOTE)).toBeVisible();
      await expectNoSidewaysScroll(page);
      const box = await picker.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= NARROW.width).toBe(true);
      await shot(page, `agent-skills-${theme}-390`);
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();

      // The Skills list: the summary under the title, and no id.
      await page.setViewportSize(WIDE);
      await page.goto("/build/skills");
      const list = page.getByRole("list", { name: "Skills" });
      const row = (title: string) => list.getByRole("listitem").filter({ hasText: title });
      await expect(row("Plain language")).toContainText(
        "Knows how to write short, easy sentences in German and English."
      );
      await expect(row("House style").getByRole("link")).toHaveText(/^House style/u);
      await expect(row("House style")).not.toContainText("ti2-house-style");
      await expect(list.locator("code")).toHaveCount(0);
      await expect(row("PDF").locator("[data-skill-icon]")).toHaveAttribute(
        "data-skill-icon",
        "generic"
      );
      await shot(page, `skills-list-${theme}-1440`);

      // The skill's page holds the summary as a field of its own, beside the agent's text.
      await row("Plain language").getByRole("link").click();
      await expect(page.locator("form").getByRole("textbox", { name: /^Summary/u })).toHaveValue(
        "Knows how to write short, easy sentences in German and English."
      );
    } finally {
      for (const skill of skills) {
        await deleteSkill(page, skill.name);
      }
    }
  });
}

test("the chooser of skills says in German that a skill adds no tools", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await signInViaApi(page);
  await page.setViewportSize(WIDE);
  await page.goto("/build/agents/application_assistant#skills");
  await page
    .locator("section#skills")
    .getByRole("button", { name: /^Skills: / })
    .click();
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(
    "Ein Skill ist eine Anleitung, der der Agent folgt. Er bringt keine Werkzeuge mit."
  );
  await shot(page, "agent-skills-de-light-1440");
});

test("the gallery's picker of skills shows a shipped skill's page bare and the generic book on its tile", async ({
  page
}) => {
  const theme = process.env.E2E_SHOTS_THEME === "dark" ? "Dark" : "Light";
  await signInViaApi(page);
  await page.setViewportSize(WIDE);
  await page.goto("/ui-library");
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name: "Overlays", exact: true })
    .click();
  await page.getByRole("group", { name: "Mode" }).getByRole("button", { name: theme }).click();
  await page.locator('[data-gallery-entry="Picker"] [data-gallery-sample="picker-skills"]').click();
  const picker = page.getByRole("dialog");
  await expect(picker).toHaveAccessibleDescription(NOTE);

  const pdf = picker.getByRole("option", { name: "PDF" });
  await expect(pdf.locator('[data-skill-icon="pdf"] [data-file-type="pdf"]')).toBeVisible();
  await expect(pdf.locator("[data-skill-icon]")).toHaveAttribute("aria-hidden", "true");
  await expect(pdf).toContainText("Knows how to read, fill and assemble PDFs");
  const plain = picker.getByRole("option", { name: "Plain language" });
  await expect(plain.locator('[data-skill-icon="generic"]')).toBeVisible();
  await expect(plain.locator("[data-file-type]")).toHaveCount(0);
  // A page stands bare on the row; the generic book sits on the neutral tile. Neither has a
  // border of its own.
  const style = (row: typeof pdf) =>
    row.locator("[data-skill-icon]").evaluate((element) => {
      const computed = getComputedStyle(element);
      return [computed.backgroundColor, computed.borderTopWidth];
    });
  expect(await style(pdf)).toEqual(["rgba(0, 0, 0, 0)", "0px"]);
  const [tileBackground, tileBorder] = await style(plain);
  expect(tileBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(tileBorder).toBe("0px");
  // A skill without a sentence shows its title alone.
  await expect(picker.getByRole("option", { name: "Offer structure" })).toHaveText(
    "Offer structure"
  );
  // The technical name is not shown and still finds the skill.
  await picker.getByRole("combobox").fill("plain-language");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await picker.getByRole("combobox").fill("");
  await shot(page, `gallery-skill-picker-${theme.toLowerCase()}-1440`);
});
