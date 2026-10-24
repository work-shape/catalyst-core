import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { requestAnswered } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "refused-skill-file",
        reason:
          "Chromium's own log line: the test saves a skill with a compiled program under scripts/ and " +
          "one with a Git LFS pointer, and asserts what the page shows for each 422.",
        matches: requestAnswered(422),
        path: /^\/api\/v1\/assets\/skill\/e2e_skill_files$/u,
        tests: [
          "a skill's files are uploaded, written, replaced and deleted, and a refused one is named"
        ]
      }
    ]
  }
});

// The skill editor's folder in Studio: a file is uploaded into a folder, a new script is
// written in place, a file is replaced and one deleted, and a file the instance refuses, a
// text file too, is named by its path. Each save is read back over the API byte for byte.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of the editor go. Unset, none is taken. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const NAME = "e2e_skill_files";
const skillPath = `${apiBaseUrl}/api/v1/assets/skill/${NAME}`;

/** A small PDF: its second line holds bytes that are no text. */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n%", "latin1"),
  Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  Buffer.from("1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1")
]);
const PDF_2 = Buffer.concat([PDF, Buffer.from("% second version\n", "latin1")]);
/** The first bytes of an ELF program. */
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const folderSchema = z.object({
  revision: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string(),
      text: z.string().optional(),
      base64: z.string().optional()
    })
  )
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function removeSkill(page: Page): Promise<void> {
  if ((await page.request.get(skillPath)).ok()) {
    await requestWithOrigin(page, "post", `${skillPath}/delete`, {
      data: { expectedRevision: await assetRevision(page, skillPath) }
    });
  }
}

/** The folder of the skill as the instance holds it, by path. */
async function folder(page: Page) {
  const response = await page.request.get(`${skillPath}?files=true`);
  expect(response.ok()).toBe(true);
  const read = folderSchema.parse(await response.json());
  return { revision: read.revision, files: new Map(read.files.map((file) => [file.path, file])) };
}

function row(page: Page, path: string): Locator {
  return page.locator(`[data-skill-file="${path}"]`).getByRole("button");
}

/** Adds a file to a folder from the folder's menu: an upload, or a new empty file. */
async function addFile(
  page: Page,
  folderName: string,
  choice: "Upload file" | "New file",
  upload?: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
  // The menu of the file added before has closed.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: `Add a file to ${folderName}/` }).click();
  if (upload === undefined) {
    await page.getByRole("menuitem", { name: choice }).click();
    return;
  }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: choice }).click();
  await (await chooser).setFiles(upload);
}

/** Saves, and waits for the instance's answer to the write. */
/** Takes a picture of the files section where `E2E_SHOTS_DIR` asks for one. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.locator("#files").evaluate((section) => section.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(shotsDir, name) });
}

async function save(page: Page): Promise<void> {
  const written = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url() === skillPath
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await written).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
}

test("a skill's files are uploaded, written, replaced and deleted, and a refused one is named", async ({
  page
}) => {
  await signIn(page);
  await removeSkill(page);
  const created = await requestWithOrigin(page, "put", skillPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, skillPath),
      config: {
        name: NAME,
        title: "Form filler",
        description: "Use when a customer form has to be filled from a case.",
        content: "# Form filler\n\nFill the form."
      }
    }
  });
  expect(created.ok()).toBe(true);
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`/build/skills/${NAME}`);
    await expect(page.locator("[data-skill-folder]")).toHaveCount(3);

    // An upload goes into its folder, and its type is read from its name.
    await addFile(page, "assets", "Upload file", {
      name: "form.pdf",
      mimeType: "application/pdf",
      buffer: PDF
    });
    await expect(row(page, "assets/form.pdf")).toHaveAttribute("aria-current", "true");
    const pane = page.locator('[data-skill-file-pane="assets/form.pdf"]');
    await expect(pane.locator("[data-skill-file-facts]")).toContainText("PDF");
    await expect(pane.locator("[data-skill-file-facts]")).toContainText("Not saved yet");
    await expect(pane.locator("[data-skill-file-binary]")).toBeVisible();

    // A new script is written in place.
    await addFile(page, "scripts", "New file");
    await expect(row(page, "scripts/script.py")).toHaveAttribute("aria-current", "true");
    await page.getByRole("textbox", { name: /^Name/u }).fill("fill_form.py");
    await page.getByRole("textbox", { name: /^Content/u }).fill("print('filled')\n");
    await save(page);

    let held = await folder(page);
    expect(held.files.get("assets/form.pdf")?.sha256).toBe(sha256(PDF));
    expect(held.files.get("scripts/fill_form.py")?.text).toBe("print('filled')\n");

    // After a reload the page reads the files the index names, and shows a script's text.
    await page.reload();
    await row(page, "scripts/fill_form.py").click();
    const script = page.getByRole("textbox", { name: /^Content/u });
    await expect(script).toHaveValue("print('filled')\n");
    await expect(row(page, "scripts/fill_form.py")).toHaveAttribute("aria-current", "true");
    await expect(row(page, "SKILL.md")).not.toHaveAttribute("aria-current", "true");
    await expect(
      page.locator('[data-skill-file-pane="scripts/fill_form.py"] [data-skill-file-facts]')
    ).toContainText(`SHA-256 ${sha256("print('filled')\n")}`);
    await shoot(page, "skill-files-script.png");

    // A text edit, and the PDF replaced with a new version.
    await script.fill("print('filled', 2)\n");
    await row(page, "assets/form.pdf").click();
    const replaced = page.waitForEvent("filechooser");
    // The file's own Replace, not the page's "Replace from folder".
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await (
      await replaced
    ).setFiles({ name: "form-2.pdf", mimeType: "application/pdf", buffer: PDF_2 });
    await expect(row(page, "assets/form.pdf")).toBeVisible();
    await save(page);

    held = await folder(page);
    expect(held.files.get("scripts/fill_form.py")?.text).toBe("print('filled', 2)\n");
    expect(held.files.get("assets/form.pdf")?.sha256).toBe(sha256(PDF_2));

    // A compiled program is refused with its path, and nothing is written.
    const before = held.revision;
    await addFile(page, "scripts", "Upload file", {
      name: "tool",
      mimeType: "application/octet-stream",
      buffer: ELF
    });
    const refused = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url() === skillPath
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await refused).status()).toBe(422);
    await expect(page.locator("#files [data-field-refusal]")).toHaveText(
      "scripts/tool is a compiled program. A skill holds scripts as text, not programs."
    );
    await shoot(page, "skill-files-refused.png");
    expect((await folder(page)).revision).toBe(before);

    // The refused file and the script are deleted.
    await row(page, "scripts/tool").click();
    await page.getByRole("button", { name: "Delete" }).click();
    await row(page, "scripts/fill_form.py").click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator('[data-skill-file^="scripts/"]')).toHaveCount(0);
    await save(page);

    held = await folder(page);
    expect([...held.files.keys()]).toEqual(["SKILL.md", "assets/form.pdf"]);

    // A text file is checked as every other file: a Git LFS pointer is refused by its path.
    await addFile(page, "references", "Upload file", {
      name: "pointer.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n")
    });
    const pointer = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url() === skillPath
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await pointer).status()).toBe(422);
    await expect(page.locator("#files [data-field-refusal]")).toHaveText(
      "references/pointer.md is a Git LFS pointer, not the file itself. Upload the file itself."
    );
    expect((await folder(page)).revision).toBe(held.revision);
  } finally {
    await removeSkill(page);
  }
});
