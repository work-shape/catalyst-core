import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const idSchema = z.object({ id: z.string() });
/** The agent save the page sends, as far as the test changes it. */
const sentAgent = z
  .object({
    config: z.object({ skillNames: z.array(z.string()).optional() }).passthrough()
  })
  .passthrough();

test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "skill-of-another-place",
        reason:
          "Chromium's own log line: the test saves an agent for everyone with a skill that " +
          "belongs to the reader alone, and asserts the sentence the page says for the 422.",
        matches: requestAnswered(422),
        path: /^\/api\/v1\/assets\/agent\/scope_words_agent_[a-f0-9]+$/u,
        tests: ["Studio says where an asset sits, greys what an agent cannot use, and says why"]
      }
    ]
  }
});

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

async function putSkill(
  page: Page,
  name: string,
  title: string,
  description: string,
  workspaceId?: string
): Promise<void> {
  const made = await requestWithOrigin(page, "put", `${apiBaseUrl}/api/v1/assets/skill/${name}`, {
    data: {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      expectedRevision: null,
      config: { name, title, description, content: `# ${title}\n\n${description}` }
    }
  });
  expect(made.ok(), await made.text()).toBe(true);
}

/** One picture at phone width, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, `scope-words-${name}.png`),
    animations: "disabled"
  });
}

test("Studio says where an asset sits, greys what an agent cannot use, and says why", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);
  await signIn(page);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const personal = idSchema.parse(
    await (await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces/personal`)).json()
  ).id;
  const team = idSchema.parse(
    await (
      await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
        data: { name: `Controlling ${tag}` }
      })
    ).json()
  ).id;
  const mine = `scope_words_mine_${tag}`;
  await putSkill(
    page,
    `scope_words_all_${tag}`,
    `Angebote prüfen ${tag}`,
    "Prüft ein Angebot auf Preis und Frist."
  );
  await putSkill(
    page,
    mine,
    `Meine Steuerprüfung ${tag}`,
    "Meine Schritte für die Steuer.",
    personal
  );
  await putSkill(
    page,
    `scope_words_team_${tag}`,
    `Monatsbericht ${tag}`,
    "Baut den Monatsbericht des Controllings.",
    team
  );
  const agent = `scope_words_agent_${tag}`;
  const agentMade = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/agent/${agent}`,
    {
      data: {
        expectedRevision: null,
        config: {
          name: agent,
          displayName: `Workshaper ${tag}`,
          description: "Baut Agenten, Skills und Apps mit dir.",
          instructions: "Hilf beim Bauen."
        }
      }
    }
  );
  expect(agentMade.ok(), await agentMade.text()).toBe(true);

  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
  });

  // The list of skills, as the instance's own and then as the reader's own. The filter asks
  // "Wo", and each row says where its skill sits in the ladder's words.
  await page.goto("/build/skills");
  const allRow = page.getByRole("listitem").filter({ hasText: `Angebote prüfen ${tag}` });
  await expect(allRow).toBeVisible();
  await expect(allRow.getByText("Alle", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Wo: /u })).toBeVisible();
  await expect(page.getByText(/Instanz|Geltungsbereich|Scope/u)).toHaveCount(0);
  await shoot(page, "skills-list-all");
  await page.evaluate(
    (id) => window.localStorage.setItem("vivd-catalyst:build-scope", id),
    personal
  );
  await page.goto("/build/skills");
  const mineRow = page.getByRole("listitem").filter({ hasText: `Meine Steuerprüfung ${tag}` });
  await expect(mineRow).toBeVisible();
  await expect(mineRow.getByText("Nur ich", { exact: true })).toBeVisible();
  await shoot(page, "skills-list-mine");

  // Data Stores, under their plain name: Daten, kept apart from Wissen.
  await page.goto("/build/data-stores");
  await expect(page.getByRole("heading", { level: 1, name: "Daten" })).toBeVisible();
  await shoot(page, "data-list");

  // A skill of the reader's own, on its page: the first line says it is the reader's alone, on
  // a phone too, where the head's chips give way to the name.
  const placeLine = page.locator("[data-asset-place]");
  await page.goto(`/build/skills/${mine}`);
  await expect(page.getByRole("heading", { name: `Meine Steuerprüfung ${tag}` })).toBeVisible();
  await expect(placeLine.getByText("Nur ich", { exact: true })).toBeVisible();
  await shoot(page, "skill-page-mine");
  await page.setViewportSize(DESKTOP);
  await shoot(page, "skill-page-mine-1280");
  await page.setViewportSize(PHONE);

  // The agent for everyone, and its skill chooser: the reader's own skill stands greyed with
  // the reason it cannot be chosen here.
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:build-scope", "instance"));
  await page.goto(`/build/agents/${agent}`);
  await expect(page.getByRole("heading", { name: `Workshaper ${tag}` })).toBeVisible();
  await expect(placeLine.getByText("Alle", { exact: true })).toBeVisible();
  await shoot(page, "agent-page");
  await page.setViewportSize(DESKTOP);
  await shoot(page, "agent-page-1280");
  await page.setViewportSize(PHONE);
  const choose = page.getByRole("button", { name: "Skills: Skills auswählen", exact: true });
  await choose.scrollIntoViewIfNeeded();
  await choose.click();
  const listbox = page.getByRole("listbox", { name: "Skills auswählen" });
  await expect(listbox).toBeVisible();
  await page.getByRole("combobox", { name: "Suchen", exact: true }).fill(tag);
  await expect(listbox.getByText(`Angebote prüfen ${tag}`)).toBeVisible();
  const greyed = listbox.getByRole("option").filter({ hasText: `Meine Steuerprüfung ${tag}` });
  // Greyed, it offers to share the skill up to the agent's place instead (SHARE-1).
  await expect(greyed).toHaveAttribute("data-picker-action", "");
  await expect(greyed).toContainText("Für alle teilen…");
  await expect(greyed).toContainText(
    "Gehört nur dir. Ein Agent für alle kann ihn nicht verwenden."
  );
  // A skill of the reader's team is greyed too, never hidden, and can be shared up to everyone.
  const teamSkill = listbox.getByRole("option").filter({ hasText: `Monatsbericht ${tag}` });
  await expect(teamSkill).toContainText(
    `Liegt in Controlling ${tag}. Ein Agent für alle kann ihn nicht verwenden.`
  );
  await expect(teamSkill).toContainText("Für alle teilen…");
  await shoot(page, "agent-skill-picker");

  // The save is sent with the reader's own skill added: the instance refuses it, and the page
  // says why and what to do.
  await listbox.getByText(`Angebote prüfen ${tag}`).click();
  await page.keyboard.press("Escape");
  await page.route(`**/api/v1/assets/agent/${agent}`, async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.continue();
    const raw: unknown = JSON.parse(request.postData() ?? "{}");
    const sent = sentAgent.parse(raw);
    const skillNames = [...(sent.config.skillNames ?? []), mine];
    await route.continue({
      postData: JSON.stringify({ ...sent, config: { ...sent.config, skillNames } })
    });
  });
  await page
    .getByRole("button", { name: /Speichern|Entwurf speichern/u })
    .first()
    .click();
  const refusal = page.locator("p[role=status][data-tone=error]");
  await expect(refusal).toContainText(
    "Das ist für alle, verwendet aber etwas, das nur dir gehört. Was für alle ist, kann nur verwenden, was auch für alle ist."
  );
  await expect(refusal).not.toContainText("CLI");
  await expect(page.getByRole("button", { name: "Entwurf speichern", exact: true })).toBeEnabled();
  await refusal.scrollIntoViewIfNeeded();
  await shoot(page, "agent-refusal");
});
