import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import JSZip from "jszip";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// PRJ-2: a person fills a shared project's folder with a folder and a .zip, and the agent of
// their chat in the project writes a checklist there. A second member's chat in the project
// changes it to its second version; the first chat, which still read the first, writes beside
// it as a conflict copy. The file's versions name both people. In German.

const creator = {
  email: "e2e-project-files@example.test",
  password: "e2e-project-files-password",
  label: "E2E Zz Project Files"
};
const member = {
  email: "e2e-project-files-member@example.test",
  password: "e2e-project-files-member-password",
  label: "E2E Zz Project Files Member"
};
const idSchema = z.object({ id: z.string() });
const shotsDir = process.env.E2E_SHOTS_DIR;

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { email: person.email, password: person.password, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    if (target) {
      // The chat renders its turn again as the width changes; the line is found again then.
      await expect(async () => {
        await target.scrollIntoViewIfNeeded({ timeout: 2_000 });
      }).toPass();
    }
    await page.screenshot({
      path: join(shotsDir, `${name}-de-${String(width)}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** Starts a chat in the project on screen with the composer, and waits until it is open. */
async function startChatInProject(page: Page, title: string, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: `Neuer Chat in ${title}` });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  await expect(page.getByText(text).first()).toBeVisible();
}

/** A folder on disk with two files, and a .zip with a folder of two more. */
async function uploadsOnDisk(root: string): Promise<{ folder: string; zip: string }> {
  const folder = join(root, "unterlagen");
  await mkdir(join(folder, "plaene"), { recursive: true });
  await writeFile(join(folder, "baubeschreibung.md"), "# Baubeschreibung\n\nMassivbau, KfW 40.\n");
  await writeFile(join(folder, "plaene", "grundriss-eg.txt"), "Erdgeschoss, 92 m²\n");
  const archive = new JSZip();
  archive.file("elektro.txt", "Angebot Elektro: 18.400 €\n");
  archive.file("sanitaer.txt", "Angebot Sanitär: 22.900 €\n");
  const zip = join(root, "angebote.zip");
  await writeFile(zip, await archive.generateAsync({ type: "nodebuffer" }));
  return { folder, zip };
}

async function upload(page: Page, button: string, path: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByTestId("project-files")
    .getByRole("button", { name: button, exact: true })
    .click();
  await (await chooser).setFiles(path);
}

test("a project's folder takes uploads, and its chats write versions and a conflict copy", async ({
  page,
  browser,
  baseURL
}, testInfo) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const title = `Hausbau Süd ${String(suffix)}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  const memberPage = await memberContext.newPage();
  await Promise.all([signIn(page, creator), signIn(memberPage, member)]);

  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Bauteam ${String(suffix)}`, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);

  // A shared project, filled with a folder and a .zip that lands unpacked.
  await page.goto(`/w/${workspaceId}/projects`);
  await page.getByRole("button", { name: "Neues Projekt" }).click();
  const dialog = page.getByRole("dialog", { name: "Neues Projekt" });
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("radio", { name: /^Geteilt mit/u }).check();
  await dialog.getByRole("button", { name: "Projekt anlegen" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  const files = page.getByTestId("project-files");
  const { folder, zip } = await uploadsOnDisk(testInfo.outputPath("uploads"));
  await upload(page, "Ordner hochladen", folder);
  await expect(files.getByTestId("project-file-upload")).toHaveCount(2);
  await upload(page, "Hochladen", zip);
  await expect(files.getByTestId("project-file-upload")).toHaveCount(4);
  await expect(files.locator('[data-testid="project-file-upload"][data-state="done"]')).toHaveCount(
    4
  );
  await expect(files.locator("[data-folder]")).toHaveCount(2);
  for (const name of ["unterlagen", "angebote"]) {
    await files.getByRole("button", { name, exact: true }).click();
  }
  await expect(files.getByTestId("project-file-row")).toHaveCount(3);
  await expect(files.locator("[data-folder]")).toHaveCount(3);
  await expect(files).toContainText("4 Dateien");
  await shot(page, "project-files-uploaded", files);

  // The creator's chat in the project: the agent writes a checklist into the folder.
  await startChatInProject(page, title, "Leg bitte eine Checkliste für die Abnahme an.");
  const creatorChat = page.url();
  await sendToolCall(page, "workspace.write_file", {
    path: "project/checkliste.md",
    content: "# Abnahme\n\n- [ ] Fenster\n- [ ] Elektro\n"
  });
  const createdLine = page.locator(
    '[data-testid="project-file-change-line"][data-change="created"]'
  );
  await expect(createdLine).toContainText("checkliste.md erstellt · v1");
  await expect(createdLine.getByTestId("project-file-undo")).toHaveText("Rückgängig");
  await shot(page, "project-file-created", createdLine);

  // The member's chat in the same project reads version 1 and writes version 2.
  await memberPage.goto(projectPath);
  await startChatInProject(memberPage, title, "Ergänze die Checkliste um Sanitär.");
  await sendToolCall(memberPage, "workspace.write_file", {
    path: "project/checkliste.md",
    content: "# Abnahme\n\n- [ ] Fenster\n- [ ] Elektro\n- [ ] Sanitär\n",
    replacesVersion: 1
  });
  const updatedLine = memberPage.getByTestId("project-file-change-line").last();
  await expect(updatedLine).toHaveAttribute("data-change", "updated");
  await expect(updatedLine).toContainText("checkliste.md aktualisiert · v2");

  // The creator's chat still read version 1: its write lands beside the file as a copy.
  await page.goto(creatorChat);
  await sendToolCall(page, "workspace.write_file", {
    path: "project/checkliste.md",
    content: "# Abnahme\n\n- [ ] Fenster\n- [ ] Elektro\n- [ ] Dach\n",
    replacesVersion: 1
  });
  const copyLine = page.locator(
    '[data-testid="project-file-change-line"][data-change="conflict_copy"]'
  );
  await expect(copyLine).toContainText("Konfliktkopie checkliste (Konflikt");
  await expect(copyLine).toContainText("checkliste.md wurde inzwischen geändert (v2)");
  await shot(page, "project-file-conflict-copy", copyLine);

  // On the project's page the file shows both versions, each with its person.
  await page.goto(projectPath);
  await expect(files.getByTestId("project-file-row")).toHaveCount(2);
  await expect(files).toContainText("6 Dateien");
  await files.locator('[data-testid="project-file-row"][data-path="checkliste.md"]').click();
  const versions = page.getByTestId("project-file-version");
  await expect(versions).toHaveCount(2);
  await expect(versions.nth(0)).toContainText(`v2 · ${member.label}`);
  await expect(versions.nth(0)).toContainText("Aktuell");
  await expect(versions.nth(1)).toContainText(`v1 · ${creator.label}`);
  await shot(page, "project-file-versions", page.getByTestId("project-file-versions"));
  await memberContext.close();
});
