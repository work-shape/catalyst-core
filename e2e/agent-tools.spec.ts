import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import {
  addToolPackage,
  closeToolPackage,
  openToolPackage,
  removeToolPackage,
  toolChip
} from "./tool-packages";

// The tools on an agent's page as chips, the way its Skills are (TOOLS-1 variant B,
// navigation-and-layout checks 6 and 34): a chip per package, per own tool and per Connection,
// "1/2" while partly on, a panel per chip with its tools, read_skill shown as included once the
// agent has a skill, a picker that adds packages with all their tools on, and the ids under
// "Technical details". Fails without the change: the section was a flat list of ids.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of the section go. Unset, none is taken. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const SHOT_SIZE = { width: 1280, height: 900 };
const agentName = "e2e_tools1_probe";
const skillName = "e2e-tools1-skill";
const agentPath = `${apiBaseUrl}/api/v1/assets/agent/${agentName}`;
const skillPath = `${apiBaseUrl}/api/v1/assets/skill/${skillName}`;
const storedAgentSchema = z.object({
  config: z.object({ toolNames: z.array(z.string()), skillNames: z.array(z.string()) })
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function deleteAsset(page: Page, path: string): Promise<void> {
  if ((await page.request.get(path)).ok()) {
    await requestWithOrigin(page, "post", `${path}/delete`, {
      data: { expectedRevision: await assetRevision(page, path) }
    });
  }
}

/** The probe agent; with its skill it also holds read_skill, as a save from the page leaves it. */
async function putAgent(page: Page, withSkill = false): Promise<void> {
  const toolNames = ["show_view", "propose_skill_change", "demo.workflow_summary"];
  const answer = await requestWithOrigin(page, "put", agentPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath),
      config: {
        name: agentName,
        displayName: "Tools probe",
        modelProviderId: "local",
        instructions: "A probe of the grouped tools.",
        toolNames: withSkill ? [...toolNames, "read_skill"] : toolNames,
        ...(withSkill ? { skillNames: [skillName] } : {})
      }
    }
  });
  expect(answer.ok()).toBe(true);
}

async function putSkill(page: Page): Promise<void> {
  const answer = await requestWithOrigin(page, "put", skillPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, skillPath),
      config: {
        name: skillName,
        title: "Tools probe skill",
        description: "Use for the tools probe.",
        content: "# Steps"
      }
    }
  });
  expect(answer.ok()).toBe(true);
}

/** The keys of the chips in the order they stand. */
async function chipKeys(page: Page): Promise<(string | null)[]> {
  return page
    .locator("#tools [data-tool-package]")
    .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("data-tool-package")));
}

