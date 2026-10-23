import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { shoot, shotsDir, signIn } from "./inbox-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A skill brought into Studio whole: a .zip is imported from the Skills list, its files show on
// the new skill's page with their sizes, and a folder replaces them with the files it adds,
// changes and removes listed before the save. A member who may not write skills is offered
// neither.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const member = { email: "e2e-user@example.test", password: "e2e-user-password" };
const NAME = "e2e_skill_import";
const skillPath = `${apiBaseUrl}/api/v1/assets/skill/${NAME}`;
const fixtures = fileURLToPath(new URL("./fixtures/skill-import/", import.meta.url));

const folderSchema = z.object({
  revision: z.number(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() }))
});

/** Every file below `folder`, by its path from `base` on. */
async function filesBelow(folder: string, base: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.set(relative(base, path), await readFile(path));
  }
  return found;
}

/** The fixture folder as a .zip with its top folder, as a library ships one. */
async function zipOf(files: Map<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of files) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function removeSkill(page: Page): Promise<void> {
  if ((await page.request.get(skillPath)).ok()) {
    await requestWithOrigin(page, "post", `${skillPath}/delete`, {
      data: { expectedRevision: await assetRevision(page, skillPath) }
    });
  }
}

/** Opens the import dialog on the Skills list and hands it the .zip. */
async function importZip(page: Page, name: string, buffer: Buffer): Promise<void> {
  await headAction(page, /^(Import skill|Skill importieren)$/u);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^(Choose \.zip|\.zip auswählen)$/u }).click();
  await (await chooser).setFiles({ name, mimeType: "application/zip", buffer });
  await expect(page.locator("[data-skill-import-preview]")).toBeVisible();
}

const REPLACE = /^(Replace from folder|Aus Ordner ersetzen)$/u;

/** Runs an action of the page head. A narrow head keeps it in its "…" menu. */
async function headAction(page: Page, name: RegExp): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const action = page.getByRole("button", { name });
  if (await action.isVisible()) {
    await action.click();
    return;
  }
  await page.getByRole("button", { name: /^(More actions|Weitere Aktionen)$/u }).click();
  await page.getByRole("menuitem", { name }).click();
  // The menu has gone once the dialog it opened is up; the dialog hides the page from the
  // roles, so the menu is looked for by its attribute.
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
}

/** Opens "Replace from folder" and hands it the folder. */
async function replaceFromFolder(page: Page, folder: string): Promise<void> {
  await headAction(page, REPLACE);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^(Choose folder|Ordner auswählen)$/u }).click();
  await (await chooser).setFiles(folder);
  await expect(page.locator("[data-skill-replace-diff]")).toBeVisible();
}

test("a skill is imported from a .zip, and its files are replaced from a folder", async ({
  page
}) => {
  // The pictures take a run of their own per language, theme and width.
  test.setTimeout(shotsDir ? 300_000 : 60_000);
  await signIn(page, superadmin);
  await removeSkill(page);
  const source = await filesBelow(join(fixtures, "e2e-skill-import"), fixtures);
  const archive = await zipOf(source);
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/build/skills");
    await importZip(page, "e2e-skill-import.zip", archive);

    // The preview reads SKILL.md and lists the four files by folder with their sizes.
    const preview = page.locator("[data-skill-import-preview]");
    await expect(preview).toContainText("Form import");
    await expect(preview).toContainText("Use when a customer form has to be filled");
    await expect(preview.getByRole("textbox", { name: /^Address/u })).toHaveValue(NAME);
    await expect(preview.locator("[data-skill-import-count]")).toContainText("4 files");
    for (const path of ["SKILL.md", "references/r.md", "scripts/run.py", "assets/t.png"]) {
      const bytes = source.get(`e2e-skill-import/${path}`)?.byteLength;
      await expect(preview.locator(`[data-skill-import-file="${path}"]`)).toContainText(
        `${bytes} B`
      );
    }

    const created = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url() === skillPath
    );
    await page.getByRole("button", { name: "Import", exact: true }).click();
    expect((await created).ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/build/skills/${NAME}$`, "u"));

    // The page shows the four files; each tells its size.
    await expect(page.locator('[data-skill-file="SKILL.md"]')).toBeVisible();
    for (const path of ["references/r.md", "scripts/run.py", "assets/t.png"]) {
      await page.locator(`[data-skill-file="${path}"]`).getByRole("button").click();
      await expect(
        page.locator(`[data-skill-file-pane="${path}"] [data-skill-file-facts]`)
      ).toContainText(`${source.get(`e2e-skill-import/${path}`)?.byteLength} B`);
    }
    const first = folderSchema.parse(
      await (await page.request.get(`${skillPath}?files=true`)).json()
    );
    expect(first.revision).toBe(1);

    // A folder replaces the files: the image changes and the reference goes.
    const replacement = join(fixtures, "replace", "e2e-skill-import");
    await replaceFromFolder(page, replacement);
    const diff = page.locator("[data-skill-replace-diff]");
    await expect(diff.locator('[data-skill-replace-group="changed"]')).toContainText(
      "assets/t.png"
    );
    await expect(diff.locator('[data-skill-replace-group="removed"]')).toContainText(
      "references/r.md"
    );
    await expect(diff.locator('[data-skill-replace-group="added"]')).toHaveCount(0);
    await shoot(page, "skill-replace", () => replaceFromFolder(page, replacement), [1280, 390]);

    const replaced = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url() === skillPath
    );
    await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
    expect((await replaced).ok()).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('[data-skill-file="references/r.md"]')).toHaveCount(0);

    const second = folderSchema.parse(
      await (await page.request.get(`${skillPath}?files=true`)).json()
    );
    expect(second.revision).toBe(2);
    expect(second.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "assets/t.png",
      "scripts/run.py"
    ]);

    // An import of an address that is taken offers to replace that skill's files instead.
    await page.goto("/build/skills");
    await importZip(page, "e2e-skill-import.zip", archive);
    await expect(page.locator("[data-skill-import-taken]")).toBeVisible();
    await expect(page.locator("[data-skill-import-replace]")).toHaveText(
      "Replace the files of Form import"
    );

    // The preview with a long German name, in both themes and at both widths.
    const long = new Map<string, Buffer | string>([
      [
        "antragsunterlagen/SKILL.md",
        "---\nname: e2e_skill_import_long\ntitle: Antragsunterlagen der Baufinanzierung vollständig prüfen und zusammenfassen\ndescription: Prüft eingereichte Unterlagen einer Baufinanzierung auf Vollständigkeit und fasst sie für die Sachbearbeitung zusammen.\n---\n\n# Prüfung\n"
      ],
      [
        "antragsunterlagen/references/einkommensnachweise-und-selbstauskunft-der-antragstellenden.md",
        "# Nachweise\n"
      ],
      ["antragsunterlagen/assets/vorlage.png", source.get("e2e-skill-import/assets/t.png") ?? ""]
    ]);
    const longArchive = await zipOf(long);
    await page.keyboard.press("Escape");
    await shoot(
      page,
      "skill-import",
      () => importZip(page, "antragsunterlagen.zip", longArchive),
      [1280, 390]
    );
  } finally {
    await removeSkill(page);
  }
});

// The member holds no right to write skills: Studio offers them no skills to change.
test("a member who may not write skills is offered no import and no replace", async ({ page }) => {
  await signIn(page, member);
  await page.goto("/build/skills");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Studio", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import skill" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replace from folder" })).toHaveCount(0);
});
