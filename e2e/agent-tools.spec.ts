import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";

// The instance's tools on an agent's page, by package (TOOLS-1, navigation-and-layout checks 6
// and 34): one group per package with its icon, sentence and switch, its tools folded below
// with title and summary, read_skill shown as included once the agent has a skill, and the ids
// under "Technical details". Fails without the change: the section was a flat list of ids.

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

const group = (tools: Locator, name: string) =>
  tools.locator(`[data-instance-tool-group="${name}"]`);

/** Unfolds a group's tools and answers the list of them. */
async function unfold(tools: Locator, name: string): Promise<Locator> {
  const card = group(tools, name);
  const trigger = card.locator("button[aria-expanded]");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return card.getByRole("group");
}

test.describe("the grouped Tools section of an agent", () => {
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

  test("groups the tools by package, folds them, shows read_skill as included and keeps the ids in the technical details", async ({
    page
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(SHOT_SIZE);
    await page.goto(`/build/agents/${agentName}`);
    const tools = page.locator("#tools");
    const own = tools.getByRole("group", { name: "Instance tools", exact: true });
    await expect(own).toBeVisible();

    // One group per package of what the suite's instance enables, in the page's order.
    await expect(own.locator("[data-instance-tool-group]")).toHaveCount(5);
    expect(
      await own
        .locator("[data-instance-tool-group]")
        .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-instance-tool-group")))
    ).toEqual(["files", "results", "skills", "platform", "instance"]);
    await expect(group(own, "results")).toContainText("Results");
    await expect(group(own, "results")).toContainText(
      "Shows and keeps results: widgets, Pages and recorded facts."
    );
    // Folded at rest: no tool and no id is on the page.
    await expect(own.getByRole("checkbox")).toHaveCount(0);
    await expect(tools).not.toContainText("show_view");

    // Results: show_view is on and page.save is not, so the switch is mixed.
    const results = await unfold(own, "results");
    const widget = results.getByRole("checkbox", { name: "Show inline widget" });
    await expect(widget).toBeChecked();
    await expect(results).toContainText(
      "Shows a small table, chart or overview inside its answer."
    );
    await expect(results.getByRole("checkbox", { name: "Save page" })).not.toBeChecked();
    const resultsSwitch = group(own, "results").getByRole("switch", {
      name: "All tools of Results"
    });
    await expect(resultsSwitch).toHaveAttribute("aria-checked", "mixed");
    // The switch turns every tool of the group on, then off.
    await resultsSwitch.click();
    await expect(resultsSwitch).toHaveAttribute("aria-checked", "true");
    await expect(results.getByRole("checkbox", { name: "Save page" })).toBeChecked();
    await resultsSwitch.click();
    await expect(resultsSwitch).toHaveAttribute("aria-checked", "false");
    await expect(widget).not.toBeChecked();
    await widget.check();
    await expect(resultsSwitch).toHaveAttribute("aria-checked", "mixed");

    // This instance's own tools: one with its deployment's wording, one by its id alone.
    const instance = await unfold(own, "instance");
    await expect(instance.getByRole("checkbox", { name: "Weather forecast" })).not.toBeChecked();
    await expect(instance).toContainText(
      "Gives a sample weather forecast for planning trips and appointments."
    );
    await expect(instance.getByRole("checkbox", { name: "demo.workflow_summary" })).toBeChecked();

    // Without a skill, read_skill is a check box like any other.
    const skills = await unfold(own, "skills");
    await expect(skills.getByRole("checkbox", { name: "Read assigned skill" })).not.toBeChecked();
    await expect(skills.locator('[data-included-tool="read_skill"]')).toHaveCount(0);

    // With a skill it is included, has no check box, and is saved with the agent.
    await page
      .locator("section#skills")
      .getByRole("button", { name: "Skills: Choose skills" })
      .click();
    const picker = page.getByRole("dialog");
    await picker.getByRole("option", { name: "Tools probe skill" }).click();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    const included = skills.locator('[data-included-tool="read_skill"]');
    await expect(included).toContainText("Read assigned skill");
    await expect(included).toContainText("Included");
    await expect(included).toContainText("Comes with the agent's skills.");
    await expect(skills.getByRole("checkbox", { name: "Read assigned skill" })).toHaveCount(0);
    await expect(skills.getByRole("checkbox", { name: "Propose skill change" })).toBeChecked();
    await expect(
      group(own, "skills").getByRole("switch", { name: "All tools of Skills" })
    ).toHaveAttribute("aria-checked", "true");
    await expect(group(own, "skills")).toContainText("2 of 2 on");

    // The ids, effects and packages stand under "Technical details", closed by default.
    const details = own.locator("[data-tool-technical-details]");
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
        const own = tools.locator('[data-tool-group="instance"]');
        await expect(own.locator("[data-instance-tool-group]")).toHaveCount(5);
        await unfold(own, "results");
        await unfold(own, "skills");
        await unfold(own, "instance");
        await expect(own.locator('[data-included-tool="read_skill"]')).toBeVisible();
        await own.locator("[data-tool-technical-details] button[aria-expanded]").click();
        await expect(own.getByRole("table")).toBeVisible();
        if (shotsDir) {
          await mkdir(shotsDir, { recursive: true });
          // The head of the section, then its end with the technical details.
          for (const [part, element] of [
            ["top", tools.getByRole("heading", { name: /^(Tools|Werkzeuge)$/u })],
            ["end", own.getByRole("table")]
          ] as const) {
            await element.evaluate((target, block) => {
              // The box that scrolls the page, as the page itself scrolls to a section.
              let scroller = target.closest("section#tools")?.parentElement ?? null;
              while (scroller && !/auto|scroll/u.test(getComputedStyle(scroller).overflowY)) {
                scroller = scroller.parentElement;
              }
              const box = target.getBoundingClientRect();
              const top = block === "top" ? box.top - 96 : box.bottom - window.innerHeight + 48;
              scroller?.scrollBy({ top, behavior: "instant" });
            }, part);
            await page.screenshot({
              path: join(shotsDir, `agent-tools-${locale}-${theme}-1280-${part}.png`),
              animations: "disabled"
            });
          }
        }
      });
    }
  }
});
