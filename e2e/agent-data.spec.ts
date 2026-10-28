import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// AGENT-DATA-1: the agent page's "Daten" section gives an agent a Data Store to read, or to read
// and change, written as the store's row tools; a store the agent cannot use stands greyed with
// the reason. The head says in plain words where a chat can choose the agent.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const shotsDir = process.env.E2E_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const idSchema = z.object({ id: z.string() });
const sentAgent = z
  .object({ config: z.object({ toolNames: z.array(z.string()).optional() }).passthrough() })
  .passthrough();

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

async function putStore(
  page: Page,
  name: string,
  title: string,
  workspaceId?: string
): Promise<void> {
  const made = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/data_store/${name}`,
    {
      data: {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        expectedRevision: null,
        files: [
          { path: "store.yaml", text: `id: ${name}\nname: ${title}\n` },
          { path: "migrations/0001_init.sql", text: "create table rows (id text primary key);\n" }
        ]
      }
    }
  );
  expect(made.ok(), await made.text()).toBe(true);
}

/** One picture, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `agent-data-${name}.png`), animations: "disabled" });
}

test("an agent is given Data Stores to read or change, and one it cannot use is greyed", async ({
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
  const store = `pruefungen-${tag}`;
  await putStore(page, store, `Prüfergebnisse ${tag}`);
  await putStore(page, `steuer-${tag}`, `Meine Steuer ${tag}`, personal);
  await putStore(page, `monat-${tag}`, `Monatszahlen ${tag}`, team);
  const agent = `agent_data_${tag}`;
  const agentMade = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/agent/${agent}`,
    {
      data: {
        expectedRevision: null,
        config: {
          name: agent,
          displayName: `Prüfassistent ${tag}`,
          description: "Beantwortet Fragen zu Prüfergebnissen.",
          instructions: "Antworte aus den Prüfergebnissen."
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
  await page.goto(`/build/agents/${agent}`);
  await expect(page.getByRole("heading", { name: `Prüfassistent ${tag}` })).toBeVisible();

  // The head says in plain words that no chat can choose the agent yet, and leads to the
  // section that changes it.
  const place = page.locator("[data-asset-place]");
  const nowhere = place.getByRole("link", { name: "In keinem Chat wählbar" });
  await expect(nowhere).toBeVisible();
  await expect(page.getByText("Noch nirgends angeboten")).toHaveCount(0);
  await shoot(page, "head-after-390");
  await page.setViewportSize(DESKTOP);
  await shoot(page, "head-after-1280");
  await nowhere.click();
  await expect(page.getByRole("heading", { name: "Verfügbar in", exact: true })).toBeInViewport();
  await page.setViewportSize(PHONE);

  // The Daten section: nothing chosen yet, and the line that the person's rights still count.
  const section = page.locator("section#data");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "Daten", exact: true })).toBeVisible();
  await expect(section.getByText("Kein Datenspeicher gewählt.")).toBeVisible();
  await expect(
    section.getByText("Bei jedem Lesen und Ändern zählen auch die Rechte der Person im Chat", {
      exact: false
    })
  ).toBeVisible();

  // The chooser offers the store of everyone, and greys the reader's own and the team's.
  const choose = section.getByRole("button", { name: "Daten: Datenspeicher wählen", exact: true });
  await choose.click();
  const listbox = page.getByRole("listbox", { name: "Datenspeicher wählen" });
  await expect(listbox).toBeVisible();
  await page.getByRole("combobox", { name: "Suchen", exact: true }).fill(tag);
  const usable = listbox.getByRole("option").filter({ hasText: `Prüfergebnisse ${tag}` });
  await expect(usable).not.toHaveAttribute("aria-disabled", "true");
  const mine = listbox.getByRole("option").filter({ hasText: `Meine Steuer ${tag}` });
  await expect(mine).toHaveAttribute("aria-disabled", "true");
  await expect(mine).toContainText("Gehört nur dir. Ein Agent für alle kann ihn nicht verwenden.");
  const teams = listbox.getByRole("option").filter({ hasText: `Monatszahlen ${tag}` });
  await expect(teams).toHaveAttribute("aria-disabled", "true");
  await expect(teams).toContainText(
    `Liegt in Controlling ${tag}. Ein Agent für alle kann ihn nicht verwenden.`
  );
  await shoot(page, "picker-390");
  await usable.click();
  await page.keyboard.press("Escape");

  // A chosen store reads; its row sets read and change.
  const row = section.locator(`[data-agent-data-store="${store}"]`);
  const access = row.getByRole("combobox", { name: `Was der Agent in Prüfergebnisse ${tag} darf` });
  await expect(access).toHaveValue("read");
  await access.selectOption("change");
  await section.scrollIntoViewIfNeeded();
  await shoot(page, "section-390");
  await page.setViewportSize(DESKTOP);
  await section.scrollIntoViewIfNeeded();
  await shoot(page, "section-1280");
  await page.setViewportSize(PHONE);

  // The save writes exactly the store's existing tool names.
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().includes(`/agent/${agent}`) &&
      (request.postData() ?? "").includes("data_store.")
  );
  await page
    .getByRole("button", { name: /Speichern|Entwurf speichern/u })
    .first()
    .click();
  const sent = sentAgent.parse(JSON.parse((await saved).postData() ?? "{}"));
  expect(sent.config.toolNames).toEqual(
    ["describe", "query", "preview_rows", "insert", "update", "delete_rows"].map(
      (verb) => `data_store.${store}.${verb}`
    )
  );
});