test.describe("the Tools section of an agent, as chips", () => {
  // Each test stores and deletes an agent of its own, so it takes its turn on the agents.
  test.beforeEach(async ({ page, instanceAgentsChange: _instanceAgentsChange }) => {
    await signIn(page);
    await deleteAsset(page, agentPath);
    await putSkill(page);
    await putAgent(page);
  });

  test.afterEach(async ({ page }) => {
    await deleteAsset(page, agentPath);
    await deleteAsset(page, skillPath);
  });

  test("shows a chip per package with its count, opens its tools, adds from the picker, includes read_skill and keeps the ids in the technical details", async ({
    page
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(SHOT_SIZE);
    await page.goto(`/build/agents/${agentName}`);
    const tools = page.locator("#tools");
    await expect(tools).toContainText(
      "What the agent can do. It always acts with the rights of the person it works for."
    );

    // A chip per package in use, then the instance's own tool, by its id where it has no title.
    // The chips stand once the references are there; until then the section is loading.
    await expect(toolChip(tools, "package:results")).toBeVisible();
    expect(await chipKeys(page)).toEqual([
      "package:results",
      "package:skills",
      "own:demo.workflow_summary"
    ]);
    await expect(toolChip(tools, "package:results")).toContainText("Results1/2");
    await expect(toolChip(tools, "own:demo.workflow_summary")).toHaveText(
      /^demo\.workflow_summary/u
    );
    // At rest the page shows no check box and no id of a package's tool.
    await expect(tools.getByRole("checkbox")).toHaveCount(0);
    await expect(tools).not.toContainText("show_view");

    // The panel of Results: its sentence and its tools, one of them on.
    let results = await openToolPackage(page, tools, "package:results");
    await expect(results).toContainText(
      "Shows and keeps results: widgets, Pages and recorded facts."
    );
    await expect(results.getByRole("checkbox", { name: "Show inline widget" })).toBeChecked();
    await expect(results).toContainText(
      "Shows a small table, chart or overview inside its answer."
    );
    await expect(results.getByRole("checkbox", { name: "Save page" })).not.toBeChecked();
    // "All on" turns every tool of it on, and the chip loses its count.
    await results.getByRole("button", { name: "All on" }).click();
    await expect(results.getByRole("checkbox", { name: "Save page" })).toBeChecked();
    await expect(toolChip(tools, "package:results")).toHaveText(/^Results$/u);
    // "Remove package" takes all of it off, and the picker offers it again.
    await results.getByRole("button", { name: "Remove package" }).click();
    await expect(toolChip(tools, "package:results")).toHaveCount(0);

    // The picker offers what is not in use, with its sentence and its number of tools.
    await tools.getByRole("button", { name: "Tools: Add packages" }).click();
    const picker = page.getByRole("dialog");
    await expect(picker.getByRole("option", { name: /^Files and code/u })).toContainText("2 tools");
    await expect(picker.getByRole("option", { name: /^Weather forecast/u })).toContainText(
      "Gives a sample weather forecast for planning trips and appointments."
    );
    await expect(picker.getByRole("option", { name: /^Skills/u })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    // Added, a package comes with all its tools on; its panel takes one off again.
    await addToolPackage(page, tools, "Results");
    await expect(toolChip(tools, "package:results")).toHaveText(/^Results$/u);
    results = await openToolPackage(page, tools, "package:results");
    await results.getByRole("checkbox", { name: "Save page" }).uncheck();
    await closeToolPackage(page);
    await expect(toolChip(tools, "package:results")).toContainText("1/2");
    // An own tool is a chip of its own, added and removed as one.
    await addToolPackage(page, tools, "Weather forecast");
    await expect(toolChip(tools, "own:demo.weather_forecast")).toHaveText(/^Weather forecast$/u);
    await removeToolPackage(tools, "own:demo.weather_forecast");

    // Without a skill, read_skill is a check box like any other.
    let skills = await openToolPackage(page, tools, "package:skills");
    await expect(skills.getByRole("checkbox", { name: "Read assigned skill" })).not.toBeChecked();
    await closeToolPackage(page);
    // With a skill it is included, has no check box, and the chip is fully on.
    await page
      .locator("section#skills")
      .getByRole("button", { name: "Skills: Choose skills" })
      .click();
    const skillPicker = page.getByRole("dialog");
    await skillPicker.getByRole("option", { name: "Tools probe skill" }).click();
    await page.keyboard.press("Escape");
    await expect(skillPicker).toBeHidden();
    await expect(toolChip(tools, "package:skills")).toHaveText(/^Skills$/u);
    skills = await openToolPackage(page, tools, "package:skills");
    const included = skills.locator('[data-included-tool="read_skill"]');
    await expect(included).toContainText("Read assigned skill");
    await expect(included).toContainText("Included");
    await expect(included).toContainText("Comes with the agent's skills.");
    await expect(skills.getByRole("checkbox", { name: "Read assigned skill" })).toHaveCount(0);
    await expect(skills.getByRole("checkbox", { name: "Propose skill change" })).toBeChecked();
    await closeToolPackage(page);

    // The ids, effects and packages stand under "Technical details", closed by default.
    const details = tools.locator("[data-tool-technical-details]");
    await expect(details.getByRole("table")).toHaveCount(0);
    await details.getByRole("button", { name: "Technical details" }).click();
    const table = details.getByRole("table");
    await expect(
      table.getByRole("row", { name: /Show inline widget show_view Reads Core/u })
    ).toBeVisible();
    await expect(
      table.getByRole("row", { name: /Save page page\.save Changes Apps/u })
    ).toBeVisible();

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname.endsWith(agentName)
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const stored = await page.request.get(agentPath);
    const { config } = storedAgentSchema.parse(await stored.json());
    expect(config.skillNames).toEqual([skillName]);
    expect(config.toolNames).toContain("read_skill");
    expect(config.toolNames).toContain("show_view");
    expect(config.toolNames).not.toContain("page.save");
  });

  // Taken over from the verifier's probe (TOOLS-1 verify, a43a5a15): the page asked for the
  // references and drew each tool by its id as an own chip until they arrived.
  test("shows no tool by its id as an own chip while the references are on their way", async ({
    page
  }) => {
    await page.setViewportSize(SHOT_SIZE);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/context/references**", async (route) => {
      await held;
      await route.continue();
    });
    try {
      await page.goto(`/build/agents/${agentName}#tools`);
      const tools = page.locator("#tools");
      await expect(tools.locator("[data-tool-loading]")).toBeAttached();
      await expect(tools.locator("[data-tool-package]")).toHaveCount(0);
      release();
      // Once they arrive the chips stand by package, never a platform tool by its id.
      await expect(toolChip(tools, "package:results")).toBeVisible();
      await expect(tools.locator("[data-tool-loading]")).toHaveCount(0);
      expect(await chipKeys(page)).not.toContain("own:show_view");
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  for (const theme of ["light", "dark"] as const) {
    for (const locale of ["en", "de"] as const) {
      test(`pictures of the Tools section (${locale}, ${theme})`, async ({ page }) => {
        test.skip(!shotsDir, "Pictures are taken only with E2E_SHOTS_DIR");
        await page.addInitScript(
          ([chosenTheme, chosenLocale]) => {
            window.localStorage.setItem("vivd-catalyst:theme", chosenTheme);
            window.localStorage.setItem("vivd-catalyst:locale", chosenLocale);
          },
          [theme, locale] as const
        );
        await putAgent(page, true);
        await page.setViewportSize(SHOT_SIZE);
        await page.goto(`/build/agents/${agentName}#tools`);
        const tools = page.locator("#tools");
        await expect(toolChip(tools, "package:results")).toBeVisible();
        // The section at the top of the view, below the page's head.
        await tools.evaluate((section) => {
          let scroller = section.parentElement;
          while (scroller && !/auto|scroll/u.test(getComputedStyle(scroller).overflowY)) {
            scroller = scroller.parentElement;
          }
          const top = section.getBoundingClientRect().top - 260;
          scroller?.scrollBy({ top, behavior: "instant" });
        });
        if (!shotsDir) return;
        await mkdir(shotsDir, { recursive: true });
        const shot = (part: string) =>
          page.screenshot({
            path: join(shotsDir, `agent-tools-${locale}-${theme}-1280-${part}.png`),
            animations: "disabled"
          });
        await openToolPackage(page, tools, "package:results");
        await shot("panel");
        await closeToolPackage(page);
        await openToolPackage(page, tools, "package:skills");
        await shot("included");
        await closeToolPackage(page);
        await tools.getByRole("button", { name: /^(Tools|Werkzeuge): / }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await shot("picker");
        await page.keyboard.press("Escape");
        await tools.locator("[data-tool-technical-details] button[aria-expanded]").click();
        await expect(tools.getByRole("table")).toBeVisible();
        await shot("details");
      });
    }
  }
});
