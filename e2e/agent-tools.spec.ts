import { readAgentDraft } from "./request-with-origin";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import {
  closeToolPackage,
  openToolPackage,
  switchToolPackage,
  toolRow,
  toolRowSwitch
} from "./tool-packages";

// The tools on an agent's page as rows (TOOLS-1 variant A, navigation-and-layout checks 6 and
// 34): a row per package, per own tool and per Connection, those the agent uses none of too,
// each with its count, a switch that is mixed while only some of its tools are on and its tools
// folded below, read_skill shown as included once the agent has a skill, the heading's count
// the rows' sum, and the ids under "Technical details". Fails without the change: the section
// showed the packages in use as chips.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of the section go. Unset, none is taken. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const SHOT_SIZE = { width: 1280, height: 900 };
const NARROW_SIZE = { width: 390, height: 844 };
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

/** The keys of the rows in the order they stand. */
async function rowKeys(page: Page): Promise<(string | null)[]> {
  return page
    .locator("#tools [data-tool-package]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-tool-package")));
}

/** The count a row shows, "1/2". */
const rowCount = (tools: Locator, key: string) => toolRow(tools, key).locator("[data-tool-count]");

test.describe("the Tools section of an agent, as rows", () => {
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

  test("shows a row per package with its count and switch, folds out its tools, includes read_skill and keeps the ids in the technical details", async ({
    page
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(SHOT_SIZE);
    await page.goto(`/build/agents/${agentName}`);
    const tools = page.locator("#tools");
    await expect(tools).toContainText(
      "What the agent can do. It always acts with the rights of the person it works for."
    );

    // A row per package, the ones the agent uses none of too, then the instance's own tools,
    // by their id where they have no title. The rows stand once the references are there.
    await expect(toolRow(tools, "package:results")).toBeVisible();
    const keys = await rowKeys(page);
    expect(keys).toEqual(
      expect.arrayContaining([
        "package:files",
        "package:results",
        "package:skills",
        "own:demo.workflow_summary",
        "own:demo.weather_forecast"
      ])
    );
    expect(keys.indexOf("package:skills")).toBeLessThan(keys.indexOf("own:demo.workflow_summary"));
    await expect(tools.getByRole("heading", { name: "This instance", level: 3 })).toBeVisible();
    await expect(rowCount(tools, "package:files")).toHaveText("0/2");
    await expect(toolRowSwitch(tools, "package:files")).toHaveAttribute("aria-checked", "false");
    await expect(rowCount(tools, "package:results")).toHaveText("1/2");
    await expect(toolRowSwitch(tools, "package:results")).toHaveAttribute("aria-checked", "mixed");
    // What a screen reader hears: partly on, not off.
    await expect(toolRowSwitch(tools, "package:results")).toMatchAriaSnapshot(
      '- checkbox "All tools of Results" [checked=mixed]'
    );
    await expect(toolRowSwitch(tools, "package:files")).toMatchAriaSnapshot(
      '- checkbox "All tools of Files and code" [checked=false]'
    );
    await expect(toolRow(tools, "package:results")).toContainText(
      "Shows and keeps results: cards, previews, apps and recorded facts."
    );
    await expect(toolRow(tools, "own:demo.workflow_summary")).toContainText(
      "demo.workflow_summary"
    );
    await expect(rowCount(tools, "own:demo.workflow_summary")).toHaveText("1/1");
    // At rest the page shows no check box and no id of a package's tool.
    await expect(tools.locator("[data-package-tool]")).toHaveCount(0);
    await expect(tools).not.toContainText("show_view");

    // Results folded out: its tools, one of them on.
    const results = await openToolPackage(tools, "package:results");
    await expect(results.getByRole("checkbox", { name: "Show inline widget" })).toBeChecked();
    await expect(results).toContainText(
      "Shows a small table, chart or overview inside its answer."
    );
    await expect(results.getByRole("checkbox", { name: "Open in preview" })).not.toBeChecked();
    // The mixed switch turns every tool of it on, and then all off; the row stays.
    await switchToolPackage(tools, "package:results", true);
    await expect(results.getByRole("checkbox", { name: "Open in preview" })).toBeChecked();
    await expect(rowCount(tools, "package:results")).toHaveText("2/2");
    await switchToolPackage(tools, "package:results", false);
    await expect(rowCount(tools, "package:results")).toHaveText("0/2");
    await expect(results.getByRole("checkbox", { name: "Show inline widget" })).not.toBeChecked();
    // One check box makes it partly on again.
    await results.getByRole("checkbox", { name: "Show inline widget" }).check();
    await expect(toolRowSwitch(tools, "package:results")).toHaveAttribute("aria-checked", "mixed");
    await closeToolPackage(tools, "package:results");
    // An own tool is a row of its own, switched as one.
    await switchToolPackage(tools, "own:demo.weather_forecast", true);
    await expect(rowCount(tools, "own:demo.weather_forecast")).toHaveText("1/1");
    await switchToolPackage(tools, "own:demo.weather_forecast", false);

    // Without a skill, read_skill is a check box like any other.
    let skills = await openToolPackage(tools, "package:skills");
    await expect(skills.getByRole("checkbox", { name: "Read assigned skill" })).not.toBeChecked();
    await closeToolPackage(tools, "package:skills");
    // With a skill it is included and has no check box, and the row is fully on.
    await page
      .locator("section#skills")
      .getByRole("button", { name: "Skills: Choose skills" })
      .click();
    const skillPicker = page.getByRole("dialog");
    await skillPicker.getByRole("option", { name: "Tools probe skill" }).click();
    await page.keyboard.press("Escape");
    await expect(skillPicker).toBeHidden();
    await expect(rowCount(tools, "package:skills")).toHaveText("2/2");
    await expect(toolRowSwitch(tools, "package:skills")).toHaveAttribute("aria-checked", "true");
    skills = await openToolPackage(tools, "package:skills");
    const included = skills.locator('[data-included-tool="read_skill"]');
    await expect(included).toContainText("Read assigned skill");
    await expect(included).toContainText("Included");
    await expect(included).toContainText("Comes with the agent's skills.");
    await expect(skills.getByRole("checkbox", { name: "Read assigned skill" })).toHaveCount(0);
    await expect(skills.getByRole("checkbox", { name: "Propose skill change" })).toBeChecked();
    await closeToolPackage(tools, "package:skills");

    // The heading counts the tools that are on: what the rows add up to.
    const counts = await tools
      .locator("[data-tool-count]")
      .evaluateAll((spans) => spans.map((span) => Number(span.textContent?.split("/")[0])));
    const sum = counts.reduce((total, count) => total + count, 0);
    await expect(tools.getByRole("heading", { name: "Tools", level: 2 }).locator("+ *")).toHaveText(
      String(sum)
    );

    // The ids, effects and packages stand under "Technical details", closed by default.
    const details = tools.locator("[data-tool-technical-details]");
    await expect(details.getByRole("table")).toHaveCount(0);
    await details.getByRole("button", { name: "Technical details" }).click();
    const table = details.getByRole("table");
    await expect(
      table.getByRole("row", { name: /Show inline widget show_view Reads Core/u })
    ).toBeVisible();
    await expect(
      table.getByRole("row", { name: /Open in preview workspace\.open Changes Apps/u })
    ).toBeVisible();

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname.endsWith(agentName)
    );
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const { config } = storedAgentSchema.parse(await readAgentDraft(page, agentPath));
    expect(config.skillNames).toEqual([skillName]);
    expect(config.toolNames).toContain("read_skill");
    expect(config.toolNames).toContain("show_view");
    expect(config.toolNames).not.toContain("workspace.open");
    expect(config.toolNames).not.toContain("demo.weather_forecast");
  });

  // Taken over from the verifier's probe (TOOLS-1 verify, a43a5a15): the page asked for the
  // references and drew each tool by its id as an own tool until they arrived.
  test("shows no tool by its id as an own row while the references are on their way", async ({
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
      // Once they arrive the rows stand by package, never a platform tool by its id.
      await expect(toolRow(tools, "package:results")).toBeVisible();
      await expect(tools.locator("[data-tool-loading]")).toHaveCount(0);
      expect(await rowKeys(page)).not.toContain("own:show_view");
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  for (const locale of ["de", "en"] as const) {
    test(`pictures of the Tools section (${locale}, light)`, async ({ page }) => {
      test.skip(!shotsDir, "Pictures are taken only with E2E_SHOTS_DIR");
      await page.addInitScript((chosenLocale) => {
        window.localStorage.setItem("vivd-catalyst:theme", "light");
        window.localStorage.setItem("vivd-catalyst:locale", chosenLocale);
      }, locale);
      await putAgent(page, true);
      if (!shotsDir) return;
      await mkdir(shotsDir, { recursive: true });
      await page.setViewportSize(SHOT_SIZE);
      await page.goto(`/build/agents/${agentName}#tools`);
      const tools = page.locator("#tools");
      await expect(toolRow(tools, "package:results")).toBeVisible();
      // Results is partly on, and folded out.
      await openToolPackage(tools, "package:results");
      for (const size of [SHOT_SIZE, NARROW_SIZE]) {
        await page.setViewportSize(size);
        // The section at the top of the view, below the page's head.
        await tools.evaluate((section) => {
          let scroller = section.parentElement;
          while (scroller && !/auto|scroll/u.test(getComputedStyle(scroller).overflowY)) {
            scroller = scroller.parentElement;
          }
          const top = section.getBoundingClientRect().top - 260;
          scroller?.scrollBy({ top, behavior: "instant" });
        });
        await page.screenshot({
          path: join(shotsDir, `agent-tools-${locale}-light-${size.width}.png`),
          animations: "disabled"
        });
        await tools.screenshot({
          path: join(shotsDir, `agent-tools-${locale}-light-${size.width}-section.png`),
          animations: "disabled"
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
          )
        ).toBe(true);
      }
    });
  }
});
